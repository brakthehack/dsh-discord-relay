/**
 * Shared protocol constants between the dsh-relay-bundle bridge (JS) and the
 * Hermes-side Discord relay (Python).
 *
 * Personal settings (Discord channel/owner ids, the shared secret, the bridge
 * port) come from ONE config file that is never checked in:
 *   ~/.config/dsh-discord-relay/config.json   (chmod 600; DSH_RELAY_CONFIG overrides the path, tests only)
 * Both halves of the relay read the same file; the Python side lives in
 * hermes-relay/relay_core.py. Keep the two readers in lockstep.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

// One source of truth for the tool name, so the registered tool and the
// answer-pending guard can never drift onto different names.
export const RELAY_TOOL_NAME = 'ask_user_question'

export const PROTOCOL_VERSION = 1

// The relay's answers are delivered out-of-band (over HTTP, polled by the
// Hermes gateway), so the caller's own turn must not bound them.
export const DEFAULT_ANSWER_TIMEOUT_MS = 600000 // 10 min
export const DEFAULT_NO_POLL_TIMEOUT_MS = 90000 // 90 s

export const DEFAULT_BRIDGE_HOST = '127.0.0.1'
export const DEFAULT_BRIDGE_PORT = 8790

// Personal config file. channelId/ownerId/secret are required keys; port and
// userAgent are optional. There is no shipped default for someone else's
// inbox, so a gap fails loudly with SETUP_HINT naming the path.
export const DEFAULT_CONFIG_PATH = '~/.config/dsh-discord-relay/config.json'
export const CONFIG_PATH_ENV = 'DSH_RELAY_CONFIG'
export const SECRET_FALLBACK_ENV = 'DSH_RELAY_SECRET' // plain process-env fallback; the file wins
export const SETUP_HINT = [
  'Personal settings live in ONE config file (chmod 600, never committed):',
  '    ~/.config/dsh-discord-relay/config.json',
  '    {"channelId": "<discord channel id>", "ownerId": "<discord user id>",'
    + ' "secret": "<shared relay secret>", "port": 8790,',
  '     "userAgent": "DiscordBot (https://example.com/dsh-discord-relay, 1.0)"}',
  'Copy config.example.json and replace every placeholder; channelId, ownerId',
  'and secret are required, port (8790) and userAgent optional. Both ids come',
  'from Discord with developer mode on: right-click the channel / your own',
  'avatar -> Copy ID. DSH_RELAY_CONFIG may point elsewhere (tests only); as a',
  'fallback the secret may also come from ' + SECRET_FALLBACK_ENV + ' in the',
  'environment, but the file always wins.',
].join('\n')

/** A config problem the caller reports verbatim; never a guess. */
export class ConfigError extends Error {}

/** Expand a leading ~ and prefer the DSH_RELAY_CONFIG override (tests only). */
export function configPath(env = process.env) {
  const raw = String(env[CONFIG_PATH_ENV] ?? '').trim()
  const p = raw || DEFAULT_CONFIG_PATH
  return p.startsWith('~') ? homedir() + p.slice(1) : p
}

function readConfigJson(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ConfigError(`${path} does not exist or cannot be read.\n\n${SETUP_HINT}`)
  }
  let conf
  try {
    conf = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`${path} cannot be parsed as JSON: ${error.message}\n\n${SETUP_HINT}`)
  }
  if (conf === null || typeof conf !== 'object' || Array.isArray(conf)) {
    throw new ConfigError(`${path} must contain a JSON object.\n\n${SETUP_HINT}`)
  }
  return conf
}

// Discord snowflakes exceed Number.MAX_SAFE_INTEGER, so ids stay STRINGS.
function requireId(conf, key, path) {
  const raw = typeof conf[key] === 'number' ? String(conf[key]) : String(conf[key] ?? '').trim()
  if (!raw) throw new ConfigError(`${path} has no "${key}".\n\n${SETUP_HINT}`)
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ConfigError(`${path} "${key}"=${raw} is not a Discord id (digits only).\n\n${SETUP_HINT}`)
  }
  return raw
}

/**
 * Read the single personal config file. Throws ConfigError (hint naming the
 * path) on a missing/unparsable file or a missing/invalid required key.
 */
export function loadConfigFile(env = process.env) {
  const path = configPath(env)
  const conf = readConfigJson(path)
  const out = {
    host: DEFAULT_BRIDGE_HOST,
    port: DEFAULT_BRIDGE_PORT,
    secret: '',
    channelId: requireId(conf, 'channelId', path),
    ownerId: requireId(conf, 'ownerId', path),
    answerTimeoutMs: envInt('DSH_RELAY_TIMEOUT_MS', DEFAULT_ANSWER_TIMEOUT_MS),
    noPollTimeoutMs: envInt('DSH_RELAY_NO_POLL_MS', DEFAULT_NO_POLL_TIMEOUT_MS),
    userAgent: String(conf.userAgent ?? '').trim(),
    configPath: path,
  }
  out.secret = String(conf.secret ?? '').trim() || String(env[SECRET_FALLBACK_ENV] ?? '').trim()
  if (Number.isFinite(conf.port) && conf.port > 0) out.port = Math.trunc(conf.port)
  return out
}

/**
 * BridgeConfig for the dsh process. Unlike loadConfigFile this never throws:
 * a broken config yields secret='' plus a `configError` string carrying the
 * full hint, which the plugin logs loudly and surfaces to any tool call while
 * the bridge stays closed (RELAY_UNCONFIGURED). Never a guess, never a hang.
 */
export function bridgeConfig(env = process.env) {
  try {
    return { ...loadConfigFile(env), configError: '' }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return {
      host: DEFAULT_BRIDGE_HOST,
      port: DEFAULT_BRIDGE_PORT,
      secret: '',
      channelId: '',
      ownerId: '',
      answerTimeoutMs: envInt('DSH_RELAY_TIMEOUT_MS', DEFAULT_ANSWER_TIMEOUT_MS),
      noPollTimeoutMs: envInt('DSH_RELAY_NO_POLL_MS', DEFAULT_NO_POLL_TIMEOUT_MS),
      userAgent: '',
      configPath: configPath(env),
      configError: error.message,
    }
  }
}

function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Discord hard budgets (verified against discord.py 2.7.1 + REST docs). */
export const BUTTON_LABEL_LIMIT = 80
export const SELECT_LABEL_LIMIT = 100
export const MAX_VIEW_ITEMS = 25
export const MAX_ACTION_ROWS = 5
export const BUTTONS_PER_ROW = 5
export const CUSTOM_ID_LIMIT = 100
export const MESSAGE_CONTENT_LIMIT = 2000

/** custom_id namespace for this relay (see DECISIONS.md, dispatch truth). */
export const CUSTOM_ID_PREFIX = 'dshr'

/** UTF-16-safe truncation that keeps the result within `limit` code units. */
export function truncate(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const ellipsis = '\u2026'
  if (limit <= ellipsis.length) return text.slice(0, limit)
  return text.slice(0, limit - ellipsis.length) + ellipsis
}

/** Collapse whitespace + cap for a single-line button label. */
export function labelize(value, limit = BUTTON_LABEL_LIMIT) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), limit)
}

/** Stable relay token for a pending question (short enough for custom_id). */
export function shortToken(uuid) {
  return String(uuid).replace(/[^0-9a-zA-Z]/g, '').slice(0, 12)
}
