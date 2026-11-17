/**
 * e2e probe (test fixture): runs inside a real dsh process on a profile that has
 * never had the relay, and drives one question through the installed bundle's own
 * ask path.
 *
 * Why it is written this way: the tool leg needs a model call, and a test lane
 * has no provider credentials (`dsh` stops with MISSING_CREDENTIAL). Everything
 * the probe does instead is still production code — the same `bridgeConfig()`,
 * the same `RelayBridge`, the same `normalizeAskArgs` and `askViaBridge` that the
 * `ask_user_question` handler runs — reached through the package the profile
 * installed, not through a copy of it.
 *
 * It deliberately omits `questions[0].id`: the argument shape schema validation
 * used to reject before any answer surface saw the question.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-relay-e2e-probe'
export const inject = ['tools', 'userQuestions']

const TOOL_NAME = 'ask_user_question'

function say(message) {
  console.log(`[e2e-probe] ${message}`)
}

function fail(why) {
  say(`PROBE-FAIL ${why}`)
  process.exit(1)
}

export function apply(ctx) {
  void run().catch(error => fail(`${error?.code ?? 'error'} ${error?.message ?? error}`))

  async function run() {
    // What the mount did, reported instead of assumed.
    let visible
    try {
      visible = ctx.tools?.get?.(TOOL_NAME)
    } catch {
      visible = undefined
    }
    say(`ctx.tools.get("${TOOL_NAME}") -> ${visible === undefined ? 'undefined (global view)' : 'definition'}`)
    say(`ctx.userQuestions present: ${ctx.userQuestions !== undefined},`
      + ` registerProvider available: ${typeof ctx.userQuestions?.registerProvider}`)

    // Reach the bundle through the profile's own node_modules - the tree the
    // plugin loader itself resolved - so this fails if the install never landed.
    const root = new URL('../../dsh-relay-bundle/', import.meta.url)
    if (!fs.existsSync(fileURLToPath(new URL('package.json', root)))) {
      return fail(`no dsh-relay-bundle installed next to ${root}`)
    }
    say(`installed bundle at ${root}`)

    const { RelayBridge } = await import(new URL('src/bridge.js', root).href)
    const { bridgeConfig } = await import(new URL('src/protocol.js', root).href)
    const { askViaBridge, normalizeAskArgs } = await import(new URL('src/ask.js', root).href)

    const config = bridgeConfig()
    if (config?.secret === undefined) return fail('bridgeConfig() found no usable config file')
    say(`config window 127.0.0.1:${config.port}-${config.port + config.portSpan - 1}`)

    const bridge = new RelayBridge(config)
    try {
      await bridge.start()
    } catch (error) {
      return fail(`bind failed: ${error.message}`)
    }
    say(`this process bound port ${bridge.port}`)

    const raw = {
      questions: [{
        question: 'Which colour should the banner be?',
        header: 'Banner',
        options: [{ label: 'Red', description: 'warm' }, { label: 'Green' }, { label: 'Blue' }],
        multi_select: false,
      }],
    }
    const normalized = normalizeAskArgs(raw)
    if (normalized.ok !== true) return fail(`argument repair refused the ask: ${normalized.message}`)
    say(`normalized ${normalized.questions.length} question(s), ids [${normalized.questions.map(q => q.id)}]`)
    for (const note of normalized.notes) say(`repair note: ${note}`)

    const askedAt = Date.now()
    let answer
    try {
      answer = await askViaBridge({ bridge, config, questions: normalized.questions })
    } catch (error) {
      return fail(`${error?.code ?? 'error'} ${error?.message ?? error}`)
    }
    say(`answer after ${Date.now() - askedAt} ms: ${JSON.stringify(answer)}`)
    const settled = Array.isArray(answer?.answers) && answer.answers.length === 1
      && answer.answers[0].id === 'q1' && Array.isArray(answer.answers[0].selected)
    await bridge.stop()
    if (!settled) return fail('the answer came back but not as one settled question')
    say('PROBE-OK the question crossed the bridge and the owner answer came back')
    process.exit(0)
  }
}
