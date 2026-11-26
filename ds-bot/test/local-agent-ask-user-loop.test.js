import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'ask_user', arguments: args } }),
  })
  assert.match(await later.text(), /The card is on screen/)
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data?.name === 'ask_user').length, 1, 'the reinitialized retry with a new JSON-RPC id does not become another DSH tool call')

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

async function recordedAskUserLoop(t) {
  const archived = []
  const lastRequest = new Map()
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-local-ask-late-'))
  const workDir = join(home, 'team')
  const recordPath = join(home, 'acp-record.jsonl')
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
    localAgents: { custom: [{ id: 'fake', name: 'Fake ACP', command: process.execPath, args: [fixture, `--record=${recordPath}`] }], sessions: {} },
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
        archiveSession: async sessionId => { archived.push(sessionId) },
      },
      sessionController: {
        create: async () => {
          const fresh = await root.agentLoop.create(SessionId('s2'), { provider: 'local-acp-fake', model: 'default', cwd: workDir })
          return { sessionId: fresh.id }
        },
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
  root.on('llm/stream', (options, next) => {
    if (options.provider === 'local-acp-fake') lastRequest.set(options.sessionId, options)
    return next()
  })
  let turnNumber = 0
  root.on('agent/pre-step', async (payload, next) => {
    const chain = ctx.listeners.get('agent/pre-step') ?? []
    const run = index => (index < chain.length ? chain[index](payload, () => run(index + 1)) : next())
    const decision = await run(0)
    if (decision.kind === 'reject') return decision
    turnNumber += 1
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: `<runtime-context turn="${turnNumber}" />` }],
          source: { kind: 'runtime-context' },
        }),
      ],
    }
  })

  const rt = createRuntime(ctx, { home })
  await rt.load()
  const adapter = root.llm.adapters.get('local-acp-fake')?.adapter
  assert.ok(adapter !== undefined)
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

  const readRecords = () => readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { agent, rt, ctx, adapter, archived, readRecords, lastRequest }
}

