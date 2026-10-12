/**
 * dsh-loop-guard — 宿主半：订阅实时输出流、检测复读、打断回合，并把结果开成一个同源 HTTP/SSE 接口。
 *
 * ## 为什么需要这一半
 *
 * 模型进入退化循环后会一直吐同一段文字，直到撞上 token 上限。DSH 把「看得见流」和「掐得断回合」
 * 两件事都给了插件，但没有任何东西把它们接起来：
 *
 * - `agent/assistant-stream` 每来一个 chunk 就触发一次，带 `text-delta`（用户看到的那段）和
 *   `reasoning-delta`（模型自己想的那些）。两条流都在这里看着。
 * - `agent.cancel(cause, { keepInbox: true })` 掐掉在飞的这一回合，但保留排队的工作。
 *
 * 于是这个文件做的事是：喂流 → 问检测核心 → 命中就记一条 + 打断 + 广播，然后把同一份状态
 * 用 JSON 暴露出去给客户端半画监控页和报警卡。
 *
 * ## 形状
 *
 * `/dsh-loop-guard/api/` 下的一组同源 JSON 路由，外加一个 SSE 通知流，注册在宿主的 webServer 上。
 * 这是 `@xxxyz/dsh-mcp-manager` 给设置页用的同一套路子，也是姊妹插件 `dsh-wechat-rooms` 已经跑通的
 * 那一套：整个功能关在本包内，不需要改 DSH 一行，也不需要改别人。
 *
 * ## 惰性读服务
 *
 * 契约（CONTRACT.md「Rules that apply to every half」）要求 `ctx.get(name)` 每次用时现读，
 * 绝不在 apply 里捕获：loader 是并发挂载的，apply 跑的那一刻服务可能还没上。下面所有
 * `ctx.get(...)` 都在调用点现读，没有一处存进闭包。
 *
 * ## 信任边界
 *
 * 路由在这里不做鉴权。它挂在宿主的 webServer 后面，而 webServer 只有穿过连接层的会话闸门
 * （没有签名 cookie 的请求根本拿不到响应）才够得着。客户端自己报它代表哪个会话，这和
 * `remote.commands` 里客户端报「以哪个 agent 跑」是一回事。路由会校验每个入参的形状，
 * 但不会去重新推导调用者的身份。
 *
 * @module dsh-loop-guard
 */

import Schema from '@deepseek-ai/schemastery'
import { createDetector, DEFAULTS } from './detect.js'

// Settings is addressed by the patch entry id, never the package name.
const SETTINGS_NS = 'loop-guard'

/** Cordis 插件名。 */
export const name = 'dsh-loop-guard'

/** 本包独占的路由前缀。 */
const API_PREFIX = '/dsh-loop-guard/api/'

/**
 * 路由的线上版本号，由 `GET health` 回显。
 *
 * 两半是分开发布的：这一半只在宿主进程启动时读一次，客户端那一半每次页面加载都会重新下载。
 * 所以正在跑的宿主完全可能比跟它说话的 bundle 更旧，客户端必须能看出来——否则「路由不存在」
 * 和「请求被拒」在它眼里长得一模一样。
 *
 * 1 — health / state / config / monitor / hits / events。
 */
const API_VERSION = 1

/** 命中历史保留条数（契约：最多 50 条，新的在前）。 */
const HITS_CAP = 50

/**
 * SSE 心跳间隔，毫秒。
 *
 * 空闲的 SSE 连接和断掉的 SSE 连接长得一样，浏览器和中间层最后都会把空连接收掉。
 * 一个注释帧只有两个字节，却能让 socket 可证明地活着。
 */
const HEARTBEAT_MS = 15_000

/** state 帧的最小间隔，毫秒（契约：最多每 500ms 一次，且只在 sessions 变了才发）。 */
const STATE_THROTTLE_MS = 500

/**
 * 生效配置的初值。
 *
 * 六个可调阈值直接取自检测核心的 `DEFAULTS`，不在这里抄第二份数字：两半共用同一组默认值，
 * 才不会出现「宿主说 5、核心按 6 算」这种没人查得出来的漂移。
 */
