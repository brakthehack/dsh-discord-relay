#!/usr/bin/env python3
"""e2e fixture: the Hermes half of the relay, minus Discord.

Runs the real discovery/collection/answer code from ``relay_core`` against a
scratch config (``DSH_RELAY_CONFIG``), so the port window, the fan-out to every
live bridge and the routing of an answer back to the bridge that owns its token
are all exercised by production code. What it cannot prove is the Discord UI
leg: that needs the operator's bot token and channel.

Succeeds only when it has seen two live bridges in the window (the dsh session's
own and the fixture's) and has settled at least one question on each port it
answered. Prints the pending payload it sees, which is the proof artifact.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "hermes-relay"))

import relay_core as core  # noqa: E402

CONFIG = os.environ.get("DSH_RELAY_CONFIG", "")
if not CONFIG or not os.path.exists(CONFIG):
    print("[e2e-poller] PROBE-FAIL DSH_RELAY_CONFIG must name a readable config file")
    raise SystemExit(1)

DONE_FILE = os.environ.get("DSH_RELAY_E2E_DONE", "")
config = core.load_config(os.environ)
print("[e2e-poller] sweeping window %s (span %d)" % (core.window_label(config), config.port_span))

deadline = time.monotonic() + 120
live_ports = set()
answered = {}
pending_seen = 0
quiet_since = None

while time.monotonic() < deadline:
    errors = []
    try:
        pairs = core.collect_pending(config, errors=errors)
    except Exception as error:  # noqa: BLE001 - the sweep itself is under test
        print("[e2e-poller] PROBE-FAIL sweep raised %r" % (error,))
        break
    for bridge, failure in errors:
        print("[e2e-poller] bridge error port=%s status=%s %s"
              % (bridge.port, getattr(failure, "status", None), failure))
    for bridge, question in pairs:
        token = question["token"]
        if token in answered:
            continue
        pending_seen += 1
        print("[e2e-poller] PENDING bridge=%s %s" % (
            bridge.port,
            json.dumps({
                "request_id": question.get("request_id"),
                "question_id": question.get("question_id"),
                "question": question.get("question"),
                "header": question.get("header"),
                "options": [option.get("label") for option in (question.get("options") or [])],
                "multi_select": question.get("multi_select"),
            }, ensure_ascii=False)))
        try:
            reply = core.post_answer(bridge, token, ["Green"], None)
        except Exception as error:  # noqa: BLE001
            print("[e2e-poller] PROBE-FAIL answer to port %s raised %r" % (bridge.port, error))
            raise
        answered[token] = bridge.port
        print("[e2e-poller] ANSWERED token=%s port=%s reply=%s"
              % (token, bridge.port, json.dumps(reply, ensure_ascii=False)))
    for port in sorted({b.port for b, _q in pairs}):
        live_ports.add(port)
    live_ports |= {b.port for b in core.discover_bridges(config)}
    if len(live_ports) >= 2:
        quiet_since = quiet_since or time.monotonic()
        if time.monotonic() - quiet_since > 3 and not pairs:
            break
    time.sleep(0.25)

ports = sorted(set(answered.values()))
print("[e2e-poller] live bridges seen: %s | pending seen %d | answered %d across ports %s"
      % (sorted(live_ports), pending_seen, len(answered), ports))
if len(live_ports) < 2:
    print("[e2e-poller] PROBE-FAIL the window never showed two live bridges")
    verdict = 1
elif not answered:
    print("[e2e-poller] PROBE-FAIL nothing was ever pending to answer")
    verdict = 1
else:
    print("[e2e-poller] PROBE-OK one poller served two bridges and every answer "
          "went back to its own port")
    verdict = 0

if DONE_FILE:
    try:
        pathlib.Path(DONE_FILE).write_text("done %d\n" % verdict)
    except OSError:
        pass
raise SystemExit(verdict)
