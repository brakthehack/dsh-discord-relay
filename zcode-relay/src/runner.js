/**
 * One qfn turn on zcode, host-supervised (M2, M4, M6).
 *
 * The CLI contract this runs against is the published host contract
 * (`docs/HOST_INTEGRATION.md`, `docs/HEADLESS.md` of `zcode-app-cli 3.18.2-47`):
 * start the `zcode` bin, one prompt per process, `--json --output-format
 * stream-json`, consume **both** stdout and stderr continuously, forward
 * SIGTERM/SIGINT on cancellation, and treat completion as *exit 0 **and** a
 * terminal `result` record* — the launcher's own docs warn that status 0
 * without a result is incomplete, and that a cancelled run is not success.
 *
 * The host owns what the CLI explicitly does not: the overall deadline, the
 * stall verdict, the capacity lease (released only once the child is reaped)
 * and the single terminal outcome. Everything the owner sees goes through the
 * mapper in ./events.js and then the bridge, so a caller cannot accidentally
 * render a progress line as completion.
 *
 * @module zcode-relay/runner
 */

import { spawn as nodeSpawn } from 'node:child_process'

import { HEARTBEAT_TYPES, createEventMapper } from './events.js'

/** 8 MiB of stdout is a record stream, more than that is a runaway. */
export const STDOUT_CAP = 8 * 1024 * 1024
/** Enough stderr to diagnose a provider refusal, not enough to matter to memory. */
export const STDERR_CAP = 256 * 1024
const TERM_GRACE_MS = 5000

export const DEFAULT_MODE = 'build'
/** Explicit confinement, never inherited: a mode name alone is not evidence (M8). */
export const DEFAULT_DISALLOWED_TOOLS = Object.freeze([
  'Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
])

/**
 * Build the argv for one headless turn.
 *
 * Deliberately explicit: `--mode` and `--disallowed-tools` are passed every
 * time rather than inherited from saved settings, and nothing secret is ever
 * added here — the child resolves its own credential from its supported
 * config file (M8). `--resume` is the only identity the caller may carry over.
 */
export function buildArgv({
  prompt,
  cwd,
  resume,
  mode = DEFAULT_MODE,
  disallowedTools = DEFAULT_DISALLOWED_TOOLS,
  extraArgs = [],
}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('prompt is required')
  if (typeof cwd !== 'string' || cwd === '') throw new Error('cwd is required')
  const argv = ['-p', prompt, '--json', '--output-format', 'stream-json', '--cwd', cwd, '--mode', mode]
  if (resume !== undefined && resume !== '') {
    if (!String(resume).startsWith('sess_')) throw new Error('resume must be a sess_… id')
    argv.push('--resume', String(resume))
  }
  const tools = Array.isArray(disallowedTools) ? disallowedTools : []
  if (tools.length > 0) argv.push('--disallowed-tools', ...tools.map(String))
  argv.push(...extraArgs.map(String))
  return argv
}

/**
 * Run one turn. Resolves with the host's own outcome record; never throws for
 * a worker-side failure, because "it failed" is an outcome the caller must be
 * able to relay (and a hang is the alternative this whole file exists to avoid).
 */
