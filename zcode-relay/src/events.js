/**
 * zcode stream-json -> relay events (M6, M9).
 *
 * The pinned build (`zcode-app-cli 3.18.2-47` / `zcode-runtime 0.17.1`) emits
 * one JSON record per line on stdout with `--output-format stream-json`. What
 * was measured on this box (`docs/HEADLESS.md:14-22` is the contract, the
 * receipt in DECISIONS.md §13 is the measurement):
 *
 *   every record    {eventId, seq, sessionId, timestamp, traceId, turnId, type, payload}
 *   progress types  session.titleUpdated, turn.started, session.updated,
 *                   model.streaming, turn.completed   (tool types keep their prefix)
 *   terminal record {type:"result", sessionId, traceId, turnId, response,
 *                    usage{source,inputTokens,outputTokens,totalTokens,…},
 *                    eventCount, projection{status}}   — no `payload`
 *
 * Two rules drive this module:
 *
 * 1. **Progress is vocabulary, not transcript.** `turn.started.payload.input`
 *    and `session.titleUpdated.payload.title` carry the prompt text, so nothing
 *    in a payload is ever forwarded verbatim: the owner sees which phase the
 *    run is in, plus counters. The terminal excerpt is clipped and redacted.
 * 2. **Only a validated terminal record is success** (M6). Exit 0 alone is not
 *    completion — a missing `result` is "incomplete even if the process reports
 *    status 0" — and empty output, an empty response, a provider error, a
 *    non-idle projection, a truncated stream, a signal, a deadline and a stall
 *    are each a distinct failure reason. Exactly one terminal event is ever
 *    emitted, no matter how many things go wrong or how often they repeat.
 *
 * @module zcode-relay/events
 */

/** Failure reasons a terminal event may carry. Success is `reason: null`. */
export const TERMINAL_REASONS = Object.freeze([
  'provider_error',
  'truncated_stream',
  'empty_output',
  'empty_response',
  'missing_session_id',
  'non_idle_projection',
  'non_zero_exit',
  'signalled',
  'deadline_expired',
  'stalled',
  'cancelled',
  'child_spawn_failed',
])

/** Records that prove nothing about progress: a stream of only these is a stall. */
export const HEARTBEAT_TYPES = Object.freeze(['relay.heartbeat', 'heartbeat', 'ping', 'keepalive', 'relay.stall'])

const PROGRESS_PHASES = new Map([
  ['turn.started', 'turn started'],
  ['turn.completed', 'turn completed'],
  ['model.streaming', 'model streaming'],
  ['session.updated', 'session updated'],
  ['session.titleUpdated', 'session titled'],
])

const REDACTION = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(Authorization\s*:\s*\S+)/gi,
  /\b([A-Za-z0-9_-]{40,})\b/g,
]

/** Strip anything that looks like a credential from a line the owner will see. */
export function redact(text, limit = 220) {
  let out = String(text ?? '').replace(/\s+/g, ' ').trim()
  for (const pattern of REDACTION) out = out.replace(pattern, '[redacted]')
  return out.length <= limit ? out : `${out.slice(0, limit - 1)}\u2026`
}

/**
 * Decide the terminal outcome from everything the host observed.
 *
 * Pure and total: it never returns "success" unless every independent check
 * passed, and it names the first thing that failed so the owner sees the cause
 * rather than a bare failure.
 */
export function validateTerminal({ exitCode, signal, result, sawStdout, streamTruncated, deadlineExpired, stalled, cancelled, spawnError } = {}) {
  if (spawnError !== undefined && spawnError !== null) {
    return { ok: false, reason: 'child_spawn_failed', detail: redact(spawnError, 160) }
  }
  if (cancelled === true) return { ok: false, reason: 'cancelled', detail: 'the run was cancelled by the host' }
  if (deadlineExpired === true) return { ok: false, reason: 'deadline_expired', detail: 'the host deadline fired' }
  if (stalled === true) return { ok: false, reason: 'stalled', detail: 'no records arrived before the stall limit' }
  if (signal !== null && signal !== undefined) {
    return { ok: false, reason: 'signalled', detail: `terminated by ${signal} (status ${128 + signalNumber(signal)})` }
  }
  if (exitCode !== 0) return { ok: false, reason: 'non_zero_exit', detail: `exit code ${exitCode}` }
  if (sawStdout !== true) return { ok: false, reason: 'empty_output', detail: 'the child wrote nothing to stdout' }
  if (streamTruncated === true) {
    return { ok: false, reason: 'truncated_stream', detail: 'stdout hit the capture cap before exiting' }
  }
  if (result === undefined || result === null) {
    return { ok: false, reason: 'truncated_stream', detail: 'exit 0 without a terminal "result" record' }
  }
  if (result.error !== undefined && result.error !== null && result.error !== '') {
    return { ok: false, reason: 'provider_error', detail: redact(result.error, 160) }
  }
  if (result.isError === true) {
    return { ok: false, reason: 'provider_error', detail: 'the terminal record is flagged as an error' }
  }
  const sessionId = String(result.sessionId ?? '')
  if (!sessionId.startsWith('sess_')) {
    return { ok: false, reason: 'missing_session_id', detail: `sessionId=${sessionId || '(none)'}` }
  }
  const response = String(result.response ?? '')
  if (response.trim() === '') {
    return { ok: false, reason: 'empty_response', detail: 'the terminal record carried no response text' }
  }
  const status = result?.projection?.status
  if (status !== undefined && status !== 'idle') {
    return { ok: false, reason: 'non_idle_projection', detail: `projection.status=${String(status)}` }
  }
  return { ok: true, reason: null, detail: '' }
}

/** `SIGTERM` -> 15, `15` -> 15. Only used for the conventional status text. */
function signalNumber(signal) {
  const table = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
  if (typeof signal === 'number') return signal
  return table[String(signal)] ?? 0
}

