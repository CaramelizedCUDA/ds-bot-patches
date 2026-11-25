import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createRuntime } from '../index.js'
import { QUESTION_CARD_CONFIRMATION } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

const textOf = content => (Array.isArray(content) ? content.map(block => block?.text ?? '').join('\n') : String(content ?? ''))

const settle = async (check, ms = 5000, label = 'condition not reached') => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await delay(10)
  assert.ok(check(), label)
}

const initMcpSession = async (mcp) => {
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  })
  await response.text()
  return response.headers.get('mcp-session-id')
}

test('real DSH concludeTurn confirms ask_user and delivers the card answer as the next turn', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-local-ask-loop-'))
  const workDir = join(home, 'team')
  const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['a'],
    workspaceId: 'w1',
    bots: { a: { id: 'a', name: 'Chief', role: 'Lead', sessionId: 's1', model: 'local-acp-fake/default', createdAt: 1 } },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    views: {},
    prefs: {},
    localAgents: { custom: [{ id: 'fake', name: 'Fake ACP', command: process.execPath, args: [fixture] }], sessions: {} },
    revision: 0,
  }))

  const root = new Context()
  await mountAgentLoopTestDependencies(root)
  await mountAgentLoopTestHarness(root)

  const ctx = fakeContext({
    services: {
      agents: root.agents,
      llm: root.llm,
      sessions: root.sessions,
      tools: root.tools,
      workspaceRegistry: {
        get: () => ({ id: 'w1', path: workDir }),
        list: () => [{ id: 'w1', path: workDir }],
        resolveByPath: async () => ({ id: 'w1', path: workDir }),
        create: async path => ({ id: 'w1', path }),
        archiveSession: async () => {},
      },
      sessionController: {
        resolveAgent: async sessionId => ({ agent: root.agents.get(sessionId) }),
        selectModel: async () => {},
        page: async () => ({ records: [], hasMore: false }),
        inspect: async sessionId => ({ events: root.agents.get(sessionId)?.session?.snapshotEvents?.() ?? [] }),
      },
      sessionTitle: { rename: async () => {} },
    },
  })
  Object.assign(ctx, {
    agents: root.agents,
    llm: root.llm,
    sessions: root.sessions,
    tools: root.tools,
    workspaceRegistry: ctx.get('workspaceRegistry'),
    sessionController: ctx.get('sessionController'),
    sessionTitle: ctx.get('sessionTitle'),
  })

  root.on('session/event', (session, event) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener(session, event)
    }
  })
  for (const name of ['agent/inbox/inserted', 'agent/inbox/claimed', 'agent/inbox/discarded']) {
    root.on(name, (payload) => {
      for (const listener of ctx.listeners.get(name) ?? []) listener(payload)
    })
  }
  root.on('agent/pre-step', async (payload, next) => {
    const chain = ctx.listeners.get('agent/pre-step') ?? []
    const run = index => (index < chain.length ? chain[index](payload, () => run(index + 1)) : next())
    return run(0)
  })

  const rt = createRuntime(ctx, { home })
  await rt.load()
  const registered = root.llm.adapters.get('local-acp-fake')
  assert.ok(registered?.adapter !== undefined, 'the production local-agents module registers the fake ACP route')
  const adapter = registered.adapter
  t.after(async () => {
    await ctx.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  const agent = await root.agentLoop.create(SessionId('s1'), {
    provider: 'local-acp-fake',
    model: 'default',
    cwd: workDir,
  })

  await rt.resolveAgent('s1')
  let saveStarted = false
  const saveGate = Promise.withResolvers()
  const saved = rt.save
  rt.save = async (...args) => {
    if (!saveStarted && rt.state.questions.s1 !== undefined) {
      saveStarted = true
      await saveGate.promise
    }
    return saved(...args)
  }
  t.after(() => saveGate.resolve())

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'please retry-ask-user now' }], source: { kind: 'user' } }))
  await settle(() => saveStarted, 5000, 'the question must enter persistence')
  const live = adapter.live.get('s1')
  const args = { question: 'Pick one?', detail: '   ', options: [{ label: 'yes' }, { label: 'no' }] }
  const retrySession = await initMcpSession(live.mcp)
  const retry = await fetch(live.mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${live.mcp.token}`, 'mcp-session-id': retrySession },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_user', arguments: args } }),
  })
  try {
    assert.equal(live.pending.size, 2, 'the reinitialized retry waits for the original card to finish saving')
  } finally {
    saveGate.resolve()
  }
  assert.match(await retry.text(), /The card is on screen/)
  await settle(() => live.pending.size === 0, 5000, 'card confirmation must settle both transports')

  const laterSession = await initMcpSession(live.mcp)
  const later = await fetch(live.mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${live.mcp.token}`, 'mcp-session-id': laterSession },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_user', arguments: args } }),
  })
  assert.match(await later.text(), /The card is on screen/)
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data?.name === 'ask_user').length, 1, 'the reinitialized retry does not become another DSH tool call')

  const question = rt.state.questions.s1
  await rt.answerQuestion('s1', question.id, { selected: ['yes'] })
  await settle(() => agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && textOf(event.data?.message?.content).includes('answer_to_pending_question')), 5000, 'the answer must start the next real agent turn')
  await settle(() => agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data?.turn === 2), 5000, 'the answer turn must finish')

  const assistant = agent.session.snapshotEvents()
    .filter(event => event.type === 'assistant/message')
    .map(event => textOf(event.data?.message?.content))
  assert.equal(assistant.some(text => text.includes('tool said:')), false, 'the concluded turn trailing text is not replayed')
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data?.name === 'ask_user').length, 1, 'exactly one ask_user tool call reached DSH')
  assert.equal(assistant.some(text => text.includes(QUESTION_CARD_CONFIRMATION)), false, 'the card confirmation stays internal to the MCP bridge')

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'please retry-ask-user now' }], source: { kind: 'user' } }))
  await settle(() => rt.state.questions.s1 !== undefined && rt.state.questions.s1.id !== question.id && live.pending.size === 0,
    5000, 'the same question can be asked again after the first card is answered')
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data?.name === 'ask_user').length, 2)
})
