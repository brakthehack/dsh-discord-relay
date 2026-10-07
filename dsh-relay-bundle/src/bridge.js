/**
 * In-process HTTP bridge for the Discord relay, bound to 127.0.0.1 inside the
 * dsh process (no extra daemon).
 *
 * Wire protocol (every request except GET /v1/health requires header
 * `x-relay-secret` equal to DSH_RELAY_SECRET; comparison is constant time):
 *
 *   GET  /v1/health   -> { ok, pending, last_poll_age_ms }          (no auth)
 *   GET  /v1/pending  -> { questions: [ QuestionSpec ] }
 *   POST /v1/answer   <- { token } | { request_id, question_id },
 *                        { selected: string[], custom?: string }
 *                     -> 200 { ok, status: 'resolved' | 'duplicate', ... }
 *                     -> 404 unknown token, 410 expired, 400 bad body
 *
 * Exactly-once: the first accepted answer wins; every later answer for the
 * same token gets 200 `status: 'duplicate'` with the winning answer echoed so
 * the relay can re-stamp its message instead of erroring.
 *
 * @module dsh-relay-bundle/bridge
 */

import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { labelize, shortToken, truncate, MESSAGE_CONTENT_LIMIT } from './protocol.js'

const MAX_BODY_BYTES = 64 * 1024
/** How long an answered question stays known so a duplicate click is idempotent. */
const RETAIN_MS = 120000
/** Cap on retained answered records (oldest go first). */
const RETAINED_MAX = 50

function log(...args) {
  process.stderr.write(`[dsh-relay] ${args.join(' ')}\n`)
}

function secretEquals(expected, given) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** One question awaiting a human answer. */
class Pending {
  constructor(record) {
    Object.assign(this, record)
    this.answered = false
    this.answer = undefined
    /** Awaiting callers (each is resolved exactly once with an outcome). */
    this.waiters = new Set()
    /** Set when an answered record starts its duplicate-guard retention. */
    this.resolvedAt = 0
  }

  settleWaiters(outcome) {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter(outcome)
    }
  }
}

export class RelayBridge {
  constructor(config) {
    this.config = config
    this.pending = new Map()
    this.lastPollAt = 0
    this.server = undefined
    this.ready = undefined
    this.closed = false
  }

