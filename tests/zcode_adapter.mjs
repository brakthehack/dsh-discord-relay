// Gate: the zcode-facing relay adapter (GH-1868 step 5, M2 + M6 + M8 + M9).
//
// What has to be true here, and nowhere else:
//   - progress and the terminal outcome are correlated to one job/session,
//     and exactly one terminal outcome exists per run;
//   - an owner question reaches the bridge once and the answer comes back to
//     the run that asked — duplicate answers are idempotent, stale ones are
//     refused, cancellation stands the question down, and every failure is
//     bounded by a code rather than a hang;
//   - a provider error, a truncated stream, a non-zero exit, an empty record,
//     a signal, a deadline or a heartbeat-only stall never render as success;
//   - one admitted qfn job per model class, shared with pairctl's lease;
//   - the effective route is the qfn triple or nothing launches, and no
//     credential ever appears in argv, in the settings file or in an event.
//
// Run: node tests/zcode_adapter.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { ZcodeBridge } from '../zcode-relay/src/bridge.js'
import { acquireClassLease, classLeasePath, TurnBusyError } from '../zcode-relay/src/classlease.js'
import { createEventMapper, redact, validateTerminal } from '../zcode-relay/src/events.js'
import { RouteError, checkPinnedBuild, classKeyOf, readEffectiveRoute } from '../zcode-relay/src/qfn-route.js'
import { runTurn, zcodeChildEnv } from '../zcode-relay/src/runner.js'
import { runRelayedJob } from '../zcode-relay/src/adapter.js'
import { MCP_SERVER_PATH } from '../zcode-relay/src/adapter.js'

const BASE = 8990
const QFN = {
  providerId: 'epyc',
  modelId: 'qwen38-flashnext',
  baseUrl: 'http://192.168.86.250:8086/v1',
}
const PINNED_VERSION = 'zcode-app-cli 3.18.2-47\nzcode-runtime 0.17.1\n'
const SECRET = 'test-relay-secret-not-a-real-one'
const scratch = mkdtempSync(join(tmpdir(), 'zcode-relay-test-'))

let checks = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks += 1
      process.stdout.write(`PASS ${name}\n`)
    })
    .catch(error => {
      process.stdout.write(`FAIL ${name}\n     ${error?.stack ?? error}\n`)
      process.exitCode = 1
    })
}

function relayConfig(over = {}) {
  return {
    host: '127.0.0.1',
    port: BASE,
    portSpan: 8,
    secret: SECRET,
    configPath: join(scratch, 'config.json'),
    answerTimeoutMs: 4000,
    noPollTimeoutMs: 400,
    channelId: '1',
    ownerId: '2',
    userAgent: '',
    ...over,
  }
}

async function http(port, method, path, { body, secret = SECRET, run } = {}) {
  // `connection: close` keeps undici from pooling a socket across bridge
  // restarts in this file: a reused keep-alive socket to a stopped bridge
  // shows up as a spurious `fetch failed`, which is a test artifact, not a
  // relay behavior.
  const headers = { 'content-type': 'application/json', connection: 'close' }
  // `null` means "send no secret at all"; `undefined` keeps the default, so a
  // negative test cannot accidentally authenticate itself.
  if (secret !== undefined && secret !== null) headers['x-relay-secret'] = secret
  if (run !== undefined) headers['x-relay-run'] = run
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }
  return { status: response.status, payload }
}

/* ------------------------------------------------------------------ *
 * A stand-in for the zcode child: deterministic, no provider involved.
 * ------------------------------------------------------------------ */
function fakeChild({ records = [], exitCode = 0, signal = null, stderr = '', hangMs = 0, neverExit = false }) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.signals = []
  child.kill = signal => {
    child.signals.push(signal)
    return true
  }
  child.finish = ({ code = exitCode, sig = signal } = {}) => {
    for (const record of records) child.stdout.write(`${JSON.stringify(record)}\n`)
    if (stderr !== '') child.stderr.write(stderr)
    child.stdout.end()
    child.stderr.end()
    if (!neverExit) setImmediate(() => child.emit('close', code, sig))
  }
  if (hangMs === 0) setImmediate(() => child.finish())
  else setTimeout(() => child.finish(), hangMs).unref?.()
  return child
}

function resultRecord(over = {}) {
  return {
    type: 'result',
    sessionId: 'sess_test-1868',
    traceId: 'trace-1',
    turnId: 'turn-1',
    response: '\n\nPONG-1868',
    usage: { source: 'provider', inputTokens: 10, outputTokens: 4, totalTokens: 14, modelRequestCount: 1 },
    eventCount: 3,
    projection: { status: 'idle' },
    ...over,
  }
}

function progressRecords() {
  return [
    { type: 'turn.started', sessionId: 'sess_test-1868', turnId: 'turn-1', payload: { input: 'SECRET-PROMPT-TEXT' } },
    { type: 'model.streaming', sessionId: 'sess_test-1868', payload: { kind: 'start', delta: '' } },
    { type: 'model.streaming', sessionId: 'sess_test-1868', payload: { kind: 'delta', delta: 'hello' } },
    { type: 'model.streaming', sessionId: 'sess_test-1868', payload: { kind: 'delta', delta: ' world' } },
    { type: 'turn.completed', sessionId: 'sess_test-1868', payload: { toolCallCount: 0 } },
    resultRecord(),
  ]
}

