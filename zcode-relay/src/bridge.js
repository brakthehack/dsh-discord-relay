/**
 * The zcode-facing half of the bridge.
 *
 * The Discord side, the secret, the token, the exactly-once answer rule and the
 * duplicate/stale retention all stay exactly where they are — in
 * `dsh-relay-bundle/src/bridge.js`, which this class *extends*. What is added
 * here is the two things a zcode worker needs and a dsh worker never did:
 *
 *   POST /v1/ask     the owner-question round trip, entered by the run's own
 *                    MCP child instead of by an in-process tool,
 *   GET  /v1/events  the progress + terminal stream the Discord half drains,
 *   pushEvent()      the in-process door the runner uses to publish them.
 *
 * Both routes land *behind* the base class's constant-time secret check (the
 * `handleExtension` seam is reached only after auth), and `/v1/ask` additionally
 * requires the run token this bridge was constructed with: a question can only
 * come from the run that was given that token, which is what makes "the
 * owner's answer comes back to the right session" a property rather than a
 * hope (M9). Answers themselves are resolved by the inherited `POST /v1/answer`
 * path, so a duplicate answer is still a 200 `duplicate` echoing the winner and
 * a stale one is still a 404 — nothing about the answer contract is re-decided
 * here.
 *
 * @module zcode-relay/bridge
 */

import { RelayBridge } from '../../dsh-relay-bundle/src/bridge.js'
import { RelayError, normalizeAskArgs, runAsk } from '../../dsh-relay-bundle/src/ask.js'
import { labelize, truncate } from '../../dsh-relay-bundle/src/protocol.js'

/** Upper bounds so a wedged worker cannot grow the queue without limit. */
const PROGRESS_CAP = 200
const TERMINAL_CAP = 8
const MAX_BODY_BYTES = 256 * 1024

export const RUN_HEADER = 'x-relay-run'

function statusFor(code) {
  if (code === 'ASK_INVALID') return 400
  if (code === 'ASK_ABORTED') return 499
  if (code === 'RELAY_UNCONFIGURED' || code === 'RELAY_BIND_FAILED' || code === 'RELAY_STOPPED') return 503
  if (code === 'RELAY_NOT_POLLING') return 503
  if (code === 'RELAY_ANSWER_TIMEOUT') return 504
  return 502
}

/** Read + parse a JSON body, bounded. */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return undefined
  }
}

export class ZcodeBridge extends RelayBridge {
  /**
   * @param config   the shared relay config (host/port window/secret/timeouts)
   * @param options  `{runToken, jobId}` — identity of the single run this
   *                 bridge serves, plus queue bounds for tests.
   */
  constructor(config, { runToken, jobId, progressCap = PROGRESS_CAP, terminalCap = TERMINAL_CAP } = {}) {
    super(config)
    if (typeof runToken !== 'string' || runToken === '') throw new Error('ZcodeBridge needs a runToken')
    if (typeof jobId !== 'string' || jobId === '') throw new Error('ZcodeBridge needs a jobId')
    this.runToken = runToken
    this.jobId = jobId
    this.progressCap = progressCap
    this.terminalCap = terminalCap
    /** seq -> event. Terminals are never evicted before the cap below. */
    this.events = new Map()
    this.maxSeq = 0
    /** Ask calls currently in flight, so cancellation can be observed. */
    this.inFlight = new Set()
    /** When the Discord half last drained events; the host holds its port on
     *  this, so a terminal outcome is not dropped by a process that exits too
     *  early — and a gateway that is not running cannot hold it forever. */
    this.lastEventsPollAt = 0
  }

  /**
   * Stamp the correlation identity of *this* run onto every question.
   *
   * The shared ask path mints a fresh request id per call, which is right for a
   * dsh process asking twice and wrong here: with one run per bridge, the id
   * the answer comes back on has to name the job it belongs to. Overriding the
   * public seam is deliberate — the base class is untouched, and the
   * exactly-once/duplicate/stale logic that lives behind it is unchanged.
   */
  publish({ question }) {
    return super.publish({ requestId: `job:${this.jobId}`, question })
  }

  // ------------------------------------------------------------------ events
  /** Publish one mapped relay event (called in-process by the runner). */
  pushEvent(event) {
    if (event === null || typeof event !== 'object') return undefined
    const seq = Number(event.seq)
    if (!Number.isInteger(seq) || seq <= this.maxSeq) return undefined
    this.maxSeq = seq
    this.events.set(seq, { ...event, jobId: this.jobId })
    this.#evict()
    return event
  }