export async function runTurn(options = {}) {
  const {
    bin = 'zcode',
    prompt,
    cwd,
    resume,
    mode = DEFAULT_MODE,
    disallowedTools = DEFAULT_DISALLOWED_TOOLS,
    settingsFile,
    extraArgs = [],
    env = process.env,
    jobId,
    runId,
    bridge,
    mapper = createEventMapper({ jobId, runId }),
    deadlineMs = 600000,
    stallMs = 180000,
    hardStallMs = 300000,
    termGraceMs = TERM_GRACE_MS,
    spawn = nodeSpawn,
    lease,
    stdoutCap = STDOUT_CAP,
    stderrCap = STDERR_CAP,
  } = options

  if (typeof jobId !== 'string' || jobId === '') throw new Error('runTurn needs a jobId')
  if (typeof runId !== 'string' || runId === '') throw new Error('runTurn needs a runId')

  const onEvent = options.onEvent
  const publish = event => {
    if (event === null || event === undefined) return event
    if (bridge !== undefined && typeof bridge.pushEvent === 'function') bridge.pushEvent(event)
    if (typeof onEvent === 'function') {
      try {
        onEvent(event)
      } catch {
        /* a noisy console never costs a run its outcome */
      }
    }
    return event
  }

  // The per-process zcode settings file is selected through the environment
  // (`ZCODE_CLI_SETTINGS_FILE`), never argv: argv is visible in `ps`, and the CLI
  // has no flag for it.
  const argv = buildArgv({ prompt, cwd, resume, mode, disallowedTools, extraArgs })
  // The per-process zcode settings file is selected through the environment
  // (`ZCODE_CLI_SETTINGS_FILE`), never argv: argv is visible in `ps`, and the
  // CLI has no flag for it.
  const childEnv = settingsFile === undefined || settingsFile === ''
    ? env
    : { ...env, ZCODE_CLI_SETTINGS_FILE: String(settingsFile) }
  const state = {
    exitCode: null,
    signal: null,
    spawnError: undefined,
    truncated: false,
    deadlineExpired: false,
    stalled: false,
    cancelled: false,
    malformedLines: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    lastRecordAt: Date.now(),
    stallWarned: false,
    result: undefined,
  }
  let stderrTail = ''

  const child = spawn(bin, argv, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })

  let resolveExit
  const exited = new Promise(resolve => { resolveExit = resolve })
  let settled = false
  child.once('error', error => {
    state.spawnError = error?.message ?? String(error)
    if (!settled) { settled = true; resolveExit({ code: null, signal: null }) }
  })
  child.once('close', (code, signal) => {
    if (!settled) { settled = true; resolveExit({ code, signal }) }
  })

  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }, termGraceMs + 1000)
  killTimer.unref?.()

  const cancel = (reason, signal = 'SIGTERM') => {
    if (state.cancelled) return
    state.cancelled = true
    state.cancelReason = reason
    try { child.kill(signal) } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, termGraceMs).unref?.()
  }

  const deadlineTimer = setTimeout(() => {
    state.deadlineExpired = true
    cancel('deadline')
  }, Math.max(1, Number(deadlineMs)))
  deadlineTimer.unref?.()

  const stallTimer = setInterval(() => {
    const quiet = Date.now() - state.lastRecordAt
    if (quiet >= hardStallMs) {
      state.stalled = true
      cancel('stalled')
      return
    }
    if (quiet >= stallMs && !state.stallWarned) {
      state.stallWarned = true
      publish(mapper.push({ type: 'relay.stall', payload: { quietMs: quiet } }))
    }
  }, Math.max(1000, Math.min(stallMs, 5000)))
  stallTimer.unref?.()

  // Both streams are consumed continuously: the CLI docs are explicit that a
  // blocked consumer can hold completion open, and a capped one cannot grow.
  const consume = (stream, onChunk) => {
    if (stream === null || stream === undefined) return Promise.resolve()
    return new Promise(resolve => {
      stream.on('data', chunk => onChunk(Buffer.from(chunk)))
      stream.on('end', resolve)
      stream.on('error', resolve)
    })
  }

  let lineBuffer = ''
  const onData = chunk => {
    state.stdoutBytes += chunk.length
    if (state.stdoutBytes > stdoutCap) {
      state.truncated = true
      return
    }
    lineBuffer += chunk.toString('utf8')
    let index = lineBuffer.indexOf('\n')
    while (index >= 0) {
      const line = lineBuffer.slice(0, index).trim()
      lineBuffer = lineBuffer.slice(index + 1)
      if (line !== '') handleLine(line)
      index = lineBuffer.indexOf('\n')
    }
  }
  const handleLine = line => {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      state.malformedLines += 1
      // Unparsable output is not progress either, but it did arrive: let the
      // stall clock move so a chatty-but-broken child hits the deadline, not
      // the stall path.
      state.lastRecordAt = Date.now()
      return
    }
    // A heartbeat keeps the pipe warm and proves nothing: it must not reset the
    // stall clock, or a stalled worker looks alive forever and M6 is void.
    if (!HEARTBEAT_TYPES.includes(String(record?.type ?? ''))) state.lastRecordAt = Date.now()
    if (record?.type === 'result') state.result = record
    const event = mapper.push(record)
    if (event !== null) publish(event)
  }

  const onStderr = chunk => {
    state.stderrBytes += chunk.length
    if (state.stderrBytes > stderrCap) {
      state.stderrTruncated = true
      return
    }
    stderrTail = (`${stderrTail}${chunk.toString('utf8')}`).slice(-2000)
  }

  const externalSignal = options.signal
  const onAbort = () => cancel('abort')
  if (externalSignal !== undefined && externalSignal !== null) {
    if (externalSignal.aborted) cancel('abort')
    else externalSignal.addEventListener?.('abort', onAbort)
  }

  const [stdoutDone, stderrDone] = await Promise.all([
    consume(child.stdout, onData),
    consume(child.stderr, onStderr),
  ])
  void stdoutDone; void stderrDone
  const { code, signal } = await exited
  clearTimeout(deadlineTimer)
  clearInterval(stallTimer)
  clearTimeout(killTimer)
  externalSignal?.removeEventListener?.('abort', onAbort)

  state.exitCode = code
  state.signal = signal

  // A final line with no trailing newline is still a record if it parses.
  if (lineBuffer.trim() !== '' && state.result === undefined) {
    try {
      const record = JSON.parse(lineBuffer.trim())
      if (record?.type === 'result') state.result = record
    } catch {
      state.malformedLines += 1
    }
  }

  const terminal = mapper.finish({
    exitCode: code,
    signal,
    result: state.result,
    sawStdout: state.stdoutBytes > 0,
    streamTruncated: state.truncated,
    deadlineExpired: state.deadlineExpired,
    stalled: state.stalled,
    cancelled: state.cancelled && !state.deadlineExpired && !state.stalled,
    spawnError: state.spawnError,
  })
  publish(terminal)

  // Capacity is released only now: the child is reaped (close fired, or it
  // never existed), so the slot it occupied is genuinely free.
  const released = lease !== undefined && lease !== null ? lease.release() : undefined

  const outcome = terminal?.ok === true
  return {
    ok: outcome === true,
    // A success carries `reason: null` by contract; only a genuinely
    // absent terminal event is the 'no_terminal_record' case.
    reason: terminal === null || terminal === undefined ? 'no_terminal_record' : terminal.reason,
    detail: terminal?.text ?? '',
    exitCode: code,
    signal,
    sessionId: mapper.sessionId || (state.result?.sessionId ?? ''),
    turnId: state.result?.turnId,
    usage: outcome ? state.result?.usage : undefined,
    result: outcome ? state.result : undefined,
    stderrTail: outcome ? '' : stderrTail.slice(-500),
    malformedLines: state.malformedLines,
    truncated: state.truncated,
    leaseReleased: released,
  }
}
