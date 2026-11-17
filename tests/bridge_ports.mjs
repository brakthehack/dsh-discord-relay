// Gate: concurrent bridges (finding 3, JS half). Two dsh processes sharing one
// base port must both come up, both answer health as a bridge, and both be
// individually answerable; a window that is fully held must fail loudly.
// Run: node tests/bridge_ports.mjs
import assert from 'node:assert/strict'
import { RelayBridge } from '../dsh-relay-bundle/src/bridge.js'
import { portsToTry, windowLabel, DEFAULT_PORT_SPAN, MAX_PORT_SPAN, BRIDGE_IDENTITY, PROTOCOL_VERSION } from '../dsh-relay-bundle/src/protocol.js'

const BASE = 8930
const SECRET = 'shared-secret'
const config = over => ({
  host: '127.0.0.1', port: BASE, portSpan: 4, secret: SECRET,
  configPath: '/tmp/dsh-relay-test-config.json',
  answerTimeoutMs: 600000, noPollTimeoutMs: 90000, ...over,
})

// --- window arithmetic ------------------------------------------------------
assert.deepEqual(portsToTry(config({ portSpan: 3 })), [BASE, BASE + 1, BASE + 2])
assert.equal(windowLabel(config({ portSpan: 3 })), `127.0.0.1:${BASE}-${BASE + 2}`)
assert.equal(windowLabel(config({ portSpan: 1 })), `127.0.0.1:${BASE}`)
assert.equal(portsToTry(config({ portSpan: 'nonsense' })).length, DEFAULT_PORT_SPAN)
assert.equal(portsToTry(config({ portSpan: 9999 })).length, MAX_PORT_SPAN)
assert.equal(portsToTry(config({ portSpan: 0 })).length, 1)

// --- two processes, one base port ------------------------------------------
const first = new RelayBridge(config({}))
const second = new RelayBridge(config({}))
await Promise.all([first.start(), second.start()])
assert.equal(first.port, BASE, 'the first bridge gets the base port')
assert.notEqual(second.port, first.port, 'the second must not collide with the first')
assert.ok(second.port > BASE && second.port < BASE + 4, `unexpected second port ${second.port}`)

for (const bridge of [first, second]) {
  const health = await (await fetch(`http://127.0.0.1:${bridge.port}/v1/health`)).json()
  assert.equal(health.relay, BRIDGE_IDENTITY, 'health must name the bridge identity')
  assert.equal(health.protocol, PROTOCOL_VERSION, 'health must carry the protocol version')
  assert.equal(health.port, bridge.port, 'health must report the port it actually bound')
  assert.equal(health.ok, true)
  assert.equal(health.pending, 0)
}

// Both are answerable through their own port, and only their own token.
const tokens = new Map()
for (const bridge of [first, second]) {
  const published = bridge.publish({
    requestId: `req-${bridge.port}`,
    question: { id: 'q1', question: `Which colour on ${bridge.port}?`, options: [{ label: 'Red' }] },
  })
  tokens.set(bridge.port, published.token)
  const seen = await (await fetch(`http://127.0.0.1:${bridge.port}/v1/pending`,
    { headers: { 'x-relay-secret': SECRET } })).json()
  assert.equal(seen.questions.length, 1)
  assert.equal(seen.questions[0].token, published.token)
}
const otherPending = await (await fetch(`http://127.0.0.1:${second.port}/v1/pending`,
  { headers: { 'x-relay-secret': SECRET } })).json()
assert.equal(otherPending.questions[0].question, `Which colour on ${second.port}?`,
  'one bridge must not serve another process\u2019s question')

for (const bridge of [first, second]) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-secret': SECRET },
    body: JSON.stringify({ token: tokens.get(bridge.port), selected: ['Red'] }),
  })
  assert.equal(response.status, 200, `answer to ${bridge.port} should resolve`)
  assert.equal((await response.json()).status, 'resolved')
  // A token belonging to the other process must not resolve here.
  const foreign = bridge.port === first.port ? second.port : first.port
  const wrong = await fetch(`http://127.0.0.1:${bridge.port}/v1/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-relay-secret': SECRET },
    body: JSON.stringify({ token: tokens.get(foreign), selected: ['Red'] }),
  })
  assert.equal(wrong.status, 404, 'a foreign token is unknown to this bridge, never a wrong answer')
}

// --- a held window fails loudly instead of silently -------------------------
// `first` holds BASE and `second` holds BASE+1, so a span-2 bridge has nowhere
// to go. It must raise, naming the window, rather than sit there unasked.
const blocked = new RelayBridge(config({ portSpan: 2 }))
let bindError
try {
  await blocked.start()
} catch (error) {
  bindError = error
}
assert.ok(bindError, 'a fully held window has to raise')
assert.match(bindError.message, /no free bridge port in 127\.0\.0\.1:8930-8931/)

// The failure is not a cached state: once room appears the same instance binds.
await first.stop()
for (let attempt = 0; blocked.port === undefined || !blocked.server; attempt += 1) {
  if (attempt > 40) break
  try {
    await blocked.start()
  } catch (error) {
    if (!/EADDRINUSE/.test(String(error?.message))) throw error
    await new Promise(resolve => setTimeout(resolve, 50)) // socket still closing
  }
}
assert.equal(blocked.port, BASE, 'after the base frees up, the same bridge binds it')

// A wider window still finds room while `second` keeps BASE+1.
const third = new RelayBridge(config({ portSpan: 4 }))
await third.start()
assert.equal(third.port, BASE + 2)

console.log(`bridge ports: base ${BASE} -> first ${first.port}, second ${second.port}, third ${third.port}; held window failed loudly`)
console.log('all bridge_ports checks passed')
await Promise.all([second.stop(), blocked.stop(), third.stop()])
