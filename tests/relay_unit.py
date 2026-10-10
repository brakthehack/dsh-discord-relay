"""Gate: relay-side unit checks (no gateway, no network).

Needs an interpreter that carries discord.py 2.7.x. Two ways to get one:

    python3 tests/relay_unit.py                      # if discord.py is importable as-is
    HERMES_VENV=<path to a venv with discord.py> \\
        python3 tests/relay_unit.py                   # dev convenience: site-packages of
                                                     # that venv is appended to sys.path
"""

from __future__ import annotations

import dataclasses
import glob as _glob
import importlib.util
import json
import os
import sys

import pathlib as _pathlib
REPO = str(_pathlib.Path(__file__).resolve().parent.parent)
PKG = REPO + "/hermes-relay"
sys.path.insert(0, PKG)


def _import_discord():
    """Import discord.py, using the venv named by HERMES_VENV when needed.

    discord.py is a runtime dependency of the Hermes gateway, not of this repo.
    A dev convenience: HERMES_VENV points at a checkout's virtualenv, and this
    gate either finds its site-packages on sys.path or re-execs into its
    interpreter (needed when the current interpreter is too new for discord.py).
    """
    try:
        return __import__("discord")
    except ImportError:
        pass
    venv = (os.environ.get("HERMES_VENV") or "").strip()
    if venv:
        for site in sorted(_glob.glob(os.path.join(venv, "lib", "python3.*", "site-packages"))):
            if os.path.isdir(site) and site not in sys.path:
                sys.path.append(site)
        try:
            return __import__("discord")
        except ImportError:
            pass
        interpreter = os.path.join(venv, "bin", "python3")
        if os.path.exists(interpreter) and not os.environ.get("DSH_RELAY_TEST_REEXEC"):
            os.environ["DSH_RELAY_TEST_REEXEC"] = "1"
            os.execv(interpreter, [interpreter] + sys.argv)
    raise SystemExit(
        "tests/relay_unit.py needs discord.py 2.7.x. Run it with that interpreter, or set\n"
        "HERMES_VENV=<path to the virtualenv that has it>."
    )


import relay_core as core

discord = _import_discord()

spec = importlib.util.spec_from_file_location(
    "dsh_discord_relay", PKG + "/__init__.py", submodule_search_locations=[PKG])
plugin = importlib.util.module_from_spec(spec)
sys.modules["dsh_discord_relay"] = plugin
spec.loader.exec_module(plugin)

FAILURES = []


def check(label, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + label + ((" | " + str(detail)) if detail else ""))
    if not ok:
        FAILURES.append(label)


TOKEN = "abc123def456"
QUESTION = {
    "token": TOKEN,
    "question_id": "colour",
    "question": "Which colours apply to the banner?",
    "header": "Banner",
    "options": [{"label": "Red", "description": "warm"}, {"label": "Green"}, {"label": "Blue"}],
    "multi_select": True,
    "created_at_ms": 1,
}

check("discord.py version is 2.7.x", discord.__version__.startswith("2.7"), discord.__version__)
PromptView, AnswerModal, DisabledView = plugin._build_ui(discord)

prompt = plugin.Prompt(token=TOKEN, question=QUESTION, multi=True, message=None, view=None)
runner_stub = object()
view = PromptView(runner_stub, prompt)
modal = AnswerModal(runner_stub, prompt)

flat = [c for row in core.build_components(QUESTION) for c in row["components"]]
check("view buttons match core.build_components",
      [c.label for c in view.children] == [c["label"] for c in flat],
      [c.label for c in view.children])
check("every button carries a callback", all(c.callback is not None for c in view.children))
check("custom_ids are dshr-prefixed with the token",
      all(c.custom_id.startswith("dshr:" + TOKEN + ":") for c in view.children),
      [c.custom_id for c in view.children])
check("view never times out", view.timeout is None and view.is_finished() is False)
ti = modal.children[0] if modal.children else None
check("modal has one required TextInput(1000)",
      len(modal.children) == 1 and isinstance(ti, discord.ui.TextInput)
      and ti.required is True and ti.max_length == 1000,
      getattr(ti, "max_length", None))
check("modal custom_id is the token modal id",
      modal.custom_id == core.encode_custom_id(TOKEN, "modal"), modal.custom_id)
check("modal never times out", modal.timeout is None)

dview = DisabledView(QUESTION, ["Green"])
check("stamped view disables every button",
      len(dview.children) == len(flat) and all(c.disabled for c in dview.children))