  /** Bind the socket; resolves once listening, rejects on bind failure. */
  start() {
    if (this.ready !== undefined) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.#handle(req, res).catch(error => {
          log('handler error', error?.message ?? error)
          this.#json(res, 500, { ok: false, error: 'bridge_error' })
        })
      })
      server.once('error', error => {
        this.ready = undefined
        reject(error)
      })
      // 127.0.0.1 only: never reachable off-box.
      server.listen(this.config.port, '127.0.0.1', () => resolve(server))
      this.server = server
    })
    return this.ready
  }

  async stop() {
    this.closed = true
    for (const record of this.pending.values()) {
      if (!record.answered) {
        record.answered = true
        record.answer = undefined
      }
      record.settleWaiters({ status: 'abandoned', record })
    }
    this.pending.clear()
    const server = this.server
    this.server = undefined
    if (server) await new Promise(resolve => server.close(() => resolve()))
  }

  get everPolled() {
    return this.lastPollAt > 0
  }

  /** Publish one question; the promise settles on answer / expiry / stop. */
  publish({ requestId, question }) {
    const token = shortToken(randomUUID())
    const record = new Pending({
      token,
      requestId,
      id: question.id,
      question: truncate(question.question, MESSAGE_CONTENT_LIMIT),
      header: question.header === undefined ? undefined : labelize(question.header, 60),
      options: (question.options ?? []).map(option => ({
        label: labelize(option.label),
        description: option.description === undefined
          ? undefined
          : truncate(option.description, 100),
      })),
      multiSelect: question.multiSelect === true || question.multi_select === true,
      createdAt: Date.now(),
    })
    this.pending.set(token, record)
    return { token, record }
  }

  /**
   * Keep an answered question known for a short window so a duplicate or late
   * relay POST is answered idempotently (200 duplicate) instead of 404.
   */
  retain(token) {
    const record = this.pending.get(token)
    if (record === undefined) return
    record.resolvedAt = Date.now()
    const answered = [...this.pending.values()].filter(r => r.answered && r.resolvedAt > 0)
    if (answered.length > RETAINED_MAX) {
      answered.sort((a, b) => a.resolvedAt - b.resolvedAt)
      for (const stale of answered.slice(0, answered.length - RETAINED_MAX)) this.pending.delete(stale.token)
    }
  }

  /** Forget answered records whose retention window has passed. */
  #prune() {
    const cutoff = Date.now() - RETAIN_MS
    for (const record of [...this.pending.values()]) {
      if (record.answered && record.resolvedAt > 0 && record.resolvedAt <= cutoff) {
        this.pending.delete(record.token)
      }
    }
  }

  /** Remove a question that was never answered (abort / failure path). */
  drop(token) {
    this.pending.delete(token)
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

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${this.config.host}`)
    const route = `${req.method} ${url.pathname}`
    this.#prune()

    if (route === 'GET /v1/health') {
      this.#json(res, 200, {
        ok: true,
        pending: [...this.pending.values()].filter(r => !r.answered).length,
        last_poll_age_ms: this.lastPollAt === 0 ? null : Date.now() - this.lastPollAt,
      })
      return
    }

    if (this.config.secret === '') {
      this.#json(res, 503, {
        ok: false,
        error: 'bridge_unconfigured: ' + (this.config.configError?.split('\n')[0]
          ?? `no shared secret in ${this.config.configPath ?? 'the relay config file'}`),
      })
      return
    }
    if (!secretEquals(this.config.secret, req.headers['x-relay-secret'])) {
      this.#json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    if (route === 'GET /v1/pending') {
      this.lastPollAt = Date.now()
      this.#json(res, 200, {
        questions: [...this.pending.values()].filter(r => !r.answered).map(r => ({
          token: r.token,
          request_id: r.requestId,
          question_id: r.id,
          question: r.question,
          ...(r.header === undefined ? {} : { header: r.header }),
          options: r.options,
          multi_select: r.multiSelect,
          created_at_ms: r.createdAt,
        })),
      })
      return
    }

    if (route === 'POST /v1/answer') {
      const body = await this.#readJson(req)
      if (body === undefined) {
        this.#json(res, 400, { ok: false, error: 'bad_json' })
        return
      }
      this.lastPollAt = Date.now()
      this.#json(res, ...this.#answer(body))
      return
    }

    this.#json(res, 404, { ok: false, error: 'no_route', route })
  }

  #answer(body) {
    const selected = Array.isArray(body.selected)
      ? body.selected.map(item => labelize(item)).filter(Boolean)
      : []
    const custom = typeof body.custom === 'string' ? truncate(body.custom.trim(), 2000) : ''
    if (selected.length === 0 && custom === '') {
      return [400, { ok: false, error: 'empty_answer' }]
    }

    let record
    if (typeof body.token === 'string' && body.token !== '') {
      record = this.pending.get(body.token)
    } else if (typeof body.request_id === 'string' && typeof body.question_id === 'string') {
      record = [...this.pending.values()].find(
        r => r.requestId === body.request_id && r.id === body.question_id)
    }
    if (record === undefined) {
      return [404, { ok: false, error: 'no_such_pending_question' }]
    }
    if (record.answered) {
      // Idempotent rejection of duplicate / late answers.
      return [200, {
        ok: true,
        status: 'duplicate',
        token: record.token,
        answer: record.answer ?? { selected: [], custom: '(already resolved)' },
      }]
    }

    // single-select: a typed (custom) answer overrides the button choice;
    // multi-select: custom supplements the clicked options.
    const chosen = (custom !== '' && !record.multiSelect) ? [] : selected
    record.answered = true
    record.answer = {
      question_id: record.id,
      selected: chosen,
      ...(custom === '' ? {} : { custom }),
    }
    record.settleWaiters({ status: 'answered', record })
    return [200, {
      ok: true,
      status: 'resolved',
      token: record.token,
      answer: { selected: chosen, ...(custom === '' ? {} : { custom }) },
    }]
  }

  async #readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(chunk)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      return undefined
    }
  }
}

export { log as bridgeLog }
