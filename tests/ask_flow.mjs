// Gate: the ask path (findings 1 + 2). Argument repair must never lose a
// question, and the Discord bridge and the profile's own answer surface must
// race with exactly one winner and a loud, specific failure when neither works.
// Run: node tests/ask_flow.mjs
import assert from 'node:assert/strict'
import { normalizeAskArgs, runAsk, RelayError, LOCAL_GATE_CODES } from '../dsh-relay-bundle/src/ask.js'

const BASE = 8970
const config = over => ({
  host: '127.0.0.1', port: BASE, portSpan: 20, secret: 's',
  configPath: '/tmp/dsh-relay-test-config.json',
  answerTimeoutMs: 600000, noPollTimeoutMs: 300, ...over,
})

/* A stand-in for RelayBridge: same publish/retain/drop/everPolled contract,
 * without a socket, so the race logic is what is being tested. */
class FakeBridge {
  constructor({ everPolled = true, failStart = false } = {}) {
    this.port = BASE
    this.everPolled = everPolled
    this.failStart = failStart
    this.closed = false
    this.pending = new Map()
    this.retained = []
    this.dropped = []
    this.published = []
  }

  async start() {
    if (this.failStart) {
      const error = new Error('no free bridge port in 127.0.0.1:8970-8989 (EADDRINUSE)')
      error.code = 'EADDRINUSE'
      throw error
    }
  }

  publish({ requestId, question }) {
    const token = `tok-${this.pending.size + 1}`
    const record = {
      token,
      requestId,
      id: question.id,
      question: question.question,
      multiSelect: question.multiSelect === true,
      answered: false,
      answer: undefined,
      waiters: new Set(),
      settleWaiters(outcome) {
        for (const waiter of [...this.waiters]) {
          this.waiters.delete(waiter)
          waiter(outcome)
        }
      },
    }
    this.pending.set(token, record)
    this.published.push(question)
    return { token, record }
  }

  /** What POST /v1/answer does to a record. */
  answer(token, selected, custom) {
    const record = this.pending.get(token)
    record.answered = true
    record.answer = { question_id: record.id, selected, ...(custom === undefined ? {} : { custom }) }
    record.settleWaiters({ status: 'answered', record })
  }