check("stamped view marks the chosen option",
      any(c.label.startswith("✓ ") and "Green" in c.label for c in dview.children),
      [c.label for c in dview.children])

single = dict(QUESTION, multi_select=False)
first = core.build_components(single)[0]["components"][0]
action = core.decode_custom_id(first["custom_id"])[1]
label = single["options"][int(action)]["label"]
body = core.answer_body(TOKEN, [label], None)
check("single click -> exact bridge body", body == {"token": TOKEN, "selected": ["Red"]},
      json.dumps(body))
check("no empty custom key in body", "custom" not in body)

custom_body = core.answer_body(TOKEN, [], " ship it ")
check("modal submit -> exact bridge body",
      custom_body == {"token": TOKEN, "selected": [], "custom": "ship it"}, json.dumps(custom_body))
check("custom_id round-trips actions",
      core.decode_custom_id(core.encode_custom_id(TOKEN, "submit")) == (TOKEN, "submit"))
check("foreign custom_id is rejected", core.decode_custom_id("other:1:2") is None)
check("custom_id stays under the 100 char cap",
      max(len(c["custom_id"]) for c in flat) <= core.CUSTOM_ID_LIMIT,
      max(len(c["custom_id"]) for c in flat))

multi30 = {"token": TOKEN, "question_id": "big", "question": "Pick many",
           "options": [{"label": "opt-%d" % i} for i in range(30)], "multi_select": True}
rows30 = core.build_components(multi30)
items30 = [c for row in rows30 for c in row["components"]]
labels30 = [c["label"] for c in items30]
check("multi 30 options: <=5 rows", len(rows30) <= 5, len(rows30))
check("multi 30 options: <=5 buttons per row",
      all(len(r["components"]) <= 5 for r in rows30), [len(r["components"]) for r in rows30])
check("multi 30 options: <=25 items", len(items30) <= 25, len(items30))
check("multi 30 options keep submit + custom",
      core.SUBMIT_BUTTON_LABEL in labels30 and core.CUSTOM_BUTTON_LABEL in labels30)

single30 = dict(multi30, multi_select=False)
items30s = [c for row in core.build_components(single30) for c in row["components"]]
labels30s = [c["label"] for c in items30s]
check("single 30 options: custom but no submit",
      core.CUSTOM_BUTTON_LABEL in labels30s and core.SUBMIT_BUTTON_LABEL not in labels30s)
check("single 30 options fit the 25 item cap", len(items30s) <= 25, len(items30s))

nobody = {"token": TOKEN, "question_id": "none", "question": "Just type it",
          "options": [], "multi_select": False}
items_nb = [c for row in core.build_components(nobody) for c in row["components"]]
check("no options -> only the custom button",
      [c["label"] for c in items_nb] == [core.CUSTOM_BUTTON_LABEL], [c["label"] for c in items_nb])

# Fake ids only: this suite must never depend on a real channel or a real person.
OWNER = 222222222222222222
CHANNEL = 111111111111111111

long_q = dict(QUESTION, question="x" * 5000)
content = core.message_content(long_q, OWNER)
check("message content <= 2000", len(content) <= 2000, len(content))
check("owner tag is literal", ("<@%d>" % OWNER) in content)
answer_text = core.answer_to_text(["Green"], None)
stamped = core.stamped_content(QUESTION, OWNER, answer_text)
check("stamped content <= 2000", len(stamped) <= 2000, len(stamped))
check("stamped content shows the answer", "Green" in stamped and "✅" in stamped,
      stamped.splitlines()[-1])
check("multi hint explains Submit",
      "press submit" in core.message_content(QUESTION, OWNER).lower())
check("single hint has no Submit line",
      "press submit" not in core.message_content(single, OWNER).lower())

import json
import os
import subprocess
import tempfile

_CFG_TMP = tempfile.mkdtemp(prefix="dshr-cfg-")
_NO_HERMES = os.path.join(_CFG_TMP, "no-hermes.env")  # absent: no secret fallback


def _fixture(name, obj=None, raw=None):
    """Write a config fixture and return its path (no content -> path stays absent)."""
    path = os.path.join(_CFG_TMP, name)
    if obj is None and raw is None:
        return path  # deliberately not written
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(raw if raw is not None else json.dumps(obj))
    return path


def _load(path, env=None):
    e = {"DSH_RELAY_CONFIG": path}
    e.update(env or {})
    return core.load_config(e, hermes_env=_NO_HERMES)