const leaseEnv = { QFN_CLASS_LEASE_DIR: join(scratch, 'leases') }

/* ================================================================== *
 * M1 / M8 — the route authority refuses anything but the qfn triple
 * ================================================================== */
await check('route: the qfn triple is accepted and canonicalised to provider|model|host:port', () => {
  const read = () => JSON.stringify({ providerId: 'epyc', modelId: 'qwen38-flashnext', config: { api: { baseUrl: QFN.baseUrl } } })
  const route = readEffectiveRoute({}, read)
  assert.equal(route.providerId, 'epyc')
  assert.equal(classKeyOf(route), 'epyc|qwen38-flashnext|192.168.86.250:8086')
})

await check('route: the installed provider-config shape (defaultModelSelection + providerRules) is read, and the key is never touched', () => {
  const shape = () => JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: 'epyc',
          enabled: true,
          config: {
            access: { type: 'api-key', apiKey: 'sk-should-never-be-read-1234567890' },
            api: { type: 'openai-chat-completions', baseUrl: QFN.baseUrl },
            personalModelIds: ['qwen38-flashnext'],
          },
        }],
      },
      modelConfigRules: { providerModelRules: [{ modelId: 'qwen38-flashnext', providerId: 'epyc', config: { optionSpecs: { maxOutputTokens: { max: 32768 } } } }] },
      defaultModelSelection: { providerId: 'epyc', modelId: 'qwen38-flashnext' },
    },
  })
  const route = readEffectiveRoute({}, shape)
  assert.deepEqual(
    { providerId: route.providerId, modelId: route.modelId, baseUrl: route.baseUrl, maxOutputTokens: route.maxOutputTokens },
    { providerId: 'epyc', modelId: 'qwen38-flashnext', baseUrl: QFN.baseUrl, maxOutputTokens: 32768 })
  assert.ok(!JSON.stringify(route).includes('sk-should-never-be-read'), 'the API key must never leave the reader')
  // A second provider rule cannot hijack the route: the default selection wins.
  const twoProviders = () => JSON.stringify({
    config: {
      providerConfigRules: { providerRules: [
        { providerId: 'other', config: { api: { baseUrl: 'http://10.0.0.5:8086/v1' } } },
        { providerId: 'epyc', config: { api: { baseUrl: QFN.baseUrl } } },
      ] },
      defaultModelSelection: { providerId: 'epyc', modelId: 'qwen38-flashnext' },
    },
  })
  assert.equal(readEffectiveRoute({}, twoProviders).baseUrl, QFN.baseUrl)
})

await check('route: a different provider or model is a refusal, not a substitution', () => {
  const read = () => JSON.stringify({ providerId: 'other', modelId: 'qwen38-flashnext', config: { api: { baseUrl: QFN.baseUrl } } })
  assert.throws(() => readEffectiveRoute({}, read), error => error instanceof RouteError && error.code === 'ROUTE_MISMATCH')
})

await check('route: the retired :8080 endpoint is refused by host:port, and :8086 still passes', () => {
  const read = () => JSON.stringify({ providerId: 'epyc', modelId: 'qwen38-flashnext', config: { api: { baseUrl: 'http://192.168.86.250:8080/v1' } } })
  assert.throws(() => readEffectiveRoute({}, read), error => error.code === 'RETIRED_ENDPOINT')
  const substring = () => JSON.stringify({ providerId: 'epyc', modelId: 'qwen38-flashnext', config: { api: { baseUrl: 'http://192.168.86.250:18080/v1' } } })
  assert.throws(() => readEffectiveRoute({}, substring), error => error.code === 'ROUTE_MISMATCH')
})

await check('route: an unreadable or incomplete provider config stops the run', () => {
  assert.throws(() => readEffectiveRoute({}, () => { throw new Error('ENOENT') }), error => error.code === 'PROVIDER_CONFIG_UNREADABLE')
  assert.throws(() => readEffectiveRoute({}, () => JSON.stringify({ providerId: 'epyc' })), error => error.code === 'INCOMPLETE_ROUTE')
  assert.throws(
    () => readEffectiveRoute({}, () => JSON.stringify({ providerId: 'epyc', modelId: 'm', config: { api: { baseUrl: 'http://user:pw@192.168.86.250:8086/v1' } } })),
    error => error.code === 'BAD_BASE_URL',
  )
})

await check('route: class key canonicalises scheme/port/path so an alias cannot buy a second slot', () => {
  const a = classKeyOf({ providerId: 'EPyc', modelId: 'Qwen38-FlashNext', baseUrl: 'http://192.168.86.250:8086/v1' })
  const b = classKeyOf({ providerId: 'epyc', modelId: 'qwen38-flashnext', baseUrl: 'http://192.168.86.250:8086' })
  assert.equal(a, b)
  assert.equal(a, 'epyc|qwen38-flashnext|192.168.86.250:8086')
})

