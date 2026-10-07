"""dsh-discord-relay — Hermes plugin (Discord half).

Polls the dsh bridge for questions a blocked dsh agent is waiting on, posts
them to your configured blockers/questions channel (set channelId in the
config file), tagging the owner with clickable option buttons (plus a
"Type your own answer" button that opens a modal), and unblocks the agent by
POSTing the owner's click back to the bridge. Only the owner id may answer
(everyone else gets an ephemeral refusal); the resolved message is edited in
place with disabled buttons and the stamped answer, and the owner's response is
echoed as its own channel message.

Dispatch truth this relies on (discord.py 2.7.1; verified in
``.venv/.../discord/state/state.py`` and ``discord/ui/view.py``, recorded in
DECISIONS.md): ``State.parse_interaction_create`` routes component interactions
(type 3) through ``ViewStore.dispatch_view`` keyed by
``(component_type, EXACT custom_id)`` under the message id the view was sent
with, modal submits (type 5) through ``dispatch_modal`` keyed by the modal's
custom_id, and then ALWAYS fires ``on_interaction``. ``channel.send(view=...)``
registers the view in that store, so View/Button/Modal callbacks do fire in
this same client. Callbacks are therefore the only path that POSTs an answer;
the global ``on_interaction`` listener is an ephemeral-only backstop for relay
custom_ids whose view is gone (stale prompt), so exactly-once cannot be broken
by double handling and a click is never silently ignored.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

try:
    from . import relay_core as core
except ImportError:  # loaded as a loose module instead of a package
    import relay_core as core  # type: ignore[no-redef]

log = logging.getLogger("hermes.plugins.dsh_discord_relay")

#: id(client) -> RelayRunner, so a reconnect never starts a second poller.
_RUNNERS: Dict[int, Any] = {}


def register(ctx) -> None:
    """Hermes plugin entry point (plugin.yaml: name/version/description)."""
    ctx.register_platform_handler("discord", _factory)


def _load_config_or_none() -> Optional["core.RelayConfig"]:
    """Load config, or disable the relay with a loud setup hint (never a guess)."""
    try:
        return core.load_config()
    except core.ConfigError as error:
        log.warning("dsh-discord-relay disabled:\n%s", error)
        return None


def _factory(native, adapter) -> None:  # noqa: ARG001 - adapter is part of the seam
    """Called at gateway connect with the live discord.py commands.Bot."""
    import discord  # imported inside the factory, per the Hermes plugin contract

    config = _load_config_or_none()
    if config is None:
        return

    previous = _RUNNERS.get(id(native))
    if previous is not None:
        previous.stop()

    prompt_view, answer_modal, disabled_view = _build_ui(discord)
    runner = RelayRunner(native, config, prompt_view, answer_modal, disabled_view)
    _RUNNERS[id(native)] = runner
    _install_backstop(native, runner)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        _spawn(runner, loop)
        return

    @native.event
    async def _dsh_relay_on_ready() -> None:  # pragma: no cover - connect before loop
        _spawn(runner, asyncio.get_running_loop())


def _spawn(runner: "RelayRunner", loop: asyncio.AbstractEventLoop) -> None:
    if runner.task is not None and not runner.task.done():
        return
    runner.task = loop.create_task(runner.run(), name="dsh-discord-relay-poll")
    log.info("dsh-discord-relay polling %s for channel %s", runner.config.base_url,
             runner.config.channel_id)


def _install_backstop(native, runner: "RelayRunner") -> None:
    """Ephemeral-only notice for relay components whose live view is gone."""

    async def on_interaction(interaction) -> None:
        try:
            data = getattr(interaction, "data", None) or {}
            decoded = core.decode_custom_id(str(data.get("custom_id") or ""))
            if decoded is None:
                return
            if decoded[0] in runner.prompts:
                return  # the live view's callback owns this answer
            if interaction.response.is_done():
                return
            await interaction.response.send_message(
                "That dsh prompt is no longer live here (the asking session ended, "
                "or this gateway restarted while it was pending).",
                ephemeral=True,
            )
        except Exception:  # never break the other listeners
            log.debug("dsh-discord-relay backstop failed", exc_info=True)

    try:
        native.listen(on_interaction)
    except Exception:
        log.debug("dsh-discord-relay could not install the on_interaction backstop", exc_info=True)


@dataclass
class Prompt:
    """One pending bridge question plus the Discord message carrying it."""

    token: str
    question: Dict[str, Any]
    multi: bool
    message: Any = None
    view: Any = None
    resolved: bool = False
    in_flight: bool = False
    chosen: List[str] = field(default_factory=list)
    final_text: str = ""


class RelayRunner:
    """Bridge poller + answerer bound to one live discord.py client."""

    def __init__(self, client, config, prompt_view, answer_modal, disabled_view) -> None:
        self.client = client
        self.config = config
        self.prompt_view = prompt_view
        self.answer_modal = answer_modal
        self.disabled_view = disabled_view
        self.prompts: Dict[str, Prompt] = {}
        self.task: Optional[asyncio.Task] = None
        self._running = True
        self._bridge_failures = 0

    def stop(self) -> None:
        self._running = False
        if self.task is not None:
            self.task.cancel()

    # ------------------------------------------------------------ poll loop
    async def run(self) -> None:
        while self._running:
            try:
                questions = await core.ahead(core.fetch_pending, self.config)
                self._bridge_failures = 0
            except Exception as error:
                self._bridge_failures += 1
                # No dsh asking right now is the normal state: stay quiet.
                if self._bridge_failures in (1, 40, 400):
                    log.debug("dsh bridge not reachable (%d): %s", self._bridge_failures, error)
                await asyncio.sleep(max(self.config.poll_interval, 2.0))
                continue
            try:
                await self._reconcile(questions)
            except Exception:
                log.exception("dsh-discord-relay reconcile failed")
            await asyncio.sleep(self.config.poll_interval)

    async def _reconcile(self, questions: List[Dict[str, Any]]) -> None:
        for token in [t for t, p in self.prompts.items() if p.resolved]:
            self.prompts.pop(token, None)
        for question in questions:
            token = str(question.get("token") or "")
            if not token or token in self.prompts:
                continue
            try:
                await self._post_question(token, question)
            except Exception:
                log.exception("could not post dsh question %s to Discord", token)

    async def channel(self):
        channel = self.client.get_channel(self.config.channel_id)
        if channel is None:
            channel = await self.client.fetch_channel(self.config.channel_id)
        return channel

    async def _post_question(self, token: str, question: Dict[str, Any]) -> None:
        prompt = Prompt(token=token, question=question, multi=bool(question.get("multi_select")))
        self.prompts[token] = prompt  # registered first: a click must never lose state
        channel = await self.channel()
        content = core.message_content(question, self.config.owner_id)
        prompt.view = self.prompt_view(self, prompt)
        try:
            prompt.message = await channel.send(content=content, view=prompt.view)
        except Exception:
            self.prompts.pop(token, None)
            raise

    # ------------------------------------------------------------ answering
    async def resolve(self, prompt: Prompt, selected: List[str], custom: Optional[str]) -> Tuple[str, str]:
        """Deliver the owner's answer once; returns (display text, bridge status)."""
        prompt.in_flight = True
        try:
            return await self._resolve(prompt, selected, custom)
        finally:
            prompt.in_flight = False

    async def _resolve(self, prompt: Prompt, selected: List[str], custom: Optional[str]) -> Tuple[str, str]:
        payload = await core.ahead(core.post_answer, self.config, prompt.token, selected, custom)
        status = str(payload.get("status") or "")
        text = core.answer_to_text(selected, custom)
        if status == "duplicate":
            winner = payload.get("answer") or {}
            text = core.answer_to_text(list(winner.get("selected") or []), winner.get("custom"))
        already = prompt.resolved
        prompt.resolved = True
        prompt.chosen = [s for s in selected if s]
        prompt.final_text = text
        if not already:
            await self._stamp(prompt, text)
        return text, status

    async def stamp_duplicate(self, prompt: Prompt) -> str:
        """Late click on an already-resolved prompt: re-stamp, never re-answer."""
        text = prompt.final_text or core.answer_to_text(prompt.chosen, None)
        await self._stamp(prompt, text)
        return text

    async def _stamp(self, prompt: Prompt, text: str) -> None:
        """Edit the prompt in place (disabled buttons + answer) and echo it."""
        channel = None
        try:
            if prompt.message is not None:
                await prompt.message.edit(
                    content=core.stamped_content(prompt.question, self.config.owner_id, text),
                    view=self.disabled_view(prompt.question, prompt.chosen))
        except Exception:
            log.warning("could not edit the resolved dsh prompt message", exc_info=True)
        try:
            channel = prompt.message.channel if prompt.message is not None else await self.channel()
            await channel.send(
                f"<@{self.config.owner_id}> answered dsh: **{text}** \u2014 relayed to the agent.")
        except Exception:
            log.warning("could not echo the owner's answer to the channel", exc_info=True)


