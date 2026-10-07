/**
 * dsh-discord-relay — Cordis plugin (dsh half).
 *
 * Three jobs, one plugin module, no build step:
 *   (a) answers user-questions over Discord, by taking over the
 *       `'user-questions/request'` waterfall (registered `global`, because
 *       root listeners are filtered out of an agent-scoped dispatch),
 *   (b) hosts the 127.0.0.1 HTTP bridge (see ./bridge.js) inside this process,
 *   (c) registers the model-facing `ask_user_question` tool (the headless
 *       profile mounts the user-questions SERVICE but no ask tool).
 *
 * Resolution contract: `ask()` resolves with exactly
 * `{ answers: [{ id, selected, custom? }] }` — single-select: a typed answer
 * overrides `selected`; multi-select: it supplements `selected`.
 *
 * Never-lose / never-hang contract: a question is published to the bridge and
 * awaited with a bounded deadline. If no relay ever polls the bridge the ask
 * fails fast with a clear tool error; if the relay polls but no human answers,
 * the ask fails after the answer timeout. Both surface as ordinary tool
 * failures so the calling agent continues instead of hanging.
 *
 * @module dsh-relay-bundle
 */

import { randomUUID } from 'node:crypto'
import { bridgeConfig } from './protocol.js'
import { RelayBridge, bridgeLog as log } from './bridge.js'

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
  + 'Send one or more questions, each with a stable id that will be echoed in the answer. '
  + 'Questions are delivered to the owner in your configured blockers/questions '
  + 'channel (set channelId in the config file); multiple choice is one click.'

class RelayError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RelayError'
    this.code = code
  }
}

function failureCode(status) {
  if (status === 'no_relay') return 'RELAY_NOT_POLLING'
  if (status === 'timeout') return 'RELAY_ANSWER_TIMEOUT'
  if (status === 'aborted') return 'ASK_ABORTED'
  return 'RELAY_ABANDONED'
}

function describeFailure(status, config, token) {
  if (status === 'no_relay') {
    return 'no Discord relay is polling the bridge at 127.0.0.1:' + config.port
      + ` (start the Hermes gateway with the dsh-discord-relay plugin, or fix port/secret in ${config.configPath}); `
      + 'the question was NOT delivered to the owner'
  }
  if (status === 'timeout') {
    return `the owner did not answer the pending question (${token}) within `
      + `${Math.round(config.answerTimeoutMs / 1000)}s; proceed with your best judgement and state the assumption`
  }
  if (status === 'aborted') return 'ask_user_question was aborted before the owner answered'
  return `the Discord relay shut down before the owner answered (${token})`
}

/** Map one settled bridge record into the harness answer shape. */
function toAnswerItem(record) {
  const answer = record.answer ?? { selected: [], custom: '' }
  const selected = Array.isArray(answer.selected) ? [...answer.selected] : []
  const custom = typeof answer.custom === 'string' && answer.custom !== '' ? answer.custom : undefined
  if (record.multiSelect) {
    return { id: record.id, selected, ...(custom === undefined ? {} : { custom }) }
  }
  if (custom !== undefined) return { id: record.id, selected: [], custom }
  return { id: record.id, selected }
}

/** Wait for one record to be answered, or report the first failure cause. */
function awaitOutcome(record, { deadline, noPollDeadline, signal }) {
  return new Promise(resolve => {
    const finish = outcome => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    let settled = false
    record.waiters.add(finish)
    const tick = () => {
      if (settled) return
      const now = Date.now()
      if (signal?.aborted) return finish({ status: 'aborted' })
      if (now >= deadline) return finish({ status: 'timeout' })
      if (!bridge_polled() && now >= noPollDeadline) return finish({ status: 'no_relay' })
      setTimeout(tick, 250).unref?.()
    }
    tick()
  })
}

let bridgeRef

function bridge_polled() {
  return bridgeRef?.everPolled ?? false
}

