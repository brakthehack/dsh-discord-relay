/**
 * The qfn route authority for the zcode lane (M1, M8).
 *
 * The relay does not choose a provider, a model or an endpoint: it reads the
 * effective ones out of the pinned zcode configuration **read-only** and
 * refuses to run a turn unless they are exactly the qfn triple. Anything else
 * — an implicit provider substitution, a stale default, the retired `:8080`
 * endpoint — stops the run before a child exists.
 *
 * Credentials never pass through here. The API key lives in the provider
 * config file and is resolved by the zcode child itself, so it is never read
 * into this process, never in argv, never in a prompt, a log line or a relay
 * record. This module only ever returns identity fields it is allowed to print.
 *
 * @module zcode-relay/qfn-route
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The one route family this relay may run (M1). Never :8080, never a guess. */
export const QFN_TRIPLE = Object.freeze({
  providerId: 'epyc',
  modelId: 'qwen38-flashnext',
  baseUrl: 'http://192.168.86.250:8086/v1',
})

/** The retired endpoint, refused by host:port equality (not by substring). */
export const RETIRED_HOST_PORT = '192.168.86.250:8080'

/** The build the mappings in ./events.js were validated against. */
export const PINNED_BUILD = Object.freeze({
  distribution: '3.18.2-47',
  runtime: '0.17.1',
})

export const PROVIDER_CONFIG_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'
export const DEFAULT_PROVIDER_CONFIG = '~/.zcode/v2/provider_config.json'
export const ALLOW_UNPINNED_ENV = 'DSH_RELAY_ZCODE_ALLOW_UNPINNED'

/** A refusal to launch. `code` is what the relay and tests assert on. */
export class RouteError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RouteError'
    this.code = code
  }
}

function expandHome(value) {
  const text = String(value ?? '')
  return text.startsWith('~') ? homedir() + text.slice(1) : text
}

/** Where the effective provider config was read from (never its contents). */
export function providerConfigPath(env = process.env) {
  const raw = String(env[PROVIDER_CONFIG_ENV] ?? '').trim()
  return expandHome(raw || DEFAULT_PROVIDER_CONFIG)
}

/**
 * Parse `host:port` out of a baseUrl without importing a URL parser's
 * credentials: a baseUrl carrying userinfo is a refusal, not a route.
 */