# ---------------------------------------------------------------- UI classes
def _build_ui(discord):
    """Define the View/Modal subclasses against the real discord module."""

    class PromptView(discord.ui.View):
        """Clickable options for one dsh question (never times out while live)."""

        def __init__(self, runner: RelayRunner, prompt: Prompt) -> None:
            super().__init__(timeout=None)
            self.runner = runner
            self.prompt = prompt
            self._by_action: Dict[str, Any] = {}
            for row in core.build_components(prompt.question):
                for child in row["components"]:
                    button = discord.ui.Button(
                        label=child["label"],
                        style=discord.ButtonStyle(child["style"]),
                        custom_id=child["custom_id"],
                        disabled=bool(child.get("disabled")),
                    )
                    action = core.decode_custom_id(child["custom_id"])[1]

                    async def handler(interaction, _action: str = action, _view=self) -> None:
                        await _handle_component(_view.runner, _view.prompt, _view, interaction, _action)

                    button.callback = handler
                    self._by_action[action] = button
                    self.add_item(button)

        async def on_timeout(self) -> None:  # timeout=None: defensive only
            for child in self.children:
                child.disabled = True

    class AnswerModal(discord.ui.Modal):
        """Free-text answer, reachable from its own button."""

        def __init__(self, runner: RelayRunner, prompt: Prompt) -> None:
            super().__init__(
                title=core.clip("Answer for dsh", 45),
                custom_id=core.encode_custom_id(prompt.token, "modal"),
                timeout=None,
            )
            self.runner = runner
            self.prompt = prompt
            self.answer = discord.ui.TextInput(
                label=core.clip(prompt.question.get("header") or "Your answer", 45),
                placeholder=core.clip("Type the answer the agent should use", 100),
                style=discord.TextStyle.paragraph,
                required=True,
                max_length=1000,
            )
            self.add_item(self.answer)

        async def on_submit(self, interaction) -> None:
            text = str(self.answer.value or "").strip()
            try:
                stamp, _status = await self.runner.resolve(self.prompt, [], text)
                await interaction.response.send_message(
                    f"Relayed to dsh: **{core.clip(stamp, 900)}**", ephemeral=True)
            except Exception as error:
                log.exception("modal answer relay failed")
                await _safe_reply(interaction, f"Could not relay that answer: {error}")

        async def on_error(self, interaction, error) -> None:  # pragma: no cover
            log.exception("dsh answer modal failed", exc_info=error)

    class DisabledView(discord.ui.View):
        """Post-resolution shape: same buttons, all disabled."""

        def __init__(self, question: Dict[str, Any], chosen: Optional[List[str]] = None) -> None:
            super().__init__(timeout=None)
            for row in core.build_components(question, disabled=True, chosen=chosen):
                for child in row["components"]:
                    self.add_item(discord.ui.Button(
                        label=child["label"],
                        style=discord.ButtonStyle(child["style"]),
                        custom_id=child["custom_id"],
                        disabled=True,
                    ))

        async def on_timeout(self) -> None:  # pragma: no cover - keep buttons dead
            for child in self.children:
                child.disabled = True

    return PromptView, AnswerModal, DisabledView


