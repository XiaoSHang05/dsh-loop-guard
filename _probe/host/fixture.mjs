import { EventEmitter } from 'node:events'
import { apply } from '../../src/index.js'

export function mount(config = {}) {
  const routes = new Map(), hooks = new Map(), effects = [], logs = []
  const ctx = {
    get: name => name === 'webServer' ? { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } : name === 'agents' ? {} : undefined,
    on(name, fn, options) { hooks.set(name, {fn, options}); return () => hooks.delete(name) },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) }
  }
  const cleanup = apply(ctx, config)
  function emit(agent, type, text, attemptId = 'opaque-attempt') {
    hooks.get('agent/assistant-stream').fn({ agent, frame: {type:'chunk', attemptId, chunk:{ type, text }} })
  }
  /**
   * 一条完整回合：start 换新 attempt，随后每个 delta 一个 chunk。
   *
   * 真实宿主就是这样发的（`dsh-agent-loop` 的 `AssistantStreamAttempt`），而只看 chunk 的台子
   * 测不出「换 attempt 必须复位」——上一回合攒下的重复文本会算进下一回合，把一个正常回答报成循环。
   */
  function turn(agent, chunks, attemptId = 'opaque-attempt') {
    hooks.get('agent/assistant-stream').fn({ agent, frame: { type: 'start', attemptId } })
    for (const chunk of chunks) hooks.get('agent/assistant-stream').fn({ agent, frame: { type: 'chunk', attemptId, chunk } })
  }
  async function request(method, action, body) {
    const req = new EventEmitter(), res = new EventEmitter()
    req.method = method; req.url = '/dsh-loop-guard/api/' + action
    res.text = ''; res.writeHead = (status, headers) => {res.status = status; res.headers = headers}
    res.write = text => {res.text += text; return true}; res.end = text => {if (text) res.write(text); res.ended = true}
    const pending = routes.get(req.url).handler(req, res)
    if (method === 'POST') {req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end')}
    await pending
    return { req, res, json: action === 'events' ? null : JSON.parse(res.text) }
  }
  return {routes, hooks, logs, emit, turn, request, cleanup() {cleanup(); for (const fn of effects) fn()} }
}
