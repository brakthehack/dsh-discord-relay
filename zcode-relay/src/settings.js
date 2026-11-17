/**
 * The per-process zcode settings file (M8).
 *
 * `ZCODE_CLI_SETTINGS_FILE` is a documented host integration point
 * (`docs/HOST_INTEGRATION.md:83`: "this process's user settings, including
 * hooks, MCP servers and default tool permissions"), and it *replaces* the user
 * settings file rather than merging with `~/.zcode/cli/setting.json`. That is
 * exactly what a relayed run needs: the relay's MCP server is declared for one
 * child process, and nobody's global zcode default is edited.
 *
 * What lands in the file: the server name, the absolute node executable, the
 * absolute path of this repo's `mcp-server.mjs`, and the identity the child
 * needs to reach *its* bridge (port, job id, run token). What never lands
 * here: the relay secret (the child reads it from the one supported config
 * file), any API key, any prompt text.
 *
 * @module zcode-relay/settings
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const MCP_SERVER_NAME = 'dsh_relay'
export const RUN_PORT_ENV = 'DSH_RELAY_ZCODE_PORT'
export const RUN_JOB_ENV = 'DSH_RELAY_ZCODE_JOB_ID'
export const RUN_TOKEN_ENV = 'DSH_RELAY_ZCODE_RUN_TOKEN'
export const RUN_BASE_DIR_ENV = 'DSH_RELAY_ZCODE_STATE_DIR'

/** Where a run's scratch state lives: the caller's state dir, never a checkout. */
export function stateDir(options = {}) {
  const fromOptions = options.stateDir
  const fromEnv = String((options.env ?? process.env)[RUN_BASE_DIR_ENV] ?? '').trim()
  const raw = fromOptions || fromEnv || join('/tmp', 'zcode-relay')
  return resolve(raw)
}

/**
 * The exact `mcp.servers` entry this run needs, as an object the caller can
 * assert on without touching the filesystem.
 */
export function mcpServerSpec({ nodeExec = process.execPath, serverPath, env = {}, timeoutMs = 900000 } = {}) {
  if (typeof serverPath !== 'string' || serverPath === '') throw new Error('serverPath is required')
  return {
    type: 'stdio',
    command: nodeExec,
    args: [resolve(serverPath)],
    env: Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => [key, String(value)]),
    ),
    cwd: dirname(resolve(serverPath)),
    timeoutMs,
  }
}

/** The whole settings document: MCP on, one server, nothing else implied. */
export function settingsDocument(spec, { serverName = MCP_SERVER_NAME } = {}) {
  return {
    features: { mcp: true },
    mcp: { servers: { [serverName]: spec } },
  }
}

/**
 * Write the file a run will be launched with and return its path.
 * Owner-only mode: it is per-run scratch, and the run token in it is the
 * bridge's own capability to ask.
 */
export function writeSettingsFile({
  dir,
  fileName = 'zcode-settings.json',
  spec,
  serverName = MCP_SERVER_NAME,
  fs = { mkdirSync, writeFileSync },
} = {}) {
  if (spec === undefined) throw new Error('settings spec is required')
  const path = join(resolve(dir), fileName)
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path, `${JSON.stringify(settingsDocument(spec, { serverName }), null, 2)}\n`, { mode: 0o600 })
  return path
}

/** A run-scoped state dir, so concurrent runs never share a settings file. */
export function runStateDir({ jobId, runId, ...options } = {}) {
  const safe = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(stateDir(options), safe(jobId || 'job'), safe(runId || 'run'))
}