const DEFAULT_CONFIG = {
  enabled: true,                              // 总开关；关掉 = 什么都不看、什么都不打断
  minRepeat: DEFAULTS.minRepeat,              // 连续重复几遍算循环
  minUnit: DEFAULTS.minUnit,                  // 多短的重叠就不值得叫复读
  maxUnit: DEFAULTS.maxUnit,                  // 最长搜到多长的单元
  windowChars: DEFAULTS.windowChars,          // 搜索跑在多大的尾部窗口上
  densityLines: DEFAULTS.densityLines,        // 第二个检测器看几行
  densityRatio: DEFAULTS.densityRatio,        // 这些行里重复行要占多大比例
  structLines: DEFAULTS.structLines,          // 第三个检测器：同骨架连续几行
  structShare: DEFAULTS.structShare,          // 这些行里字母要占多大比例
  cancel: true,                               // false = 只报警，永不打断
  alarm: true,                                // false = 不弹卡片
  sound: true,                                // false = 卡片静音
  scopeDefault: 'all',                        // 'all' | 'selected'
}

/**
 * 每个字段的校验器。`POST config` 只认这张表里的键，未知键直接 400。
 *
 * 严格是有意的：配置面已经在契约里冻死了，多出来的键只可能是客户端 bug，
 * 悄悄吞掉会让那个 bug 活到下一次联调。
 */
const CONFIG_FIELDS = {
  enabled: { kind: 'boolean' },
  minRepeat: { kind: 'integer', min: 2, max: 1000 },
  minUnit: { kind: 'integer', min: 1, max: 4096 },
  maxUnit: { kind: 'integer', min: 1, max: 65536 },
  windowChars: { kind: 'integer', min: 256, max: 1_048_576 },
  densityLines: { kind: 'integer', min: 2, max: 200 },
  densityRatio: { kind: 'number', min: 0, max: 1 },
  structLines: { kind: 'integer', min: 0, max: 200 },
  structShare: { kind: 'number', min: 0, max: 1 },
  cancel: { kind: 'boolean' },
  alarm: { kind: 'boolean' },
  sound: { kind: 'boolean' },
  scopeDefault: { kind: 'scope', values: ['all', 'selected'] },
}

// Editable fields must be volatile: settings.update persists them without
// unloading a running detector. The same field table validates HTTP patches.
export const Config = Schema.object(Object.fromEntries(
  Object.entries(CONFIG_FIELDS).map(([key, field]) => {
    let schema
    if (field.kind === 'boolean') schema = Schema.boolean()
    else if (field.kind === 'scope') schema = Schema.union(field.values.map(value => Schema.const(value)))
    else {
      schema = Schema.number().min(field.min).max(field.max)
      if (field.kind === 'integer') schema = schema.step(1)
    }
    return [key, schema.default(DEFAULT_CONFIG[key]).volatile()]
  }),
))

function plainConfig(value) {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.keys(CONFIG_FIELDS)
    .filter(key => Object.prototype.hasOwnProperty.call(value, key))
    .map(key => {
      const item = value[key]
      return [key, item && typeof item.get === 'function' ? item.get() : item]
    }))
}

/** 流名。契约里就这两个，检测核心也只认这两个。 */
const STREAMS = ['thinking', 'text']

/** chunk 类型到流名的映射（`text-delta` 是用户读到的，`reasoning-delta` 是模型想的）。 */
const STREAM_BY_CHUNK = {
  'text-delta': 'text',
  'reasoning-delta': 'thinking',
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 写一个 JSON 响应。 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 收集并解析 JSON 请求体。空体算 `{}`。
 *
 * 解析失败一律包成 400：契约的状态码表把「body 读不出来」定成 bad body，而 `JSON.parse`
 * 抛的 SyntaxError 不带 `status`，直接 reject 出去会被统一 catch 归成 500——那等于把
 * 「你发坏了」说成「我坏了」，客户端会照着 500 渲染成宿主出错。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(badRequest('request body is not valid JSON'))
      }
    })
    // 传输中途出错同样是「body 读不出来」，跟解析失败归一类。
    req.on('error', () => reject(badRequest('request body could not be read')))
  })
}

