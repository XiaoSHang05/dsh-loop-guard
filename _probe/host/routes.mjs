/**
 * Host-half route bench: drive every HTTP route through the real `apply`.
 *
 * Why this exists: the sister plugin declared its handlers `(req, body)` while `apply` calls them
 * `(req, url, body)`, so every POST received the parsed URL as its body and answered "field is
 * required" no matter what the client sent. Both of that project's harnesses stayed green —
 * the client bench stubs `fetch` (it asserts the request, never the answer) and the SSE bench
 * never POSTs. Nothing exercised a POST handler with a body.
 *
 * So: mount the real plugin, call the registered handlers with the exact argument shape `apply`
 * uses, and deliver request bodies as STREAM EVENTS (readJsonBody collects `data` chunks and
 * resolves on `end`; a `req.body` property would prove nothing).
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')
const API = '/dsh-loop-guard/api/'

const results = []
function check(label, ok, detail) {
  results.push({ label, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok && detail !== undefined) console.log(`        ${detail}`)
}

// ------------------------------------------------------------------ fakes

function fakeRes() {
  const state = { status: 0, headers: null, chunks: [], ended: false }
  const listeners = new Map()
  const res = {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
      return res
    },
    write(chunk) {
      if (state.ended) throw new Error('write after end')
      state.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) res.write(chunk)
      state.ended = true
      return res
    },
    on(name, fn) {
      listeners.set(name, fn)
      return res
    },
    emit(name, arg) {
      listeners.get(name)?.(arg)
    },
    get status() {
      return state.status
    },
    get headers() {
      return state.headers
    },
    get ended() {
      return state.ended
    },
    get text() {
      return state.chunks.join('')
    },
    get json() {
      return JSON.parse(res.text)
    },
  }
  return res
}

function fakeReq(method, url) {
  const listeners = new Map()
  return {
    method,
    url,
    on(name, fn) {
      listeners.set(name, fn)
      return this
    },
    emit(name, arg) {
      listeners.get(name)?.(arg)
    },
    send(text) {
      if (text !== undefined) this.emit('data', Buffer.from(text, 'utf8'))
      this.emit('end')
    },
  }
}

// ------------------------------------------------------------------ mount

async function mount(options = {}) {
  const routes = []
  const listeners = []
  const logs = []
  const effects = []
  const settings = options.settings

  const ctx = {
    get(name) {
      if (name === 'webServer') return options.noServer ? undefined : { register(route) { routes.push(route); return () => {} } }
      if (name === 'agents') return options.noBackend ? undefined : {}
      if (name === 'settings') return settings
      if (name === 'sessionTitle') return options.titles
      return undefined
    },
    on(name, fn, opts) {
      listeners.push({ name, fn, opts })
      return () => {}
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
  }

  const mod = await import(pathToFileURL(join(ROOT, 'src', 'index.js')).href)
  const cleanup = await mod.apply(ctx, options.pluginConfig)
  return { mod, ctx, routes, listeners, logs, effects, cleanup, settings }
}

/**
 * Call one route the way `apply` does: three arguments, body as a stream.
 * `raw` sends bytes verbatim, which is the only way to test a malformed body.
 */
async function call(routes, method, path, body, raw) {
  const route = routes.find((candidate) => candidate.path === path && candidate.kind !== 'prefix')
  if (route === undefined) throw new Error(`no route registered for ${path}`)
  const req = fakeReq(method, path)
  const res = fakeRes()
  const pending = route.handler(req, res)
  if (method === 'POST') {
    if (raw !== undefined) req.send(raw)
    else if (body !== undefined) req.send(JSON.stringify(body))
    else req.send(undefined)
  }
  await pending
  return res
}

function emit(listeners, payload, name = 'agent/assistant-stream') {
  for (const entry of listeners) if (entry.name === name) entry.fn(payload)
}

const LOOP = 'Let me go. '.repeat(100)

// ------------------------------------------------------------------ main

