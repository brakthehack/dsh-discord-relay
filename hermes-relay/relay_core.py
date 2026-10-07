"""dsh-discord-relay shared logic (Hermes half).

Pure stdlib. Holds everything that must agree with the dsh bridge: the wire
client, the ``custom_id`` codec, Discord component-budget helpers, and the
builder that turns a pending question into message components. The discord.py
plugin (``__init__.py``) and the gateway-free dev runner (``dev_main.py``) both
go through here so the two halves cannot drift.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
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
    scheme: str = "http"
    host: str = "127.0.0.1"
    poll_interval: float = 1.5
    user_agent: str = DEFAULT_DISCORD_USER_AGENT
    config_path: str = ""
    hermes_env_path: str = field(default_factory=lambda: os.path.expanduser("~/.hermes/.env"))

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"


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
    shipped default for someone else's inbox — while ``port`` (8790) and
    ``userAgent`` are optional. The secret alone also falls back to
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
    pass


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
    status, payload = _request_json("GET", f"{config.base_url}/v1/pending", None, bridge_headers(config))
    if status != 200:
        raise BridgeError(f"pending failed: HTTP {status} {payload.get('error')}")
    questions = payload.get("questions") or []
    return [q for q in questions if isinstance(q, dict) and q.get("token")]


def fetch_health(config: RelayConfig) -> Dict[str, Any]:
    status, payload = _request_json("GET", f"{config.base_url}/v1/health", None, {})
    if status != 200:
        raise BridgeError(f"health failed: HTTP {status}")
    return payload


def post_answer(config: RelayConfig, token: str, selected: List[str],
                custom: Optional[str] = None) -> Dict[str, Any]:
    """Blocking: deliver the owner's answer. Idempotent server-side."""
    status, payload = _request_json("POST", f"{config.base_url}/v1/answer",
                                    answer_body(token, selected, custom), bridge_headers(config))
    if status not in (200, 201):
        raise BridgeError(f"answer failed: HTTP {status} {payload.get('error')}")
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