await check('build: a different zcode build is refused unless explicitly allowed', () => {
  assert.deepEqual(checkPinnedBuild(PINNED_VERSION, {}), { distribution: '3.18.2-47', runtime: '0.17.1', pinned: true })
  assert.throws(() => checkPinnedBuild('zcode-app-cli 9.9.9\nzcode-runtime 1.0.0\n', {}), error => error.code === 'BUILD_UNPINNED')
  assert.equal(checkPinnedBuild('zcode-app-cli 9.9.9\nzcode-runtime 1.0.0\n', { DSH_RELAY_ZCODE_ALLOW_UNPINNED: '1' }).pinned, false)
})

/* ================================================================== *
 * M2 — one admitted qfn job per class, shared with pairctl
 * ================================================================== */
await check('lease: the filename and record match the Go authority byte for byte', () => {
  const lease = acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'relay:test', { env: leaseEnv })
  const digest = createHash('sha256').update('epyc|qwen38-flashnext|192.168.86.250:8086').digest('hex').slice(0, 32)
  assert.equal(lease.path, join(leaseEnv.QFN_CLASS_LEASE_DIR, `class-${digest}.lock`))
  assert.equal(lease.path, classLeasePath('epyc|qwen38-flashnext|192.168.86.250:8086', leaseEnv))
  const record = JSON.parse(readFileSync(lease.path, 'utf8'))
  assert.deepEqual(Object.keys(record).sort(), ['acquired', 'class', 'nonce', 'owner', 'pid'])
  assert.equal(record.class, 'epyc|qwen38-flashnext|192.168.86.250:8086')
  assert.equal(record.pid, process.pid)
  lease.release()
})

await check('lease: a second holder of the same class is TURN_BUSY (no second qfn job)', () => {
  const held = acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'relay:first', { env: leaseEnv })
  assert.throws(
    () => acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'relay:second', { env: leaseEnv }),
    error => error instanceof TurnBusyError && error.code === 'TURN_BUSY',
  )
  // A different model class is a different slot; that is the whole rule.
  const other = acquireClassLease('epyc|some-other|192.168.86.250:8086', 'relay:other', { env: leaseEnv })
  assert.ok(other.held())
  other.release()
  held.release()
  const again = acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'relay:third', { env: leaseEnv })
  assert.ok(again.held())
  again.release()
})

await check('lease: only a provably dead owner may be reclaimed; a live pid keeps the slot', async () => {
  const dir = join(scratch, 'leases-live')
  const env = { QFN_CLASS_LEASE_DIR: dir }
  const alive = spawn('sleep', ['30'])
  await new Promise(resolve => alive.once('spawn', resolve))
  const dead = spawn('sleep', ['0.05'])
  await new Promise(resolve => dead.once('exit', resolve))

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = classLeasePath('epyc|qwen38-flashnext|192.168.86.250:8086', env)
  const write = pid => writeFileSync(path, JSON.stringify({
    class: 'epyc|qwen38-flashnext|192.168.86.250:8086', pid, nonce: 'foreign', acquired: new Date().toISOString(), owner: 'ghost',
  }), { mode: 0o600 })

  write(alive.pid)
  assert.throws(() => acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'relay:x', { env }), error => error.code === 'TURN_BUSY')
  alive.kill('SIGKILL')
  write(dead.pid)
  const reclaimed = acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'relay:x', { env })
  assert.ok(reclaimed.held())
  // Releasing a lease somebody else now owns must not free their capacity.
  writeFileSync(path, JSON.stringify({ class: 'x', pid: process.pid, nonce: 'someone-else', acquired: '', owner: 'y' }))
  assert.deepEqual(reclaimed.release(), { released: false, reason: 'owned-by-another' })
  assert.ok(existsSync(path))
})

/* ================================================================== *
 * M6 — progress correlation and the terminal outcome
 * ================================================================== */
await check('events: progress is correlated to one job/run/session and streaming coalesces', () => {
  const mapper = createEventMapper({ jobId: 'job-1', runId: 'run-1' })
  const events = progressRecords().map(record => mapper.push(record)).filter(Boolean)
  const progress = events.filter(event => event.kind === 'progress')
  assert.ok(progress.length >= 3, `expected progress, got ${progress.length}`)
  for (const event of progress) {
    assert.equal(event.jobId, 'job-1')
    assert.equal(event.runId, 'run-1')
    assert.equal(event.sessionId, 'sess_test-1868')
  }
  assert.equal(progress.filter(event => event.phase === 'streaming').length, 1, 'streaming must coalesce into one line')
  // The stream alone never decides completion: the outcome comes from finish(),
  // which is where the exit code joins the record (M6).
  const terminal = mapper.finish({ exitCode: 0, sawStdout: true })
  assert.equal(terminal.kind, 'terminal')
  assert.equal(terminal.ok, true)
  assert.equal(terminal.reason, null)
  assert.equal(terminal.usage.source, 'provider')
})

await check('events: prompt text never travels in a progress line', () => {
  const mapper = createEventMapper({ jobId: 'job-2', runId: 'run-2' })
  const lines = progressRecords().map(record => mapper.push(record)).filter(Boolean)
  for (const event of lines) {
    assert.ok(!event.text.includes('SECRET-PROMPT-TEXT'), `leaked: ${event.text}`)
  }
})

await check('events: redact removes credential-shaped text from an excerpt', () => {
  assert.ok(!redact('here is sk-abcdefghijklmnop').includes('sk-abcdefghijklmnop'))
})