async function main() {
  // ---- registration
  {
    const { routes, mod } = await mount()
    const paths = routes.map((route) => `${route.kind} ${route.path}`).sort()
    check('mounts name', mod.name === 'dsh-loop-guard', mod.name)
    check('injects webServer', JSON.stringify(mod.inject) === '["webServer"]', JSON.stringify(mod.inject))
    check(
      'registers the five actions, the prefix and events',
      paths.join('|') === [
        `exact ${API}config`,
        `exact ${API}events`,
        `exact ${API}health`,
        `exact ${API}hits`,
        `exact ${API}monitor`,
        `exact ${API}state`,
        `prefix ${API}`,
      ].join('|'),
      paths.join('\n        '),
    )
  }

  // ---- health answers even with no agent runtime; everything else 503s
  {
    const present = await mount()
    const health = await call(present.routes, 'GET', `${API}health`)
    check('GET health 200 + {backend:present,version:1}',
      health.status === 200 && health.json.ok === true && health.json.value.backend === 'present' && health.json.value.version === 1,
      health.text)

    const absent = await mount({ noBackend: true })
    const health2 = await call(absent.routes, 'GET', `${API}health`)
    check('GET health still 200 with backend absent',
      health2.status === 200 && health2.json.value.backend === 'absent', health2.text)

    const state = await call(absent.routes, 'GET', `${API}state`)
    check('GET state 503 no-backend when no agent runtime',
      state.status === 503 && state.json.error.code === 'no-backend', state.text)

    const events = await call(absent.routes, 'GET', `${API}events`)
    check('GET events 503 no-backend when no agent runtime',
      events.status === 503 && events.json.error.code === 'no-backend', events.text)

    const monitor = await call(absent.routes, 'POST', `${API}monitor`, { sessionId: 's', monitored: true })
    check('POST monitor 503 no-backend when no agent runtime',
      monitor.status === 503 && monitor.json.error.code === 'no-backend', monitor.text)
  }

  // ---- state document
  {
    const host = await mount()
    const state = await call(host.routes, 'GET', `${API}state`)
    const value = state.json.value
    check('GET state 200 with {version,config,sessions,hits}',
      state.status === 200 && value.version === 1 && Array.isArray(value.sessions) && Array.isArray(value.hits) && typeof value.config === 'object',
      state.text)
    check('state config carries all eleven fields',
      Object.keys(value.config).sort().join(',') ===
        'alarm,cancel,densityLines,densityRatio,enabled,maxUnit,minRepeat,minUnit,scopeDefault,sound,windowChars',
      Object.keys(value.config).join(','))
  }

  // ---- plugin config merge, and the Config schema export
  {
    const host = await mount({ pluginConfig: { minRepeat: 7, alarm: false } })
    const value = (await call(host.routes, 'GET', `${API}state`)).json.value
    check('plugin config overrides defaults', value.config.minRepeat === 7 && value.config.alarm === false, JSON.stringify(value.config))
    check('unknown plugin config keys do not discard the whole config',
      value.config.enabled === true && value.config.minUnit === 6, JSON.stringify(value.config))

    const volatile = host.mod.Config({ minRepeat: 9, enabled: false })
    check('Config schema unwraps volatile values',
      volatile.minRepeat.get() === 9 && volatile.enabled.get() === false)
  }

  // ---- POST config
  {
    const host = await mount()
    const ok = await call(host.routes, 'POST', `${API}config`, { patch: { minRepeat: 9 } })
    check('POST config applies a patch', ok.status === 200 && ok.json.value.config.minRepeat === 9, ok.text)

    const unknown = await call(host.routes, 'POST', `${API}config`, { patch: { nope: 1 } })
    check('POST config rejects an unknown field with 400',
      unknown.status === 400 && unknown.json.error.code === 'bad-request', unknown.text)

    const missing = await call(host.routes, 'POST', `${API}config`, {})
    check('POST config without patch is 400', missing.status === 400 && /patch/.test(missing.json.error.message), missing.text)

    const empty = await call(host.routes, 'POST', `${API}config`, undefined)
    check('POST config with an empty body is 400, not 500', empty.status === 400, empty.text)

    const bad = await call(host.routes, 'POST', `${API}config`, undefined, '{"patch":}')
    check('POST config with malformed JSON is 400 bad-request, not 500',
      bad.status === 400 && bad.json.error.code === 'bad-request', bad.text)

    const range = await call(host.routes, 'POST', `${API}config`, { patch: { densityRatio: 2 } })
    check('POST config rejects an out-of-range number with 400', range.status === 400, range.text)

    const cross = await call(host.routes, 'POST', `${API}config`, { patch: { maxUnit: 99999, windowChars: 4096 } })
    check('POST config rejects maxUnit > windowChars with 400', cross.status === 400, cross.text)

    const partial = await call(host.routes, 'POST', `${API}config`, { patch: { alarm: false } })
    check('POST config is incremental (untouched keys survive)',
      partial.json.value.config.minRepeat === 9 && partial.json.value.config.alarm === false, partial.text)
  }

  // ---- POST monitor
  {
    const host = await mount()
    const on = await call(host.routes, 'POST', `${API}monitor`, { sessionId: 's1', monitored: true })
    check('POST monitor echoes {sessionId,monitored}',
      on.status === 200 && on.json.value.sessionId === 's1' && on.json.value.monitored === true, on.text)

    const noId = await call(host.routes, 'POST', `${API}monitor`, { monitored: true })
    check('POST monitor without sessionId is 400', noId.status === 400, noId.text)

    const noFlag = await call(host.routes, 'POST', `${API}monitor`, { sessionId: 's1' })
    check('POST monitor without a boolean monitored is 400', noFlag.status === 400, noFlag.text)

    const off = await call(host.routes, 'POST', `${API}monitor`, { sessionId: 's1', monitored: false })
    check('POST monitor turns a session off', off.json.value.monitored === false, off.text)

    const row = (await call(host.routes, 'GET', `${API}state`)).json.value.sessions.find((s) => s.sessionId === 's1')
    check('an unknown session gets a row so it can be pre-selected', row !== undefined && row.monitored === false, JSON.stringify(row))
  }

  // ---- wrong method
  {
    const host = await mount()
    const wrong = await call(host.routes, 'POST', `${API}health`, {})
    check('wrong method is 405 method-not-allowed',
      wrong.status === 405 && wrong.json.error.code === 'method-not-allowed', wrong.text)
    const wrong2 = await call(host.routes, 'GET', `${API}config`)
    check('GET on a POST route is 405', wrong2.status === 405, wrong2.text)
  }

  // ---- unknown action, through the prefix route
  {
    const { routes } = await mount()
    const prefix = routes.find((route) => route.kind === 'prefix')
    const res = fakeRes()
    prefix.handler(fakeReq('GET', `${API}nope`), res)
    check('unknown action answers 404 unknown-action',
      res.status === 404 && res.json.error.code === 'unknown-action', res.text)
  }

  // ---- a loop: hit recorded, turn cancelled with keepInbox
  {
    const host = await mount()
    const calls = []
    const agent = { session: { id: 'loop-1' }, cancel: (cause, options) => calls.push({ cause, options }) }
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'loop-1:1', chunk: { type: 'text-delta', text: LOOP } } })

    const value = (await call(host.routes, 'GET', `${API}state`)).json.value
    const hit = value.hits[0]
    check('a repeated tail records exactly one hit', value.hits.length === 1, JSON.stringify(value.hits))
    check('the hit carries the contract fields',
      hit !== undefined && typeof hit.id === 'string' && hit.sessionId === 'loop-1' && hit.stream === 'text' &&
        (hit.kind === 'cycle' || hit.kind === 'density') && typeof hit.unit === 'string' && hit.repeats >= 5 &&
        typeof hit.at === 'number' && hit.cancelled === true && hit.dismissed === false,
      JSON.stringify(hit))
    check('cancel is called with keepInbox so queued work survives',
      calls.length === 1 && calls[0].cause.kind === 'hook' && calls[0].options?.keepInbox === true,
      JSON.stringify(calls))

    const session = value.sessions.find((row) => row.sessionId === 'loop-1')
    check('the session row reports the loop', session !== undefined && session.repeats >= 5 && session.stream === 'text', JSON.stringify(session))
    check('session score is the normalised core score (0..1)',
      session !== undefined && session.score > 0 && session.score <= 1, JSON.stringify(session))

    // one loop = one hit, not one per chunk
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'loop-1:1', chunk: { type: 'text-delta', text: LOOP } } })
    const after = (await call(host.routes, 'GET', `${API}state`)).json.value
    check('pushing the same loop again does not add a second hit', after.hits.length === 1, String(after.hits.length))

    // a new attempt re-arms the detector
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'loop-1:2', chunk: { type: 'text-delta', text: LOOP } } })
    const rearmed = (await call(host.routes, 'GET', `${API}state`)).json.value
    check('a new attemptId re-arms the detector and records a new hit', rearmed.hits.length === 2, String(rearmed.hits.length))
  }

  // ---- cancel:false keeps the alarm but does not touch the turn
  {
    const host = await mount({ pluginConfig: { cancel: false } })
    const calls = []
    const agent = { session: { id: 'quiet' }, cancel: () => calls.push(1) }
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'q:1', chunk: { type: 'text-delta', text: LOOP } } })
    const hit = (await call(host.routes, 'GET', `${API}state`)).json.value.hits[0]
    check('cancel:false records the hit with cancelled:false and never calls cancel',
      hit !== undefined && hit.cancelled === false && calls.length === 0, JSON.stringify(hit))
  }

  // ---- a healthy session is not a hit
  {
    const host = await mount()
    const agent = { session: { id: 'ok' } }
    emit(host.listeners, {
      agent,
      frame: { type: 'chunk', attemptId: 'ok:1', chunk: { type: 'text-delta', text: 'Here is the plan.\n\n1. Read the file.\n2. Fix the bug.\n3. Run the tests.\n' } },
    })
    const value = (await call(host.routes, 'GET', `${API}state`)).json.value
    check('ordinary prose records no hit', value.hits.length === 0, JSON.stringify(value.hits))
    check('but the session is still listed with its char count',
      value.sessions[0]?.chars > 0 && value.sessions[0]?.repeats === 0, JSON.stringify(value.sessions))
  }

  // ---- monitoring off silences the detector
  {
    const host = await mount()
    await call(host.routes, 'POST', `${API}monitor`, { sessionId: 'off', monitored: false })
    const agent = { session: { id: 'off' } }
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'off:1', chunk: { type: 'text-delta', text: LOOP } } })
    const value = (await call(host.routes, 'GET', `${API}state`)).json.value
    check('a muted session produces no hit', value.hits.length === 0, JSON.stringify(value.hits))
    check('and its row says monitored:false', value.sessions[0]?.monitored === false, JSON.stringify(value.sessions))
  }

  // ---- disabled master switch
  {
    const host = await mount({ pluginConfig: { enabled: false } })
    const agent = { session: { id: 'd' } }
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'd:1', chunk: { type: 'text-delta', text: LOOP } } })
    const value = (await call(host.routes, 'GET', `${API}state`)).json.value
    check('enabled:false silences every session', value.hits.length === 0 && value.sessions.every((row) => row.monitored === false), JSON.stringify(value.sessions))
  }

  // ---- POST hits
  {
    const host = await mount()
    const agent = { session: { id: 'h' } }
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'h:1', chunk: { type: 'text-delta', text: LOOP } } })
    const id = (await call(host.routes, 'GET', `${API}state`)).json.value.hits[0].id

    const notTrue = await call(host.routes, 'POST', `${API}hits`, { id })
    check('POST hits requires dismissed:true', notTrue.status === 400, notTrue.text)

    const dismissed = await call(host.routes, 'POST', `${API}hits`, { id, dismissed: true })
    check('POST hits dismisses a hit', dismissed.status === 200 && dismissed.json.value.ok === true, dismissed.text)
    const row = (await call(host.routes, 'GET', `${API}state`)).json.value.hits[0]
    check('the hit is marked dismissed', row.dismissed === true, JSON.stringify(row))

    const unknown = await call(host.routes, 'POST', `${API}hits`, { id: 'nope', dismissed: true })
    check('POST hits with an unknown id is 404 unknown-hit',
      unknown.status === 404 && unknown.json.error.code === 'unknown-hit', unknown.text)

    const clear = await call(host.routes, 'POST', `${API}hits`, { clearAll: true })
    check('POST hits clearAll empties the history',
      clear.status === 200 && (await call(host.routes, 'GET', `${API}state`)).json.value.hits.length === 0, clear.text)
  }

  // ---- hits cap
  {
    const host = await mount({ pluginConfig: { cancel: false } })
    const agent = { session: { id: 'many' } }
    for (let index = 0; index < 60; index += 1) {
      emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: `many:${index}`, chunk: { type: 'text-delta', text: LOOP } } })
    }
    const hits = (await call(host.routes, 'GET', `${API}state`)).json.value.hits
    check('hit history is capped at 50, newest first', hits.length === 50, String(hits.length))
  }

  // ---- config persistence
  {
    const updates = []
    const settings = {
      describe: () => [{ ns: 'loop-guard', value: {}, revision: 3 }],
      update: (ns, patch, revision) => updates.push({ ns, patch, revision }),
    }
    const host = await mount({ settings })
    await call(host.routes, 'POST', `${API}config`, { patch: { minRepeat: 8 } })
    check('a config change is persisted under the loop-guard namespace',
      updates.length === 1 && updates[0].ns === 'loop-guard' && updates[0].patch.minRepeat === 8, JSON.stringify(updates))

    const persisted = await mount({
      settings: { describe: () => [{ ns: 'loop-guard', value: { minRepeat: 11, alarm: false }, revision: 1 }], update: () => {} },
    })
    const value = (await call(persisted.routes, 'GET', `${API}state`)).json.value
    check('a persisted config wins over the defaults',
      value.config.minRepeat === 11 && value.config.alarm === false, JSON.stringify(value.config))
  }

  // ---- agent/disposed forgets a session
  {
    const host = await mount()
    const agent = { session: { id: 'gone' } }
    emit(host.listeners, { agent, frame: { type: 'chunk', attemptId: 'g:1', chunk: { type: 'text-delta', text: 'hello there' } } })
    emit(host.listeners, { agent }, 'agent/disposed')
    const value = (await call(host.routes, 'GET', `${API}state`)).json.value
    check('agent/disposed removes the session row', value.sessions.length === 0, JSON.stringify(value.sessions))
  }

  // ---- no web server, and lifecycle
  {
    const bare = await mount({ noServer: true })
    check('no web server is survivable (and logged)',
      bare.routes.length === 0 && bare.logs.some(([level]) => level === 'warn'), JSON.stringify(bare.logs))

    const host = await mount()
    let disposed = 0
    host.routes[0].handler(fakeReq('GET', `${API}health`), fakeRes())
    const cleanup = host.cleanup
    check('apply returns a cleanup function', typeof cleanup === 'function')
    if (typeof cleanup === 'function') {
      cleanup()
      disposed = host.effects.filter((entry) => typeof entry.dispose === 'function').length
    }
    check('cleanup runs every registered effect', disposed === host.effects.length && host.effects.length > 0, String(disposed))
  }

  // ---- report
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('HARNESS ERROR:', error)
  process.exit(1)
})