async def _handle_component(runner: RelayRunner, prompt: Prompt, view, interaction,
                            action: str) -> None:
    """One button click on a live prompt: gate, act, respond within 3 s."""
    owner_only = str(runner.config.owner_id)
    user_id = str(getattr(getattr(interaction, "user", None), "id", ""))
    if user_id != owner_only:
        await _safe_reply(interaction,
                          "Only the owner of this dsh session may answer it.", ephemeral=True)
        return
    if prompt.resolved or prompt.in_flight:
        try:
            await runner.stamp_duplicate(prompt)
        except Exception:
            log.warning("could not re-stamp a duplicate click", exc_info=True)
        await _safe_reply(interaction, "Already answered \u2014 the agent moved on.", ephemeral=True)
        return

    if action == core.CUSTOM_ACTION:
        await interaction.response.send_modal(runner.answer_modal(runner, prompt))
        return

    labels = [str(o.get("label") or "") for o in (prompt.question.get("options") or [])]
    if action == core.SUBMIT_ACTION:
        chosen = list(prompt.chosen)
        if not chosen:
            await _safe_reply(interaction, "Pick at least one option first.", ephemeral=True)
            return
    else:
        try:
            index = int(action)
        except ValueError:
            await _safe_reply(interaction, "Unknown option.", ephemeral=True)
            return
        if index < 0 or index >= len(labels):
            await _safe_reply(interaction, "Unknown option.", ephemeral=True)
            return
        if not prompt.multi:
            await _defer(interaction)
            try:
                stamp, status = await runner.resolve(prompt, [labels[index]], None)
            except Exception as error:
                log.exception("relay of option click failed")
                await _followup(interaction, f"Could not relay that answer: {error}", ephemeral=True)
                return
            await _followup(interaction,
                            f"Answered dsh: **{core.clip(stamp, 900)}**"
                            + (" (already answered earlier)" if status == "duplicate" else ""),
                            ephemeral=True)
            return
        prompt.chosen = _toggle(prompt.chosen, labels[index])
        _repaint(view, prompt)
        await interaction.response.edit_message(view=view)
        return

    # multi-select submit
    await _defer(interaction)
    try:
        stamp, status = await runner.resolve(prompt, list(prompt.chosen), None)
    except Exception as error:
        log.exception("relay of multi-select answer failed")
        await _followup(interaction, f"Could not relay that answer: {error}", ephemeral=True)
        return
    await _followup(interaction,
                    f"Answered dsh: **{core.clip(stamp, 900)}**"
                    + (" (already answered earlier)" if status == "duplicate" else ""),
                    ephemeral=True)