/** 非空字符串，否则 undefined。 */
function asText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 造一个带 HTTP 状态码的错误。路由表的统一 catch 读 `status` 和 `code`。 */
function httpError(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** 400。 */
function badRequest(message) {
  return httpError(400, 'bad-request', message)
}

/**
 * 503。宿主上没有 agent 运行时时，除 health 外的每条路由都答它。
 *
 * 客户端把 503 和 404/501 并列当成「路由在、但宿主半看不了任何东西」，所以这个码不是
 * 「插件没装」，而是「装了也没得看」——`GET health` 保持 200 正是为了让人能区分这两者。
 */
function noBackend() {
  return httpError(503, 'no-backend', 'this host has no agent runtime, nothing can be watched')
}

/**
 * 校验一个配置补丁，返回「干净的补丁」。
 *
 * 只返回被显式给出的字段，调用方据此合并——这样 `POST config` 天生就是增量语义，
 * 客户端不必先把整个配置读回来再写回去（那中间会丢并发的改动）。
 */
function cleanConfigPatch(patch, base = DEFAULT_CONFIG) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('patch must be an object')
  }
  const clean = {}
  for (const [key, raw] of Object.entries(patch)) {
    const field = CONFIG_FIELDS[key]
    if (field === undefined) throw badRequest(`unknown config field "${key}"`)
    if (field.kind === 'boolean') {
      if (typeof raw !== 'boolean') throw badRequest(`${key} must be a boolean`)
      clean[key] = raw
      continue
    }
    if (field.kind === 'scope') {
      if (!field.values.includes(raw)) {
        throw badRequest(`${key} must be one of ${field.values.join(', ')}`)
      }
      clean[key] = raw
      continue
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw badRequest(`${key} must be a finite number`)
    }
    if (field.kind === 'integer' && !Number.isInteger(raw)) {
      throw badRequest(`${key} must be an integer`)
    }
    if (raw < field.min || raw > field.max) {
      throw badRequest(`${key} must be within [${field.min}, ${field.max}]`)
    }
    clean[key] = raw
  }
  // 跨字段：窗口比单元还小的话检测核心永远搜不到东西，这种组合当场拒掉比让它静默失效好。
  const merged = { ...base, ...clean }
  if (merged.minUnit > merged.maxUnit) throw badRequest('minUnit must not exceed maxUnit')
  if (merged.maxUnit > merged.windowChars) {
    throw badRequest('maxUnit must not exceed windowChars')
  }
  return clean
}

/** 从配置里挑出检测核心认识的那几个阈值。 */
function detectorOptions(config) {
  return {
    minRepeat: config.minRepeat,
    minUnit: config.minUnit,
    maxUnit: config.maxUnit,
    windowChars: config.windowChars,
    densityLines: config.densityLines,
    densityRatio: config.densityRatio,
    structLines: config.structLines,
    structShare: config.structShare,
  }
}

/**
 * 取一个 payload 里的 agent。
 *
 * `dsh-agent-loop` 自己 `emit('agent/assistant-stream', { frame })` 只发了 frame，
 * 但事件经过 dispatch 时会注入 agent（任务书给的形状是 `{ agent, frame }`）。两处都试一遍
 * 的成本是一个 `??`，而猜错的成本是整个插件看不见任何流。
 */
function agentOf(payload) {
  const candidate = payload?.agent ?? payload?.frame?.agent
  return candidate !== null && typeof candidate === 'object' ? candidate : undefined
}

/**
 * 取会话 id。
 *
 * The Agent is the authority. LlmAttemptId is opaque: deriving an identity
 * from its spelling can associate a stream (and a cancellation) with the wrong session.
 */
function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 会话的显示名：有标题就用标题，没有就用 id（契约原话）。
 *
 * 标题是锦上添花，`sessionTitle` 服务可能压根没装，`get()` 也可能因为会话没有合格输入而返回
 * undefined，所以整段包在 try 里——取不到标题绝不该影响看流。
 */
function labelOf(ctx, agent, sessionId) {
  try {
    const title = ctx.get('sessionTitle')?.get?.(agent?.session)?.title
    if (typeof title === 'string' && title.trim() !== '') return title.trim()
  } catch (error) {
    /* 标题读不到就算了，用 id 顶上 */
  }
  return sessionId
}

// ---------------------------------------------------------------------------
// 看守本体
// ---------------------------------------------------------------------------

/**
 * 守卫：会话表、命中历史、检测器注册表，以及对外的三种动作（喂流 / 记命中 / 读状态）。
 *
 * @param ctx - cordis 上下文，用来惰性读服务、记日志。
 * @param initialConfig - 合并好的初始配置（默认值 + 插件 config + 已持久化的覆盖）。
 * @param persist - 配置变更后的持久化出口，尽力而为，失败不回滚内存里的值。
 * @param broadcast - 往 SSE 订阅者发一帧。
 */
