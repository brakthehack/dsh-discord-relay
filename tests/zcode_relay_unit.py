#!/usr/bin/env python3
"""Gate: the Discord half's zcode event path (GH-1868 step 5, M6 + M9).

What has to hold before an owner ever sees a zcode run:

  - a terminal outcome renders as completed only when the adapter's own
    validation said so (`ok is True`). A missing, stringified or absent `ok`,
    an unknown kind, an empty line: never a green check (M6).
  - progress and the outcome are labelled with the job/session they belong to,
    and the same event id is never delivered twice (M9).
  - a chatty worker costs one message per poll, not one per record.
  - the poll cursor advances only for events actually handed back, and a bridge
    that does not know the route (404) is not mistaken for a dead one.

Run: python3 tests/zcode_relay_unit.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hermes-relay"))

import relay_core as core  # noqa: E402

CHECKS = 0


def check(name, fn):
    global CHECKS
    try:
        fn()
    except Exception as error:  # noqa: BLE001
        print(f"FAIL {name}\n     {type(error).__name__}: {error}")
        sys.exit(1)
    CHECKS += 1
    print(f"PASS {name}")


def config():
    return core.RelayConfig(secret="s", channel_id=1, owner_id=2, port=8995, port_span=2)


def progress(seq=1, job="job-1", event_id=None, text="turn started", **over):
    return {
        "id": event_id or f"{job}:{seq}",
        "seq": seq,
        "job_id": job,
        "kind": "progress",
        "phase": "turn-started",
        "text": text,
        "session_id": "sess_abc",
        **over,
    }


def terminal(seq=9, job="job-1", ok=True, reason=None, text="completed: PONG", **over):
    return {
        "id": f"{job}:{seq}",
        "seq": seq,
        "job_id": job,
        "kind": "terminal",
        "phase": "terminal-ok" if ok else "terminal-failed",
        "ok": ok,
        "reason": reason,
        "text": text,
        "session_id": "sess_abc",
        **over,
    }


# ------------------------------------------------------------------ rendering
def test_progress_line():
    text = core.render_event_text(progress())
    assert text is not None
    assert "⏳" in text and "zcode" in text
    assert "`job-1`" in text and "`sess_abc`" in text
    assert "turn started" in text


def test_success_requires_boolean_true():
    done = core.render_event_text(terminal())
    assert "✅" in done and "completed" in done, done
    for not_ok in (False, None, "true", 1, 0, "ok"):
        event = terminal(ok=not_ok, reason=None if not_ok is False else "provider_error")
        line = core.render_event_text(event)
        assert "✅" not in line, f"{not_ok!r} rendered as success: {line}"
        assert "❌" in line and "FAILED" in line, line


def test_unverified_outcome_is_a_failure():
    event = terminal()
    del event["ok"]
    line = core.render_event_text(event)
    assert "unverified_outcome" in line and "✅" not in line, line
    assert core.is_success({"kind": "terminal", "ok": "true"}) is False
    assert core.is_success({"kind": "progress", "ok": True}) is False


def test_reason_is_shown():
    line = core.render_event_text(terminal(ok=False, reason="truncated_stream", text="failed (truncated_stream): no result"))
    assert "(truncated_stream)" in line, line


def test_unknown_kind_and_empty_text_are_not_posted():
    assert core.render_event_text({"kind": "mystery", "text": "hi", "job_id": "j"}) is None
    assert core.render_event_text(progress(text="   ")) is None


def test_clipping_and_budget():
    long_event = progress(text="x" * 5000)
    line = core.render_event_text(long_event)
    assert len(line) <= core.PROGRESS_LINE_LIMIT + 40, len(line)
    many = [progress(seq=i, event_id=f"bulk:{i}", text="y" * 300) for i in range(1, 40)]
    body = core.coalesce_progress(many)
    assert body is not None and len(body) <= core.MESSAGE_CONTENT_LIMIT
    assert "suppressed" in body


def test_duplicates_are_delivered_once():
    core.forget_job("job-dup")
    event = progress(job="job-dup", event_id="job-dup:1")
    assert core.already_delivered(event) is False
    assert core.already_delivered(event) is True
    other = progress(job="job-dup", event_id="job-dup:2")
    assert core.already_delivered(other) is False
    core.forget_job("job-dup")
    assert core.already_delivered(event) is False


# --------------------------------------------------------------- poll cursor
def _stub_bridges(monkey, bridges):
    monkey["discover"] = core.discover_bridges
    core.discover_bridges = lambda config, cache=None: bridges


def _stub_fetch(monkey, batches):
    monkey["fetch"] = core.fetch_events
    calls = []

    def fake(config, after=0, limit=core.MAX_EVENT_BATCH):
        calls.append(after)
        return batches.pop(0) if batches else {"events": [], "max_seq": after, "job_id": ""}

    core.fetch_events = fake
    return calls


def test_cursor_advances_and_does_not_redeliver():
    monkey = {}
    bridge = core.bridge_at(config(), 8995)
    _stub_bridges(monkey, [bridge])
    calls = _stub_fetch(monkey, [
        {"events": [progress(seq=1), progress(seq=2)], "max_seq": 2, "job_id": "job-1"},
        {"events": [terminal(seq=3)], "max_seq": 3, "job_id": "job-1"},
    ])
    cursors = {}
    first = core.collect_events(config(), cursors)
    assert len(first) == 2, first
    assert cursors[core.cursor_key(bridge)] == 2
    second = core.collect_events(config(), cursors)
    assert len(second) == 1 and second[0][1]["kind"] == "terminal"
    assert cursors[core.cursor_key(bridge)] == 3
    assert calls == [0, 2], calls
    third = core.collect_events(config(), cursors)
    assert third == []
    core.discover_bridges = monkey["discover"]
    core.fetch_events = monkey["fetch"]


def test_404_bridge_is_not_forgotten_and_401_is_loud():
    monkey = {}
    bridge = core.bridge_at(config(), 8996)
    _stub_bridges(monkey, [bridge])
    cache = {}
    monkey["fetch"] = core.fetch_events
    forgets = []
    monkey["forget"] = core.forget_bridge
    core.forget_bridge = lambda config, b, cache=None: forgets.append(b.port)

    def raise_for_status(status):
        def fake(config, after=0, limit=core.MAX_EVENT_BATCH):
            raise core.BridgeError("nope", status=status)
        return fake

    core.fetch_events = raise_for_status(404)
    errors = []
    assert core.collect_events(config(), {}, cache=cache, errors=errors) == []
    assert errors == [], errors
    assert forgets == [], "a bridge that simply has no events route must stay cached"

    core.fetch_events = raise_for_status(401)
    errors = []
    core.collect_events(config(), {}, cache=cache, errors=errors)
    assert len(errors) == 1 and errors[0][1].status == 401, errors
    assert forgets == [], "a wrong secret is a fixable config mistake, not a dead port"

    core.fetch_events = raise_for_status(None)
    errors = []
    core.collect_events(config(), {}, cache=cache, errors=errors)
    assert len(errors) == 1 and forgets == [8996], "an unreachable bridge is dropped until it returns"

    core.discover_bridges = monkey["discover"]
    core.fetch_events = monkey["fetch"]
    core.forget_bridge = monkey["forget"]


for name, fn in list(globals().items()):
    if name.startswith("test_"):
        check(name[5:].replace("_", " "), fn)

print(f"\nall zcode_relay_unit checks passed ({CHECKS} checks)")