export function apply(ctx) {
  const config = bridgeConfig()
  const bridge = new RelayBridge(config)
  bridgeRef = bridge
  let bindFailure

  if (config.secret === '') {
    const why = config.configError || `no "secret" in ${config.configPath}`
    log(`WARNING dsh-relay-bundle: ${why}; the bridge stays closed (port ${config.port})`)
    bindFailure = new RelayError(
      `the Discord relay bridge is not configured: ${why.split('\n')[0]} (see ${config.configPath})`,
      'RELAY_UNCONFIGURED')
  } else {
    bridge.start().then(
      () => log(`bridge listening on http://127.0.0.1:${config.port}`),
      error => {
        bindFailure = new RelayError(
          `the Discord relay bridge could not bind 127.0.0.1:${config.port} (${error?.message ?? error})`,
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

  async function answerViaDiscord(request) {
      if (bindFailure !== undefined) throw bindFailure
      if (bridge.closed) throw new RelayError('the Discord relay bridge is shutting down', 'RELAY_STOPPED')
      if (request.signal?.aborted) {
        throw new RelayError('ask_user_question was aborted before the owner answered', 'ASK_ABORTED')
      }
      // Let the socket finish binding: asks fired in the first tick are common.
      try {
        await bridge.start()
      } catch (error) {
        throw new RelayError(
          `the Discord relay bridge could not bind 127.0.0.1:${config.port} (${error?.message ?? error})`,
          'RELAY_BIND_FAILED')
      }

      const requestId = randomUUID()
      const published = request.questions.map(question => bridge.publish({ requestId, question }))
      const deadline = Date.now() + config.answerTimeoutMs
      const noPollDeadline = Date.now() + config.noPollTimeoutMs

      try {
        const answers = []
        for (const entry of published) {
          const outcome = await awaitOutcome(entry.record, {
            deadline, noPollDeadline, signal: request.signal,
          })
          if (outcome.status !== 'answered') {
            throw new RelayError(describeFailure(outcome.status, config, entry.token), failureCode(outcome.status))
          }
          answers.push(toAnswerItem(entry.record))
        }
        return { answers }
      } finally {
        // Answered questions stay known briefly (duplicate guard); anything the
        // owner never answered is forgotten so it cannot be settled later.
        for (const entry of published) {
          if (entry.record.answered) bridge.retain(entry.token)
          else bridge.drop(entry.token)
        }
      }
  }

  // Seam shape in the installed runtime (dsh 0.2.0-rc.2): answerers are composed
  // on the agent-scoped Cordis waterfall 'user-questions/request' - claim by
  // returning an answer, delegate by calling next(). The dispatch binds `this` to
  // the agent scope and filters listeners by that scope, so we register globally.
  // Newer sources expose ctx.userQuestions.registerProvider(); prefer it if present.
  const DELEGATABLE = new Set([
    'RELAY_UNCONFIGURED', 'RELAY_BIND_FAILED', 'RELAY_STOPPED', 'RELAY_NOT_POLLING',
  ])

  if (typeof ctx.userQuestions?.registerProvider === 'function') {
    ctx.userQuestions.registerProvider({ ask: answerViaDiscord })
    log('answerer registered via userQuestions.registerProvider()')
  } else {
    ctx.on('user-questions/request', async function (request, next) {
      try {
        return await answerViaDiscord(request)
      } catch (error) {
        // Nothing reached Discord: let a local answerer (if any mounted) try.
        if (DELEGATABLE.has(error?.code) && typeof next === 'function') {
          try {
            return await next()
          } catch {
            throw error
          }
        }
        throw error
      }
    }, { global: true })
    log("answerer registered on the 'user-questions/request' waterfall")
  }

  if (typeof defineTool !== 'function') {
    log('ERROR ask_user_question NOT registered (@deepseek-ai/dsh-tools unavailable)')
    return
  }

  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description: toolDescription,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
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
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
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
      const result = await ctx.userQuestions.ask({
        questions: args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header !== undefined ? { header: question.header } : {},
          ...question.options !== undefined ? { options: question.options } : {},
          ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
        })),
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        signal: exec.signal,
      })
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
      }
    },
  }))
  log('tool ask_user_question registered')
}
