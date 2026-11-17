#!/usr/bin/env node
/**
 * `zcode-relay run` — one qfn turn on zcode, relayed to the owner.
 *
 * The dsh half has a plugin that lives inside the worker process; zcode has no
 * plugin seam a host may use, so the equivalent here is a host: this command
 * owns the child, its deadline, its capacity lease, its bridge and its event
 * stream, and it is the reason the owner sees progress and one terminal
 * outcome instead of silence.
 *
 * stdout carries exactly one JSON record (the outcome) so a caller can parse
 * it; progress goes to stderr, redacted and clipped, because the durable copy
 * of what the owner sees is Discord, not this terminal.
 *
 * Usage:
 *   zcode-relay run --prompt '…' --cwd DIR [--resume sess_…] [--job-id ID]
 *                   [--mode build] [--disallowed-tools Bash Edit] [--hold-ms 20000]
 *   zcode-relay ask --question '…' [--option A --option B] [--job-id ID]
 *
 * @module zcode-relay/bin
 */

import { randomUUID } from 'node:crypto'

import { RelayError } from '../../dsh-relay-bundle/src/ask.js'
import { ZcodeBridge } from '../src/bridge.js'
import { runRelayedJob } from '../src/adapter.js'
import { bridgeConfig, windowLabel } from '../../dsh-relay-bundle/src/protocol.js'
import { askViaBridge } from '../../dsh-relay-bundle/src/ask.js'

const USAGE = `zcode-relay run --prompt TEXT --cwd DIR [options]

  --prompt TEXT          the instruction for this turn (required)
  --cwd DIR              workspace the child runs in (required)
  --resume sess_…        continue a persisted zcode session
  --job-id ID            correlation id (default: generated)
  --run-id ID            correlation id for this attempt (default: generated)
  --mode MODE            permission mode, passed explicitly (default: build)
  --disallowed-tools …   tools removed for this run (default: the editing set)
  --deadline-ms N        host deadline for the turn (default: 600000)
  --hold-ms N            keep the bridge up after the turn so the poller can
                         drain the terminal event (default: 20000)
  --bin PATH             zcode executable (default: zcode)
  --quiet                do not echo progress to stderr
  --json                 print only the outcome record (default shape)

zcode-relay ask --question TEXT [--option LABEL]… [--multi-select]
               [--header TEXT] [--job-id ID]
  Ask the owner one question through the same bridge, for operator use and for
  proving the round trip without a model in the loop.`

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      options._.push(token)
      continue
    }
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = value
    index += 1
  }
  return options
}

async function commandRun(options) {
  const config = bridgeConfig()
  if (config.secret === '') {
    process.stderr.write(`[zcode-relay] relay is not configured: ${String(config.configError).split('\n')[0]}\n`)
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'relay_unconfigured' })}\n`)
    return 2
  }
  if (typeof options.prompt !== 'string' || typeof options.cwd !== 'string') {
    process.stderr.write(`${USAGE}\n`)
    return 64
  }
  const jobId = String(options['job-id'] ?? `job-${randomUUID().slice(0, 8)}`)
  const quiet = options.quiet === true
  const onEvent = event => {
    if (quiet || event === null) return
    process.stderr.write(`[zcode-relay] ${event.kind} ${event.phase}: ${event.text}\n`)
  }

  const result = await runRelayedJob({
    prompt: options.prompt,
    cwd: options.cwd,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    jobId,
    ...(options['run-id'] === undefined ? {} : { runId: options['run-id'] }),
    bin: String(options.bin ?? 'zcode'),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options['disallowed-tools'] === undefined
      ? {}
      : { disallowedTools: String(options['disallowed-tools']).split(/[,\s]+/).filter(Boolean) }),
    ...(options['deadline-ms'] === undefined ? {} : { deadlineMs: Number(options['deadline-ms']) }),
    onEvent,
  })

  const bridge = result.bridge
  const holdMs = Math.max(0, Number(options['hold-ms'] ?? 20000) || 0)
  if (bridge instanceof ZcodeBridge && holdMs > 0) {
    // The Discord half polls; hold the port until it has actually taken the
    // terminal event, or until the bounded window ends. Bounded either way:
    // a missing gateway cannot keep this process (and its capacity) alive.
    const terminalAt = Date.now()
    const until = terminalAt + holdMs
    while (Date.now() < until) {
      if (bridge.lastEventsPollAt >= terminalAt) break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await bridge.stop()
  }

  const { bridge: _bridge, ...record } = result
  process.stdout.write(`${JSON.stringify(record)}\n`)
  return record.ok === true ? 0 : 1
}

async function commandAsk(options) {
  const config = bridgeConfig()
  if (typeof options.question !== 'string' || options.question === '') {
    process.stderr.write(`${USAGE}\n`)
    return 64
  }
  const jobId = String(options['job-id'] ?? `ask-${randomUUID().slice(0, 8)}`)
  const bridge = new ZcodeBridge(config, { runToken: randomUUID(), jobId })
  try {
    await bridge.start()
    const questions = [{
      id: String(options.id ?? 'q1'),
      question: options.question,
      ...(options.header === undefined ? {} : { header: String(options.header) }),
      ...(options.option === undefined
        ? {}
        : {
            options: (Array.isArray(options.option) ? options.option : [options.option])
              .map(label => ({ label: String(label) })),
          }),
      multiSelect: options['multi-select'] === true,
    }]
    const outcome = await askViaBridge({ bridge, config, questions })
    process.stdout.write(`${JSON.stringify({ ok: true, job_id: jobId, ...outcome })}\n`)
    return 0
  } catch (error) {
    const code = error instanceof RelayError ? error.code : 'ASK_FAILED'
    process.stdout.write(`${JSON.stringify({ ok: false, job_id: jobId, error: code, message: error?.message })}\n`)
    return 1
  } finally {
    await bridge.stop()
  }
}

const argv = process.argv.slice(2)
const command = argv[0]
const options = parseArgs(argv.slice(1))

if (command === 'run') {
  process.exitCode = await commandRun(options)
} else if (command === 'ask') {
  process.exitCode = await commandAsk(options)
} else {
  process.stderr.write(`${USAGE}\n\n(bridge window: ${windowLabel(bridgeConfig())})\n`)
  process.exitCode = command === undefined ? 64 : 2
}
