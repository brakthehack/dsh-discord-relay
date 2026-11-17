// Gate: bridge answer semantics (single/multi/custom, duplicate guard, 404/400).
// Run: node tests/bridge_answer.mjs
import assert from 'node:assert/strict'
import { RelayBridge } from '../dsh-relay-bundle/src/bridge.js'

const PORT = 8897
const bridge = new RelayBridge({
  host: '127.0.0.1', port: PORT, secret: 's', answerTimeoutMs: 600000, noPollTimeoutMs: 90000,
})
await bridge.start()
assert.equal(bridge.port, PORT, 'uncontested base port is used as-is')

const base = `http://127.0.0.1:${PORT}`
const ok = { 'content-type': 'application/json', 'x-relay-secret': 's' }
const call = async (path, body, headers = ok) => {
  const init = { method: body === undefined ? 'GET' : 'POST', headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(base + path, init)
  return { status: res.status, text: await res.text() }
}
let checks = 0

const health = await call('/v1/health')
assert.equal(health.status, 200)
assert.match(health.text, /"relay":"dsh-bridge"/)
assert.match(health.text, /"protocol":1/)
checks += 1
console.log('health                   ->', health.status, health.text)

// The identity handshake is what keeps a foreign service on the same port from
// being polled as if it were a bridge, so /v1/health must stay unauthenticated.
const pub = bridge.publish({
  requestId: 'req-1',
  question: { id: 'q1', question: 'Q?', options: [{ label: 'Red' }, { label: 'Green' }] },
})
const pending = await call('/v1/pending')
assert.equal(pending.status, 200)
assert.match(pending.text, new RegExp(pub.token))
assert.match(pending.text, /"multi_select":false/)
checks += 1
console.log('pending                  -> 200 (token visible to the relay only)')

assert.equal((await call('/v1/pending', undefined, { 'x-relay-secret': 'nope' })).status, 401)
assert.equal((await call('/v1/pending', undefined, {})).status, 401)
checks += 1
console.log('wrong secret             -> 401 unauthorized')

const answered = await call('/v1/answer', { token: pub.token, selected: ['Green'] })
assert.equal(answered.status, 200)
assert.match(answered.text, /"status":"resolved"/)
assert.match(answered.text, /"selected":\["Green"\]/)
checks += 1
console.log('answer by token          ->', answered.status, answered.text)

bridge.retain(pub.token)
const dup = await call('/v1/answer', { token: pub.token, selected: ['Red'] })
assert.equal(dup.status, 200)
assert.match(dup.text, /"status":"duplicate"/)
checks += 1
console.log('duplicate answer         ->', dup.status, dup.text)

const gone = await call('/v1/answer', { token: 'nosuchtoken', selected: ['Red'] })
assert.equal(gone.status, 404)
assert.match(gone.text, /no_such_pending_question/)
checks += 1
console.log('unknown token            ->', gone.status, gone.text)

const empty = await call('/v1/answer', { token: pub.token, selected: [] })
assert.ok(empty.status === 400 || empty.status === 404, `unexpected ${empty.status}`)
checks += 1
console.log('empty answer             ->', empty.status, empty.text)

// Routing by ids (no token) is the other half's happy path for a still-open
// question; multi-select plus a custom answer has to survive it.
const multi = bridge.publish({
  requestId: 'req-2',
  question: { id: 'q2', question: 'Which files?', options: [{ label: 'a.ts' }, { label: 'b.ts' }], multiSelect: true },
})
const byIds = await call('/v1/answer', { request_id: 'req-2', question_id: 'q2', selected: ['a.ts', 'b.ts'], custom: 'and c.ts' })
assert.equal(byIds.status, 200)
assert.match(byIds.text, /"status":"resolved"/)
assert.match(byIds.text, /"selected":\["a\.ts","b\.ts"\]/)
assert.match(byIds.text, /"custom":"and c.ts"/)
assert.ok(multi.record.answered, 'the ids path must settle the record too')
console.log('record keys              ->', JSON.stringify(Object.keys(multi.record)),
  'answer =', JSON.stringify(multi.record.answer ?? multi.record.resolution ?? null))
checks += 1
console.log('answer by ids (multi)    ->', byIds.status, byIds.text)

assert.equal((await call('/v1/nonsense')).status, 404)
checks += 1
console.log('unknown route            -> 404 no_route')

const after = await call('/v1/pending')
assert.deepEqual(JSON.parse(after.text).questions, [])
checks += 1
console.log('pending after resolves   -> 200 {"questions":[]}')

const stray = new RelayBridge({ host: '127.0.0.1', port: PORT + 1, answerTimeoutMs: 600000, noPollTimeoutMs: 90000 })
await stray.start()
const unc = await (async () => {
  const res = await fetch(`http://127.0.0.1:${stray.port}/v1/pending`, { headers: { 'x-relay-secret': 'x' } })
  return { status: res.status, text: await res.text() }
})()
assert.equal(unc.status, 503)
assert.match(unc.text, /bridge_unconfigured/)
checks += 1
console.log('no secret configured     ->', unc.status, unc.text)
await stray.stop()

bridge.drop('whatever')
await bridge.stop()
console.log(`all bridge_answer checks passed (${checks} checks)`)