function createGuard(ctx, initialConfig, persist, broadcast) {
  let config = initialConfig

  /** sessionId -> 会话行。 */
  const sessions = new Map()
  /** 命中历史，新的在前。 */
  const hits = []
  /** 命中 id 的自增尾号，保证同一毫秒内的两次命中也各不相同。 */
  let hitSeq = 0

  /**
   * sessions 的版本号。
   *
   * 契约要求 state 帧「只在 sessions 变了才发」。比较整个 sessions 数组既贵又脆，
   * 所以这里在每次真正改动行内容的地方自增一个计数器，发送方只比两个数字。
   */
  let revision = 0
  let sentRevision = -1
  let stateTimer = null

  function bump() {
    revision += 1
  }

  function log(level, ...args) {
    ctx.logger?.[level]?.(...args)
  }

  /**
   * 排一次 state 广播。
   *
   * 同一个窗口里被叫多少次都只排一次定时器：这是「最多每 500ms 一次」的落点。
   * 定时器 unref 掉——它是通知，不该拖住宿主退出。
   */
  function scheduleState() {
    if (stateTimer !== null) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      if (revision === sentRevision) return
      sentRevision = revision
      broadcast('state', { sessions: sessionsValue() })
    }, STATE_THROTTLE_MS)
    stateTimer.unref?.()
  }

  /** 某个会话此刻是否真的在被看着。 */
  function isMonitored(record) {
    if (!config.enabled) return false
    if (record.monitored === false) return false
    if (record.monitored === true) return true
    // 用户没表过态：由 scopeDefault 决定。'all' 是默认值，也就是「来者都看」。
    return config.scopeDefault === 'all'
  }

  /** 取（必要时建）一行会话。 */
  function rowOf(sessionId) {
    let record = sessions.get(sessionId)
    if (record === undefined) {
      record = {
        sessionId,
        label: sessionId,
        monitored: null,   // null = 跟随 scopeDefault；true/false = 用户明确表过态
        detector: null,    // 第一次真要看流时才建，省掉没人看时的缓冲
        attemptId: null,
        lastHitAt: null,
        agent: undefined,
      }
      sessions.set(sessionId, record)
      bump()
    }
    return record
  }

  /**
   * 把一次命中记进历史，并在需要时打断回合。
   *
   * 顺序是刻意的：先落 hit、再打断、最后广播。打断失败不能让这条 hit 丢掉——报警比掐断重要，
   * 用户至少还看得见发生了什么。
   */
  function recordHit(record, hit, agent) {
    hitSeq += 1
    const entry = {
      id: `h${Date.now().toString(36)}-${hitSeq.toString(36)}`,
      sessionId: record.sessionId,
      label: record.label,
      stream: hit.stream,
      kind: hit.kind,
      unit: hit.unit,
      repeats: hit.repeats,
      at: typeof hit.at === 'number' ? hit.at : Date.now(),
      cancelled: false,
      dismissed: false,
    }

    hits.unshift(entry)
    if (hits.length > HITS_CAP) hits.length = HITS_CAP
    record.lastHitAt = entry.at
    bump()

    if (config.cancel && typeof agent?.cancel === 'function') {
      try {
        // keepInbox:true 是关键：只掐掉在飞的这一回合，排队和引导中的工作原样留着。
        // 不带它的话 cancel 会连队列一起清空——用户只是想让它别复读了，不是想丢掉自己的输入。
        agent.cancel({ kind: 'hook', reason: 'loop-guard: repeated output' }, { keepInbox: true })
        entry.cancelled = true
      } catch (error) {
        log('warn', 'dsh-loop-guard: cancel failed for %s (%s)', record.sessionId, String((error && error.message) || error))
      }
    }

    // alarm 帧是「弹卡片」的触发器，所以 alarm:false 时不发它。但 hit 本身仍然要送达客户端，
    // 于是靠上面那次 bump 走一帧 state——卡片没了，命中历史还在。
    if (config.alarm) {
      broadcast('alarm', {
        id: entry.id,
        sessionId: entry.sessionId,
        label: entry.label,
        stream: entry.stream,
        kind: entry.kind,
        unit: entry.unit,
        repeats: entry.repeats,
        at: entry.at,
        cancelled: entry.cancelled,
      })
    }
    scheduleState()
  }

  /**
   * 喂一个 chunk。
   *
   * 整段包在 try 里：这是挂在宿主事件总线上的监听器，抛出去的异常会顺着 emit 冒到别人的
   * 调用栈里。看守坏了可以，但它绝不能把宿主一起带走。
   */
  function ingest(payload) {
    try {
      const frame = payload?.frame
      if (!frame || typeof frame !== 'object') return
      if (frame.type !== 'start' && frame.type !== 'chunk') return
      const agent = agentOf(payload)
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return
      const record = rowOf(sessionId)
      record.agent = agent
      if (frame.type === 'start' || record.attemptId !== frame.attemptId) {
        record.attemptId = frame.attemptId
        record.detector?.reset()
        record.label = labelOf(ctx, agent, sessionId)
        bump()
        scheduleState()
      }
      if (frame.type === 'start') return
      const stream = STREAM_BY_CHUNK[frame.chunk?.type]
      const text = frame.chunk?.text
      if (stream === undefined || typeof text !== 'string' || text === '') return
      if (!isMonitored(record)) return
      if (record.detector === null) record.detector = createDetector(detectorOptions(config))
      const hit = record.detector.push(stream, text)
      bump()
      scheduleState()
      if (hit != null) recordHit(record, hit, agent)
    } catch (error) {
      log('warn', 'dsh-loop-guard: stream ingest failed (%s)', String((error && error.message) || error))
    }
  }

  /**
   * 一行会话的线上形状。
   *
   * `stream` 是「离循环最近的那条流」：两条流各自独立计数（契约第 4 条），这里取分数高的那条；
   * 平分时比谁攒的字符多，都没动过就是 null。
   */
  function sessionValue(record) {
    const snapshot = record.detector?.snapshot?.() ?? {}
    let best = null
    let bestScore = 0
    let chars = 0
    for (const stream of STREAMS) {
      const unit = snapshot[stream]
      const streamChars = typeof unit?.chars === 'number' ? unit.chars : 0
      const repeats = typeof unit?.repeats === 'number' ? unit.repeats : 0
      const score = typeof unit?.score === 'number' ? unit.score : 0
      chars = Math.max(chars, streamChars)
      if (score > bestScore || (score === bestScore && streamChars > (best?.unit?.chars ?? 0))) {
        bestScore = score
        best = { stream, unit, repeats }
      }
    }
    const repeats = best?.repeats ?? 0
    const score = bestScore
    return {
      sessionId: record.sessionId,
      label: record.label,
      monitored: isMonitored(record),
      stream: best === null ? null : best.stream,
      chars,
      repeats,
      unit: best === null ? '' : String(best.unit?.unit ?? ''),
      score: Math.round(score * 1000) / 1000,
      lastHitAt: record.lastHitAt,
    }
  }

  function sessionsValue() {
    const rows = []
    for (const record of sessions.values()) rows.push(sessionValue(record))
    return rows
  }

  function hitsValue() {
    return hits.map((entry) => ({ ...entry }))
  }

  function stateValue() {
    return { version: API_VERSION, config: { ...config }, sessions: sessionsValue(), hits: hitsValue() }
  }

  /**
   * 合并一个配置补丁并让改动立刻生效。
   *
   * 活着的检测器要重新 configure：阈值改了却只影响下一次新建的检测器，等于用户改了个寂寞。
   */
  function applyConfigPatch(patch) {
    const clean = cleanConfigPatch(patch, config)
    config = { ...config, ...clean }
    for (const record of sessions.values()) {
      record.detector?.configure?.(detectorOptions(config))
      record.detector?.reset()
    }
    bump()
    persist(clean)
    scheduleState()
    return config
  }

  /** 用户显式表态「监视 / 不监视这一个」。 */
  function setMonitored(sessionId, monitored) {
    const record = rowOf(sessionId)
    record.monitored = monitored
    record.detector?.reset()
    bump()
    scheduleState()
    return { sessionId, monitored: isMonitored(record) }
  }

  /** 关掉一条命中卡片，或清空全部。 */
  function dismiss(body) {
    if (body.clearAll === true) {
      hits.length = 0
      bump()
      scheduleState()
      return { ok: true }
    }
    const id = asText(body.id)
    if (id === undefined) throw badRequest('id is required unless clearAll is true')
    const entry = hits.find((candidate) => candidate.id === id)
    if (entry === undefined) throw httpError(404, 'unknown-hit', `unknown hit ${id}`)
    if (body.dismissed !== true) throw badRequest('dismissed must be true')
    entry.dismissed = true
    bump()
    scheduleState()
    return { ok: true }
  }

  /** 会话没了就把它从表里摘掉——「正在被看着的会话」不该包括已经关掉的。 */
  function forget(payload) {
    try {
      const agent = agentOf(payload) ?? (typeof payload?.session?.id === 'string' ? payload : undefined)
      const sessionId = agent?.session?.id ?? payload?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (sessions.delete(sessionId)) {
        bump()
        scheduleState()
      }
    } catch (error) {
      /* 摘不掉一行不影响看守本身 */
    }
  }

  /** 把初始配置里那些「用户显式选过」的会话状态带上——目前只有内存配置，预留位。 */
  function configValue() {
    return { ...config }
  }

  return {
    ingest,
    forget,
    stateValue,
    sessionsValue,
    configValue,
    applyConfigPatch,
    setMonitored,
    dismiss,
    stop() {
      if (stateTimer !== null) clearTimeout(stateTimer)
      stateTimer = null
      sessions.clear()
    },
    /** 给持久化回填用：配置被外部改掉时直接换掉整份。 */
    replaceConfig(next) {
      config = next
      for (const record of sessions.values()) {
        record.detector?.configure?.({ ...DEFAULTS, ...detectorOptions(config) })
      }
      bump()
      scheduleState()
    },
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * 事件流：一个 SSE 端点，把守卫的 alarm / state 帧扇出给每个连着的客户端。
 *
 * 这条流是**通知**，永远不是数据通道——一帧只说「有事发生了」，客户端拿到后回头读
 * `GET state`，而那份状态是权威的。丢一帧的代价是新鲜度，不是正确性。
 *
 * @returns 路由处理器、广播函数和停止函数。
 */
function createEventStream() {
  const subscribers = new Set()
  let heartbeat = null

  /** 摘掉一个订阅者；最后一个走的时候把心跳也停掉。 */
  function drop(res) {
    if (!subscribers.delete(res)) return
    if (subscribers.size > 0) return
    if (heartbeat !== null) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  /**
   * 给每个订阅者写一帧。
   *
   * 一次写入撞上 socket 拆除会让 `res.write` 抛异常、或者在 res 上发 `error`，而没接住的
   * 流错误能把宿主进程带走。把订阅者摘掉，就把这场竞态降级成丢一帧——下一帧或者客户端
   * 自己的兜底轮询会修好它。
   */
  function broadcast(event, data) {
    if (subscribers.size === 0) return
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of Array.from(subscribers)) {
      try {
        res.write(frame)
      } catch (error) {
        drop(res)
      }
    }
  }

  function handler(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: `GET ${API_PREFIX}events` },
      })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 告诉浏览器断了以后多久重连。
    res.write('retry: 2000\n\n')
    subscribers.add(res)
    if (heartbeat === null) {
      heartbeat = setInterval(() => {
        for (const current of Array.from(subscribers)) {
          try {
            current.write(': ping\n\n')
          } catch (error) {
            drop(current)
          }
        }
      }, HEARTBEAT_MS)
      heartbeat.unref?.()
    }
    res.on('error', () => drop(res))
    req.on('close', () => drop(res))
  }

  function stop() {
    if (heartbeat !== null) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    for (const res of Array.from(subscribers)) {
      try {
        res.end()
      } catch (error) {
        /* 已经断了就算了 */
      }
    }
    subscribers.clear()
  }

  return { handler, broadcast, stop }
}