const terminalFailures = [
  ['provider error in the terminal record', { result: resultRecord({ error: 'HTTP 503 from provider' }) }, 'provider_error'],
  ['terminal record flagged isError', { result: resultRecord({ isError: true }) }, 'provider_error'],
  ['truncated stream (exit 0, no result record)', {}, 'truncated_stream'],
  ['stdout cap exceeded', { result: resultRecord(), streamTruncated: true }, 'truncated_stream'],
  ['empty output', { result: resultRecord(), sawStdout: false }, 'empty_output'],
  ['empty response', { result: resultRecord({ response: '   ' }) }, 'empty_response'],
  ['missing session id', { result: resultRecord({ sessionId: 'nope' }) }, 'missing_session_id'],
  ['non-idle projection', { result: resultRecord({ projection: { status: 'running' } }) }, 'non_idle_projection'],
  ['non-zero exit', { result: resultRecord(), exitCode: 3 }, 'non_zero_exit'],
  ['killed by a signal', { result: resultRecord(), signal: 'SIGTERM' }, 'signalled'],
  ['host deadline', { result: resultRecord(), deadlineExpired: true }, 'deadline_expired'],
  ['heartbeat-only stall', { result: resultRecord(), stalled: true }, 'stalled'],
  ['cancelled', { result: resultRecord(), cancelled: true }, 'cancelled'],
  ['child could not spawn', { result: resultRecord(), spawnError: 'ENOENT zcode' }, 'child_spawn_failed'],
]
for (const [name, observation, reason] of terminalFailures) {
  await check(`M6: ${name} is never success`, () => {
    const outcome = validateTerminal({ sawStdout: true, exitCode: 0, ...observation })
    assert.equal(outcome.ok, false, `${name} rendered as success`)
    assert.equal(outcome.reason, reason)
  })
}

await check('M6: exactly one terminal outcome per run, however many things go wrong', () => {
  const mapper = createEventMapper({ jobId: 'job-3', runId: 'run-3' })
  const first = mapper.finish({ exitCode: 1, result: undefined })
  assert.equal(first.kind, 'terminal')
  assert.equal(first.ok, false)
  assert.equal(mapper.finish({ exitCode: 0, result: resultRecord() }), null, 'a second outcome must not exist')
  assert.equal(mapper.push(resultRecord()), null, 'records after the outcome are ignored')
})

await check('M5: usage that is not provider-reported is unknown, not zero', () => {
  const mapper = createEventMapper({ jobId: 'job-4', runId: 'run-4' })
  const event = mapper.finish({ exitCode: 0, sawStdout: true, result: resultRecord({ usage: { source: 'estimated' } }) })
  assert.match(event.text, /usage: unknown/)
})

/* ================================================================== *
 * The runner: lifecycle, cancellation, and capacity released only after reap
 * ================================================================== */
await check('runner: a good turn yields correlated progress and one success on the bridge', async () => {
  const config = relayConfig()
  const bridge = new ZcodeBridge(config, { runToken: 'tok-run', jobId: 'job-runner-1' })
  const lease = acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'runner', { env: leaseEnv })
  const seen = []
  const outcome = await runTurn({
    jobId: 'job-runner-1',
    runId: 'run-runner-1',
    prompt: 'do the thing',
    cwd: scratch,
    bridge,
    lease,
    spawn: () => fakeChild({ records: progressRecords() }),
    onEvent: event => seen.push(event),
  })
  assert.equal(outcome.ok, true, outcome.detail)
  assert.equal(outcome.reason, null)
  assert.equal(outcome.sessionId, 'sess_test-1868')
  assert.equal(lease.held(), false, 'capacity must be released once the child is reaped')
  const drained = bridge.drainEvents({ after: 0, limit: 100 }).events
  assert.equal(drained.filter(event => event.kind === 'terminal').length, 1)
  assert.ok(seen.length >= 3)
  await bridge.stop()
})

for (const [name, childOptions, reason] of [
  ['provider error', { records: [...progressRecords().slice(0, -1), resultRecord({ error: 'HTTP 500' })] }, 'provider_error'],
  ['truncated stream', { records: progressRecords().slice(0, -1) }, 'truncated_stream'],
  ['non-zero exit', { records: progressRecords(), exitCode: 2 }, 'non_zero_exit'],
  ['signalled', { records: progressRecords(), exitCode: null, signal: 'SIGKILL' }, 'signalled'],
]) {
  await check(`runner: ${name} is relayed as a failure and never as success`, async () => {
    const bridge = new ZcodeBridge(relayConfig(), { runToken: 'tok', jobId: `job-${reason}` })
    const lease = acquireClassLease(`epyc|${reason}|127.0.0.1:1`, 'runner', { env: leaseEnv })
    const outcome = await runTurn({
      jobId: `job-${reason}`,
      runId: `run-${reason}`,
      prompt: 'x',
      cwd: scratch,
      bridge,
      lease,
      spawn: () => fakeChild(childOptions),
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.reason, reason)
    const terminal = bridge.drainEvents({ limit: 100 }).events.filter(event => event.kind === 'terminal')
    assert.equal(terminal.length, 1)
    assert.equal(terminal[0].ok, false)
    assert.equal(lease.held(), false)
    await bridge.stop()
  })
}

await check('runner: cancellation signals the child, fails, and still frees capacity', async () => {
  const child = fakeChild({ records: [], neverExit: true })
  const bridge = new ZcodeBridge(relayConfig(), { runToken: 'tok', jobId: 'job-cancel' })
  const lease = acquireClassLease('epyc|cancel|127.0.0.1:1', 'runner', { env: leaseEnv })
  const controller = new AbortController()
  const running = runTurn({
    jobId: 'job-cancel',
    runId: 'run-cancel',
    prompt: 'x',
    cwd: scratch,
    bridge,
    lease,
    spawn: () => child,
    signal: controller.signal,
  })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  // The host forwards the conventional signals, then the child is reaped.
  setTimeout(() => {
    child.stdout.end()
    child.stderr.end()
    child.emit('close', null, 'SIGTERM')
  }, 30)
  const outcome = await running
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'cancelled')
  assert.equal(lease.held(), false)
  await bridge.stop()
})

