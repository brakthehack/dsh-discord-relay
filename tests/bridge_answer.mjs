// Gate: bridge answer semantics (single/multi/custom, duplicate guard, 404/400).
// Run: node tests/bridge_answer.mjs
import { RelayBridge } from '../dsh-relay-bundle/src/bridge.js'
const bridge = new RelayBridge({ host: '127.0.0.1', port: 8897, secret: 's', answerTimeoutMs: 600000, noPollTimeoutMs: 90000 })
await bridge.start()
const base = 'http://127.0.0.1:8897'
const h = { 'content-type': 'application/json', 'x-relay-secret': 's' }
const post = async p => { const r = await fetch(`${base}/v1/answer`, { method: 'POST', headers: h, body: JSON.stringify(p) }); return `${r.status} ${await r.text()}` }
const pub = bridge.publish({ requestId: 'r', question: { id: 'c', question: 'Q?', options: [{ label: 'Red' }, { label: 'Green' }] } })
console.log('answer  ->', await post({ token: pub.token, selected: ['Green'] }))
pub.record.answered && bridge.retain(pub.token)
console.log('dup     ->', await post({ token: pub.token, selected: ['Red'] }))
const pend = await (await fetch(`${base}/v1/pending`, { headers: h })).text()
console.log('pending after resolve (must be empty) ->', pend)
console.log('health  ->', await (await fetch(`${base}/v1/health`)).text())
bridge.drop('whatever')
await bridge.stop()