test('answering ask_user with a late read_own_chat and runtime context sends one ACP prompt and one reply block', async (t) => {
  const { agent, rt, adapter, readRecords } = await recordedAskUserLoop(t)

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'please ask-user-late-read now' }], source: { kind: 'user' } }))
  await settle(() => {
    const live = adapter.live.get('s1')
    return rt.state.questions.s1 !== undefined
      && live?.pending.size === 1
      && [...live.pending.values()][0]?.name === 'read_own_chat'
  }, 5000, 'card must be saved while late read_own_chat waits in pending')

  const promptsBeforeAnswer = readRecords().filter(entry => entry.event === 'prompt').length
  assert.equal(promptsBeforeAnswer, 1, 'initial question turn sent exactly one ACP prompt')

  const question = rt.state.questions.s1
  await rt.answerQuestion('s1', question.id, { selected: ['Pass'] })
  await settle(() => agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data?.turn === 2), 5000, 'answer turn must finish')

  const recordsAfterAnswer = readRecords()
  const promptsAfterAnswer = recordsAfterAnswer.filter(entry => entry.event === 'prompt').slice(promptsBeforeAnswer)
  const answerPrompts = promptsAfterAnswer.filter(entry => entry.text.includes(question.id))
  assert.equal(answerPrompts.length, 1, `expected 1 prompt carrying answer id ${question.id}, got ${answerPrompts.length}: ${JSON.stringify(promptsAfterAnswer)}`)
  assert.equal(promptsAfterAnswer.length, 1, `expected 1 total ACP prompt after answering card, got ${promptsAfterAnswer.length}: ${JSON.stringify(promptsAfterAnswer)}`)
  assert.equal(answerPrompts[0].text.includes('read_own_chat →'), false, 'card reply must not be wrapped as a settled read_own_chat result')

  const lateRead = recordsAfterAnswer.find(entry => entry.event === 'late-read')
  assert.ok(lateRead !== undefined, 'late read_own_chat settled during card turn wind-down')
  assert.equal(lateRead.isError, true, 'late read_own_chat was rejected rather than receiving user answer')
  assert.match(lateRead.text, /question card ended this turn/)
  assert.equal(lateRead.text.includes(question.id), false, 'late read_own_chat did not receive the question answer')

  const eventsAfterAnswer = agent.session.snapshotEvents()
  const turn1End = eventsAfterAnswer.findIndex(event => event.type === 'turn/end' && event.data?.turn === 1)
  assert.notEqual(turn1End, -1)
  const answerAssistantMessages = eventsAfterAnswer
    .slice(turn1End + 1)
    .filter(event => event.type === 'assistant/message')
    .map(event => event.data?.message)
  assert.equal(answerAssistantMessages.length, 1, 'answer turn produced exactly one assistant message')
  const textBlocks = (answerAssistantMessages[0]?.content ?? []).filter(block => block.type === 'text')
  assert.equal(textBlocks.length, 1, `expected 1 text block on assistant reply, got ${textBlocks.length}: ${JSON.stringify(textBlocks)}`)

  // Ordinary follow-up messages (including identical wording across separate turns) stay intact.
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ACP042 follow-up' }], source: { kind: 'user' } }))
  await settle(() => agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data?.turn === 3), 5000, 'first ordinary follow-up must finish')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ACP042 follow-up' }], source: { kind: 'user' } }))
  await settle(() => agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data?.turn === 4), 5000, 'second identical ordinary follow-up must finish')
  const followUpReplies = agent.session.snapshotEvents()
    .slice(eventsAfterAnswer.length)
    .filter(event => event.type === 'assistant/message')
  assert.equal(followUpReplies.length, 2, 'both ordinary follow-ups produced their own assistant replies')

  // Same single-prompt / single-block guarantee when an earlier tool call (read_own_chat)
  // completed in the same ACP turn before ask_user and another late read_own_chat trailed it.
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'please prior-read ask-user-late-read now' }], source: { kind: 'user' } }))
  await settle(() => {
    const live = adapter.live.get('s1')
    return rt.state.questions.s1 !== undefined
      && live?.pending.size === 1
      && [...live.pending.values()][0]?.name === 'read_own_chat'
  }, 5000, 'second card must be saved after prior read_own_chat while late read_own_chat waits')

  const promptsBeforeSecondAnswer = readRecords().filter(entry => entry.event === 'prompt').length
  const eventsBeforeSecondAnswer = agent.session.snapshotEvents().length
  const secondQuestion = rt.state.questions.s1
  await rt.answerQuestion('s1', secondQuestion.id, { selected: ['Pass'] })
  await settle(() => agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data?.turn === 6), 5000, 'second answer turn must finish')

  const promptsAfterSecondAnswer = readRecords().filter(entry => entry.event === 'prompt').slice(promptsBeforeSecondAnswer)
  assert.equal(promptsAfterSecondAnswer.length, 1, `expected 1 ACP prompt after answering prior-tool card, got ${promptsAfterSecondAnswer.length}: ${JSON.stringify(promptsAfterSecondAnswer)}`)
  assert.equal(promptsAfterSecondAnswer.filter(entry => entry.text.includes(secondQuestion.id)).length, 1)
  assert.equal(promptsAfterSecondAnswer[0].text.includes('The calls that were waiting on the user are settled:'), false, 'earlier step read_own_chat result must not be re-sent on card answer')

  const secondAnswerMessages = agent.session.snapshotEvents()
    .slice(eventsBeforeSecondAnswer)
    .filter(event => event.type === 'assistant/message')
    .map(event => event.data?.message)
  assert.equal(secondAnswerMessages.length, 1, 'second answer turn produced one assistant message')
  const secondTextBlocks = (secondAnswerMessages[0]?.content ?? []).filter(block => block.type === 'text')
  assert.equal(secondTextBlocks.length, 1, `expected 1 text block after prior-tool card answer, got ${secondTextBlocks.length}: ${JSON.stringify(secondTextBlocks)}`)
})

