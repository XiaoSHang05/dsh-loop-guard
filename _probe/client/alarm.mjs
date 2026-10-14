/**
 * Harness for the alarm card's one unbreakable rule (`lib/client.js`).
 *
 * WHY THIS PROBE EXISTS
 * The contract is unusually blunt about it: "Alarm card: never auto-dismisses. A card that
 * vanished on its own would be the one alarm the user was away for." That is the whole point
 * of the plugin. A rice guard that notices a runaway and then lets the notification slide off
 * the screen after a few seconds has not guarded anything — it has produced a log line the
 * user was not present to read.
 *
 * THE FAILURE MODE IS ADDITIVE, WHICH IS WHY IT NEEDS A PROBE
 * Nobody writes "dismiss the card after 5s" on purpose. It arrives as a toast helper, a
 * convenience timer, a "clean up the UI" refactor — a `setTimeout` that is obviously fine
 * everywhere else. Nothing about the diff looks like it touches the contract. So the probe
 * does not check that the card *renders*; it counts every timer the render arms, and asserts
 * the count is zero. A future timer is then a failing test rather than a shipped regression.
 *
 * IT ALSO PINS THE INVERSE
 * "Never dismisses itself" is half the rule; the other half is that the card must actually
 * leave when the user says so, and must not render at all for a hit that is already dismissed
 * or for a host with the alarm switched off. A probe that only proved persistence would pass
 * on a card that never disappears under any circumstance — which is just as broken.
 *
 * RUN AFTER A BUILD — this reads the generated bundle, not the source.
 *     node scripts/build-client.mjs && node _probe/client/alarm.mjs
 */
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../../lib/client.js', import.meta.url)

let source
try {
  source = readFileSync(BUNDLE, 'utf8')
} catch (error) {
  console.error('cannot read lib/client.js — run: node scripts/build-client.mjs')
  process.exit(1)
}

/* --- count every timer the render arms ---------------------------------- */

let timersArmed = 0
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, delay) => {
  timersArmed += 1
  return realSetTimeout(fn, delay)
}

/* --- a React stub that still runs render -------------------------------- */

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length ? children : undefined },
  }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f(),
  useSyncExternalStore: (s, g) => g(),
  Fragment: 'F',
}

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
new Function('window', source)(globalThis.window)
const api = captured.factory((n) => {
  if (n === 'react') return React
  throw new Error('req ' + n)
})

const results = []
const check = (name, condition, detail) => results.push({ name, ok: condition, detail })

const hit = {
  id: 'hit-1',
  sessionId: 's1',
  label: 'demo session',
  stream: 'text',
  kind: 'cycle',
  unit: 'the same sentence over and over',
  repeats: 7,
  at: Date.now(),
  cancelled: true,
  dismissed: false,
}

const snapshotWith = (hits, config) => ({
  status: 'ready',
  error: null,
  reachable: true,
  config: { enabled: true, minRepeat: 5, densityRatio: 0.75, alarm: true, sound: true, cancel: true, ...(config || {}) },
  sessions: [],
  hits,
  at: Date.now(),
})

const storeWith = (hits, config) => ({
  subscribe: () => () => {},
  getSnapshot: () => snapshotWith(hits, config),
  sync: () => {},
  write: async () => ({ ok: true }),
  start: () => {},
  dispose: () => {},
})

/* --- 1. the card renders for a live hit --------------------------------- */

const store = storeWith([hit])
const card = api.AlarmCard({ store })
check('card renders for an undismissed hit', card !== null && card !== undefined, String(card && card.type))

/* --- 2. the load-bearing assertion: render arms no timer ---------------- */

check('rendering the card arms no timer', timersArmed === 0, 'armed=' + timersArmed)

/* --- 3. and it is still there after every timer has had its chance ------ */

await new Promise((resolve) => realSetTimeout(resolve, 250))
check('card is still rendered after timers fired', api.AlarmCard({ store }) !== null)
check('no timer was armed across the whole probe', timersArmed === 0, 'armed=' + timersArmed)

/* --- 4. the dismiss button is the only exit ----------------------------- */

const actions = card.props.children.find((c) => c && c.type === 'div' && c.props.className === 'rg-alarm-actions')
check('the card offers an actions row', actions !== undefined)
const button = actions === undefined ? undefined : actions.props.children[0]
check('dismiss button exists', button !== undefined && button.type === 'button', button && button.props.className)
check('dismiss button is the primary action', String(button && button.props.className).includes('rg-button--primary'), button && button.props.className)
check('dismiss is wired to a handler', typeof (button && button.props.onClick) === 'function')

/* --- 5. the card follows the snapshot, not a local timer ---------------- */

check('a dismissed hit renders nothing', api.AlarmCard({ store: storeWith([{ ...hit, dismissed: true }]) }) === null)
check('alarm=false renders nothing', api.AlarmCard({ store: storeWith([hit], { alarm: false }) }) === null)
check('no hits renders nothing', api.AlarmCard({ store: storeWith([]) }) === null)

/* ------------------------------------------------------------------ report */

let failures = 0
for (const r of results) {
  if (!r.ok) failures += 1
  console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail === undefined ? '' : '   [' + r.detail + ']'))
}
console.log('')
console.log(failures === 0 ? 'ALL ' + results.length + ' PASS' : failures + ' FAILURES of ' + results.length)
process.exit(failures === 0 ? 0 : 1)
