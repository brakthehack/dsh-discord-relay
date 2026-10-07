#!/usr/bin/env python3
"""Gateway-free dev runner for the dsh Discord relay (raw Discord REST).

Purpose: prove the relay half - real clickable components on a real message in
your configured blockers/questions channel (set channelId in the config file)
and tagged for the owner - without enabling the Hermes plugin or touching the
gateway. Same shared builder (``relay_core``) the plugin uses, so what this
posts is what the plugin posts.

The bot token is read at call time from the environment or ~/.hermes/.env and is
never printed.

Usage (with ~/.config/dsh-discord-relay/config.json for the channel, owner,
secret and bridge port, and a live
pending question created by a scripted dsh ask):

    python3 dev_main.py selftest [--delete]   # post ONE [relay self-test] msg,
                                             # GET-verify, optionally DELETE it
    python3 dev_main.py poll [--once]          # act as the relay (no plugin)
    python3 dev_main.py answer TOKEN INDEX     # simulate an owner click
    python3 dev_main.py health                 # bridge liveness probe
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

try:
    from . import relay_core as core
except ImportError:  # run as a loose script: python3 dev_main.py ...
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import relay_core as core  # type: ignore[no-redef]

API = "https://discord.com/api/v10"


def bot_token() -> str:
    token = (os.environ.get("DISCORD_BOT_TOKEN") or "").strip()
    if not token:
        token = core.read_env_file(os.path.expanduser("~/.hermes/.env")).get("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit("DISCORD_BOT_TOKEN is not set (nor present in ~/.hermes/.env)")
    return token


def discord_request(method: str, path: str, payload: dict | None = None,
                    token: str | None = None) -> tuple[int, dict]:
    token = token or bot_token()
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{API}{path}",
        data=body,
        method=method,
        headers={
            "authorization": f"Bot {token}",
            "content-type": "application/json",
            # A DiscordBot UA is mandatory (Cloudflare 1010 without one);
            # main() pushes the config file's "userAgent" onto this constant.
            "user-agent": core.DISCORD_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status, raw = response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read().decode("utf-8", "replace")
    except OSError as error:
        raise SystemExit(f"{method} {path} failed: {error}") from error
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        parsed = {"raw": raw[:400]}
    return status, parsed if isinstance(parsed, dict) else {"data": parsed}


def post_message(config: core.RelayConfig, content: str, components: list) -> dict:
    status, payload = discord_request(
        "POST", f"/channels/{config.channel_id}/messages",
        {"content": content[:core.MESSAGE_CONTENT_LIMIT], "components": components},
    )
    if status not in (200, 201):
        raise SystemExit(f"message post failed: HTTP {status} {payload.get('message') or payload}")
    return payload


def cmd_health(config: core.RelayConfig, _args) -> None:
    print(json.dumps(core.fetch_health(config), indent=2, sort_keys=True))


def cmd_selftest(config: core.RelayConfig, args) -> None:
    if not config.secret:
        raise SystemExit("no shared relay secret configured; cannot read the bridge")
    questions = core.fetch_pending(config)
    if not questions:
        raise SystemExit("the bridge has no pending question to render; start a scripted dsh ask first")
    question = questions[0]
    content = core.message_content(question, config.owner_id, prefix="[relay self-test]")
    components = core.build_components(question)
    message = post_message(config, content, components)
    message_id = message["id"]
    print(f"posted message_id={message_id} channel={config.channel_id} token={question['token']}")

    status, fetched = discord_request("GET", f"/channels/{config.channel_id}/messages/{message_id}")
    print(f"GET -> HTTP {status}")
    expected_tag = f"<@{config.owner_id}>"
    custom_ids = [child["custom_id"]
                  for row in (fetched.get("components") or [])
                  for child in (row.get("components") or [])
                  if "custom_id" in child]
    labels = [child.get("label")
              for row in (fetched.get("components") or [])
              for child in (row.get("components") or [])]
    ok_tag = expected_tag in str(fetched.get("content") or "")
    ok_components = len(custom_ids) > 0 and all(cid.startswith(f"{core.CUSTOM_ID_PREFIX}:") for cid in custom_ids)
    print(f"content_has_owner_tag={ok_tag} literal={expected_tag}")
    print(f"component_rows={len(fetched.get('components') or [])} buttons={labels}")
    print(f"custom_ids={custom_ids}")
    print(f"VERIFY components={ok_components} owner_tag={ok_tag}")

    if args.answer_index is not None:
        options = question.get("options") or []
        label = options[args.answer_index]["label"]
        result = core.post_answer(config, question["token"], [label], None)
        print(f"answer POST -> {json.dumps(result, sort_keys=True)}")

    if args.delete:
        status, payload = discord_request("DELETE", f"/channels/{config.channel_id}/messages/{message_id}")
        print(f"DELETE -> HTTP {status} {payload if status not in (200, 204) else ''}".rstrip())
        if status not in (200, 204):
            raise SystemExit(f"cleanup FAILED: HTTP {status}")
        print(f"deleted message_id={message_id}")


def cmd_answer(config: core.RelayConfig, args) -> None:
    questions = {q["token"]: q for q in core.fetch_pending(config)}
    question = questions.get(args.token)
    if question is None:
        raise SystemExit(f"{args.token} is not pending (open tokens: {sorted(questions)})")
    options = question.get("options") or []
    if args.custom is not None:
        selected, custom = [], args.custom
    else:
        if args.index >= len(options):
            raise SystemExit(f"option index out of range (0..{len(options) - 1})")
        selected, custom = [options[args.index]["label"]], None
    print(json.dumps(core.post_answer(config, args.token, selected, custom), sort_keys=True))


def cmd_poll(config: core.RelayConfig, args) -> None:
    import time
    seen: set[str] = set()
    while True:
        for question in core.fetch_pending(config):
            token = question["token"]
            if token in seen:
                continue
            seen.add(token)
            message = post_message(config, core.message_content(question, config.owner_id),
                                   core.build_components(question))
            print(f"posted {token} -> message_id={message['id']}")
        if args.once:
            return
        time.sleep(config.poll_interval)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="dsh Discord relay dev runner (raw REST)")
    parser.add_argument("command", choices=["health", "selftest", "answer", "poll"])
    parser.add_argument("token", nargs="?", help="bridge token (answer)")
    parser.add_argument("index", nargs="?", type=int, default=0, help="option index (answer)")
    parser.add_argument("--delete", action="store_true", help="DELETE the self-test message")
    parser.add_argument("--once", action="store_true", help="poll: one pass then exit")
    parser.add_argument("--answer-index", type=int, default=None,
                        help="selftest: also POST this option as the owner answer")
    parser.add_argument("--custom", default=None, help="answer: send typed text instead of an option")
    args = parser.parse_args(argv)

    try:
        config = core.load_config()
    except core.ConfigError as error:  # unset target: print the hint, not a traceback
        raise SystemExit(str(error)) from None
    # Raw REST lives outside discord.py, so push the file's userAgent onto the
    # module constant discord_request() reads.
    core.DISCORD_USER_AGENT = config.user_agent
    handlers = {"health": cmd_health, "selftest": cmd_selftest,
                "answer": cmd_answer, "poll": cmd_poll}
    handlers[args.command](config, args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