def _load_error(name, obj=None, raw=None, env=None):
    """ConfigError message from loading fixture `name`, or None if it loaded."""
    try:
        _load(_fixture(name, obj, raw), env)
    except core.ConfigError as error:
        return str(error)
    return None


# One personal config file is the ruling: both halves read it, nothing else is
# required. Fake ids only, real ones never appear here.
_GOOD = _fixture("good.json", {"channelId": str(CHANNEL), "ownerId": str(OWNER),
                               "secret": "s3cret", "port": 9999,
                               "userAgent": "DiscordBot (https://example.test, 1.0)"})
cfg = _load(_GOOD)
check("config file wiring",
      (cfg.secret, cfg.port, cfg.channel_id, cfg.owner_id) == ("s3cret", 9999, CHANNEL, OWNER),
      (cfg.port, cfg.channel_id, cfg.owner_id))
check("config userAgent wins", cfg.user_agent == "DiscordBot (https://example.test, 1.0)",
      cfg.user_agent)
check("bridge headers carry the secret",
      core.bridge_headers(cfg).get("x-relay-secret") == "s3cret")

missing_msg = _load_error("absent.json")
check("missing config file fails loud, naming the path with the hint",
      missing_msg is not None and "absent.json" in missing_msg
      and missing_msg.count("developer mode") == 1)
check("an unparsable config file fails loud with the hint",
      (_load_error("bad.json", raw="{not json") or "").count("developer mode") == 1)
check("channelId is required in the file and prints the setup hint",
      (_load_error("nochan.json", {"ownerId": str(OWNER), "secret": "s"})
       or "").count("developer mode") == 1)
check("ownerId is required in the file and prints the setup hint",
      (_load_error("noown.json", {"channelId": str(CHANNEL), "secret": "s"})
       or "").count("developer mode") == 1)
check("the secret is required (file or fallback) and prints the setup hint",
      (_load_error("nosec.json", {"channelId": str(CHANNEL), "ownerId": str(OWNER)})
       or "").count("developer mode") == 1)
check("a non-numeric channelId is refused with the hint",
      (_load_error("badchan.json",
                   {"channelId": "not-a-channel-id", "ownerId": str(OWNER), "secret": "s"})
       or "").count("developer mode") == 1)

check("the file secret wins over the env fallback",
      _load(_GOOD, {"DSH_RELAY_SECRET": "env-wins-not"}).secret == "s3cret")
check("DSH_RELAY_SECRET still serves as a fallback",
      _load(_fixture("nofile-secret.json",
                     {"channelId": str(CHANNEL), "ownerId": str(OWNER)}),
            {"DSH_RELAY_SECRET": "envsecret"}).secret == "envsecret")
_bare = _fixture("bare.json", {"channelId": str(CHANNEL), "ownerId": str(OWNER), "secret": "s"})
check("port defaults to 8790 without a port key", _load(_bare).port == core.DEFAULT_PORT,
      _load(_bare).port)
check("default User-Agent is a neutral DiscordBot placeholder",
      _load(_bare).user_agent.startswith("DiscordBot (https://")
      and "github.com" not in _load(_bare).user_agent, _load(_bare).user_agent)
check("no personal channel/owner defaults are exported",
      not hasattr(core, "DEFAULT_CHANNEL_ID") and not hasattr(core, "DEFAULT_OWNER_ID"))
check("discord_user_agent trims a value and falls back to the placeholder",
      core.discord_user_agent(" DiscordBot (https://a, 1) ") == "DiscordBot (https://a, 1)"
      and core.discord_user_agent(None) == core.DEFAULT_DISCORD_USER_AGENT)
check("answer_to_text joins selection and note",
      core.answer_to_text(["Red", "Green"], "extra") == "Red; Green (+ typed: extra)",
      core.answer_to_text(["Red", "Green"], "extra"))
# The bridge normalises single-select custom answers to selected=[] (see
# src/bridge.js), so the echo receives the typed text alone.
check("echo renders a normalised single-select answer",
      core.answer_to_text([], "z.ts") == "z.ts", core.answer_to_text([], "z.ts"))

# dshProfile names the profile the launch wrapper starts. It is a personal
# choice, so relay_core must neither require it nor be disturbed by it.
_profile_cfg = _fixture("profile.json", {"channelId": str(CHANNEL), "ownerId": str(OWNER),
                                         "secret": "s3cret", "port": 9999,
                                         "dshProfile": "some-operators-choice"})