await check('runner: a deadline that fires while the child lives does not release capacity', async () => {
  const child = fakeChild({ records: [], neverExit: true })
  const bridge = new ZcodeBridge(relayConfig(), { runToken: 'tok', jobId: 'job-deadline' })
  const lease = acquireClassLease('epyc|deadline|127.0.0.1:1', 'runner', { env: leaseEnv })
  const running = runTurn({
    jobId: 'job-deadline',
    runId: 'run-deadline',
    prompt: 'x',
    cwd: scratch,
    bridge,
    lease,
    deadlineMs: 40,
    termGraceMs: 20,
    spawn: () => child,
  })
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(lease.held(), true, 'a live worker still owns the qfn slot')
  assert.ok(child.signals.includes('SIGTERM'), 'the deadline must cancel the child')
  child.stdout.end()
  child.stderr.end()
  child.emit('close', null, 'SIGTERM')
  const outcome = await running
  assert.equal(outcome.reason, 'deadline_expired')
  assert.equal(lease.held(), false, 'released only now that it is reaped')
  await bridge.stop()
})

await check('runner: a stalled child with only heartbeats fails as stalled, not as success', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const bridge = new ZcodeBridge(relayConfig(), { runToken: 'tok', jobId: 'job-stall' })
  const lease = acquireClassLease('epyc|stall|127.0.0.1:1', 'runner', { env: leaseEnv })
  const running = runTurn({
    jobId: 'job-stall',
    runId: 'run-stall',
    prompt: 'x',
    cwd: scratch,
    bridge,
    lease,
    stallMs: 20,
    hardStallMs: 60,
    deadlineMs: 5000,
    spawn: () => child,
  })
  // Heartbeats keep the pipe warm but never produce a terminal record: a
  // heartbeat-only stream must not look like progress forever.
  const heartbeat = setInterval(() => child.stdout.write(`${JSON.stringify({ type: 'relay.heartbeat', sessionId: 'sess_hb' })}\n`), 10)
  heartbeat.unref?.()
  const timer = setTimeout(() => {
    clearInterval(heartbeat)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0, null)
  }, 200)
  const outcome = await running
  assert.equal(outcome.ok, false)
  assert.ok(['stalled', 'truncated_stream'].includes(outcome.reason), outcome.reason)
  await bridge.stop()
})

