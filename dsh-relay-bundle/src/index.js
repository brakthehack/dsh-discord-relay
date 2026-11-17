/**
 * dsh-discord-relay — Cordis plugin (dsh half).
 *
 * Four jobs, one plugin module, no build step:
 *   (a) hosts the 127.0.0.1 HTTP bridge (see ./bridge.js) inside this process,
 *       on the first free port of the configured window,
 *   (b) registers the model-facing `ask_user_question` tool WHENEVER THE
 *       PROFILE DOES NOT ALREADY HAVE ONE (a plain headless profile has none;
 *       the app-launched profiles mount it via their own bundle),
 *   (c) owns the tool name on the `tools/execute` waterfall in every profile,
 *       so one ask path serves all of them, and
 *   (d) registers itself as the user-questions answerer when the slot is free,
 *       which is what keeps plan-mode approvals reaching Discord headlessly.
 *
 * Coverage contract (see DECISIONS.md 9-11): an ask must reach a human in any
 * profile and in any failure mode, and must say so out loud when it cannot.
 * In the app profiles the built-in tool validates strictly and its own
 * answer surface owns the provider slot; the relay therefore answers
 * *through* both (it never calls `next()`, so a missing `id` cannot be
 * rejected before a human sees it) and races Discord against the in-app card,
 * first real answer winning. In a plain headless profile it is often the only
 * surface.
 *
 * Resolution contract: `ask()` resolves with exactly
 * `{ answers: [{ id, selected, custom? }] }` — single-select: a typed answer
 * overrides `selected`; multi-select: it supplements `selected`.
 *
 * Never-lose / never-hang contract: a question is published to the bridge and
 * awaited with a bounded deadline. If no relay ever polls the bridge the ask
 * fails with a clear tool error; if the relay polls but no human answers, the
 * ask fails after the answer timeout. Both surface as ordinary tool failures
 * so the calling agent continues instead of hanging.
 *
 * @module dsh-relay-bundle
 */

import { bridgeConfig, RELAY_TOOL_NAME, windowLabel } from './protocol.js'
import { RelayBridge, bridgeLog as log } from './bridge.js'
import { RelayError, normalizeAskArgs, runAsk } from './ask.js'

export const name = 'dsh-discord-relay'
export const inject = ['tools', 'userQuestions']

// Resolved at module load so tool registration stays synchronous inside the
// cordis setup phase. A missing/renamed dsh-tools export degrades to "no ask
// tool in this profile" rather than taking the whole plugin down.
let defineTool
try {
  defineTool = (await import('@deepseek-ai/dsh-tools')).defineTool
} catch (error) {
  log(`WARN cannot import @deepseek-ai/dsh-tools (${error?.message ?? error})`)
}

const toolDescription = 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with an optional stable id that is echoed in the answer (ids are generated when omitted). '
  + 'Questions are delivered to the owner in your configured questions channel (set channelId in the config file) and, '
  + 'where the app shows its own prompt, in both places at once - the first answer wins.'

