/**
 * Harness for the client half's transport (`lib/client.js`).
 *
 * WHY THIS PROBE EXISTS
 * The contract calls SSE "the accelerator" and the poll "the safety net under it". That
 * wording hides the failure this file is looking for: an accelerator that, when it stalls,
 * takes the safety net with it. The dangerous version of this code is not a client that
 * cannot connect — it is a client that connects, loses the stream, and then polls *slower*
 * than one that never connected at all. So the first assertion is not about reconnection;
 * it is that the very first cadence, before any frame has arrived, is already the fast one.
 *
 * THE TIMER COUNT IS THE REAL SUBJECT
 * Every bug in this file has the same shape: two timers where one was intended. An `error`
 * that arms a second interval without clearing the first does not break anything visible —
 * it just doubles the request rate, quietly, forever, on a connection that is already
 * struggling. So the probe counts live intervals rather than observing that polling works,
 * and it fires `error` three times to prove the count is a fixed point and not a coincidence.
 *
 * A FRAME IS A NOTIFICATION, NOT A DELIVERY
 * `alarm` and `state` carry a payload on the wire, and it is tempting to render it. The
 * contract forbids that: everything on screen must be reconstructible from `GET state`, so a
 * dropped frame costs freshness and never correctness. The probe asserts each frame causes a
 * re-read, which is what that rule looks like from the outside.
 *
 * RUN AFTER A BUILD — this reads the generated bundle, not the source.
 *     node scripts/build-client.mjs && node _probe/client/stream.mjs
 */
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../../lib/client.js', import.meta.url)
const API_PREFIX = '/dsh-loop-guard/api/'

let source
try {
  source = readFileSync(BUNDLE, 'utf8')
} catch (error) {
  console.error('cannot read lib/client.js — run: node scripts/build-client.mjs')
  process.exit(1)
}

/* --- load the bundle the way the ModuleLoader does ---------------------- */

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

const React = {
  createElement: (type, props) => ({ type, props }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f(),
  useSyncExternalStore: (s, g) => g(),
  Fragment: 'F',
}
new Function('window', source)(globalThis.window)
const api = captured.factory((n) => {
  if (n === 'react') return React
  throw new Error('req ' + n)
})

/* --- count live intervals instead of trusting that polling works --------- */

let live = 0
const intervals = new Map()
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

globalThis.setInterval = (fn, delay) => {
  const id = realSetInterval(fn, delay)
  intervals.set(id, delay)
  live += 1
  return id
}
globalThis.clearInterval = (id) => {
  if (intervals.has(id)) {
    intervals.delete(id)
    live -= 1
  }
  return realClearInterval(id)
}

/** The only cadence currently armed. Asserts there is exactly one. */
const cadence = () => (intervals.size === 1 ? [...intervals.values()][0] : undefined)

/* --- an EventSource we can fire by hand --------------------------------- */

const listeners = new Map()
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.closed = false
    this.readyState = 0
    listeners.set(this, {})
  }
  addEventListener(name, fn) {
    const table = listeners.get(this)
    table[name] = (table[name] || []).concat(fn)
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  emit(name) {
    for (const fn of listeners.get(this)[name] || []) fn({ type: name })
  }
}
globalThis.EventSource = FakeEventSource

let fetches = 0
globalThis.fetch = async () => {
  fetches += 1
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: { version: 1, config: {}, sessions: [], hits: [] } }),
  }
}

const results = []
const check = (name, condition, detail) => results.push({ name, ok: condition, detail })

const ctx = { sessions: { list: { subscribe: () => () => {} } } }

/* --- 1. the first cadence is already the fast one ----------------------- */

const store = api.createStore(ctx, 'probe')
store.start()
const stream = [...listeners.keys()].pop()

check('start() arms exactly one interval', live === 1, 'live=' + live)
check('first cadence is the degraded 2000ms', cadence() === 2000, String(cadence()))
check('EventSource url matches the contract prefix', stream !== undefined && stream.url === API_PREFIX + 'events', stream?.url)

/* --- 2. `open` relaxes it, still one timer ------------------------------ */

stream.emit('open')
check('open() relaxes to 5000ms', cadence() === 5000, String(cadence()))
check('still exactly one interval after open', live === 1, 'live=' + live)

/* --- 3. `error` tightens it, and must not stack a second ---------------- */

stream.emit('error')
check('error() tightens to 2000ms', cadence() === 2000, String(cadence()))
check('still exactly one interval after error', live === 1, 'live=' + live)
check('error does NOT close the stream (auto-reconnect preserved)', stream.closed === false)

/* --- 4. the count is a fixed point, not a coincidence ------------------- */

stream.emit('error')
stream.emit('error')
check('repeated errors leak no timers', live === 1, 'live=' + live)

/* --- 5. a frame means "re-read", never "carry the data" ----------------- */

const before = fetches
stream.emit('alarm')
stream.emit('state')
await new Promise((resolve) => setTimeout(resolve, 30))
check('alarm and state frames each trigger a re-read', fetches >= before + 2, 'fetches ' + before + ' -> ' + fetches)

/* --- 6. dispose stops the poll and closes the stream -------------------- */

store.dispose()
check('dispose clears the interval', live === 0, 'live=' + live)
check('dispose closes the EventSource', stream.closed === true)

const settled = fetches
await new Promise((resolve) => setTimeout(resolve, 120))
check('no fetches after dispose', fetches === settled, 'fetches ' + settled + ' -> ' + fetches)

/* ------------------------------------------------------------------ report */

let failures = 0
for (const result of results) {
  if (!result.ok) failures += 1
  console.log((result.ok ? 'PASS  ' : 'FAIL  ') + result.name + (result.detail === undefined ? '' : '   [' + result.detail + ']'))
}
console.log('')
console.log(failures === 0 ? 'ALL ' + results.length + ' PASS' : failures + ' FAILURES of ' + results.length)
process.exit(failures === 0 ? 0 : 1)