await check('runner: both streams are consumed and argv carries no credential', async () => {
  let seenArgv = null
  let seenEnv = null
  const child = fakeChild({ records: progressRecords(), stderr: 'provider refused the request\n' })
  const bridge = new ZcodeBridge(relayConfig(), { runToken: 'tok', jobId: 'job-argv' })
  const outcome = await runTurn({
    jobId: 'job-argv',
    runId: 'run-argv',
    prompt: 'hello',
    cwd: scratch,
    bridge,
    env: { PATH: '/usr/bin', ZCODE_CLI_SETTINGS_FILE: join(scratch, 'settings.json') },
    disallowedTools: ['Bash', 'Edit'],
    spawn: (bin, argv, options) => {
      seenArgv = argv
      seenEnv = options.env
      return child
    },
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(seenArgv.slice(0, 2), ['-p', 'hello'])
  assert.ok(seenArgv.includes('--output-format') && seenArgv.includes('stream-json'))
  assert.ok(seenArgv.includes('--mode') && seenArgv.includes('build'), 'confinement is explicit')
  assert.ok(seenArgv.includes('--disallowed-tools'))
  assert.ok(!JSON.stringify(seenArgv).includes(SECRET), 'argv must not carry a secret')
  assert.equal(seenEnv.ZCODE_CLI_SETTINGS_FILE, join(scratch, 'settings.json'))
  await bridge.stop()
})

/* ================================================================== *
 * M9 — the owner question round trip over the authenticated bridge
 * ================================================================== */
async function withBridge(options = {}) {
  const runToken = options.runToken ?? randomUUID()
  const bridge = new ZcodeBridge(relayConfig(options.config), { runToken, jobId: options.jobId ?? 'job-ask' })
  await bridge.start()
  return { bridge, runToken, port: bridge.port }
}

/** What the Discord half does: poll, then answer once. */
async function pollOnce(port) {
  return http(port, 'GET', '/v1/pending')
}

async function ask(bridge, { run, questions, body } = {}) {
  return http(bridge.port, 'POST', '/v1/ask', {
    run: run ?? bridge.runToken,
    body: body ?? { request_id: 'job:job-ask', questions: questions ?? [{ id: 'confirm', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
  })
}

await check('ask: one question, one owner answer, delivered to the asking run', async () => {
  const { bridge, runToken, port } = await withBridge()
  const pending = []
  const asking = ask(bridge, { run: runToken })
  for (let i = 0; i < 20 && pending.length === 0; i += 1) {
    const found = await pollOnce(port)
    pending.push(...found.payload.questions ?? [])
    if (pending.length === 0) await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(pending.length, 1, 'the question must be visible exactly once')
  assert.equal(pending[0].question_id, 'confirm')
  assert.equal(pending[0].request_id, 'job:job-ask')
  assert.deepEqual(pending[0].options.map(o => o.label), ['Yes', 'No'])
  const answered = await http(port, 'POST', '/v1/answer', { body: { token: pending[0].token, selected: ['Yes'] } })
  assert.equal(answered.status, 200)
  assert.equal(answered.payload.status, 'resolved')
  const result = await asking
  assert.equal(result.status, 200)
  assert.deepEqual(result.payload.answers, [{ id: 'confirm', selected: ['Yes'] }])
  await bridge.stop()
})

await check('ask: a duplicate answer is idempotent and the run still sees one answer', async () => {
  const { bridge, runToken, port } = await withBridge()
  const asking = ask(bridge, { run: runToken })
  let token
  for (let i = 0; i < 20 && token === undefined; i += 1) {
    token = (await pollOnce(port)).payload.questions?.[0]?.token
  }
  const first = await http(port, 'POST', '/v1/answer', { body: { token, selected: ['Yes'] } })
  const second = await http(port, 'POST', '/v1/answer', { body: { token, selected: ['No'] } })
  assert.equal(first.payload.status, 'resolved')
  assert.equal(second.status, 200, 'a duplicate is not an error the owner can see')
  assert.equal(second.payload.status, 'duplicate')
  assert.deepEqual(second.payload.answer.selected, ['Yes'], 'the winner is echoed')
  const result = await asking
  assert.deepEqual(result.payload.answers, [{ id: 'confirm', selected: ['Yes'] }])
  await bridge.stop()
})

await check('ask: after the run ends, a stale answer meets 404 and cannot revive the ask', async () => {
  const { bridge, runToken, port } = await withBridge()
  const asking = ask(bridge, { run: runToken })
  let token
  for (let i = 0; i < 20 && token === undefined; i += 1) {
    token = (await pollOnce(port)).payload.questions?.[0]?.token
  }
  const stoodDown = bridge.abandonAsks('the run ended')
  assert.equal(stoodDown, 1)
  const outcome = await asking
  assert.notEqual(outcome.status, 200)
  const late = await http(port, 'POST', '/v1/answer', { body: { token, selected: ['Yes'] } })
  assert.equal(late.status, 404)
  assert.equal(late.payload.error, 'no_such_pending_question')
  await bridge.stop()
})

await check('ask: no relay polling and no answer are both bounded failures with codes', async () => {
  const { bridge, runToken } = await withBridge({ config: { noPollTimeoutMs: 150, answerTimeoutMs: 1500 } })
  const noRelay = await ask(bridge, { run: runToken })
  assert.equal(noRelay.status, 503)
  assert.equal(noRelay.payload.error, 'relay_not_polling')
  assert.match(noRelay.payload.message, /NOT delivered to Discord/)

  const polling = await withBridge({ config: { noPollTimeoutMs: 5000, answerTimeoutMs: 250 } })
  const asking = ask(polling.bridge, { run: polling.runToken })
  for (let i = 0; i < 20; i += 1) {
    if ((await pollOnce(polling.port)).payload.questions?.length > 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const timedOut = await asking
  assert.equal(timedOut.status, 504)
  assert.equal(timedOut.payload.error, 'relay_answer_timeout')
  await bridge.stop()
  await polling.bridge.stop()
})

await check('ask: only the run that was given the token may ask, and only with the secret', async () => {
  const { bridge, port } = await withBridge()
  const wrongRun = await ask(bridge, { run: 'not-my-run' })
  assert.equal(wrongRun.status, 403)
  assert.equal(wrongRun.payload.error, 'unknown_run')
  const noSecret = await http(port, 'POST', '/v1/ask', { secret: null, run: bridge.runToken, body: { questions: [{ question: 'x' }] } })
  assert.equal(noSecret.status, 401)
  const badArgs = await ask(bridge, { run: bridge.runToken, body: { questions: [] } })
  assert.equal(badArgs.status, 400)
  assert.equal(badArgs.payload.error, 'ask_invalid')
  await bridge.stop()
})

await check('events: the poller drains correlated events once and the host can see who polled', async () => {
  const { bridge, port } = await withBridge({ jobId: 'job-events' })
  const mapper = createEventMapper({ jobId: 'job-events', runId: 'run-events' })
  for (const record of progressRecords()) {
    const event = mapper.push(record)
    if (event) bridge.pushEvent(event)
  }
  bridge.pushEvent(mapper.finish({ exitCode: 0, sawStdout: true }))
  const first = await http(port, 'GET', '/v1/events?after=0&limit=100')
  assert.equal(first.status, 200)
  assert.equal(first.payload.events.filter(e => e.kind === 'terminal').length, 1)
  assert.equal(first.payload.job_id ?? first.payload.jobId, 'job-events')
  const after = first.payload.maxSeq
  const second = await http(port, 'GET', `/v1/events?after=${after}&limit=100`)
  assert.equal(second.payload.events.length, 0, 'the cursor must not redeliver')
  assert.ok(bridge.lastEventsPollAt > 0)
  const unauthenticated = await http(port, 'GET', '/v1/events', { secret: null })
  assert.equal(unauthenticated.status, 401)
  await bridge.stop()
})

/* ================================================================== *
 * The MCP server as zcode would run it: tools/list, then the real question
 * ================================================================== */
await check('mcp: a model tool call becomes an owner question and the answer is the tool result', async () => {
  const { bridge, runToken, port } = await withBridge({ jobId: 'job-mcp' })
  const configFile = join(scratch, 'relay-config.json')
  writeFileSync(configFile, JSON.stringify({
    channelId: '123456789012345678', ownerId: '223456789012345678', secret: SECRET, port, portSpan: 1,
  }), { mode: 0o600 })

  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    env: {
      ...process.env,
      DSH_RELAY_CONFIG: configFile,
      DSH_RELAY_ZCODE_PORT: String(port),
      DSH_RELAY_ZCODE_RUN_TOKEN: runToken,
      DSH_RELAY_ZCODE_JOB_ID: 'job-mcp',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  const waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line)
      lines.push(parsed)
      const waiter = waiters.shift()
      if (waiter) waiter(parsed)
    }
  })
  const next = () => new Promise(resolve => waiters.push(resolve))
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })
  const initialized = await next()
  assert.equal(initialized.result.serverInfo.name, 'dsh-relay-ask')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listed = await next()
  assert.equal(listed.result.tools[0].name, 'ask_user_question')

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'ask_user_question', arguments: { questions: [{ id: 'deploy', question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'Wait' }] }] } },
  })

  let question
  for (let i = 0; i < 40 && question === undefined; i += 1) {
    question = (await pollOnce(port)).payload.questions?.[0]
    if (question === undefined) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(question.question_id, 'deploy')
  assert.equal(question.request_id, 'job:job-mcp', 'the answer must be routed to this job')
  await http(port, 'POST', '/v1/answer', { body: { token: question.token, selected: ['Yes'] } })

  const call = await next()
  assert.equal(call.id, 3)
  assert.equal(call.result.isError, false)
  assert.deepEqual(JSON.parse(call.result.content[0].text).answers, [{ id: 'deploy', selected: ['Yes'] }])
  child.kill()
  await bridge.stop()
})