check("dshProfile is optional and ignored by the relay config",
      _load(_profile_cfg).port == 9999 and not hasattr(_load(_profile_cfg), "profile"),
      _load(_profile_cfg).port)

# The wrapper's profile precedence is pure shell, so test it by running it with
# a stub `dsh` on PATH: config file dshProfile > DSH_RELAY_PROFILE > headless.
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_STUB_DIR = os.path.join(_CFG_TMP, "stubbin")
os.makedirs(_STUB_DIR, exist_ok=True)
# The stub only reports how it was called, so the assertions can see the profile
# the wrapper chose. ($* unquoted is enough: the fixture args are single tokens.)
with open(os.path.join(_STUB_DIR, "dsh"), "w", encoding="utf-8") as handle:
    handle.write("#!/usr/bin/env bash" + chr(10) + "echo dsh $*" + chr(10))
os.chmod(os.path.join(_STUB_DIR, "dsh"), 0o755)


def _wrapper(*args, **extra):
    """Run bin/dsh-relay in a clean HOME and return its stdout."""
    env = {key: value for key, value in os.environ.items() if key != "DSH_RELAY_PROFILE"}
    env.update(HOME=_CFG_TMP, PATH=_STUB_DIR + os.pathsep + env.get("PATH", ""))
    env.update(extra)
    run = subprocess.run(["bash", os.path.join(_REPO, "bin", "dsh-relay"), *args],
                         env=env, capture_output=True, text=True, check=True)
    return run.stdout.strip()


def _invoked(**extra):
    """What the stub dsh reports for one wrapper run."""
    return _wrapper("task", **extra)


check("wrapper: the config file's dshProfile wins over the env",
      _invoked(**{"DSH_RELAY_CONFIG": _profile_cfg,
                  "DSH_RELAY_PROFILE": "env-profile"})
      == "dsh --profile some-operators-choice task")
check("wrapper: DSH_RELAY_PROFILE applies when the file has no dshProfile",
      _invoked(**{"DSH_RELAY_CONFIG": _bare, "DSH_RELAY_PROFILE": "env-profile"})
      == "dsh --profile env-profile task")
check("wrapper: headless is the default when neither is set",
      _invoked(**{"DSH_RELAY_CONFIG": os.path.join(_CFG_TMP, "none.json")})
      == "dsh --profile headless task")

# ---------------------------------------------------------------------------
# One poller, many bridges (finding 3): window arithmetic, discovery, fan-out.
# ---------------------------------------------------------------------------
_WINDOW = _load(_fixture("window.json", {"channelId": str(CHANNEL), "ownerId": str(OWNER),
                                         "secret": "s", "portSpan": 3}))
check("portSpan comes from the config file", _WINDOW.port_span == 3, _WINDOW.port_span)
check("DSH_RELAY_PORT_SPAN overrides the file",
      _load(_fixture("window.json"), {"DSH_RELAY_PORT_SPAN": "5"}).port_span == 5)
check("a junk portSpan falls back to the default window",
      _load(_fixture("spanjunk.json", {"channelId": str(CHANNEL), "ownerId": str(OWNER),
                                       "secret": "s", "portSpan": "very wide"})).port_span
      == core.DEFAULT_PORT_SPAN)
check("ports_to_try walks the configured window",
      core.ports_to_try(_WINDOW) == [8790, 8791, 8792], core.ports_to_try(_WINDOW))
check("window_label names the whole window",
      core.window_label(_WINDOW) == "127.0.0.1:8790-8792", core.window_label(_WINDOW))
check("window_label collapses a span of one",
      core.window_label(dataclasses.replace(_WINDOW, port_span=1)) == "127.0.0.1:8790")
check("clamp_span caps a runaway window", core.clamp_span(9999) == core.MAX_PORT_SPAN)
check("clamp_span keeps at least one port", core.clamp_span(0) == 1)
check("health from a foreign server is not a bridge", not core.is_bridge({"ok": True}))
check("a matching relay bridge is a bridge",
      core.is_bridge({"ok": True, "relay": core.BRIDGE_IDENTITY, "protocol": core.PROTOCOL_VERSION}))
check("a future protocol version is not ours to poll",
      not core.is_bridge({"relay": core.BRIDGE_IDENTITY, "protocol": core.PROTOCOL_VERSION + 1}))

_PROBES = []


