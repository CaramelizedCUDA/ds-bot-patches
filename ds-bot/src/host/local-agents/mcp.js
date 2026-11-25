// The loopback MCP server: one per CLI session, Streamable HTTP on 127.0.0.1
// with a random port and a per-session bearer token. It serves only the DS
// Bot team tools; every call is handed to the adapter, which emits it as a
// DSH tool call and answers here once the result arrives.
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

const PROTOCOL_VERSION = '2025-03-26'
const KEEPALIVE_MS = 20_000
// A retry after a transport failure is prompt; one minute covers its late
// frames without turning a deliberately repeated question into an old answer.
const REPLAY_RESULT_MS = 60_000

const stableValue = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`
}
const keyOf = (name, args) => `${String(name ?? '')}\u0000${stableValue(args ?? {})}`

// Several CLIs refuse schemas with unions, refs or const, so every schema is
// flattened to plain JSON Schema before tools/list.
export function flattenSchema(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(flattenSchema)
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' || key === '$defs' || key === 'definitions' || key === 'const') continue
    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      const branches = Array.isArray(value) ? value : []
      const first = branches.find(branch => branch?.type !== 'null')
      if (first !== undefined) Object.assign(out, flattenSchema(first))
      continue
    }
    out[key] = flattenSchema(value)
  }
  return out
}

export class LoopbackMcp {
  // onCall(name, args) -> Promise<{text, isError}> runs while the adapter waits
  // for the DSH result; it resolves when the tool call settles.
  constructor(tools, onCall) {
    this.token = randomBytes(32).toString('hex')
    this.tools = tools
    this.onCall = onCall
    this.calls = new Map()
    this.operations = new Map()
    this.server = createServer((request, response) => void this.serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }))
    this.url = undefined
  }

  async listen() {
    await new Promise((resolve, reject) => this.server.listen(0, '127.0.0.1', () => resolve()).once('error', reject))
    const { port } = this.server.address()
    this.url = `http://127.0.0.1:${port}/mcp`
    return this.url
  }

  remember(operation) {
    let operations = this.operations.get(operation.key)
    if (operations === undefined) {
      operations = new Set()
      this.operations.set(operation.key, operations)
    }
    operations.add(operation)
  }

  forget(operation) {
    clearTimeout(operation.expire)
    const operations = this.operations.get(operation.key)
    if (operations === undefined) return
    operations.delete(operation)
    if (operations.size === 0) this.operations.delete(operation.key)
  }

  // A transport retry carries the request's JSON-RPC id inside one MCP session;
  // attach it even when TCP teardown has not reached the server yet. A new id,
  // a new session, or a client without session identity is independent: sending
  // the same message twice can be intended.
  reusableOperation(key, attemptId) {
    if (attemptId === undefined) return undefined
    const operations = []
    for (const operation of this.operations.get(key) ?? []) {
      if (operation.settled === true && Date.now() - operation.settledAt >= REPLAY_RESULT_MS) this.forget(operation)
      else operations.push(operation)
    }
    return operations.find(operation => operation.ids.has(attemptId))
  }

  finishOperation(operation, result) {
    if (operation.settled === true) return
    operation.settled = true
    operation.result = result
    operation.settledAt = Date.now()
    for (const connection of operation.connections) connection.settle(result)
    operation.expire = setTimeout(() => this.forget(operation), REPLAY_RESULT_MS)
    operation.expire.unref?.()
  }

  // A queued or in-flight tool call that the CLI cancelled, or that an abort
  // must fail instead of leaving the agent waiting.
  failAll(error) {
    const result = { isError: true, text: error.message ?? String(error) }
    for (const operations of this.operations.values()) {
      for (const operation of operations) {
        operation.settled = true
        operation.result = result
        operation.settledAt = Date.now()
        clearTimeout(operation.expire)
        for (const connection of operation.connections) connection.settle(result)
      }
    }
    for (const call of this.calls.values()) call.settle(result)
    this.calls.clear()
    this.operations.clear()
  }

  close() {
    this.failAll(new Error('the session closed'))
    this.server.close()
    this.server.closeIdleConnections?.()
    const timer = setTimeout(() => this.server.closeAllConnections?.(), 50)
    timer.unref?.()
    this.server.once('close', () => clearTimeout(timer))
  }

  closeOperation(operation) {
    if (operation.settled === true || operation.connections.size > 0 || operation.closeHook === undefined || operation.closeHookRan === true) return
    operation.closeHookRan = true
    if (operation.closeHook() === true) this.forget(operation)
  }

  async serve(request, response) {
    const auth = request.headers.authorization
    if (auth !== `Bearer ${this.token}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }))
      return
    }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    const body = await readBody(request)
    let message
    try { message = JSON.parse(body) } catch { response.writeHead(400); response.end(); return }
    const messages = Array.isArray(message) ? message : [message]
    // Notifications and responses get 202 with no body, per the spec.
    const calls = messages.filter(item => item?.method !== undefined && item?.id !== undefined)
    if (calls.length === 0) { response.writeHead(202); response.end(); return }
    const sessionHeader = request.headers['mcp-session-id']
    const sessionId = typeof sessionHeader === 'string' && sessionHeader !== '' ? sessionHeader : undefined
    const toolsCall = calls.find(item => item.method === 'tools/call')
    if (toolsCall !== undefined) {
      this.serveCall(toolsCall, response, sessionId)
      return
    }
    const issuedSession = calls.some(item => item.method === 'initialize') && sessionId === undefined ? randomUUID() : undefined
    const replies = calls.map(item => this.answer(item)).filter(Boolean)
    response.writeHead(200, {
      'content-type': 'application/json',
      ...issuedSession !== undefined ? { 'mcp-session-id': issuedSession } : {},
    })
    response.end(JSON.stringify(Array.isArray(message) ? replies : replies[0]))
  }

  answer({ id, method, params }) {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'ds-bot', version: '1' } } }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: this.tools().map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: flattenSchema(tool.parameters ?? { type: 'object', properties: {} }) })) } }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
    }
  }

  // tools/call answers on an SSE stream: comments keep the transport alive, and
  // progress notifications go only to callers that supplied a progress token.
  serveCall({ id, params }, response, sessionId) {
    const callId = `mcp-${randomUUID()}`
    const progressToken = params?._meta?.progressToken
    const key = keyOf(params?.name, params?.arguments ?? {})
    const attemptId = sessionId === undefined ? undefined : `${sessionId}\u0000${stableValue(id)}`
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (value) => { try { response.write(`data: ${JSON.stringify(value)}\n\n`) } catch {} }
    const comment = (text) => { try { response.write(`: ${text}\n\n`) } catch {} }
    let settled = false
    const cleanup = () => {
      if (settled) return false
      settled = true
      clearInterval(timer)
      this.calls.delete(callId)
      entry.operation?.connections.delete(entry)
      return true
    }
    const entry = {
      progress: 0,
      operation: undefined,
      settle: (result) => {
        if (!cleanup()) return
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], isError: result.isError === true } })
        response.end()
      },
      cancel: () => {
        if (!cleanup()) return
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'the call was cancelled' }], isError: true } })
        response.end()
      },
    }
    const timer = setInterval(() => {
      entry.progress += 1
      if (progressToken === undefined) comment('waiting for the tool result')
      else send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: entry.progress * KEEPALIVE_MS, message: 'waiting for the tool result' } })
    }, KEEPALIVE_MS)
    timer.unref?.()
    // The first frame flushes the response. Until bytes flow, some clients
    // have no response object to cancel and the server cannot observe their
    // disconnects promptly either. It is a comment rather than a progress
    // notification because a notification needs the caller's own token.
    comment('waiting for the tool result')

    const existing = this.reusableOperation(key, attemptId)
    if (existing?.settled === true) {
      entry.settle(existing.result)
      return
    }

    let operation = existing
    if (operation === undefined) {
      operation = { key, ids: new Set(), connections: new Set(), settled: false, result: undefined, settledAt: 0 }
      this.remember(operation)
    }
    entry.operation = operation
    if (attemptId !== undefined) operation.ids.add(attemptId)
    operation.connections.add(entry)
    this.calls.set(callId, entry)

    response.on('close', () => {
      if (!cleanup()) return
      this.closeOperation(operation)
    })

    if (existing === undefined) {
      let running
      try {
        running = Promise.resolve(this.onCall({
          name: params?.name,
          arguments: params?.arguments ?? {},
          callId,
          onClose: (hook) => {
            operation.closeHook = hook
            this.closeOperation(operation)
          },
        }))
      } catch (error) {
        running = Promise.reject(error)
      }
      running.then(
        result => this.finishOperation(operation, result),
        error => this.finishOperation(operation, { isError: true, text: error?.message ?? String(error) }),
      )
    }
  }
}

const readBody = (request) => new Promise((resolve, reject) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => resolve(body))
  request.on('error', reject)
})