await check('mcp: an undeliverable question is reported as a tool error, never as an answer', async () => {
  const { bridge, runToken, port } = await withBridge({ jobId: 'job-mcp-fail', config: { noPollTimeoutMs: 200, answerTimeoutMs: 1000 } })
  const configFile = join(scratch, 'relay-config-2.json')
  writeFileSync(configFile, JSON.stringify({ channelId: '1', ownerId: '2', secret: SECRET, port, portSpan: 1 }), { mode: 0o600 })
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    env: { ...process.env, DSH_RELAY_CONFIG: configFile, DSH_RELAY_ZCODE_PORT: String(port), DSH_RELAY_ZCODE_RUN_TOKEN: runToken, DSH_RELAY_ZCODE_JOB_ID: 'job-mcp-fail' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue
      const waiter = waiters.shift()
      if (waiter) waiter(JSON.parse(line))
    }
  })
  const next = () => new Promise(resolve => waiters.push(resolve))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  await next()
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user_question', arguments: { questions: [{ id: 'q', question: 'Nobody will answer this' }] } } })}\n`)
  const call = await next()
  assert.equal(call.result.isError, true)
  assert.match(call.result.content[0].text, /did not reach the owner/)
  child.kill()
  await bridge.stop()
})

/* ================================================================== *
 * The adapter as a whole: refusals before a child, and the settings file
 * ================================================================== */
const goodRoute = { providerId: 'epyc', modelId: 'qwen38-flashnext', baseUrl: QFN.baseUrl }

await check('adapter: a good run writes a per-run MCP settings file holding identity, not secrets', async () => {
  const bridge = new ZcodeBridge(relayConfig(), { runToken: 'tok', jobId: 'job-adapter' })
  const result = await runRelayedJob({
    prompt: 'hello',
    cwd: scratch,
    jobId: 'job-adapter',
    runId: 'run-adapter',
    route: goodRoute,
    buildVersion: PINNED_VERSION,
    bridge,
    stateDir: join(scratch, 'state'),
    leaseEnv,
    spawn: () => fakeChild({ records: progressRecords() }),
  })
  assert.equal(result.ok, true, result.detail)
  assert.equal(result.class, 'epyc|qwen38-flashnext|192.168.86.250:8086')
  assert.ok(existsSync(result.settingsFile))
  const settings = readFileSync(result.settingsFile, 'utf8')
  const parsed = JSON.parse(settings)
  assert.equal(parsed.features.mcp, true)
  const server = parsed.mcp.servers.dsh_relay
  assert.equal(server.type, 'stdio')
  assert.equal(server.args[0], MCP_SERVER_PATH)
  assert.equal(server.env.DSH_RELAY_ZCODE_JOB_ID, 'job-adapter')
  assert.ok(server.env.DSH_RELAY_ZCODE_RUN_TOKEN.length > 10)
  assert.ok(!settings.includes(SECRET), 'the relay secret never enters the zcode settings file')
  await bridge.stop()
})

