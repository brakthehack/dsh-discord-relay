#!/usr/bin/env node
/**
 * The owner-question path, seen from zcode's side (M9).
 *
 * This is a plain stdio MCP server: zcode loads it from the run's
 * `ZCODE_CLI_SETTINGS_FILE`, the model sees one tool
 * (`ask_user_question`), and a call to it blocks until the owner has answered
 * over Discord. That makes the question round trip a real tool call whose
 * result is the answer — not a scraped approval, not a log line, and not a
 * question that dies at a schema boundary.
 *
 * It holds no authority of its own:
 *   - publishing, exactly-once resolution, duplicate/stale handling and every
 *     failure code live in the bridge it POSTs to
 *     (`dsh-relay-bundle/src/bridge.js` + `ask.js`, reached through
 *     `zcode-relay/src/bridge.js`),
 *   - the shared secret comes from the one supported config file, exactly like
 *     the dsh bundle and the Discord half — never from argv, never from this
 *     source, never printed,
 *   - the run token says *which* run may ask, so an answer can only ever land
 *     on the session that asked.
 *
 * Failures are reported as tool errors with the reason an agent can act on
 * ("no relay is polling", "the owner did not answer in time"), which is the
 * same never-hang contract the dsh half has.
 *
 * @module zcode-relay/mcp-server
 */

import { bridgeConfig, windowLabel } from '../../dsh-relay-bundle/src/protocol.js'
import { RUN_HEADER } from './bridge.js'
import { RUN_JOB_ENV, RUN_PORT_ENV, RUN_TOKEN_ENV } from './settings.js'

const TOOL_NAME = 'ask_user_question'
const SERVER_INFO = { name: 'dsh-relay-ask', title: 'dsh-discord-relay owner questions', version: '1.0.0' }
const PROTOCOL_FALLBACK = '2025-06-18'

const config = bridgeConfig()

function log(message) {
  process.stderr.write(`[zcode-relay-ask] ${message}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const toolDeclaration = {
  name: TOOL_NAME,
  description:
    'Ask the owner one or more concise questions over Discord and wait for the answers. '
    + 'Use it when you need confirmation, a choice, or missing information before continuing. '
    + 'Each question may carry an optional stable id (echoed in the answer, generated when omitted), '
    + 'a short header, a list of {label, description?} options, and multi_select. '
    + `Questions arrive in the owner's blockers channel (set channelId in ${config.configPath}).`,
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask the owner before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'Optional stable id; echoed back in the answer.' },
            question: { type: 'string', description: 'The question to ask the owner.' },
            header: { type: 'string', description: 'Optional short heading, e.g. "Confirm".' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
            multi_select: { type: 'boolean' },
          },
        },
      },
    },
    required: ['questions'],
  },
}

/** The bridge that owns this run: the port it published, else the same window. */
async function resolvePort() {
  const declared = Number.parseInt(String(process.env[RUN_PORT_ENV] ?? ''), 10)
  if (Number.isInteger(declared) && declared > 0) return declared
  // Fallback discovery mirrors the Discord half: probe health, accept only a
  // port that identifies itself as our bridge on this protocol.
  const { portsToTry } = await import('../../dsh-relay-bundle/src/protocol.js')
  for (const port of portsToTry(config)) {
    try {
      const response = await fetch(`http://${config.host}:${port}/v1/health`, {
        signal: AbortSignal.timeout(2000),
      })
      const body = await response.json()
      if (body?.relay === 'dsh-bridge' && Number(body?.protocol) === 1) return port
    } catch {
      /* next port */
    }
  }
  return undefined
}

async function callAsk(questions) {
  if (config.secret === '') {
    throw new Error(
      `the relay is not configured: ${String(config.configError ?? '').split('\n')[0] || `no secret in ${config.configPath}`}`)
  }
  const port = await resolvePort()
  if (port === undefined) {
    throw new Error(`no running relay bridge answered on ${windowLabel(config)}`)
  }
  const runToken = String(process.env[RUN_TOKEN_ENV] ?? '')
  if (runToken === '') throw new Error('this run was not given a relay run token')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.answerTimeoutMs + 30000)
  try {
    const response = await fetch(`http://${config.host}:${port}/v1/ask`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-secret': config.secret,
        [RUN_HEADER]: runToken,
      },
      body: JSON.stringify({
        request_id: `job:${String(process.env[RUN_JOB_ENV] ?? 'unknown')}`,
        questions,
        timeout_ms: config.answerTimeoutMs,
      }),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body?.ok !== true) {
      throw new Error(body?.message ?? `the relay answered HTTP ${response.status}`)
    }
    return body.answers ?? []
  } finally {
    clearTimeout(timer)
  }
}

async function handle(message) {
  const { id, method, params } = message ?? {}
  const isRequest = id !== undefined && id !== null

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_FALLBACK,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
    return
  }
  if (method === 'ping') {
    if (isRequest) reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: [toolDeclaration] })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    if (name !== TOOL_NAME) {
      reply(id, { content: [{ type: 'text', text: `unknown tool ${String(name)}` }], isError: true })
      return
    }
    const questions = params?.arguments?.questions ?? params?.arguments
    try {
      const answers = await callAsk(questions)
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ answers }) }],
        structuredContent: { answers },
        isError: false,
      })
    } catch (error) {
      // A question that could not be asked is reported, never pretended.
      const text = `${TOOL_NAME} did not reach the owner: ${error?.message ?? error}. `
        + 'Do not assume the owner saw it; state the assumption you made instead.'
      reply(id, { content: [{ type: 'text', text }], isError: true })
    }
    return
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return

  if (isRequest) replyError(id, -32601, `method not found: ${String(method)}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') {
      try {
        void handle(JSON.parse(line))
      } catch (error) {
        log(`bad request line: ${error?.message ?? error}`)
      }
    }
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
log(`ready (config ${config.configPath}, job ${process.env[RUN_JOB_ENV] ?? 'unknown'})`)
