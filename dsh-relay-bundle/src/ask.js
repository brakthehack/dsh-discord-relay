/**
 * The ask path, kept free of Cordis so it is testable on its own.
 *
 * Three jobs, in the order the gap report needed them:
 *
 * 1. `normalizeAskArgs` — repair what the model sends before anything can
 *    reject it. The dropped questions in the incident were argument-validation
#    rejections (`missing required property "questions[0].id"`): a required `id`
 *    is a wire detail, and an ask eaten by the validator is a question nobody
 *    ever saw. So `id` is optional here and synthesized when absent, and only
 *    genuinely unaskable input fails — with a message the agent can act on.
 * 2. `askViaBridge` — the Discord half: publish, wait, report every failure
 *    with a code and a fix.
 * 3. `runAsk` — compose the Discord bridge with whatever local answer surface
 *    the profile already has (the app's own question card). Both surfaces see
 *    the question; the first real answer wins and the other is stood down.
 *    A failure on one surface is not a failure of the ask: it is only a
 *    failure when every surface has failed, and then the agent is told so.
 *
 * @module dsh-relay-bundle/ask
 */

import { randomUUID } from 'node:crypto'

import { windowLabel } from './protocol.js'

/** An ask that did not reach an answer; `code` is the machine-readable half. */
export class RelayError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RelayError'
    this.code = code
  }
}

/** Ask-gate codes: the local surface refused to ask, so it is not a rival. */
export const LOCAL_GATE_CODES = new Set([
  'EMPTY_QUESTIONS',
  'CALLER_NOT_LIVE',
  'DELEGATED_CALLER',
  'BAD_INTENT',
  'NO_PROVIDER',
  'ASK_MISSING_AGENT',
])

/** Bridge-unusable codes: Discord was never going to deliver anything. */
export const DELEGATABLE_CODES = new Set([
  'RELAY_UNCONFIGURED',
  'RELAY_BIND_FAILED',
  'RELAY_STOPPED',
  'RELAY_NOT_POLLING',
])

function failureCode(status) {
  if (status === 'no_relay') return 'RELAY_NOT_POLLING'
  if (status === 'timeout') return 'RELAY_ANSWER_TIMEOUT'
  if (status === 'aborted') return 'ASK_ABORTED'
  return 'RELAY_ABANDONED'
}

/** "900 milliseconds" / "1.5 seconds" / "10 minutes", for failure prose. */
function duration(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (value < 1000) return `${Math.round(value)} milliseconds`
  if (value < 90000) return `${value < 10000 ? (value / 1000).toFixed(1) : Math.round(value / 1000)} seconds`
  return `${Math.round(value / 60000)} minutes`
}

/** Why the wait ended, phrased so an agent can act rather than guess. */
export function describeFailure(status, config, token) {
  if (status === 'aborted') return 'ask_user_question was aborted before the owner answered'
  if (status === 'timeout') {
    return `the owner did not answer within ${duration(config.answerTimeoutMs)} `
      + '(proceed with your best judgement and state the assumption)'
  }
  if (status === 'no_relay') {
    return 'no running Hermes Discord relay is polling this bridge (nothing reached the owner on any port of '
      + `${windowLabel(config)}, so the question was NOT delivered to Discord; start the gateway, or run `
      + `install.sh and restart it; config: ${config.configPath}). `
      + 'Do not assume the owner saw it: re-ask once the relay is up, or state the assumption you made'
  }
  return `question ${token} was abandoned (the relay bridge is shutting down)`
}

/** Answer record -> tool answer item, keeping the caller's question id. */
function toAnswerItem(record) {
  const selected = Array.isArray(record.answer?.selected) ? record.answer.selected : []
  const custom = record.answer?.custom
  if (record.multiSelect) {
    return { id: record.id, selected, ...(custom === undefined ? {} : { custom }) }
  }
  if (custom !== undefined) return { id: record.id, selected: [], custom }
  return { id: record.id, selected }
}

/** Wait for one record to be answered, or report the first failure cause. */
export function awaitOutcome(bridge, record, { deadline, noPollDeadline, signal }) {
  return new Promise(resolve => {
    let settled = false
    const finish = outcome => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    record.waiters.add(finish)
    const tick = () => {
      if (settled) return
      const now = Date.now()
      if (signal?.aborted) return finish({ status: 'aborted' })
      if (now >= deadline) return finish({ status: 'timeout' })
      if (!bridge.everPolled && now >= noPollDeadline) return finish({ status: 'no_relay' })
      setTimeout(tick, 250).unref?.()
    }
    tick()
  })
}

/* ------------------------------------------------------------------ *
 * Argument repair: a validation rejection must never eat a question
 * ------------------------------------------------------------------ */

const MAX_QUESTIONS = 25
const MAX_OPTIONS = 25

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanId(value, limit = 64) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim().replace(/\s+/g, '-')
  return text === '' ? undefined : text.slice(0, limit)
}