def _fake_health(config):
    """Ports 8790/8791 answer the health probe; everything else is dead or foreign."""
    _PROBES.append(config.port)
    if config.port in (8790, 8791):
        return {"ok": True, "relay": core.BRIDGE_IDENTITY, "protocol": core.PROTOCOL_VERSION,
                "port": config.port}
    raise core.BridgeError("connect failed: connection refused")


_REAL_HEALTH = core.fetch_health
_REAL_PENDING = core.fetch_pending
try:
    core.fetch_health = _fake_health
    _cache = {}
    _bridges = core.discover_bridges(_WINDOW, cache=_cache, now=100.0)
    check("discovery keeps only ports that identify themselves as relay bridges",
          [b.port for b in _bridges] == [8790, 8791], [b.port for b in _bridges])

    _PROBES.clear()
    core.discover_bridges(_WINDOW, cache=_cache, now=101.0)
    check("discovery is cached inside the TTL (no re-probe per poll)", _PROBES == [], _PROBES)
    core.discover_bridges(_WINDOW, cache=_cache, now=100.0 + core.DISCOVERY_TTL + 1)
    check("discovery re-probes once the cache ages out", len(_PROBES) == 3, len(_PROBES))

    def _two_pending(config):
        return [{"token": "t%d" % (config.port - 8790), "question_id": "q1",
                 "question": "asked on port %d" % config.port}]

    core.fetch_pending = _two_pending
    _errors = []
    _pairs = core.collect_pending(_WINDOW, cache=_cache, errors=_errors)
    check("every bridge's questions are collected, not just the first port's",
          sorted(q["question"] for _, q in _pairs)
          == ["asked on port 8790", "asked on port 8791"], _pairs)
    check("each question is paired with the bridge that owns it",
          sorted((b.port, q["token"]) for b, q in _pairs) == [(8790, "t0"), (8791, "t1")], _pairs)
    check("a healthy sweep reports no per-bridge errors", _errors == [], _errors)
    check("answers travel back to the owning port",
          core.bridge_at(_WINDOW, 8791).base_url == "http://127.0.0.1:8791",
          core.bridge_at(_WINDOW, 8791).base_url)
    check("a question record carries the bridge it came from",
          "bridge" in [field.name for field in dataclasses.fields(plugin.Prompt)])

    def _wrong_secret_on_8791(config):
        if config.port == 8791:
            raise core.BridgeError("pending failed: HTTP 401 unauthorized", status=401)
        return _two_pending(config)

    core.fetch_pending = _wrong_secret_on_8791
    _errors = []
    _pairs = core.collect_pending(_WINDOW, cache=_cache, errors=_errors)
    check("a wrong secret is reported instead of silently skipping that bridge",
          len(_errors) == 1 and _errors[0][0].port == 8791
          and getattr(_errors[0][1], "status", None) == 401, _errors)
    check("a bridge we cannot auth against stays cached (it is ours; fix the secret)",
          [b.port for b in core.discover_bridges(_WINDOW, cache=_cache, now=102.0)]
          == [8790, 8791])

    _errors = []
    core.fetch_pending = lambda config: (_ for _ in ()).throw(
        core.BridgeError("pending failed: HTTP 404 no_route"))
    _pairs = core.collect_pending(_WINDOW, cache=_cache, errors=_errors)
    check("a bridge that stops serving questions is dropped from the cache",
          _pairs == [] and len(_errors) == 2, (_pairs, _errors))
    _PROBES.clear()
    core.discover_bridges(_WINDOW, cache=_cache, now=103.0)
    check("dropped bridges are re-probed on the next poll", len(_PROBES) >= 3, len(_PROBES))
finally:
    core.fetch_health = _REAL_HEALTH
    core.fetch_pending = _REAL_PENDING

with open(PKG + "/plugin.yaml", encoding="utf-8") as handle:
    _manifest = handle.read()
_declared = [line.strip() for line in _manifest.splitlines()
             if line.strip().startswith("capabilities:") and not line.lstrip().startswith("#")]
check("the manifest declares an explicitly empty capability list",
      _declared == ["capabilities: []"], _declared)
check("the manifest says why the capability list is empty",
      "DECISIONS.md" in _manifest, "the deny line must be explained in-repo")

print()
if FAILURES:
    print("%d check(s) failed: %s" % (len(FAILURES), FAILURES))
    raise SystemExit(1)
print("all relay_core / discord.py UI checks passed")
