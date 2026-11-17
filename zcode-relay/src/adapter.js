/**
 * The relay's zcode-facing adapter: route authority → capacity → bridge →
 * per-run MCP settings → one supervised turn → exactly one terminal outcome.
 *
 * Order is the point. Nothing is launched until the effective route is the qfn
 * triple (M1) and the installed build is the one the event mapping was
 * validated against; the class lease is taken before a child exists and is
 * released only after it is reaped (M2, shared with pairctl); the bridge is up
 * before the run can ask anything, so a question can never be asked into a
 * process with nowhere to deliver it; and the run's unanswered questions are
 * stood down when it ends, so a late click cannot answer into a finished
 * session (M9 stale protection).
 *
 * The Discord half is untouched and the dsh half is unmodified: this file
 * extends the same bridge class and reuses the same ask path.
 *
 * @module zcode-relay/adapter
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { bridgeConfig } from '../../dsh-relay-bundle/src/protocol.js'
import { RelayError } from '../../dsh-relay-bundle/src/ask.js'
import { ZcodeBridge } from './bridge.js'
import { TurnBusyError, acquireClassLease } from './classlease.js'
import { createEventMapper } from './events.js'
import { DEFAULT_DISALLOWED_TOOLS, DEFAULT_MODE, runTurn } from './runner.js'
import {
  RUN_JOB_ENV,
  RUN_PORT_ENV,
  RUN_TOKEN_ENV,
  mcpServerSpec,
  runStateDir,
  writeSettingsFile,
} from './settings.js'
import { RouteError, assertQfnRoute, checkPinnedBuild, classKeyOf, readEffectiveRoute } from './qfn-route.js'

export const MCP_SERVER_PATH = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))

/** `zcode --version`, as one string. Injectable so tests never spawn. */
export function readBuildVersion(bin = 'zcode', env = process.env, exec = execFileSync) {
  try {
    return String(exec(bin, ['--version'], { env, encoding: 'utf8', timeout: 20000 }))
  } catch (error) {
    throw new RouteError(
      `cannot run ${bin} --version (${error?.message ?? error}); nothing was launched`,
      'ZCODE_UNAVAILABLE')
  }
}

/**
 * One relayed qfn turn on zcode.
 *
 * Resolves with the host outcome record (see ./runner.js) plus the identities
 * that make it auditable: `class`, `jobId`, `runId`, `sessionId`, and the
 * settings file that carried the MCP declaration. A refusal to launch is also
 * an outcome — `ok: false` with a `reason` — never a throw, because the caller
 * has to be able to tell the owner what happened.
 */
export async function runRelayedJob(options = {}) {
  const {
    prompt,
    cwd,
    resume,
    jobId,
    runId = randomUUID(),
    bin = 'zcode',
    env = process.env,
    mode = DEFAULT_MODE,
    disallowedTools = DEFAULT_DISALLOWED_TOOLS,
    deadlineMs = 600000,
    stallMs = 180000,
    hardStallMs = 300000,
    stateDir,
    config = bridgeConfig(env),
    leaseEnv = env,
    spawn,
    route,
    buildVersion = readBuildVersion(bin, env, options.exec),
    allowUnpinned = false,
    onEvent,
  } = options

  if (typeof jobId !== 'string' || jobId === '') throw new Error('runRelayedJob needs a jobId')

  const started = { jobId, runId, class: undefined, sessionId: '', ok: false, reason: 'not_started' }
  let resolvedRoute = route
  if (resolvedRoute === undefined) {
    try {
      resolvedRoute = readEffectiveRoute(env)
    } catch (error) {
      return { ...started, ok: false, reason: (error?.code ?? 'route_error').toLowerCase(), detail: error?.message ?? String(error) }
    }
  }

  let build
  try {
    build = checkPinnedBuild(buildVersion, allowUnpinned ? { ...env, DSH_RELAY_ZCODE_ALLOW_UNPINNED: '1' } : env)
  } catch (error) {
    return { ...started, ok: false, reason: (error?.code ?? 'build_check_failed').toLowerCase(), detail: error?.message ?? String(error) }
  }

  let verified
  try {
    // M1 is enforced here, not only in the reader: a route handed in by a
    // caller is checked against the triple before anything is admitted.
    verified = assertQfnRoute(resolvedRoute)
  } catch (error) {
    return { ...started, ok: false, reason: (error?.code ?? 'route_error').toLowerCase(), detail: error?.message ?? String(error) }
  }

  let classKey
  try {
    classKey = classKeyOf(verified)
  } catch (error) {
    return { ...started, ok: false, reason: error?.code ?? 'route_error', detail: error?.message ?? String(error) }
  }

  // M2: one admitted qfn job per model class, the same file lease pairctl
  // takes. Contention is a refusal, never a queue that lets two jobs run.
  let lease
  try {
    lease = acquireClassLease(classKey, `zcode-relay:${jobId}`, { env: leaseEnv })
  } catch (error) {
    if (error instanceof TurnBusyError) {
      return { ...started, class: classKey, ok: false, reason: 'turn_busy', detail: error.message }
    }
    throw error
  }

  const runToken = randomUUID()
  const mapper = createEventMapper({ jobId, runId })
  const bridge = options.bridge ?? new ZcodeBridge(config, { runToken, jobId })
  let settingsFile
  try {
    try {
      await bridge.start()
    } catch (error) {
      lease.release()
      return {
        ...started,
        class: classKey,
        ok: false,
        reason: 'bridge_bind_failed',
        detail: error?.message ?? String(error),
      }
    }

    const dir = runStateDir({ jobId, runId, stateDir, env })
    settingsFile = writeSettingsFile({
      dir,
      spec: mcpServerSpec({
        serverPath: MCP_SERVER_PATH,
        env: {
          [RUN_PORT_ENV]: bridge.port,
          [RUN_JOB_ENV]: jobId,
          [RUN_TOKEN_ENV]: runToken,
        },
      }),
    })

    const outcome = await runTurn({
      bin,
      prompt,
      cwd,
      resume,
      mode,
      disallowedTools,
      env,
      jobId,
      runId,
      bridge,
      mapper,
      deadlineMs,
      stallMs,
      hardStallMs,
      spawn,
      lease,
      settingsFile,
      ...(typeof onEvent === 'function' ? { onEvent } : {}),
    })

    // The run is over: nothing may still be answerable. An unanswered question
    // is dropped, so a click that arrives later meets a 404, not a stale await.
    const stoodDown = bridge.abandonAsks('the qfn run ended')

    return {
      ...outcome,
      class: classKey,
      jobId,
      runId,
      build,
      // Identity only: the route record carries provider, model and endpoint,
      // never the credential the child reads for itself (M8).
      route: {
        providerId: resolvedRoute.providerId,
        modelId: resolvedRoute.modelId,
        baseUrl: resolvedRoute.baseUrl,
        ...(resolvedRoute.maxOutputTokens === undefined ? {} : { maxOutputTokens: resolvedRoute.maxOutputTokens }),
      },
      settingsFile,
      bridgePort: bridge.port,
      stoodDownAsks: stoodDown,
      bridge,
    }
  } catch (error) {
    // Any host-side surprise still frees capacity and still says why.
    if (lease.held()) lease.release()
    const code = error instanceof RelayError || error instanceof RouteError ? error.code : 'adapter_error'
    return {
      ...started,
      class: classKey,
      ok: false,
      reason: code.toLowerCase(),
      detail: error?.message ?? String(error),
      bridge,
      settingsFile,
    }
  }
}

export { ZcodeBridge, TurnBusyError }
