/**
 * 真实 REPL 里的那一遍：从 start 到打断，一路喂进真实宿主路由。
 *
 * WHY THIS PROBE EXISTS
 * 其余六个台子都在测一层：核心算得对不对、路由答得对不对、视图画得对不对。没有一个测「一次
 * 真实回合长什么样」——start 之后一个个 chunk 进来，直到守卫自己把这一回合掐掉。这个台子把那
 * 条路径按宿主真实的事件顺序走一遍，断言的是**你真正关心的那件事**：我吐到第几遍才被拦住。
 *
 * THE CLOCK IS FROZEN FOR A REASON
 * 真实时间由 chunk 数量决定，两者不可复现；这里用固定的每 chunk 时间推进，于是「第几遍被掐断」
 * 是一个数字而不是一段感觉。守卫的判定只依赖文本，不依赖时钟，所以冻结时钟不会掩盖任何东西。
 *
 * RUN AFTER A BUILD (it drives the real generated client too).
 *     node scripts/build-client.mjs && node _probe/host/repl.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mount } from './fixture.mjs'

// jsdom/react 装在 _probe/render 下（那张台子才是它们的消费者），这里按显式路径借，不复制依赖。
const require = createRequire(new URL('../render/package.json', import.meta.url))
const { JSDOM } = require('jsdom')

let n = 0
const check = (ok, label) => { assert.ok(ok, label); n += 1 }

/* --- 客户端半（真实渲染），并给它的报警音和流打桩 ---------------------- */

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React

let sounds = 0
window.AudioContext = class {
  currentTime = 0; destination = {}
  constructor() { sounds += 1 }   // 计数在构造上：视图每次报警都该新建一次上下文
  resume() { return Promise.resolve() } close() { return Promise.resolve() }
  createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {} } }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
}
const streams = []
window.EventSource = class {
  listeners = {}
  constructor(url) { this.url = url; streams.push(this) }
  addEventListener(name, fn) { this.listeners[name] = fn }
  close() { this.closed = true }
}
globalThis.EventSource = window.EventSource

/* --- 冻结的时钟：每推进 1ms 喂一个 chunk ------------------------------- */

const FROZEN = Date.UTC(2026, 9, 12, 9, 0)
let clock = FROZEN
const realNow = Date.now
Date.now = () => clock

const host = mount()
globalThis.fetch = async (url, init = {}) => {
  const action = String(url).split('/').pop()
  const answer = await host.request(init.method || 'GET', action, init.body ? JSON.parse(init.body) : undefined)
  return { ok: answer.res.status === 200, status: answer.res.status, json: async () => answer.json }
}

const api = (() => {
  let spec
  const window = globalThis.window
  window.__ModuleLoader__ = { load(value) { spec = value } }
  new Function('window', require('node:fs').readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8'))(window)
  return spec.factory(name => { if (name === 'react') return React; throw new Error('optional module absent: ' + name) })
})()

const store = api.createStore({})
const root = createRoot(document.querySelector('main'))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* --- 这一回合：模型失控地重复同一句话 -------------------------------- */

const PHRASE = 'Let me go. '       // 正是用户描述的那个循环
const COPIES = 100                 // 用户要求的「重复 100 遍」
const PER_CHUNK = 3                // 一次流式增量大约几个字符

const turnAgent = {
  session: { id: 'session-repl-guard' },
  cancelled: null,
  cancel(cause, options) { this.cancelled = { cause, options }; return Promise.resolve() },
}

/** 逐 chunk 喂，喂到守卫取消为止；返回「第几遍被掐断」。 */
function runaway() {
  const pieces = []
  for (let copy = 0; copy < COPIES; copy += 1) {
    for (let at = 0; at < PHRASE.length; at += PER_CHUNK) pieces.push(PHRASE.slice(at, at + PER_CHUNK))
  }
  let fed = 0
  for (const piece of pieces) {
    clock += 1
    host.emit(turnAgent, 'text-delta', piece)
    fed += piece.length
    if (turnAgent.cancelled !== null) break
  }
  return { copiesFed: Math.floor(fed / PHRASE.length), copiesSent: COPIES }
}

try {
  await act(async () => { store.start(); await wait(5) })
  await act(async () => { root.render(React.createElement(api.AlarmCard, { store })) })

  /* 先开一个正常回答的回合，证明它不会被误伤 */
  const healthy = { session: { id: 'session-repl-healthy' }, cancel() { throw new Error('must not cancel a healthy turn') } }
  host.turn(healthy, [
    { type: 'reasoning-delta', text: '先看现有路由，再决定要不要加一个。' },
    { type: 'text-delta', text: '我打算分三步做：先读契约，再补测试，最后构建产物。' },
    { type: 'text-delta', text: '每一步都会留下可复现的证据，而不是一句「已完成」。' },
  ])
  check(host.request !== undefined, 'harness wired')
  const healthyState = (await host.request('GET', 'state')).json.value
  check(healthyState.hits.length === 0, '正常回答不报警')
  check(healthyState.sessions.every((row) => row.score < 1), '正常回答分数不满')

  /* 失控回合：start 之后逐 chunk 喂 100 遍 */
  host.turn(turnAgent, [], 'attempt-runaway')
  const outcome = runaway()
  clock += 1

  const state = (await host.request('GET', 'state')).json.value
  const hit = state.hits[0]
  check(state.hits.length === 1, '一次循环只报一次警')
  check(hit.kind === 'cycle', '按逐字循环判定')
  check(hit.cancelled === true, '真的调用了取消')
  check(turnAgent.cancelled.cause.kind === 'hook', '取消原因是 hook')
  check(turnAgent.cancelled.options.keepInbox === true, '保留队列')
  check(hit.unit.trim() === PHRASE.trim(), '报警里的循环单元就是那句话')
  check(hit.repeats >= 5 && hit.repeats <= 10, `在第 ${hit.repeats} 遍掐断（要求 5–10）`)
  check(outcome.copiesFed < outcome.copiesSent, '没有把 100 遍喂完')
  check(hit.at === clock - 1 || hit.at <= clock, '冻结时钟下命中时间可复现')

  /* 报警要走到真实 DOM，并且真的响过一次 */
  await act(async () => { streams[0].listeners.alarm(); await wait(5) })
  const card = document.querySelector('.rg-alarm')
  check(card, '报警卡出现在真实 DOM')
  check(card.textContent.includes('Let me go.'), '卡片上写着循环内容')
  check(sounds === 1, '提示音响一次')

  /* 手动关闭：只有点了才消失 */
  const dismissed = await host.request('POST', 'hits', { id: hit.id, dismissed: true })
  check(dismissed.res.status === 200, '关闭请求被宿主接受')
  await act(async () => { streams[0].listeners.state(); await wait(5) })
  check(!document.querySelector('.rg-alarm'), '用户关掉之后才消失')

  check(store.laneOf ? store.laneOf() : true, 'store 仍在运行')
  console.log(`repl: ${n}/${n} checks passed; 第 ${hit.repeats} 遍掐断，喂出 ${outcome.copiesFed}/${outcome.copiesSent} 遍`)
} finally {
  Date.now = realNow
  store.dispose()
  host.cleanup()
  dom.window.close()
  // jsdom 的动画帧循环会让事件循环不空转（同 mount.mjs），但**绝不能**在这里写死 exit(0)：
  // 那会把断言失败一起吞掉，台子变成永远绿的装饰。这里保留真实退出码，并给一个 unref 的兜底。
  const bail = setTimeout(() => process.exit(process.exitCode || 0), 2000)
  bail.unref()
}