test('the DS Bot context steward switches parts with an open question and delivers its answer once', async (t) => {
  const { agent, rt, ctx, adapter, archived, readRecords, lastRequest } = await recordedAskUserLoop(t)
  const oldSessionId = agent.id
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'please ask-user-late-read now' }],
    source: { kind: 'user' },
  }))
  await settle(() => rt.state.questions[oldSessionId] !== undefined
    && agent.session.snapshotEvents().some(event => event.type === 'turn/end')
    && agent.status === 'idle', 5000, 'the first part must be idle with an open card')
  const question = rt.state.questions[oldSessionId]
  assert.ok(question.callId)
  const oldPrompt = readRecords().find(entry => entry.event === 'prompt')
  assert.ok(oldPrompt)

  const stewardCalls = []
  const localContext = rt.localAgentContext
  rt.localAgentContext = id => id === oldSessionId ? { used: 220_000, size: 262_000, compactions: 0 } : localContext(id)
  rt.localAgentAsk = async id => {
    stewardCalls.push(id)
    return JSON.stringify({ action: 'switch', reason: 'context is full' })
  }
  const handoffMarker = 'ACP042-SWITCH-HANDOFF'
  rt.localAgentNote = async () => ['Goals', 'Constraints and preferences', 'Progress', 'Decisions',
    'Facts to keep', 'Open threads', 'Next step', 'Where to look']
    .map(section => `## ${section}\n- ${section === 'Goals' ? handoffMarker : 'Keep the open question.'}`).join('\n\n')

  for (const listener of ctx.listeners.get('agent/status')) listener({ agent, status: 'idle' })
  await settle(() => archived.includes(oldSessionId), 5000, 'DS Bot must archive the old part after switching')

  const freshSessionId = rt.chatOf('a')
  assert.notEqual(freshSessionId, oldSessionId)
  assert.deepEqual(stewardCalls, [oldSessionId])
  assert.equal(rt.state.questions[oldSessionId], undefined)
  const carried = rt.state.questions[freshSessionId]
  assert.equal(carried?.id, question.id)
  assert.equal(carried.callId, question.callId)
  assert.equal(carried.callSessionId, oldSessionId)
  assert.equal(adapter.live.has(oldSessionId), false, 'the old part releases its ACP session')

  const fresh = await rt.resolveAgent(freshSessionId)
  await settle(() => fresh.session.snapshotEvents().some(event => event.type === 'turn/end') && fresh.status === 'idle',
    5000, 'the handoff must finish before answering')
  const before = fresh.session.snapshotEvents()
  const handoffs = before.filter(event => event.type === 'user/message' && event.data?.source?.handoff === true)
  assert.equal(handoffs.length, 1)
  assert.match(textOf(handoffs[0].data.content), /ACP042-SWITCH-HANDOFF/)
  const promptCount = readRecords().filter(entry => entry.event === 'prompt').length

  await rt.answerQuestion(freshSessionId, question.id, { selected: ['Pass'] })
  const events = () => fresh.session.snapshotEvents().slice(before.length)
  await settle(() => events().some(event => event.type === 'turn/end') && fresh.status === 'idle',
    5000, 'the answer turn must finish in the fresh part')

  const replies = events().filter(event => event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply')
  assert.deepEqual(replies.map(event => event.data.source.callId), [question.callId])
  assert.equal(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data?.source?.kind === 'user-question-reply'), false)
  assert.equal(rt.state.questions[freshSessionId], undefined)
  const prompts = readRecords().filter(entry => entry.event === 'prompt').slice(promptCount)
  assert.equal(prompts.length, 1, 'the answer must not send a standalone context prompt')
  assert.notDeepEqual([prompts[0].pid, prompts[0].sessionId], [oldPrompt.pid, oldPrompt.sessionId])
  assert.equal(prompts[0].text.split(question.callId).length - 1, 1, 'the original callId appears once in the ACP answer')
  assert.match(prompts[0].text, /^Current time: /m, 'the answer carries its context snapshot')
  assert.equal(events().find(event => event.type === 'turn/end').data.reason.kind, 'completed')
  assert.equal(events().filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content.filter(block => block.type === 'text')).length, 1)

  const last = lastRequest.get(freshSessionId)
  assert.ok(last, 'capture the real request that carried the answer')
  const clock = 'Current time: late snapshot after the switch.'
  const snapshot = createUserMessage({
    content: [{ type: 'text', text: clock }],
    source: { kind: 'ds-bot-time-context', form: 'snapshot', sections: [{ name: 'ds-bot-time-context', text: clock }] },
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    ...last, messages: [...last.messages, snapshot], signal: AbortSignal.timeout(5000),
  })) chunks.push(chunk)
  const contextPrompts = readRecords().filter(entry => entry.event === 'prompt').slice(promptCount + 1)
  assert.deepEqual(contextPrompts.map(entry => entry.text), [], 'a late context snapshot must not start a second ACP prompt')
  assert.deepEqual(chunks.map(chunk => chunk.type), ['finish'])
  assert.equal(chunks[0].reason.kind, 'stop')
})