  retain(token) { this.retained.push(token) }
  drop(token) { this.dropped.push(token); this.pending.delete(token) }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// The real bridge owns a listening socket, so its poll loop's timers can be
// unref'd; with a fake bridge this interval stands in for that socket.
const keepEventLoopAlive = setInterval(() => {}, 1000)
const code = async promise => promise.then(() => 'resolved', error => error?.code ?? 'unknown')
const text = async promise => promise.then(() => 'resolved', error => String(error?.message))

/* ---------------------------------------------------------------- arg repair */
{
  const repaired = normalizeAskArgs({ questions: [
    { question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Green' }] },
    { id: 'ship', question: 'Ship it?', multi_select: true, options: 'yes\nno' },
    { id: 'ship', question: 'Duplicate id?' },
  ] })
  assert.equal(repaired.ok, true)
  assert.equal(repaired.questions.length, 3)
  assert.equal(repaired.questions[0].id, 'q1', 'a missing id is synthesized, not rejected')
  assert.deepEqual(repaired.questions[0].options, [{ label: 'Red' }, { label: 'Green' }])
  assert.deepEqual(repaired.questions[1].options, [{ label: 'yes' }, { label: 'no' }])
  assert.equal(repaired.questions[1].multiSelect, true)
  assert.notEqual(repaired.questions[2].id, repaired.questions[1].id, 'ids must stay unique per request')
  assert.ok(repaired.notes.length >= 2, 'every repair is reported to the asking agent')
}
{
  // The finding-2 shape itself: no id at all, nothing else to fix.
  const one = normalizeAskArgs({ questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] })
  assert.equal(one.ok, true)
  assert.equal(one.questions[0].id, 'q1')
}
{
  // A JSON string of questions is a repair, not a rejection.
  const fenced = normalizeAskArgs({ questions: '```json\n[{"question":"Fenced?"}]\n```' })
  assert.equal(fenced.ok, true, `fenced JSON should repair, got ${JSON.stringify(fenced)}`)
  assert.equal(fenced.questions[0].question, 'Fenced?')
  assert.ok(fenced.notes.some(note => /json/i.test(note)))
}
{
  assert.equal(normalizeAskArgs({}).ok, false)
  assert.equal(normalizeAskArgs({ questions: [] }).ok, false)
  assert.equal(normalizeAskArgs({ questions: [{ header: 'no text' }] }).ok, false)
  const truncated = normalizeAskArgs({ questions: '[{"question":"cut of' })
  assert.equal(truncated.ok, false)
  assert.match(truncated.message, /json/i, 'the shape error says what is wrong with the arguments')
}

/* ------------------------------------------------------------------- races */
{
  // Remote (Discord) answers; the answer is retained so a duplicate click is
  // reported, not re-delivered.
  const bridge = new FakeBridge()
  const running = runAsk({
    bridge,
    config: config({}),
    questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'Red' }, { label: 'Green' }] }],
  })
  await delay(20)
  assert.equal(bridge.published.length, 1)
  bridge.answer('tok-1', ['Green'])
  const result = await running
  assert.deepEqual(result, { answers: [{ id: 'color', selected: ['Green'] }] })
  assert.deepEqual(bridge.retained, ['tok-1'])
  assert.deepEqual(bridge.dropped, [])
}
{
  // A custom (typed) answer of a multi-select supplements the clicked labels.
  const bridge = new FakeBridge()
  const running = runAsk({
    bridge,
    config: config({}),
    questions: [{ id: 'm', question: 'Which?', multiSelect: true, options: [{ label: 'A' }] }],
  })
  await delay(20)
  bridge.answer('tok-1', ['A'], 'and also B')
  assert.deepEqual((await running).answers, [{ id: 'm', selected: ['A'], custom: 'and also B' }])
}
{
  // Nothing polls the bridge: loud, specific, and it names the port window.
  const bridge = new FakeBridge({ everPolled: false })
  const message = await text(runAsk({
    bridge,
    config: config({ noPollTimeoutMs: 100 }),
    questions: [{ id: 'q1', question: 'Anyone there?' }],
  }))
  assert.match(message, new RegExp(`127\\.0\\.0\\.1:${BASE}-${BASE + 19}`))
  assert.match(message, /NOT delivered/i)
  assert.equal(await code(runAsk({
    bridge: new FakeBridge({ everPolled: false }),
    config: config({ noPollTimeoutMs: 100 }),
    questions: [{ id: 'q1', question: 'Anyone there?' }],
  })), 'RELAY_NOT_POLLING')
}
{
  // No port left in the window: still loud, still specific.
  const message = await text(runAsk({
    bridge: new FakeBridge({ failStart: true }),
    config: config({}),
    bindFailure: undefined,
    questions: [{ id: 'q1', question: 'Bind me' }],
  }))
  assert.match(message, /no free bridge port in 127\.0\.0\.1:8970-8989/)
}
{
  // The profile owns an answer surface and it wins: Discord is stood down.
  const bridge = new FakeBridge()
  const local = async questions => ({ answers: questions.map(q => ({ id: q.id, selected: ['local'] })) })
  const result = await runAsk({
    bridge,
    config: config({}),
    questions: [{ id: 'q1', question: 'Local or Discord?' }],
    localAsk: local,
  })
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['local'] }])
  await delay(400)
  assert.equal(bridge.pending.size, 0, 'the Discord prompt must be dropped when the app answers')
  assert.equal(bridge.retained.length, 0, 'an unanswered Discord prompt is dropped, not retained')
}
{
  // Discord wins against a local surface that never resolves.
  const bridge = new FakeBridge()
  let localSignal
  const running = runAsk({
    bridge,
    config: config({}),
    questions: [{ id: 'q1', question: 'Local or Discord?' }],
    localAsk: (questions, signal) => new Promise((resolve, reject) => {
      localSignal = signal
      signal.addEventListener('abort', () => reject(new Error('cancelled by the app')))
    }),
  })
  await delay(20)
  bridge.answer('tok-1', ['Discord'])
  assert.deepEqual((await running).answers, [{ id: 'q1', selected: ['Discord'] }])
  assert.equal(localSignal.aborted, true, 'the losing local surface is aborted')
}
{
  // A local surface that cannot ask (a gate code) must not shadow Discord.
  assert.ok(LOCAL_GATE_CODES.size > 0)
  const gateCode = [...LOCAL_GATE_CODES][0]
  for (const gate of [gateCode, 'NO_PROVIDER']) {
    const bridge = new FakeBridge()
    const running = runAsk({
      bridge,
      config: config({}),
      questions: [{ id: 'q1', question: 'Gate?' }],
      localAsk: () => { const error = new Error('local surface declined'); error.code = gate; throw error },
    })
    await delay(30)
    bridge.answer('tok-1', ['Red'])
    assert.deepEqual((await running).answers, [{ id: 'q1', selected: ['Red'] }], `${gate} must stay a gate`)
  }
}
{
  // Both surfaces broken: the agent hears about both, in one message.
  const bridge = new FakeBridge({ everPolled: false })
  const error = await runAsk({
    bridge,
    config: config({ noPollTimeoutMs: 100 }),
    questions: [{ id: 'q1', question: 'Nobody answers' }],
    localAsk: () => { throw new Error('app surface is gone') },
  }).then(() => undefined, caught => caught)
  assert.ok(error instanceof RelayError)
  assert.match(error.message, /no answer surface/i)
  assert.match(error.message, /discord:/i)
  assert.match(error.message, /local surface: app surface is gone/)
  assert.match(error.message, /NOT delivered/)
  assert.equal(error.code, 'RELAY_NOT_POLLING', 'the remote cause carries the code when the local one is generic')
}
{
  // The caller aborting (user cancelled the turn) is reported as a cancel.
  const bridge = new FakeBridge()
  const controller = new AbortController()
  const running = runAsk({
    bridge,
    config: config({}),
    questions: [{ id: 'q1', question: 'Cancel me' }],
    signal: controller.signal,
  })
  await delay(20)
  controller.abort()
  assert.equal(await code(running), 'ASK_ABORTED')
  assert.deepEqual(bridge.dropped, ['tok-1'])
}
{
  // An answer timeout is a timeout, named with the config path to fix.
  const bridge = new FakeBridge()
  const error = await runAsk({
    bridge,
    config: config({ answerTimeoutMs: 1500, noPollTimeoutMs: 20 }),
    questions: [{ id: 'q1', question: 'Slow owner' }],
  }).then(() => undefined, caught => caught)
  assert.equal(error.code, 'RELAY_ANSWER_TIMEOUT')
  assert.match(error.message, /1\.5 seconds/)
  assert.match(error.message, /best judgement/)
}

clearInterval(keepEventLoopAlive)
console.log('all ask_flow checks passed')