export function apply(ctx) {
  const config = bridgeConfig()
  const bridge = new RelayBridge(config)
  let bindFailure

  if (config.secret === '') {
    const why = config.configError || `no "secret" in ${config.configPath}`
    log(`WARNING dsh-relay-bundle: ${why}; the bridge stays closed (window ${windowLabel(config)})`)
    bindFailure = new RelayError(
      `the Discord relay bridge is not configured: ${String(why).split('\n')[0]} (see ${config.configPath})`,
      'RELAY_UNCONFIGURED')
  } else {
    bridge.start().then(
      () => log(bridge.port === config.port
        ? `bridge listening on http://127.0.0.1:${bridge.port}`
        // Concurrent dsh processes each host a bridge; only the first gets the base.
        : `bridge listening on http://127.0.0.1:${bridge.port} `
          + `(base ${config.port} is held by another dsh process; the relay polls ${windowLabel(config)})`),
      error => {
        bindFailure = new RelayError(
          `the Discord relay bridge could not bind any port of ${windowLabel(config)} (${error?.message ?? error})`,
          'RELAY_BIND_FAILED')
        log(`ERROR ${bindFailure.message}`)
      },
    )
  }

  ctx.effect(function* () {
    yield () => {
      void bridge.stop()
    }
  }, 'dsh-discord-relay.bridge')

  /**
   * Ask over Discord only. This is the answerer registered on the
   * user-questions service, so it must not call back into that service.
   */
  async function answerViaDiscord(request) {
    const normalized = normalizeAskArgs({ questions: request?.questions })
    if (!normalized.ok) throw new RelayError(normalized.message, 'ASK_INVALID')
    if (normalized.notes.length > 0) log(`repaired ask: ${normalized.notes.join('; ')}`)
    return await runAsk({
      bridge,
      config,
      bindFailure,
      questions: normalized.questions,
      ...(request?.signal === undefined ? {} : { signal: request.signal }),
    })
  }

  // The answer slot. In the app profiles the in-process answer surface (the
  // GUI question card, which also serves plan mode) owns it; taking it over
  // would amputate that, so the relay adds the Discord bridge alongside it
  // instead. `localSurface` records who owns it.
  let localSurface = false
  let hadProviderSeam = true
  if (typeof ctx.userQuestions?.registerProvider === 'function') {
    try {
      ctx.userQuestions.registerProvider({ ask: answerViaDiscord })
      log('answerer registered via userQuestions.registerProvider()')
    } catch (error) {
      if (error?.code !== 'DUPLICATE_PROVIDER') throw error
      localSurface = true
      log('the profile owns the answer surface; the relay will race it instead of replacing it')
    }
  } else {
    // No provider seam in this runtime. The older answerer seam is the
    // agent-scoped `user-questions/request` waterfall, which root listeners
    // are filtered out of, so register globally and delegate on a delivery
    // failure. Whether anything dispatches that name is a property of the
    // runtime, not of this plugin - so the log claims only what it did, and
    // the routes line below says which path is left if nothing emits it.
    ctx.on('user-questions/request', async function (request, next) {
      try {
        return await answerViaDiscord(request)
      } catch (error) {
        if (error?.code === 'ASK_INVALID' || typeof next !== 'function') throw error
        // Nothing reached Discord: let a local answerer (if any mounted) try.
        try {
          return await next()
        } catch {
          throw error
        }
      }
    }, { global: true })
    hadProviderSeam = false
    log('no userQuestions.registerProvider() here; registered a global'
      + " 'user-questions/request' answerer instead - if this runtime does not"
      + ' dispatch that waterfall, the ask_user_question tool is the only path')
  }

  // State the routes that are actually live: an operator reading the log
  // should be able to tell where a question will surface.
  log(hadProviderSeam
    ? 'routes: the ask_user_question tool and the userQuestions provider'
    : 'routes: the ask_user_question tool, plus the user-questions waterfall if'
      + ' this runtime dispatches it; plan-mode asks depend on that')

  /** Drive the profile's own card, when that surface exists and is not us. */
  function makeLocalAsk(exec) {
    return (questions, signal) => Promise.resolve(ctx.userQuestions.ask({
      questions: questions.map(question => ({ ...question })),
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(signal === undefined ? {} : { signal }),
    })).then(result => ({
      answers: (result?.answers ?? []).map(answer => ({
        id: answer.id,
        selected: Array.isArray(answer.selected) ? [...answer.selected] : [],
        ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      })),
    }))
  }

  /** The single ask path: repair the arguments, then ask wherever it can. */
  async function askFromTool(arguments_, exec) {
    const normalized = normalizeAskArgs(arguments_)
    if (!normalized.ok) {
      throw new RelayError(`${normalized.message} (nothing was asked, nobody was notified)`, 'ASK_INVALID')
    }
    if (normalized.notes.length > 0) log(`repaired ask: ${normalized.notes.join('; ')}`)
    return await runAsk({
      bridge,
      config,
      bindFailure,
      questions: normalized.questions,
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
      ...(localSurface && typeof ctx.userQuestions?.ask === 'function'
        ? { localAsk: makeLocalAsk(exec) }
        : {}),
    })
  }

  // Own the tool name. This listener answers `ask_user_question` in every
  // profile and never calls `next()` for it, which is what makes the built-in
  // tool's strict argument validation unreachable for this name - the class of
  // failure that silently ate the owner's questions. It must run before the
  // tool body, and it does: argument validation lives inside `defineTool`'s
  // wrapper, i.e. inside the dispatch this waterfall wraps.
  ctx.on('tools/execute', async function (exec, next) {
    if (exec?.name !== RELAY_TOOL_NAME) return next()
    return { value: await askFromTool(exec.arguments, exec) }
  }, { global: true })

  const existing = typeof ctx.tools?.get === 'function' ? ctx.tools.get(RELAY_TOOL_NAME) : undefined
  if (existing !== undefined) {
    log(`${RELAY_TOOL_NAME} is provided by the profile; the relay answers it from the tool waterfall`)
    return
  }
  if (typeof defineTool !== 'function') {
    log(`ERROR ${RELAY_TOOL_NAME} NOT registered (@deepseek-ai/dsh-tools unavailable)`)
    return
  }

  // Nothing in this profile asks, so mount the tool. The schema is deliberately
  // permissive - `id` and even `question` are not required here, because a
  // rejection at the argument boundary is a question that dies unheard.
  // `normalizeAskArgs` is the real validator and reports in terms an agent can
  // fix. `execute` is the same path the waterfall listener uses.
  ctx.tools.register(defineTool({
    name: RELAY_TOOL_NAME,
    description: toolDescription,
    parameters: {
      questions: {
        type: 'array',
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'Optional stable id for this question; echoed in the answer. Generated when omitted.' },
            question: { type: 'string', description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return await askFromTool(args, exec)
    },
  }))
  log(`tool ${RELAY_TOOL_NAME} registered`)
}