/** Usage for the owner's terminal line; unknown stays unknown (M5). */
export function usageSummary(usage) {
  if (!usage || typeof usage !== 'object' || usage.source !== 'provider') {
    return 'usage: unknown'
  }
  const total = Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : undefined
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : undefined
  const requests = Number.isFinite(usage.modelRequestCount) ? usage.modelRequestCount : undefined
  const parts = []
  if (input !== undefined) parts.push(`in ${input}`)
  if (output !== undefined) parts.push(`out ${output}`)
  if (total !== undefined) parts.push(`total ${total}`)
  if (requests !== undefined) parts.push(`${requests} request${requests === 1 ? '' : 's'}`)
  return parts.length > 0 ? `usage: ${parts.join(', ')}` : 'usage: unknown'
}

/**
 * One run's worth of event mapping, correlated by job + session.
 *
 * `push(record)` turns a parsed stream record into zero or one relay event:
 * streaming deltas coalesce into a single "model streaming" line instead of one
 * Discord message per token, unknown record types still count as progress
 * without inventing meaning for them, and anything after the terminal record is
 * ignored — the run has one outcome, ever.
 */
export function createEventMapper({ jobId, runId, clip = redact } = {}) {
  if (typeof jobId !== 'string' || jobId === '') throw new Error('createEventMapper needs a jobId')
  if (typeof runId !== 'string' || runId === '') throw new Error('createEventMapper needs a runId')

  let seq = 0
  let sessionId = ''
  let terminal = undefined
  let recordedResult = undefined
  let sawStdout = false
  let streamingDeltas = 0
  let toolCalls = 0

  const emit = (kind, phase, text, extra = {}) => {
    seq += 1
    return {
      id: `${runId}:${seq}`,
      seq,
      jobId,
      runId,
      sessionId: sessionId || undefined,
      kind,
      phase,
      text,
      at: Date.now(),
      ...extra,
    }
  }

  return {
    /** The session id seen on the stream, once. Correlation, not decoration. */
    get sessionId() {
      return sessionId
    },
    get sawStdout() {
      return sawStdout
    },
    get terminalEmitted() {
      return terminal !== undefined
    },
    get result() {
      return terminal?.result ?? recordedResult
    },
    /** The stashed terminal record, before any outcome is decided. */
    get recordedResult() {
      return recordedResult
    },

    /** True when a line was consumed at all (the `empty_output` discriminator). */
    noteStdout() {
      sawStdout = true
    },

    /** Map one parsed record; returns an event or null. */
    push(record) {
      if (terminal !== undefined) return null
      if (record === null || typeof record !== 'object') return null
      sawStdout = true
      if (typeof record.sessionId === 'string' && record.sessionId.startsWith('sess_')) {
        sessionId = record.sessionId
      }
      const type = String(record.type ?? '')

      if (type === 'result') {
        // Stash it; do NOT emit the outcome here. Completion is exit code *and*
        // this record, and the exit code is only known when the child is gone
        // (M6). Emitting success from a stream line is exactly the bug HEADLESS
        // warns about ("a missing result is incomplete even if the process
        // reports status 0" — and a result with no exit status is the mirror).
        recordedResult = record
        return null
      }

      if (type === 'tool_use' || type === 'tool.started' || type.startsWith('tool.')) {
        toolCalls += 1
        const name = redact(record?.payload?.name ?? record?.payload?.toolName ?? 'tool', 60)
        return emit('progress', 'tool', `running ${name}`)
      }

      if (type === 'model.streaming') {
        streamingDeltas += 1
        // One line per phase change, not one per token.
        const kind = String(record?.payload?.kind ?? '')
        if (kind !== 'start' && kind !== 'end' && streamingDeltas !== 1) return null
        return emit('progress', 'streaming', `model streaming (${streamingDeltas} chunks)`)
      }

      const phase = PROGRESS_PHASES.get(type)
      if (phase !== undefined) {
        if (type === 'turn.completed') {
          const count = Number(record?.payload?.toolCallCount)
          const suffix = Number.isFinite(count) ? ` — ${count} tool call${count === 1 ? '' : 's'}` : ''
          return emit('progress', 'turn-completed', `turn completed${suffix}`)
        }
        return emit('progress', type, phase)
      }

      // Unrecognised record: the run is still alive, which is worth saying,
      // but its meaning is not ours to invent.
      return emit('progress', 'activity', `activity: ${redact(type || 'record', 60)}`)
    },

    /**
     * Emit the one terminal event. Idempotent: the first call wins, so a
     * provider error followed by a non-zero exit still yields a single outcome
     * with the first, most actionable cause.
     */
    finish(observation) {
      if (terminal !== undefined) return null
      const outcome = validateTerminal({
        sawStdout,
        ...observation,
        result: observation?.result ?? recordedResult ?? terminal?.result,
      })
      const result = observation?.result ?? recordedResult
      const usage = usageSummary(result?.usage)
      const excerpt = outcome.ok ? redact(result?.response ?? '', 200) : outcome.detail
      const head = outcome.ok
        ? `completed: ${excerpt}`
        : `failed (${outcome.reason}): ${excerpt}`
      terminal = { result, outcome }
      return emit('terminal', outcome.ok ? 'terminal-ok' : 'terminal-failed',
        `${head} \u2014 ${usage}`,
        {
          ok: outcome.ok,
          reason: outcome.reason,
          usage: result?.usage?.source === 'provider' ? result.usage : undefined,
          turnId: typeof result?.turnId === 'string' ? result.turnId : undefined,
        })
    },

    /** Events already emitted, for the caller's own bookkeeping. */
    counts() {
      return { seq, streamingDeltas, toolCalls }
    },
  }
}