/**
 * Repair tool arguments into the canonical internal question shape.
 *
 * Returns `{ ok: true, questions, notes }` — `notes` records every repair, so
 * the agent can see what was inferred — or `{ ok: false, message }` naming the
 * one thing to fix. Never throws, never echoes the payload back.
 */
export function normalizeAskArgs(raw) {
  let value = raw
  let parsedFrom = ''
  // {questions: "<json>"} is the same shape with the array left as a string.
  if (isRecord(value) && typeof value.questions === 'string') value = value.questions
  if (typeof value === 'string') {
    const text = value.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
    try {
      value = JSON.parse(text)
      parsedFrom = 'questions arrived as a JSON string and were parsed'
    } catch {
      return { ok: false, message: 'questions must be JSON, not a code-fenced or truncated string' }
    }
  }
  // One question sent bare, or wrapped in an object, is still one question.
  if (isRecord(value) && typeof value.question === 'string') value = [value]
  else if (isRecord(value) && Array.isArray(value.questions)) value = value.questions
  if (!Array.isArray(value)) {
    return { ok: false, message: 'questions must be an array of {question, header?, options?, multi_select?}' }
  }
  if (value.length === 0) return { ok: false, message: 'questions must contain at least one question' }

  const notes = []
  const used = new Set()
  const questions = []
  for (const [index, item] of value.entries()) {
    if (questions.length >= MAX_QUESTIONS) {
      notes.push(`only the first ${MAX_QUESTIONS} questions are asked`)
      break
    }
    if (!isRecord(item)) {
      notes.push(`questions[${index}] is not an object and was skipped`)
      continue
    }
    const text = typeof item.question === 'string'
      ? item.question
      : (typeof item.text === 'string' ? item.text : '')
    if (text.trim() === '') {
      notes.push(`questions[${index}] has no "question" text and was skipped`)
      continue
    }

    let id = cleanId(item.id)
    if (id === undefined) {
      notes.push(`questions[${index}].id was missing; asked as "q${index + 1}"`)
      id = `q${index + 1}`
    }
    if (used.has(id)) {
      notes.push(`questions[${index}].id "${id}" was a duplicate; asked as "${id}-${index + 1}"`)
      id = `${id}-${index + 1}`
    }
    used.add(id)

    const question = { id, question: text.trim(), multiSelect: item.multi_select === true || item.multiSelect === true }
    const header = typeof item.header === 'string' ? item.header.trim() : ''
    if (header !== '') question.header = header.slice(0, 60)
    const options = normalizeOptions(item.options, notes, index)
    if (options.length > 0) question.options = options
    questions.push(question)
  }

  if (questions.length === 0) {
    return {
      ok: false,
      message: 'no usable question: each needs a "question" string '
        + '(shape: {id?, question, header?, options?: [{label, description?}], multi_select?})',
    }
  }
  if (parsedFrom !== '') notes.unshift(parsedFrom)
  return { ok: true, questions, notes }
}