  /**
   * Keep the queue bounded without ever losing the outcome: progress is the
   * thing that may be dropped when a worker floods, the terminal record is not.
   */
  #evict() {
    const overflow = this.events.size - this.progressCap
    if (overflow <= 0) return
    const droppable = [...this.events.values()]
      .filter(entry => entry.kind !== 'terminal')
      .sort((a, b) => a.seq - b.seq)
      .slice(0, overflow)
    for (const entry of droppable) this.events.delete(entry.seq)
    const terminals = [...this.events.values()].filter(entry => entry.kind === 'terminal')
    if (terminals.length <= this.terminalCap) return
    for (const entry of terminals.slice(0, terminals.length - this.terminalCap)) {
      this.events.delete(entry.seq)
    }
  }

  /** Every event with `seq > after`, oldest first, capped. */
  drainEvents({ after = 0, limit = 50 } = {}) {
    const from = Number.isFinite(Number(after)) ? Number(after) : 0
    const size = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 200) : 50
    const picked = [...this.events.values()]
      .filter(entry => entry.seq > from)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, size)
    return { events: picked, maxSeq: this.maxSeq, jobId: this.jobId, pending: this.pendingSize() }
  }

  pendingSize() {
    return [...this.pending.values()].filter(record => !record.answered).length
  }

  /** Stand every unanswered ask down (cancellation / shutdown): bounded, never a hang. */
  abandonAsks(reason = 'run ended') {
    const tokens = [...this.pending.entries()].filter(([, record]) => !record.answered)
    for (const [token] of tokens) this.drop(token)
    for (const controller of this.inFlight) controller.abort(reason)
    this.inFlight.clear()
    return tokens.length
  }

  // -------------------------------------------------------------------- routes
  async handleExtension(req, res, route) {
    if (route === 'GET /v1/events') {
      const url = new URL(req.url ?? '/', `http://${this.config.host}`)
      const payload = this.drainEvents({
        after: url.searchParams.get('after') ?? 0,
        limit: url.searchParams.get('limit') ?? 50,
      })
      this.lastEventsPollAt = Date.now()
      this.lastPollAt = Date.now()
      this.#json(res, 200, payload)
      return true
    }

    if (route === 'POST /v1/ask') {
      if (!this.#sameRun(req)) {
        this.#json(res, 403, { ok: false, error: 'unknown_run' })
        return true
      }
      const body = await readJson(req)
      if (body === undefined) {
        this.#json(res, 400, { ok: false, error: 'bad_json' })
        return true
      }
      await this.#handleAsk(req, res, body)
      return true
    }

    return false
  }

  #sameRun(req) {
    const given = req.headers?.[RUN_HEADER]
    if (typeof given !== 'string' || given === '') return false
    if (given.length !== this.runToken.length) return false
    // The run token is not a credential, but a length-then-compare keeps a
    // timing oracle out of a header the child controls.
    let diff = 0
    for (let i = 0; i < given.length; i += 1) {
      diff |= given.charCodeAt(i) ^ this.runToken.charCodeAt(i)
    }
    return diff === 0
  }

  /**
   * The owner-question round trip. Normalisation, publishing, the wait, the
   * duplicate/stale retention and every failure code come from the shared ask
   * path — this only translates HTTP in and out, plus the run's correlation id.
   */
  async #handleAsk(req, res, body) {
    const normalized = normalizeAskArgs({ questions: body?.questions ?? body })
    if (!normalized.ok) {
      this.#json(res, 400, { ok: false, error: 'ask_invalid', message: normalized.message })
      return
    }
    if (normalized.notes.length > 0) {
      process.stderr.write(`[zcode-relay] repaired ask: ${normalized.notes.join('; ')}\n`)
    }
    const controller = new AbortController()
    this.inFlight.add(controller)
    const timeout = Number(body?.timeout_ms)
    const config = Number.isFinite(timeout) && timeout > 0
      ? { ...this.config, answerTimeoutMs: Math.min(timeout, this.config.answerTimeoutMs) }
      : this.config
    try {
      const result = await runAsk({
        bridge: this,
        config,
        questions: normalized.questions.map(question => ({
          ...question,
          question: truncate(question.question, 2000),
          header: question.header === undefined ? undefined : labelize(question.header, 60),
        })),
        signal: controller.signal,
      })
      this.#json(res, 200, { ok: true, job_id: this.jobId, answers: result.answers })
    } catch (error) {
      const code = error instanceof RelayError ? error.code : 'ASK_FAILED'
      this.#json(res, statusFor(code), {
        ok: false,
        error: code.toLowerCase(),
        message: error?.message ?? String(error),
      })
    } finally {
      this.inFlight.delete(controller)
    }
  }

  #json(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.length),
      'cache-control': 'no-store',
    })
    res.end(payload)
  }
}