await check('adapter: the class lease is refused before a child exists (turn_busy, not a queue)', async () => {
  const holder = acquireClassLease('epyc|qwen38-flashnext|192.168.86.250:8086', 'pairctl-holds-it', { env: leaseEnv })
  let spawned = false
  const result = await runRelayedJob({
    prompt: 'hello',
    cwd: scratch,
    jobId: 'job-busy',
    route: goodRoute,
    buildVersion: PINNED_VERSION,
    leaseEnv,
    spawn: () => {
      spawned = true
      return fakeChild({ records: progressRecords() })
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'turn_busy')
  assert.equal(spawned, false, 'a refused job must never spawn')
  holder.release()
})

await check('adapter: a wrong route or a wrong build launches nothing', async () => {
  const attempts = []
  const wrongRoute = await runRelayedJob({
    prompt: 'x', cwd: scratch, jobId: 'job-route',
    route: { providerId: 'epyc', modelId: 'other-model', baseUrl: QFN.baseUrl },
    buildVersion: PINNED_VERSION, leaseEnv,
    spawn: () => { attempts.push('route'); return fakeChild({ records: [] }) },
  })
  assert.equal(wrongRoute.reason, 'route_mismatch' , wrongRoute.reason)
  const wrongBuild = await runRelayedJob({
    prompt: 'x', cwd: scratch, jobId: 'job-build',
    route: goodRoute, buildVersion: 'zcode-app-cli 1.0.0\nzcode-runtime 0.1.0\n', leaseEnv,
    spawn: () => { attempts.push('build'); return fakeChild({ records: [] }) },
  })
  assert.equal(wrongBuild.reason, 'build_unpinned')
  assert.deepEqual(attempts, [])
})

await check('adapter: a terminal failure is reported as a failure, with the reason the owner sees', async () => {
  const bridge = new ZcodeBridge(relayConfig(), { runToken: 'tok', jobId: 'job-fail' })
  const result = await runRelayedJob({
    prompt: 'x',
    cwd: scratch,
    jobId: 'job-fail',
    route: goodRoute,
    buildVersion: PINNED_VERSION,
    bridge,
    stateDir: join(scratch, 'state-fail'),
    leaseEnv,
    spawn: () => fakeChild({ records: [...progressRecords().slice(0, -1), resultRecord({ response: '', error: 'provider 503' })] }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'provider_error')
  const terminal = bridge.drainEvents({ limit: 100 }).events.filter(e => e.kind === 'terminal')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].ok, false)
  assert.match(terminal[0].text, /failed \(provider_error\)/)
  await bridge.stop()
})

check('the zcode child carries the telemetry-off policy (owner 2026-11-17)', async () => {
  const env = zcodeChildEnv({
    PATH: '/usr/bin', HOME: '/tmp/h',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
    OTEL_TRACES_EXPORTER: 'otlp',
    ZCODE_MODEL_TELEMETRY_ENABLED: '1',
  })
  assert.ok(!('OTEL_EXPORTER_OTLP_ENDPOINT' in env), 'a parent OTLP endpoint survives into the worker')
  assert.ok(!('OTEL_TRACES_EXPORTER' in env), 'a parent exporter survives into the worker')
  assert.equal(env.ZCODE_MODEL_TELEMETRY_ENABLED, '0', 'the CLI gate must be replaced, not shadowed')
  assert.equal(env.PATH, '/usr/bin', 'the compose must not lose the inherited environment')
  // End-to-end: runTurn hands the spawn EXACTLY this composition (settings-file
  // merge included) — a future refactor back to a bare process.env inherit
  // fails here, not in a production turn.
  let spawnedEnv = null
  const fake = fakeChild({ records: [resultRecord({})] })
  await runTurn({
    jobId: 'job-ztel', runId: 'run-ztel', prompt: 'x', cwd: tmpdir(),
    env: { HOME: '/tmp/h', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://x/v1/traces', ZCODE_MODEL_TELEMETRY_ENABLED: 'true' },
    settingsFile: '/tmp/zsel.json',
    spawn: (_bin, _argv, opts) => { spawnedEnv = opts.env; return fake },
  })
  assert.ok(spawnedEnv, 'runTurn must hand the spawn an explicit env')
  assert.ok(!('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' in spawnedEnv), 'the OTLP channel survives through runTurn')
  assert.equal(spawnedEnv.ZCODE_MODEL_TELEMETRY_ENABLED, '0')
  assert.equal(spawnedEnv.ZCODE_CLI_SETTINGS_FILE, '/tmp/zsel.json', 'the settings-file merge must survive the compose')
})

if (process.exitCode) {
  process.stdout.write(`\n${checks} checks passed, with failures above\n`)
} else {
  process.stdout.write(`\nall zcode_adapter checks passed (${checks} checks)\n`)
}
process.exit(process.exitCode ?? 0)