// ---------------------------------------------------------------------------
// 配置持久化
// ---------------------------------------------------------------------------

/**
 * 配置的持久化出口：尽力而为。
 *
 * 契约要求「用 `ctx.get('settings')` 惰性读；没有该服务时就退化成内存配置」。`settings`
 * 服务是按 profile entry id 寻址的，而且只接受插件 Config 里声明为 `.volatile()` 的字段；
 * Config uses the host's Schemastery dependency and volatile fields. In a
 * host without Settings, values remain in memory; persistence failures are logged.
 * 插件必须能在没有 settings 的宿主上跑起来，这个函数不许抛。
 *
 * @param ctx - cordis 上下文。
 * @returns `{ read, write }`，两者都不会抛。
 */
function createConfigStore(ctx) {
  let warned = false

  function settingsOf() {
    const settings = ctx.get('settings')
    if (settings === undefined || settings === null) return undefined
    if (typeof settings.describe !== 'function' || typeof settings.update !== 'function') return undefined
    return settings
  }

  /** 读回上一次写下的配置，读不到就 undefined。 */
  function read() {
    try {
      const settings = settingsOf()
      if (settings === undefined) return undefined
      const descriptor = settings.describe().find((row) => row?.ns === SETTINGS_NS)
      const value = descriptor?.value
      if (value === null || typeof value !== 'object') return undefined
      // 只认这张表里的键：settings 里的 value 是整份插件配置，可能混着别的字段。
      const patch = {}
      for (const key of Object.keys(CONFIG_FIELDS)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) patch[key] = value[key]
      }
      return Object.keys(patch).length === 0 ? undefined : cleanConfigPatch(patch)
    } catch (error) {
      if (!warned) {
        warned = true
        ctx.logger?.info?.('dsh-loop-guard: settings service not usable, keeping config in memory (%s)', String((error && error.message) || error))
      }
      return undefined
    }
  }

  /** 写一个补丁。刻意不 await：配置已经生效了，落盘慢一点不该拖住 HTTP 响应。 */
  function write(patch) {
    try {
      const settings = settingsOf()
      if (settings === undefined) return
      const descriptor = settings.describe().find((row) => row?.ns === SETTINGS_NS)
      if (descriptor === undefined) return
      const result = settings.update(descriptor.ns, patch, descriptor.revision)
      if (result !== null && typeof result?.catch === 'function') {
        result.catch((error) => {
          if (warned) return
          warned = true
          ctx.logger?.info?.('dsh-loop-guard: config not persisted (%s)', String((error && error.message) || error))
        })
      }
    } catch (error) {
      if (warned) return
      warned = true
      ctx.logger?.info?.('dsh-loop-guard: config not persisted (%s)', String((error && error.message) || error))
    }
  }

  return { read, write }
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