export function hostPortOf(baseUrl) {
  let url
  try {
    url = new URL(String(baseUrl))
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  const host = String(url.hostname).toLowerCase()
  const port = url.port !== ''
    ? url.port
    : (url.protocol === 'https:' ? '443' : '80')
  return `${host}:${port}`
}

/**
 * The canonical qfn class key, byte-compatible with the Go authority in
 * `internal/pair/classlease.go` (`ClassKey`): `provider|model|host:port`, with
 * the endpoint canonicalised so scheme spelling or a trailing `/v1` cannot
 * split one endpoint into two pools (M2).
 */
export function classKeyOf(route) {
  const hostPort = hostPortOf(route?.baseUrl)
  if (!hostPort) {
    throw new RouteError(`cannot canonicalise baseUrl ${route?.baseUrl ?? '(missing)'}`, 'BAD_BASE_URL')
  }
  const provider = String(route?.providerId ?? '').trim().toLowerCase()
  const model = String(route?.modelId ?? '').trim().toLowerCase()
  if (provider === '' || model === '') {
    throw new RouteError('provider id and model id are both required', 'INCOMPLETE_ROUTE')
  }
  return `${provider}|${model}|${hostPort}`
}

/**
 * The M1 gate itself: accept only the qfn triple, from wherever the route was
 * read. Anything that is not exactly this provider, this model and this
 * endpoint — including a route handed in by a caller that skipped the file —
 * stops the run before a child exists.
 */
export function assertQfnRoute(route) {
  const providerId = String(route?.providerId ?? '').trim()
  const modelId = String(route?.modelId ?? '').trim()
  const baseUrl = String(route?.baseUrl ?? '').trim()
  const hostPort = hostPortOf(baseUrl)
  if (hostPort === undefined) {
    throw new RouteError(`baseUrl ${baseUrl || '(missing)'} is not an http(s) endpoint`, 'BAD_BASE_URL')
  }
  if (hostPort === RETIRED_HOST_PORT) {
    throw new RouteError(`route points at the retired endpoint ${RETIRED_HOST_PORT} (M1)`, 'RETIRED_ENDPOINT')
  }
  if (providerId !== QFN_TRIPLE.providerId || modelId !== QFN_TRIPLE.modelId || baseUrl !== QFN_TRIPLE.baseUrl) {
    throw new RouteError(
      `effective route ${providerId || '(none)'}/${modelId || '(none)'}@${hostPort} is not the qfn triple `
        + `${QFN_TRIPLE.providerId}/${QFN_TRIPLE.modelId}@${hostPortOf(QFN_TRIPLE.baseUrl)} (M1); nothing was launched`,
      'ROUTE_MISMATCH')
  }
  // The verified identity, plus whatever read-only metadata the reader lifted
  // (e.g. the configured output ceiling). Never a credential.
  return { ...route, providerId, modelId, baseUrl }
}

/**
 * Read the effective route from the pinned zcode provider config.
 *
 * Returns `{providerId, modelId, baseUrl, path}` — identity only. Throws
 * RouteError with a code the caller can print: the file is missing, the
 * declared shape is wrong, or the route is not the qfn triple.
 */
export function readEffectiveRoute(env = process.env, read = readFileSync) {
  const path = providerConfigPath(env)
  let parsed
  try {
    parsed = JSON.parse(String(read(path, 'utf8')))
  } catch (error) {
    throw new RouteError(
      `cannot read the zcode provider config at ${path} (${error?.message ?? error})`,
      'PROVIDER_CONFIG_UNREADABLE')
  }
  // The installed file is `{schemaVersion, config:{providerConfigRules:{
  // providerRules:[{providerId, config:{access:{apiKey}, api:{baseUrl}}}]},
  // modelConfigRules:{providerModelRules:[…]}, defaultModelSelection:{
  // providerId, modelId}}}` (measured on this box; see DECISIONS.md §13). Only
  // the identity fields are lifted out — the apiKey sits in `access` and is
  // never touched, printed or copied (M8). A flat shape is accepted too, so a
  // fixture can stand in for the file.
  const config = parsed?.config ?? {}
  const selection = config.defaultModelSelection ?? {}
  const rules = config.providerConfigRules?.providerRules
  const modelRules = config.modelConfigRules?.providerModelRules
  const declaredProviderId = String(
    selection.providerId ?? parsed?.providerId ?? (Array.isArray(rules) ? rules[0]?.providerId : '') ?? '').trim()
  const declaredModelId = String(
    selection.modelId ?? parsed?.modelId ?? (Array.isArray(modelRules) ? modelRules[0]?.modelId : '') ?? '').trim()

  let baseUrl = String(config?.api?.baseUrl ?? parsed?.baseUrl ?? '').trim()
  if (Array.isArray(rules) && baseUrl === '') {
    const match = rules.find(rule => String(rule?.providerId ?? '').trim() === declaredProviderId) ?? rules[0]
    baseUrl = String(match?.config?.api?.baseUrl ?? '').trim()
  }

  if (declaredProviderId === '' || declaredModelId === '' || baseUrl === '') {
    throw new RouteError(
      `${path} does not declare a default providerId, modelId and that provider's `
        + 'config.api.baseUrl together',
      'INCOMPLETE_ROUTE')
  }
  const hostPort = hostPortOf(baseUrl)
  if (hostPort === undefined) {
    throw new RouteError(`baseUrl ${baseUrl} is not an http(s) endpoint`, 'BAD_BASE_URL')
  }
  if (hostPort === RETIRED_HOST_PORT) {
    throw new RouteError(
      `${path} points at the retired endpoint ${RETIRED_HOST_PORT}; `
        + 'the qfn route is 192.168.86.250:8086 (M1)',
      'RETIRED_ENDPOINT')
  }
  const route = { providerId: declaredProviderId, modelId: declaredModelId, baseUrl, path }
  if (Array.isArray(modelRules)) {
    const modelRule = modelRules.find(
      rule => String(rule?.providerId ?? '').trim() === declaredProviderId
        && String(rule?.modelId ?? '').trim() === declaredModelId)
    const max = Number(modelRule?.config?.optionSpecs?.maxOutputTokens?.max)
    if (Number.isFinite(max)) route.maxOutputTokens = max
  }
  return assertQfnRoute(route)
}

/**
 * Verify the `zcode --version` output names the build these mappings were
 * validated against. A different build may map events differently, which is a
 * silent wrong-answer risk — so it is a refusal unless explicitly overridden.
 */
export function checkPinnedBuild(versionOutput, env = process.env) {
  const text = String(versionOutput ?? '')
  const distribution = /zcode-app-cli\s+([0-9][^\s]*)/.exec(text)?.[1] ?? ''
  const runtime = /zcode-runtime\s+([0-9][^\s]*)/.exec(text)?.[1] ?? ''
  const pinned = distribution === PINNED_BUILD.distribution && runtime === PINNED_BUILD.runtime
  if (!pinned && String(env[ALLOW_UNPINNED_ENV] ?? '').trim() !== '1') {
    throw new RouteError(
      `zcode build ${distribution || '(unknown)'}/${runtime || '(unknown)'} is not the pinned `
        + `${PINNED_BUILD.distribution}/${PINNED_BUILD.runtime}; pass ${ALLOW_UNPINNED_ENV}=1 `
        + 'only after re-validating the event mapping',
      'BUILD_UNPINNED')
  }
  return { distribution, runtime, pinned }
}