def _toggle(chosen: List[str], label: str) -> List[str]:
    out = list(chosen)
    if label in out:
        out.remove(label)
    else:
        out.append(label)
    return out


def _repaint(view, prompt: Prompt) -> None:
    """Check-mark the toggled options without rebuilding the message."""
    for action, button in getattr(view, "_by_action", {}).items():
        if action in ("custom", "submit"):
            continue
        try:
            index = int(action)
        except ValueError:
            continue
        labels = [str(o.get("label") or "") for o in (prompt.question.get("options") or [])]
        if index < len(labels):
            mark = "\u2713 " if labels[index] in prompt.chosen else ""
            button.label = core.clip(mark + labels[index], core.BUTTON_LABEL_LIMIT)


async def _defer(interaction) -> None:
    """Acknowledge a component interaction so the relay call may take a moment."""
    try:
        if not interaction.response.is_done():
            await interaction.response.defer(ephemeral=True)
    except Exception:
        log.debug("defer failed (already answered?)", exc_info=True)


async def _safe_reply(interaction, text: str, *, ephemeral: bool = True) -> None:
    try:
        if interaction.response.is_done():
            await interaction.followup.send(text, ephemeral=ephemeral)
        else:
            await interaction.response.send_message(text, ephemeral=ephemeral)
    except Exception:
        log.debug("could not reply to an interaction", exc_info=True)


async def _followup(interaction, text: str, *, ephemeral: bool = True) -> None:
    try:
        await interaction.followup.send(text, ephemeral=ephemeral)
    except Exception:
        log.debug("could not send an interaction follow-up", exc_info=True)