/**
 * 路由表。每个条目写明它答应哪个方法和路径，并返回要作为 `{ ok: true, value }` 发出去的值。
 *
 * 所有处理器签名统一是 `(req, url, body)`，`apply` 三个参数无条件全传：GET 忽略 `body`，
 * POST 什么都不忽略。姊妹插件在这个签名上栽过一次——处理器写成 `(req, body)` 时每个 POST
 * 收到的其实是解析好的 URL，于是不管客户端发什么都答「字段必填」，而且两个 harness 都抓不到。
 *
 * @param guard - 看守本体。
 * @param backendPresent - 这台宿主上还有没有能打断回合的 agent 运行时。
 */
function routesOf(guard, backendPresent) {
  return {
    'GET health': async () => ({
      // health 永远答 200，哪怕这台宿主根本没有 agent 运行时——它是唯一能把
      // 「插件没装」（404）和「装了但没得看」（503）区分开的路由，所以它自己不能 503。
      backend: backendPresent() ? 'present' : 'absent',
      version: API_VERSION,
    }),

    'GET state': async () => guard.stateValue(),

    'POST config': async (req, url, body) => {
      const patch = body?.patch
      if (patch === null || typeof patch !== 'object') throw badRequest('patch is required')
      return { config: guard.applyConfigPatch(patch) }
    },

    'POST monitor': async (req, url, body) => {
      const sessionId = asText(body.sessionId)
      if (sessionId === undefined) throw badRequest('sessionId is required')
      if (typeof body.monitored !== 'boolean') throw badRequest('monitored must be a boolean')
      // 未知会话也建行：scopeDefault 是 'selected' 的时候，用户得能在会话开始吐字之前先把它选上。
      return guard.setMonitored(sessionId, body.monitored)
    },

    'POST hits': async (req, url, body) => guard.dismiss(body ?? {}),
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * `apply` 之前要等到的服务。
 *
 * `webServer` 是唯一的硬依赖：API 就是这个宿主半，没有 web server 的 profile 里它无事可做，
 * 等着它能让这层依赖出现在 profile 树上，而不是等到运行时才发现。`settings`、`sessionTitle`
 * 都是按需惰性读的——没有它们，插件照样挂载，只是配置留在内存里、会话名退化成 id。
 */
export const inject = ['webServer']

/**
 * 挂载看守。
 *
 * @param ctx - cordis 上下文，作用域已经限到本插件。
 * @param pluginConfig - 来自 cordis 配置的初始值，可能没有。
 */
export function apply(ctx, pluginConfig) {
  const disposers = []

  // 合并顺序：默认值 → 插件 config → 已持久化的覆盖。后者赢，因为它是用户最后一次明确表态。
  let config = { ...DEFAULT_CONFIG }
  if (pluginConfig !== null && typeof pluginConfig === 'object') {
    try {
      config = { ...config, ...cleanConfigPatch(plainConfig(pluginConfig)) }
    } catch (error) {
      ctx.logger?.warn?.('dsh-loop-guard: plugin config ignored (%s)', String((error && error.message) || error))
    }
  }

  const store = createConfigStore(ctx)
  const persisted = store.read()
  if (persisted !== undefined) config = { ...config, ...persisted }

  const stream = createEventStream()
  const guard = createGuard(ctx, config, (patch) => store.write(patch), stream.broadcast)

  // 流订阅必须带 { global: true }：`agent/assistant-stream` 是从 agent 自己的 dispatch 上发的，
  // 不带这个选项，cordis 的 context 过滤器会在它到达这里之前就把它筛掉，监听器永远不触发。
  disposers.push(ctx.on('agent/assistant-stream', (payload) => guard.ingest(payload), { global: true }))

  // 会话关掉就不再是「正在被看着的会话」。同样要 global。
  disposers.push(ctx.on('agent/disposed', (payload) => guard.forget(payload), { global: true }))

  // 路由按表逐个挂。`webServer.register` 遇到重复 path 会 throw，所以每条单独 try：
  // 一次重入的 apply（HMR 重载、二次挂载）不该把整个插件带下去。
  //
  // backendPresent 刻意是个函数而不是布尔：loader 并发挂载，apply 跑的时候 `agents`
  // 可能还没上，在这里求值会永久记住「没有」。
  const backendPresent = () => ctx.get('agents') !== undefined
  const routes = routesOf(guard, backendPresent)
  const server = ctx.get('webServer')
  if (server === undefined || server === null) {
    ctx.logger?.warn?.('dsh-loop-guard: no web server in this profile, the API is not mounted')
  } else {
    for (const key of Object.keys(routes)) {
      const [method, action] = key.split(' ')
      const path = API_PREFIX + action
      try {
        const dispose = server.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (req.method !== method) {
              sendJson(res, 405, {
                ok: false,
                error: { code: 'method-not-allowed', message: `${method} ${path}` },
              })
              return
            }
            try {
              const url = new URL(req.url || path, 'http://localhost')
              const body = method === 'POST' ? await readJsonBody(req) : {}
              // 每次请求现读 agents，不在 apply 时捕获：loader 并发挂载，apply 跑的时候
              // 这个服务可能还没上，捕获了就会永久记住「没有」。
              if (action !== 'health' && !backendPresent()) throw noBackend()
              const value = await routes[key](req, url, body)
              sendJson(res, 200, { ok: true, value })
            } catch (error) {
              const code = typeof error?.code === 'string' ? error.code : 'request-failed'
              const status = typeof error?.status === 'number' ? error.status : 500
              sendJson(res, status, {
                ok: false,
                error: { code, message: String((error && error.message) || error) },
              })
            }
          },
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        ctx.logger?.warn?.(
          'dsh-loop-guard: route %s not mounted (%s)',
          path,
          String((error && error.message) || error),
        )
      }
    }

    // 前缀本身也挂一条，好让「动作名不认识」答 404 而不是撞上宿主的兜底页——
    // 契约把 404 定为「未知动作」，这条路由就是它的落点。
    try {
      const dispose = server.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          sendJson(res, 404, {
            ok: false,
            error: {
              code: 'unknown-action',
              message: `unknown action for ${API_PREFIX}; expected ${Object.keys(routes).join(', ')}`,
            },
          })
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.('dsh-loop-guard: route %s not mounted (%s)', API_PREFIX, String((error && error.message) || error))
    }

    // 事件流不在路由表里：它答 GET，但永远不返回一个 JSON 值，而且它拿着长连接订阅者，
    // 上面那个请求/响应循环对此一无所知。
    try {
      const dispose = server.register({
        kind: 'exact',
        path: API_PREFIX + 'events',
        handler: (req, res) => {
          // 和路由表同样的 503 闸门。开一条永远不会来帧的流，比当场答错更糟。
          if (req.method === 'GET' && !backendPresent()) {
            const error = noBackend()
            sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
            return
          }
          return stream.handler(req, res)
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.('dsh-loop-guard: route %sevents not mounted (%s)', API_PREFIX, String((error && error.message) || error))
    }
  }

  // 所有清理都登记成 effect：监听器、路由、SSE 订阅者必须随插件一起走。
  // 少登记一个，一次 HMR 重载就会留下一个还在写已关闭 socket 的订阅者。
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        /* 拆卸期出错没有补救价值，别让它拦住后面的清理 */
      }
    }
    guard.stop()
    stream.stop()
  }, 'dsh-loop-guard lifecycle')

  ctx.logger?.info?.(
    'dsh-loop-guard: ready — %sAPI mounted (events on %sevents), watching %s, cancel %s',
    API_PREFIX,
    API_PREFIX,
    config.enabled ? `${config.scopeDefault} sessions` : 'nothing (disabled)',
    config.cancel ? 'on' : 'off',
  )

  // 也返回一份清理函数：cordis 不要求它，但「每个监听器在 apply 里注册并返回清理函数」
  // 是契约的原话，返回它对调用方没有坏处。
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        /* 同上 */
      }
    }
    guard.stop()
    stream.stop()
  }
}
