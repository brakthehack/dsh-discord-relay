"""dsh-discord-relay shared logic (Hermes half).

Pure stdlib. Holds everything that must agree with the dsh bridge: the wire
client, the ``custom_id`` codec, Discord component-budget helpers, and the
builder that turns a pending question into message components. The discord.py
plugin (``__init__.py``) and the gateway-free dev runner (``dev_main.py``) both
go through here so the two halves cannot drift.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------- Discord budgets
BUTTON_LABEL_LIMIT = 80
SELECT_LABEL_LIMIT = 100
MAX_VIEW_ITEMS = 25
MAX_ACTION_ROWS = 5
BUTTONS_PER_ROW = 5
MESSAGE_CONTENT_LIMIT = 2000
CUSTOM_ID_LIMIT = 100

# Raw-REST component styles (discord.ButtonStyle values).
STYLE_PRIMARY = 1
STYLE_SECONDARY = 2
STYLE_SUCCESS = 3
STYLE_DANGER = 4

CUSTOM_ID_PREFIX = "dshr"
DEFAULT_PORT = 8790
# The configured port is a BASE. Every dsh process hosts its own bridge on the
# first free port of this window and the poller walks the same window, so
# concurrent sessions deliver without any coordination file (DECISIONS.md 11).
DEFAULT_PORT_SPAN = 20
MAX_PORT_SPAN = 64
PORT_SPAN_ENV = "DSH_RELAY_PORT_SPAN"

# What a port must answer on /v1/health to count as one of our bridges: a scan
# of a port window must never mean poking strangers' servers.
BRIDGE_IDENTITY = "dsh-bridge"
PROTOCOL_VERSION = 1
HEALTH_TIMEOUT = 1.0
DISCOVERY_TTL = 5.0

# Personal settings live in ONE config file that is never checked in (owner
# ruling 2026-10-06). No defaults for the channel or the owner: a second
# install can never inherit the first person's inbox. Every config failure
# quotes SETUP_HINT, naming the path the loader actually read.
CONFIG_PATH_ENV = "DSH_RELAY_CONFIG"          # path override; tests only
DEFAULT_CONFIG_PATH = "~/.config/dsh-discord-relay/config.json"
SECRET_FALLBACK_ENV = "DSH_RELAY_SECRET"      # ~/.hermes/.env fallback; the file wins
SETUP_HINT = (
    "Personal settings live in ONE config file (chmod 600, never committed):\n"
    "    ~/.config/dsh-discord-relay/config.json\n"
    '    {"channelId": "<discord channel id>", "ownerId": "<discord user id>",'
    ' "secret": "<shared relay secret>", "port": 8790,'
    ' "userAgent": "DiscordBot (https://example.com/dsh-discord-relay, 1.0)"}\n'
    "Copy config.example.json and replace every placeholder; channelId, ownerId\n"
    "and secret are required, port (8790) and userAgent optional. Both ids come\n"
    "from Discord with developer mode on: right-click the channel / your own\n"
    "avatar -> Copy ID. DSH_RELAY_CONFIG may point elsewhere (tests only); as a\n"
    "fallback the secret may also come from DSH_RELAY_SECRET in ~/.hermes/.env,"
    " but the file always wins."
)

# Cloudflare answers 1010 without a DiscordBot UA, so one is mandatory. The
# config file's "userAgent" key overrides this neutral replace-me placeholder.
DEFAULT_DISCORD_USER_AGENT = "DiscordBot (https://example.com/dsh-discord-relay, 1.0)"


def discord_user_agent(value: Optional[str] = None) -> str:
    """Discord REST User-Agent: the configured value when set, the placeholder otherwise."""
    return str(value or "").strip() or DEFAULT_DISCORD_USER_AGENT


# Neutral fallback constant; dev_main.py pushes the configured UA onto it.
DISCORD_USER_AGENT = DEFAULT_DISCORD_USER_AGENT


class ConfigError(RuntimeError):
    """The relay cannot run as configured; ``str(error)`` is the operator message."""


@dataclass
class RelayConfig:
    secret: str
    # No defaults: these two are supplied by load_config or it raises ConfigError.
    channel_id: int
    owner_id: int
    port: int = DEFAULT_PORT
    port_span: int = DEFAULT_PORT_SPAN
    scheme: str = "http"
    host: str = "127.0.0.1"
    poll_interval: float = 1.5
    user_agent: str = DEFAULT_DISCORD_USER_AGENT
    config_path: str = ""
    hermes_env_path: str = field(default_factory=lambda: os.path.expanduser("~/.hermes/.env"))
    # Request timeout for ordinary bridge calls; probes use HEALTH_TIMEOUT.
    timeout: float = 10.0

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"

    @property
    def window(self) -> str:
        return window_label(self)


def read_env_file(path: str) -> Dict[str, str]:
    """Parse a KEY=VALUE .env file (quotes stripped); tolerates comments."""
    values: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):].lstrip()
                key, _, raw = line.partition("=")
                key = key.strip()
                raw = raw.strip().strip('"').strip("'")
                if key:
                    values[key] = raw
    except OSError:
        pass
    return values


def _env_int(source: Dict[str, str], name: str, fallback: int) -> int:
    raw = str(source.get(name, "") or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def config_path(env: Optional[Dict[str, str]] = None) -> str:
    """Absolute path of the personal config file (DSH_RELAY_CONFIG overrides it)."""
    source = env if env is not None else os.environ
    raw = str(source.get(CONFIG_PATH_ENV, "") or "").strip()
    return os.path.expanduser(raw or DEFAULT_CONFIG_PATH)


def _read_config_json(path: str) -> Dict[str, Any]:
    """Parse the config file; missing or unparsable fails loud with SETUP_HINT."""
    if not os.path.exists(path):
        raise ConfigError(f"{path} does not exist.\n\n{SETUP_HINT}")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            conf = json.load(handle)
    except (OSError, ValueError) as error:  # ValueError covers JSONDecodeError
        raise ConfigError(f"{path} cannot be parsed as JSON: {error}\n\n{SETUP_HINT}") from error
    if not isinstance(conf, dict):
        raise ConfigError(f"{path} must contain a JSON object.\n\n{SETUP_HINT}")
    return conf


def _require_id(conf: Dict[str, Any], name: str, path: str) -> int:
    """A required Discord id (string or number) from the config file."""
    raw = str(conf.get(name, "") or "").strip()
    if not raw:
        raise ConfigError(f'{path} has no "{name}".\n\n{SETUP_HINT}')
    try:
        value = int(raw)
    except ValueError:
        value = -1
    if value <= 0:
        raise ConfigError(f'{path} "{name}"={raw!r} is not a Discord id (digits only).\n\n{SETUP_HINT}')
    return value


def _fallback_secret(source: Dict[str, str], hermes_env: str) -> str:
    """Secret fallback for a file without one: env, then ~/.hermes/.env; file wins."""
    secret = (source.get(SECRET_FALLBACK_ENV) or "").strip()
    if secret:
        return secret
    return read_env_file(hermes_env).get(SECRET_FALLBACK_ENV, "").strip()


def _positive_int(value: Any, fallback: int) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return fallback
    return number if number > 0 else fallback


def load_config(env: Optional[Dict[str, str]] = None,
                hermes_env: Optional[str] = None) -> RelayConfig:
    """Build the relay config from ONE personal JSON file (never checked in).

    ``channelId``/``ownerId``/``secret`` are required there — there is no
    shipped default for someone else's inbox — while ``port`` (8790, the base of
    the probe window), ``portSpan`` (20) and ``userAgent`` are optional. The secret alone also falls back to
    ``DSH_RELAY_SECRET`` (env, then the installer-owned ``~/.hermes/.env``);
    the file wins whenever it has one. Every gap raises ``ConfigError``
    naming the path and carrying ``SETUP_HINT``.
    """
    source = env if env is not None else dict(os.environ)
    path = config_path(source)
    conf = _read_config_json(path)
    secret = str(conf.get("secret") or "").strip()
    if not secret:
        secret = _fallback_secret(source, hermes_env or os.path.expanduser("~/.hermes/.env"))
    if not secret:
        raise ConfigError(f'{path} has no "secret" and no {SECRET_FALLBACK_ENV} fallback was found.\n\n{SETUP_HINT}')
    return RelayConfig(
        secret=secret,
        port=_positive_int(conf.get("port"), DEFAULT_PORT),
        port_span=clamp_span(source.get(PORT_SPAN_ENV) or conf.get("portSpan")),
        channel_id=_require_id(conf, "channelId", path),
        owner_id=_require_id(conf, "ownerId", path),
        user_agent=discord_user_agent(conf.get("userAgent")),
        config_path=path,
        poll_interval=float(_env_int(source, "DSH_RELAY_POLL_MS", 1500)) / 1000.0,
    )


# ---------------------------------------------------------------- text budgets
def clip(value: Any, limit: int) -> str:
    text = " ".join(str(value if value is not None else "").split())
    if len(text) <= limit:
        return text
    if limit <= 1:
        return text[:limit]
    return text[: limit - 1] + "\u2026"


# ---------------------------------------------------------------- custom_id codec
def encode_custom_id(token: str, action: str) -> str:
    """``dshr:<token>:<action>``; action is an option index or ``custom``."""
    custom_id = f"{CUSTOM_ID_PREFIX}:{token}:{action}"
    return custom_id[:CUSTOM_ID_LIMIT]


_CUSTOM_ID_RE = re.compile(rf"^{re.escape(CUSTOM_ID_PREFIX)}:([0-9a-zA-Z]{{1,24}}):(.+)$")


def decode_custom_id(custom_id: str) -> Optional[tuple[str, str]]:
    match = _CUSTOM_ID_RE.match(custom_id or "")
    if not match:
        return None
    return match.group(1), match.group(2)


# ---------------------------------------------------------------- bridge client
class BridgeError(RuntimeError):
    """A bridge call failed. ``status`` is the HTTP status when there was one,
    which is how a wrong secret (401, fix the config) is told apart from a
    process that exited (no status, drop the port)."""

    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def _request_json(method: str, url: str, payload: Optional[dict], headers: Dict[str, str],
                  timeout: float = 10.0) -> tuple[int, dict]:
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method=method,
                                     headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        status = error.code
    except OSError as error:  # connection refused / timeout => bridge down
        raise BridgeError(f"{method} {url}: {error}") from error
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError as error:
        raise BridgeError(f"{method} {url}: not json: {error}") from error
    return status, parsed if isinstance(parsed, dict) else {"data": parsed}


def bridge_headers(config: RelayConfig) -> Dict[str, str]:
    return {"x-relay-secret": config.secret}


def fetch_pending(config: RelayConfig) -> List[Dict[str, Any]]:
    """Blocking: questions awaiting an owner answer."""
    status, payload = _request_json("GET", f"{config.base_url}/v1/pending", None,
                                    bridge_headers(config), config.timeout)
    if status != 200:
        # The status travels with the error: a wrong secret (401) is a fixable
        # config mistake worth keeping the bridge cached for, while a dead or
        # foreign port is dropped from the window until it reappears.
        raise BridgeError(f"pending failed: HTTP {status} {payload.get('error')}", status=status)
    questions = payload.get("questions") or []
    return [q for q in questions if isinstance(q, dict) and q.get("token")]


def fetch_health(config: RelayConfig) -> Dict[str, Any]:
    status, payload = _request_json("GET", f"{config.base_url}/v1/health", None, {},
                                    config.timeout)
    if status != 200:
        raise BridgeError(f"health failed: HTTP {status}")
    return payload


def is_bridge(payload: Dict[str, Any]) -> bool:
    """True when a health answer came from a dsh relay bridge we may poll."""
    return (isinstance(payload, dict)
            and payload.get("relay") == BRIDGE_IDENTITY
            and int(payload.get("protocol") or 0) == PROTOCOL_VERSION)


# -------------------------------------------------------- bridge window discovery
def clamp_span(value: Any) -> int:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return DEFAULT_PORT_SPAN
    return min(MAX_PORT_SPAN, max(1, number))


def ports_to_try(config: RelayConfig) -> List[int]:
    """Every port a bridge of this setup may be listening on, base first."""
    span = clamp_span(getattr(config, "port_span", DEFAULT_PORT_SPAN))
    return [int(config.port) + offset for offset in range(span)]


def window_label(config: RelayConfig) -> str:
    """The port window in the shape both halves print (`127.0.0.1:8790-8809`)."""
    ports = ports_to_try(config)
    first = f"{config.host}:{ports[0]}"
    return first if len(ports) == 1 else f"{first}-{ports[-1]}"


def bridge_at(config: RelayConfig, port: int) -> RelayConfig:
    """The same setup, addressed at one port of the window."""
    return replace(config, port=int(port))


def _cache_key(config: RelayConfig) -> tuple:
    fingerprint = hashlib.sha256(config.secret.encode("utf-8")).hexdigest()[:12]
    return (config.host, int(config.port), clamp_span(config.port_span), fingerprint)


# Discovery results, keyed by _cache_key -> (expiry, live bridges). Process
# state only: nothing is written anywhere, so a restart re-probes the window.
_BRIDGE_CACHE: Dict[tuple, tuple[float, List[RelayConfig]]] = {}


def probe_bridge(config: RelayConfig, port: int) -> Optional[RelayConfig]:
    """Return the bridge at ``port`` if it identifies itself, else nothing.

    Only ``/v1/health`` is asked, and only a reply naming itself
    ``dsh-bridge`` on the matching protocol counts, so scanning the window
    cannot hand a stranger's port a secret or mistake one for a bridge.
    """
    probe = replace(bridge_at(config, port), timeout=HEALTH_TIMEOUT)
    try:
        return probe if is_bridge(fetch_health(probe)) else None
    except (BridgeError, OSError, ValueError):
        return None


def discover_bridges(config: RelayConfig,
                     cache: Optional[Dict[tuple, tuple[float, List[RelayConfig]]]] = None,
                     now: Optional[float] = None) -> List[RelayConfig]:
    """Every live bridge in the configured port window, base port first.

    Concurrent dsh processes each host a bridge and only one Hermes poller
    exists, so delivery means asking them all. Results are cached for
    ``DISCOVERY_TTL`` seconds because a loopback probe is cheap but 20 per poll
    would not be, and a newly started session is found within one TTL.
    """
    store = _BRIDGE_CACHE if cache is None else cache
    key = _cache_key(config)
    moment = time.monotonic() if now is None else now
    hit = store.get(key)
    if hit is not None and hit[0] > moment and hit[1]:
        return hit[1]
    alive = [bridge for bridge in _probe_window(config) if bridge is not None]
    store[key] = (moment + DISCOVERY_TTL, alive)
    return alive


def _probe_window(config: RelayConfig) -> List[Optional[RelayConfig]]:
    ports = ports_to_try(config)
    if len(ports) == 1:
        return [probe_bridge(config, ports[0])]
    with ThreadPoolExecutor(max_workers=min(len(ports), 8),
                            thread_name_prefix="dsh-relay-probe") as pool:
        return list(pool.map(lambda port: probe_bridge(config, port), ports))


def forget_bridge(config: RelayConfig, bridge: RelayConfig,
                  cache: Optional[Dict[tuple, tuple[float, List[RelayConfig]]]] = None) -> None:
    """Drop a bridge we thought was alive (its port answered, then stopped)."""
    store = _BRIDGE_CACHE if cache is None else cache
    key = _cache_key(config)
    hit = store.get(key)
    if hit is None:
        return
    alive = [entry for entry in hit[1] if entry.port != bridge.port]
    store[key] = (0.0 if len(alive) != len(hit[1]) else hit[0], alive)


def collect_pending(
        config: RelayConfig,
        cache: Optional[Dict[tuple, tuple[float, List[RelayConfig]]]] = None,
        errors: Optional[List[tuple]] = None,
) -> List[tuple[RelayConfig, Dict[str, Any]]]:
    """Pending questions of every live bridge, each paired with its bridge.

    The pair is what makes an answer routable: ``post_answer`` must address the
    process that owns the token, not the base port. A bridge that stops
    answering mid-poll is dropped from the cache and simply re-appears when it
    does.
    """
    found: List[tuple[RelayConfig, Dict[str, Any]]] = []
    for bridge in discover_bridges(config, cache=cache):
        try:
            for question in fetch_pending(bridge):
                found.append((bridge, question))
        except BridgeError as error:
            # A bridge that answers health but rejects the secret is a real
            # bridge with a wrong config; forgetting its port would turn a
            # fixable mistake into silence, which is the failure being removed.
            if getattr(error, "status", None) in (401, 403):
                if errors is not None:
                    errors.append((bridge, error))
                continue
            forget_bridge(config, bridge, cache=cache)
            if errors is not None:
                errors.append((bridge, error))
        except (OSError, ValueError) as error:
            forget_bridge(config, bridge, cache=cache)
            if errors is not None:
                errors.append((bridge, error))
    return found


def post_answer(config: RelayConfig, token: str, selected: List[str],
                custom: Optional[str] = None) -> Dict[str, Any]:
    """Blocking: deliver the owner's answer. Idempotent server-side."""
    status, payload = _request_json("POST", f"{config.base_url}/v1/answer",
                                    answer_body(token, selected, custom), bridge_headers(config),
                                    config.timeout)
    if status not in (200, 201):
        raise BridgeError(f"answer failed: HTTP {status} {payload.get('error')}", status=status)
    return payload


