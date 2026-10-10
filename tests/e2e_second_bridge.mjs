/**
 * e2e fixture: a SECOND live bridge in a second process.
 *
 * Finding 3 is about concurrency, so the proof needs two bridges asking while
 * one poller sweeps one port window. The dsh session supplies one of them; this
 * process supplies the other using the real bridge code (no reimplementation)
 * and the same shared config file, and it stays alive after being answered so
 * the poller has two bridges to find at once.
 */
import fs from 'node:fs'
import { RelayBridge } from '../dsh-relay-bundle/src/bridge.js'
import { bridgeConfig } from '../dsh-relay-bundle/src/protocol.js'

const config = bridgeConfig()
if (config?.secret === undefined) {
  console.log('[e2e-bridge2] PROBE-FAIL no usable relay config (set DSH_RELAY_CONFIG)')
  process.exit(1)
}

const bridge = new RelayBridge(config)
try {
  await bridge.start()
} catch (error) {
  console.log(`[e2e-bridge2] PROBE-FAIL bind: ${error.message}`)
  process.exit(1)
}
console.log(`[e2e-bridge2] bound port ${bridge.port}`)

const { token, record } = bridge.publish({
  requestId: 'e2e-second-bridge',
  question: {
    id: 'q1',
    question: 'Second bridge: which colour should the banner be?',
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
    multiSelect: false,
  },
})
console.log(`[e2e-bridge2] published ${token} on port ${bridge.port}`)

// Leave only when answered AND the poller has finished, so both bridges are
// live for the whole sweep.
const doneFile = process.env.DSH_RELAY_E2E_DONE
const deadline = Date.now() + 90_000
let answer = null
while (Date.now() < deadline) {
  if (answer === null && record.answered) {
    answer = record.answer?.answer ?? record.answer
    console.log(`[e2e-bridge2] PROBE-OK answered on port ${bridge.port}: ${JSON.stringify(answer)}`)
  }
  if (answer !== null && doneFile !== undefined && fs.existsSync(doneFile)) break
  await new Promise(resolve => setTimeout(resolve, 100))
}
await bridge.stop()
if (answer === null) {
  console.log('[e2e-bridge2] PROBE-FAIL nobody answered within 90s')
  process.exit(1)
}
console.log(`[e2e-bridge2] held port ${bridge.port} until the poller finished`)
process.exit(0)