function normalizeOptions(value, notes, index) {
  if (value === undefined || value === null || value === '') return []
  let options = value
  if (typeof options === 'string') {
    try {
      options = JSON.parse(options)
    } catch {
      options = options.split('\n')
    }
  }
  if (!Array.isArray(options)) {
    notes.push(`questions[${index}].options is not a list and was ignored`)
    return []
  }
  const out = []
  for (const option of options) {
    if (out.length >= MAX_OPTIONS) {
      notes.push(`questions[${index}] offered more than ${MAX_OPTIONS} options; the rest were dropped`)
      break
    }
    if (typeof option === 'string') {
      const label = option.trim()
      if (label !== '') out.push({ label })
      continue
    }
    if (!isRecord(option)) continue
    const label = typeof option.label === 'string'
      ? option.label.trim()
      : (typeof option.value === 'string' ? option.value.trim() : '')
    if (label === '') continue
    const description = typeof option.description === 'string' ? option.description.trim() : ''
    out.push(description === '' ? { label } : { label, description })
  }
  if (options.length > 0 && out.length === 0) {
    notes.push(`questions[${index}].options had no usable "label" and was ignored`)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * The answer surfaces
 * ------------------------------------------------------------------ */

/**
 * Ask over Discord through the in-process bridge: publish every question, wait
 * for the owner's answers in order, retain answered records (idempotent
 * duplicates) and drop unanswered ones so a stood-down prompt can never be
 * answered into the wrong request.
 */
export async function askViaBridge({ bridge, config, bindFailure, questions, signal }) {
  if (bindFailure !== undefined) throw bindFailure
  if (bridge.closed) throw new RelayError('the Discord relay bridge is shutting down', 'RELAY_STOPPED')
  if (signal?.aborted) {
    throw new RelayError('ask_user_question was aborted before the owner answered', 'ASK_ABORTED')
  }
  // Let the socket finish binding: asks fired in the first tick are common.
  try {
    await bridge.start()
  } catch (error) {
    throw new RelayError(
      `the Discord relay bridge could not bind any port of ${windowLabel(config)} (${error?.message ?? error})`,
      'RELAY_BIND_FAILED')
  }

  const requestId = randomUUID()
  const published = questions.map(question => bridge.publish({ requestId, question }))
  const deadline = Date.now() + config.answerTimeoutMs
  const noPollDeadline = Date.now() + config.noPollTimeoutMs
  try {
    const answers = []
    for (const entry of published) {
      const outcome = await awaitOutcome(bridge, entry.record, { deadline, noPollDeadline, signal })
      if (outcome.status !== 'answered') {
        throw new RelayError(describeFailure(outcome.status, config, entry.token), failureCode(outcome.status))
      }
      answers.push(toAnswerItem(entry.record))
    }
    return { answers }
  } finally {
    for (const entry of published) {
      if (entry.record.answered) bridge.retain(entry.token)
      else bridge.drop(entry.token)
    }
  }
}

/** One settled attempt at one surface. */
function attempt(source, promise) {
  return Promise.resolve(promise).then(
    value => ({ source, ok: true, value }),
    error => ({ source, ok: false, error: asError(error) }),
  )
}

function asError(error) {
  if (error instanceof Error) return error
  return new RelayError(String(error ?? 'unknown failure'), 'ASK_FAILED')
}

/** The relay is out of the running, so whatever stays is the answer path. */
function isGateFailure(outcome) {
  return outcome.source === 'local' && LOCAL_GATE_CODES.has(outcome.error?.code)
}

/**
 * Ask wherever this profile can ask.
 *
 * `localAsk` (optional) drives the profile's own answer surface, when it has
 * one; `askViaBridge` always runs, because "the operator is at Discord" is the
 * case this bundle exists for. The first surface to actually answer wins and
 * the other is stood down: the local card through the same abort path an
 * in-app cancel uses, the Discord prompt by dropping it from the bridge.
 *
 * A failure on one surface never cancels the other, and a question is never
 * reported as answered because the other half was convenient. If every
 * surface fails, the agent gets the reasons, preferring the one it can act on.
 */
export async function runAsk({ bridge, config, bindFailure, questions, signal, localAsk }) {
  const controllers = {
    remote: childController(signal),
    local: childController(signal),
  }
  // One attempt per surface, keyed by source so a settled outcome can remove it.
  const open = new Map([
    ['remote', attempt('remote', askViaBridge({
      bridge, config, bindFailure, questions, signal: controllers.remote.signal,
    }))],
  ])
  if (localAsk !== undefined) {
    open.set('local', attempt('local', Promise.resolve().then(() => localAsk(questions, controllers.local.signal))))
  }

  const failures = []
  let winner
  while (winner === undefined) {
    const outcome = await Promise.race([...open.values()])
    open.delete(outcome.source)
    if (outcome.ok) {
      winner = outcome
      break
    }
    failures.push(outcome)
    // A surface that cannot even ask is out of the running, not a failure of
    // the ask; keep waiting on the one that can.
    if (open.size === 0) break
  }

  if (winner !== undefined) {
    // Stand the losing surface down, then report the winner's answer.
    if (winner.source === 'remote') controllers.local.abort('answered over Discord')
    else controllers.remote.abort('answered in the app')
    settleLooseEnds(open)
    return winner.value
  }

  const meaningful = failures.filter(outcome => !isGateFailure(outcome))
  const chosen = meaningful.length > 0 ? meaningful : failures
  if (chosen.length === 0) {
    throw new RelayError('the question reached no answer surface', 'ASK_NO_SURFACE')
  }
  if (chosen.length === 1 || sameReason(chosen)) throw chosen[0].error
  throw new RelayError(
    `no answer surface could deliver this question: ${describeAll(chosen)}`,
    preferredCode(chosen),
  )
}

/** Attach the loser's late rejection so nothing surfaces as an unhandled error. */
function settleLooseEnds(open) {
  for (const entry of open.values()) Promise.resolve(entry).catch(() => {})
}

function sameReason(outcomes) {
  return new Set(outcomes.map(outcome => outcome.error?.code)).size === 1
}

function describeAll(outcomes) {
  const seen = new Set()
  const parts = []
  for (const outcome of outcomes) {
    const message = outcome.error?.message ?? 'unknown failure'
    if (seen.has(message)) continue
    seen.add(message)
    parts.push(`${outcome.source === 'remote' ? 'discord' : 'local surface'}: ${message}`)
  }
  return parts.join(' | ')
}

/** The code that says most about what to fix: a real delivery failure beats a gate or an abort. */
function preferredCode(outcomes) {
  const codes = outcomes.map(outcome => outcome.error?.code).filter(Boolean)
  return codes.find(code => !DELEGATABLE_CODES.has(code) && code !== 'ASK_ABORTED' && code !== 'ASK_NO_SURFACE')
    ?? codes[0] ?? 'ASK_NO_SURFACE'
}

/** An AbortController that follows an outer signal, for standing one surface down. */
function childController(parent) {
  const child = new AbortController()
  if (parent?.aborted) child.abort(parent.reason)
  else parent?.addEventListener('abort', () => child.abort(parent.reason), { once: true })
  const abort = child.abort.bind(child)
  child.abort = reason => {
    if (!child.signal.aborted) abort(reason)
  }
  return child
}