def answer_body(token: str, selected: List[str], custom: Optional[str]) -> Dict[str, Any]:
    """Exact bridge POST body for one owner response.

    ``custom`` is the typed answer (modal); ``selected`` the clicked option
    labels. The bridge decides override-vs-supplement from the question's
    multi_select flag, which only the dsh side knows.
    """
    body: Dict[str, Any] = {"token": token, "selected": [str(s) for s in selected]}
    text = (custom or "").strip()
    if text:
        body["custom"] = clip(text, 2000)
    return body


async def ahead(method, *args, **kwargs):
    """Run a blocking bridge helper off the event loop."""
    return await asyncio.to_thread(method, *args, **kwargs)


# ---------------------------------------------------------------- component builder
CUSTOM_ACTION = "custom"
SUBMIT_ACTION = "submit"
CUSTOM_BUTTON_LABEL = "Type your own answer"
SUBMIT_BUTTON_LABEL = "Submit selection"


def build_components(question: Dict[str, Any], disabled: bool = False,
                     chosen: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Action rows for one pending question, within Discord's budgets.

    Multiple choice is always clickable; a dedicated button opens a modal for
    free text. With ``multi_select`` an extra Submit button finalises the
    toggle set. Overflow options are dropped (never silently truncated labels
    that would make two buttons collide).
    """
    token = str(question.get("token") or "")
    multi = bool(question.get("multi_select"))
    reserve = 1 + (1 if multi else 0)
    raw_options = question.get("options") or []
    options = [o for o in raw_options if isinstance(o, dict) and str(o.get("label") or "").strip()]
    budget = min(MAX_VIEW_ITEMS - reserve, BUTTONS_PER_ROW * (MAX_ACTION_ROWS - 1))
    options = options[:max(budget, 0)]

    rows: List[Dict[str, Any]] = []

    def new_row() -> Dict[str, Any]:
        row: Dict[str, Any] = {"type": 1, "components": []}
        rows.append(row)
        return row

    row: Optional[Dict[str, Any]] = None

    def add_button(label: str, style: int, action: str, *, is_disabled: bool) -> None:
        nonlocal row
        if row is None or len(row["components"]) >= BUTTONS_PER_ROW:
            if len(rows) >= MAX_ACTION_ROWS:
                return
            row = new_row()
        row["components"].append({
            "type": 2,
            "style": style,
            "label": clip(label, BUTTON_LABEL_LIMIT),
            "custom_id": encode_custom_id(token, action),
            "disabled": bool(is_disabled),
        })

    marks = set(chosen or [])
    for index, option in enumerate(options):
        label = option["label"]
        shown = ("\u2713 " + label) if label in marks else label
        add_button(shown, STYLE_PRIMARY if index == 0 else STYLE_SECONDARY, str(index),
                   is_disabled=disabled)
    if multi:
        add_button(SUBMIT_BUTTON_LABEL, STYLE_SUCCESS, SUBMIT_ACTION, is_disabled=disabled or not options)
    add_button(CUSTOM_BUTTON_LABEL, STYLE_SECONDARY, CUSTOM_ACTION, is_disabled=disabled)

    return [r for r in rows if r["components"]]


def stamped_content(question: Dict[str, Any], owner_id: int, answer_text: str,
                    prefix: str = "") -> str:
    """Message body after resolution: original ask + the owner's answer."""
    return message_content(question, owner_id, prefix=prefix) + f"\n\u2705 **Answered:** {answer_text}"


def message_content(question: Dict[str, Any], owner_id: int, prefix: str = "") -> str:
    """Message body for a pending question; MUST contain the literal owner tag."""
    header = clip(question.get("header") or "", 60)
    body = clip(question.get("question") or "(no question text)", MESSAGE_CONTENT_LIMIT - 200)
    parts = [f"<@{owner_id}>"]
    if prefix:
        parts.insert(0, prefix)
    if header:
        parts.append(f"**{header}**")
    parts.append(body)
    options = question.get("options") or []
    if question.get("multi_select") and options:
        parts.append("_Select every option that applies, then press Submit._")
    text = "\n".join(parts)
    return text[:MESSAGE_CONTENT_LIMIT]


def answer_to_text(selected: List[str], custom: Optional[str]) -> str:
    """Human rendering of an owner response for the Discord echo."""
    chosen = [s for s in selected if s]
    typed = (custom or "").strip()
    if chosen and typed:
        return "; ".join(chosen) + f" (+ typed: {typed})"
    if typed:
        return typed
    return "; ".join(chosen) or "(empty)"


# ------------------------------------------------------------ zcode relay events
#
# The zcode half of the relay (GH-1868 step 5, DECISIONS.md §13) puts the run's
# progress and its one terminal outcome on the same authenticated 127.0.0.1
# bridge the questions already use, so this poller drains them alongside
# `/v1/pending`. Three rules the rendering below enforces, straight from the
# invariants:
#
#   - M6: only `ok is True` renders as completed. A terminal event with a
#     missing, absent or non-boolean `ok` is an unverified outcome and is shown
#     as a failure — a progress line, a truncated stream or a heartbeat-only
#     stall can never read as success here either.
#   - M9: everything is labelled with the job it belongs to, and an event id is
#     only ever posted once per bridge, so a redelivered queue entry cannot
#     print a second "completed".
#   - Bounded: progress is coalesced into one message per poll and clipped;
#     a chatty worker cannot flood the channel.
EVENT_PROGRESS = "progress"
EVENT_TERMINAL = "terminal"
MAX_EVENT_BATCH = 40
PROGRESS_COALESCE_LIMIT = 8
PROGRESS_LINE_LIMIT = 200

#: job key -> set of event ids already delivered (process state, bounded).
_EVENT_SEEN: Dict[str, set] = {}
_EVENT_SEEN_MAX = 400


def fetch_events(config: RelayConfig, after: int = 0,
                 limit: int = MAX_EVENT_BATCH) -> Dict[str, Any]:
    """Blocking: relay events with ``seq > after`` from one bridge."""
    url = f"{config.base_url}/v1/events?after={int(after)}&limit={int(limit)}"
    status, payload = _request_json("GET", url, None, bridge_headers(config), config.timeout)
    if status != 200:
        raise BridgeError(f"events failed: HTTP {status} {payload.get('error')}", status=status)
    events = payload.get("events")
    if not isinstance(events, list):
        raise BridgeError("events failed: malformed payload", status=status)
    return {
        "events": [e for e in events if isinstance(e, dict)],
        "max_seq": int(payload.get("max_seq") or payload.get("maxSeq") or after),
        "job_id": str(payload.get("job_id") or payload.get("jobId") or ""),
    }


def cursor_key(bridge: RelayConfig) -> tuple:
    return (bridge.host, int(bridge.port))


def collect_events(
        config: RelayConfig,
        cursors: Dict[tuple, int],
        cache: Optional[Dict[tuple, tuple[float, List[RelayConfig]]]] = None,
        errors: Optional[List[tuple]] = None,
) -> List[tuple[RelayConfig, Dict[str, Any]]]:
    """Every new relay event of every live bridge, each paired with its bridge.

    The cursor advances only after the events were handed back, so a poll that
    dies mid-delivery re-reads the same events instead of losing the outcome.
    """
    found: List[tuple[RelayConfig, Dict[str, Any]]] = []
    for bridge in discover_bridges(config, cache=cache):
        key = cursor_key(bridge)
        after = cursors.get(key, 0)
        try:
            batch = fetch_events(bridge, after=after)
        except BridgeError as error:
            # 404 = a bridge too old to know about events: normal, not an error
            # worth logging every poll and not a reason to forget the port.
            if getattr(error, "status", None) == 404:
                continue
            if getattr(error, "status", None) in (401, 403):
                if errors is not None:
                    errors.append((bridge, error))
                continue
            forget_bridge(config, bridge, cache=cache)
            if errors is not None:
                errors.append((bridge, error))
            continue
        except (OSError, ValueError) as error:
            forget_bridge(config, bridge, cache=cache)
            if errors is not None:
                errors.append((bridge, error))
            continue
        events = batch["events"]
        if events:
            cursors[key] = max([after] + [int(e.get("seq") or 0) for e in events])
        for event in events:
            found.append((bridge, event))
    return found


def already_delivered(event: Dict[str, Any]) -> bool:
    """True when this exact event has been posted before (per job, bounded)."""
    job = str(event.get("job_id") or event.get("jobId") or "")
    event_id = str(event.get("id") or "")
    if job == "" or event_id == "":
        return False
    seen = _EVENT_SEEN.setdefault(job, set())
    if event_id in seen:
        return True
    seen.add(event_id)
    if len(seen) > _EVENT_SEEN_MAX:
        _EVENT_SEEN[job] = set(list(seen)[-_EVENT_SEEN_MAX:])
    return False


def forget_job(job_id: str) -> None:
    _EVENT_SEEN.pop(str(job_id), None)


def is_success(event: Dict[str, Any]) -> bool:
    """M6: exactly boolean True, and only on a terminal event."""
    return (str(event.get("kind") or "") == EVENT_TERMINAL
            and event.get("ok") is True
            and str(event.get("reason") or "") in ("", "null", "None"))


def render_event_text(event: Dict[str, Any], owner_id: Optional[int] = None) -> Optional[str]:
    """The channel line for one event, or None when it must not be posted.

    Never a guess: an unrecognised kind is dropped rather than invented, and a
    terminal event whose outcome was not verified reads as a failure.
    """
    kind = str(event.get("kind") or "")
    job = str(event.get("job_id") or event.get("jobId") or "job")
    session = str(event.get("session_id") or event.get("sessionId") or "")
    label = f"`{job}`" + (f" · `{session}`" if session else "")
    body = clip(str(event.get("text") or "").strip(), PROGRESS_LINE_LIMIT)

    if kind == EVENT_PROGRESS:
        if body == "":
            return None
        return f"⏳ zcode {label} — {body}"

    if kind == EVENT_TERMINAL:
        reason = str(event.get("reason") or "")
        if is_success(event):
            return f"✅ zcode {label} completed — {body}"
        verdict = reason if reason not in ("", "null", "None") else "unverified_outcome"
        return f"❌ zcode {label} FAILED ({verdict}) — {body}"

    return None


def coalesce_progress(events: List[Dict[str, Any]], owner_id: Optional[int] = None) -> Optional[str]:
    """One message for a run of progress lines from the same job."""
    lines: List[str] = []
    for event in events[:PROGRESS_COALESCE_LIMIT]:
        text = render_event_text(event, owner_id)
        if text is not None:
            lines.append(text)
    if not lines:
        return None
    if len(events) > PROGRESS_COALESCE_LIMIT:
        lines.append(f"… {len(events) - PROGRESS_COALESCE_LIMIT} more progress lines suppressed")
    return "\n".join(lines)[:MESSAGE_CONTENT_LIMIT]
