/**
 * dsh-rice-guard — client half (source).
 *
 * Two surfaces, one store:
 *
 *  - a `conversation.view` tab (id `rice-guard`, ordered last) — the 监控 page:
 *    the master switch, the two thresholds that actually change behaviour, the
 *    live session table, and the hit history;
 *  - a `shell.overlay` entry (id `rice-guard-alarm`, ordered early) — the alarm
 *    card, which never dismisses itself.
 *
 * WHY BOTH SURFACES SHARE ONE STORE
 * The alarm and the tab read the same `GET state` document. Two stores would mean
 * two pollers, two streams and two answers to "is this loop still going", which
 * is exactly the kind of disagreement that makes a guard untrustworthy. The
 * store is created once per `apply`, started on first subscription, and every
 * mounted surface draws from it.
 *
 * WHAT IS AUTHORITATIVE
 * `GET /dsh-rice-guard/api/state` is. The SSE stream and the fallback poll only
 * decide *when* to re-read it; neither carries data the client trusts. A dropped
 * frame therefore costs freshness, never correctness — and a client that never
 * receives a single frame still converges.
 *
 * WHAT MUST NOT HAPPEN
 * A crash inside a slot entry retires that entry: the tab would vanish, or worse,
 * the alarm would. So every subscription, fetch, storage access and audio call in
 * this file is individually guarded, and a failure is surfaced as inline text.
 *
 * The file is deliberately not an ES module: `React`, the stylesheet text and the
 * ModuleLoader `require` arrive as parameters of {@link createRiceGuardClient},
 * so `scripts/build-client.mjs` is a pure concatenation and there is no JSX
 * anywhere (the view is built with `h = React.createElement`).
 *
 * @module dsh-rice-guard/client
 */

/**
 * Build the client half's cordis plugin surface.
 *
 * @param React - the shell's React instance (hooks only).
 * @param css - the stylesheet text, injected once under a `data-plugin-css` tag.
 * @param require_ - the ModuleLoader resolver, kept for optional peers.
 * @returns the `apply` / `inject` pair the ModuleLoader exports.
 */
function createRiceGuardClient(React, css, require_) {
  'use strict'

  var h = React.createElement
  var NS = 'rice-guard'
  var CSS_TAG_ID = 'dsh-rice-guard/client.css'

  /* ------------------------------------------------------------------ wire */

  /** This package's own host API, mounted same-origin by `src/index.js`. */
  var API_BASE = '/dsh-rice-guard/api/'
  var API_STATE = API_BASE + 'state'
  var API_EVENTS = API_BASE + 'events'

  /** Wire version this bundle knows how to read. */
  var API_VERSION = 1

  /**
   * Fallback poll interval while the change stream is delivering, in
   * milliseconds.
   *
   * The stream is the accelerator; this is the safety net under it. Five seconds
   * is short enough that the session table is never visibly stale and long enough
   * that a forgotten tab is not a load generator: the document is a few KB of
   * in-memory maps.
   */
  var POLL_MS = 5000

  /**
   * Fallback poll interval while the stream is *not* delivering, in
   * milliseconds.
   *
   * A host without the route, a proxy that eats `text/event-stream`, a host
   * mid-restart: all of them must degrade to polling, and never to something
   * slower than polling. Two seconds is the contract's number.
   */
  var POLL_MS_DEGRADED = 2000

  /**
   * How many hits the history list draws before it stops.
   *
   * The host caps its own list at 50; the tab shows a screenful and a bit, and a
   * "showing 20 of 50" line rather than a scrollbar nobody reaches the end of.
   */
  var HISTORY_LIMIT = 20

  /** The contract's cap on `hits[]`. Enforced here too, so the view never renders a runaway list. */
  var HITS_LIMIT = 50

  /** The two thresholds the tab exposes, with the range each accepts. */
  var THRESHOLD_REPEAT = { min: 2, max: 20, step: 1 }
  var THRESHOLD_RATIO = { min: 0.1, max: 1, step: 0.05 }
  // The counting rule's share starts at 0.4 rather than 0.1: below the honest ceiling (34% at
  // twelve lines) the control would offer values that fire on file listings and port tables,
  // which is the one thing this rule exists not to do.
  var THRESHOLD_SHARE = { min: 0.4, max: 1, step: 0.05 }

  /**
   * The range of the custom phrase threshold.
   *
   * Two is the floor because one occurrence is not a repetition. The ceiling is lower than
   * `THRESHOLD_REPEAT`'s on purpose: a phrase the user typed by hand is a deliberate
   * statement about one model, so waiting twenty copies before saying anything wastes the
   * whole reason for typing it.
   */
  var CUSTOM_REPEAT = { min: 2, max: 20, step: 1 }

  /**
   * Alarm tone, in Hz and milliseconds.
   *
   * Three rising blips rather than one long note: a single tone is
   * indistinguishable from a notification the user already ignores, and this
   * alarm is the one thing in the product that must not be slept through.
   */
  var TONE = { first: 880, second: 1175, blipMs: 0.16, gapMs: 0.09, repeats: 3 }

  /* ------------------------------------------------------------------ i18n */

  var ZH = {
    'view.monitor': '监控',
    'title.monitor': '复读监控',
    'subtitle': '模型开始重复自己时，这里会亮起来，并且打断这一回合。',
    'label.master': '启用监控',
    'label.masterHint': '关闭后不观察任何流，也不会打断任何回合。',
    'label.autoCancel': '自动打断',
    'label.autoCancelHint': '捕获复读后立刻中止这一回合。关掉就只报警。',
    'label.sound': '提示音',
    'label.soundHint': '报警卡出现时响一声。',
    'label.thresholds': '阈值',
    'label.minRepeat': '重复次数',
    'label.minRepeatHint': '同一段文字连续出现多少次算复读。',
    'label.densityRatio': '重复行占比',
    'label.densityRatioHint': '最近几行里有多少是重复行。',
    'label.structShare': '编号循环占比',
    'label.structShareHint': '同一句式连着出现时，行里字母要占多大比例才算循环（表格和坐标清单会被这一条挡住）。',
    'label.custom': '自定义短语',
    'label.customHint': '盯住你自己写的几句话。默认关闭：只有打开并填入内容后这条规则才工作。',
    'label.customOff': '未启用。上面打开后可以填入要盯的句子。',
    'label.customPlaceholder': '一行一句，例如：Let me go.',
    'label.customNote': '按行匹配，至少两个字。句子被反复连写时报警；正常行文里提到几次不算。',
    'label.customRepeat': '自定义短语次数',
    'label.customRepeatHint': '你自己填的句子出现几次算循环。',
    'label.sessions': '会话',
    'label.hits': '命中历史',
    'label.unit': '重复内容',
    'label.stream': '流',
    'label.kind': '类型',
    'label.repeats': '次数',
    'label.when': '时间',
    'label.cancelled': '已打断',
    'label.alarmOnly': '仅报警',
    'label.dismissed': '已关闭',
    'label.monitored': '监控中',
    'label.muted': '已静音',
    'label.mute': '静音',
    'label.unmute': '恢复',
    'label.loading': '加载中…',
    'label.reconnecting': '正在重连…',
    'label.live': '实时',
    'label.empty.sessions': '当前没有正在运行的会话。',
    'label.empty.hits': '还没有捕获到复读。',
    'label.clearHits': '清除历史',
    'label.more': '仅显示最近 {count} 条',
    'stream.thinking': '思考',
    'stream.text': '正文',
    'kind.cycle': '逐字重复',
    'kind.density': '近似重复',
    'kind.struct': '编号循环',
    'kind.custom': '自定义短语',
    'status.unavailable': '监控服务不可用',
    'status.unavailableHint': '宿主半没有挂载 /dsh-rice-guard/api，这个 profile 里没有加载 dsh-rice-guard。',
    'status.disabled': '监控已关闭',
    'status.disabledHint': '下面的开关打开后才会开始观察模型输出。',
    'status.error': '操作失败：{message}',
    'alarm.title': '检测到复读',
    'alarm.stream': '出现在{stream}',
    'alarm.unit': '重复内容',
    'alarm.repeats': '连续 {count} 次',
    'alarm.cancelled': '这一回合已经被打断。',
    'alarm.notCancelled': '未自动打断：请检查配置，必要时手动停止该回合。',
    'alarm.dismiss': '知道了',
    'alarm.dismissing': '正在关闭…',
    'alarm.dismissFailed': '关闭失败：{message}',
    'alarm.openTab': '打开监控',
  }

  var EN = {
    'view.monitor': 'Monitor',
    'title.monitor': 'Repeat guard',
    'subtitle': 'When the model starts repeating itself, this lights up — and the turn is cut short.',
    'label.master': 'Watch the stream',
    'label.masterHint': 'Off means nothing is observed and nothing is interrupted.',
    'label.autoCancel': 'Interrupt the turn',
    'label.autoCancelHint': 'Abort the turn as soon as a loop is caught. Off makes it alarm-only.',
    'label.sound': 'Alarm tone',
    'label.soundHint': 'Play a short tone when the alarm card appears.',
    'label.thresholds': 'Thresholds',
    'label.minRepeat': 'Repeats',
    'label.minRepeatHint': 'How many contiguous copies of one unit count as a loop.',
    'label.densityRatio': 'Duplicate share',
    'label.densityRatioHint': 'What share of the recent lines must be duplicates.',
    'label.structShare': 'Counting-loop share',
    'label.structShareHint': 'When one sentence shape repeats line after line, how much of it must be words — this is what keeps tables and coordinate dumps out.',
    'label.custom': 'Your own phrases',
    'label.customHint': 'Watch for sentences you write down yourself. Off by default: the rule does nothing until you turn it on and fill it in.',
    'label.customOff': 'Not enabled. Turn the switch on above to type the sentences to watch for.',
    'label.customPlaceholder': 'One phrase per line, for example: Let me go.',
    'label.customNote': 'Matched per line, at least two characters. Alarms when a phrase is written over and over; a few mentions in ordinary prose do not count.',
    'label.customRepeat': 'Phrase repeats',
    'label.customRepeatHint': 'How many copies of your own phrase count as a loop.',
    'label.sessions': 'Sessions',
    'label.hits': 'Hit history',
    'label.unit': 'Repeated text',
    'label.stream': 'Stream',
    'label.kind': 'Kind',
    'label.repeats': 'Repeats',
    'label.when': 'When',
    'label.cancelled': 'Interrupted',
    'label.alarmOnly': 'alarm only',
    'label.dismissed': 'dismissed',
    'label.monitored': 'watched',
    'label.muted': 'muted',
    'label.mute': 'Mute',
    'label.unmute': 'Watch',
    'label.loading': 'Loading…',
    'label.reconnecting': 'Reconnecting…',
    'label.live': 'live',
    'label.empty.sessions': 'No session is running right now.',
    'label.empty.hits': 'No loop has been caught yet.',
    'label.clearHits': 'Clear history',
    'label.more': 'Newest {count} only',
    'stream.thinking': 'thinking',
    'stream.text': 'output',
    'kind.cycle': 'verbatim',
    'kind.density': 'near-duplicate',
    'kind.struct': 'counting',
    'kind.custom': 'your phrase',
    'status.unavailable': 'Guard service unavailable',
    'status.unavailableHint': 'The host half does not serve /dsh-rice-guard/api — dsh-rice-guard is not loaded in this profile.',
    'status.disabled': 'Watching is off',
    'status.disabledHint': 'Flip the switch below to start observing model output.',
    'status.error': 'That did not work: {message}',
    'alarm.title': 'Repetition detected',
    'alarm.stream': 'in {stream}',
    'alarm.unit': 'Repeated text',
    'alarm.repeats': '{count} copies in a row',
    'alarm.cancelled': 'This turn has been interrupted.',
    'alarm.notCancelled': 'Not automatically interrupted. Check settings or stop the turn manually.',
    'alarm.dismiss': 'Got it',
    'alarm.dismissing': 'Dismissing…',
    'alarm.dismissFailed': 'Could not dismiss: {message}',
    'alarm.openTab': 'Open monitor',
  }

  /**
   * Translate with `{name}` interpolation, falling back to the key itself.
   *
   * Deliberately total: the view renders before (and independently of) a locale
   * binding, and a missing key must produce readable text rather than a crash
   * inside a slot entry.
   */
  function translate(dict, key, params) {
    var text = dict[key]
    if (text === undefined) text = ZH[key]
    if (text === undefined) return key
    if (params === undefined || params === null) return text
    return text.replace(/\{(\w+)\}/gu, function (whole, name) {
      var value = params[name]
      return value === undefined ? whole : String(value)
    })
  }

  /* -------------------------------------------------------------- formatting */

  /** Join class names, dropping the empty ones. */
  function cx() {
    var out = []
    for (var i = 0; i < arguments.length; i += 1) {
      if (arguments[i]) out.push(arguments[i])
    }
    return out.join(' ')
  }

  /**
   * Collapse a unit to one short line for the table and the card.
   *
   * Non-strings become the empty string rather than their `String()` form: this
   * field is printed inside `<code>` and used as the alarm card's headline, and
   * "[object Object]" is a worse answer than a dash.
   *
   * The host already trims to 120 characters, but the unit arrives from the
   * model: newlines inside a table cell would break the row, and a `\r` from a
   * Windows-flavoured stream would render as nothing at all.
   */
  function oneLine(text, max) {
    if (typeof text !== 'string') return ''
    var flat = text.replace(/\s+/gu, ' ').trim()
    var limit = max === undefined ? 120 : max
    if (flat.length <= limit) return flat
    return flat.slice(0, limit - 1) + '…'
  }

  /** `14:03:22` — the clock the alarm was raised at. */
  function clockOf(millis) {
    if (typeof millis !== 'number' || !isFinite(millis) || millis <= 0) return '—'
    var date = new Date(millis)
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value)
  }

  /**
   * A score as a whole-number percentage.
   *
   * The core reports normalized progress (0..1), so a full bar means the
   * selected detector reached its threshold. Repeat counts are shown separately.
   */
  function percentOf(score) {
    var value = typeof score === 'number' && isFinite(score) ? score : 0
    if (value < 0) value = 0
    return Math.round(value * 100) + '%'
  }

  /**
   * Turn a `minRepeat` / `densityRatio` field value into a patch value, or
   * `null` when the text is not a number in range.
   *
   * The tab's thresholds are typed into number inputs, and a number input hands
   * back `''` for anything it considers incomplete (`-`, `1e`). Sending that to
   * the host would 400; keeping the last good value and saying so is better than
   * a red error under a control the user is still typing into.
   */
  function numberInRange(raw, range) {
    if (raw === '' || raw === null || raw === undefined) return null
    var value = Number(raw)
    if (!isFinite(value)) return null
    if (value < range.min || value > range.max) return null
    return value
  }

  /** Parse the phrase box: one phrase per line, blanks and one-character lines dropped. */
  function phraseListOf(raw) {
    if (typeof raw !== 'string') return []
    return phraseListOr(raw.split('\n'))
  }

  /* -------------------------------------------------------------- wire decode */

  /**
   * Decode `GET state` into the rows the two surfaces draw.
   *
   * Pure and exported: it touches no DOM and needs no context, which is what
   * lets a harness feed the *host's own output* to the *client's own reader*
   * instead of handing each half a fixture that happens to agree with it.
   *
   * Never throws and never returns undefined: a malformed document degrades to
   * an empty but well-formed snapshot, because a half-read state is worse than a
   * visibly empty one.
   *
   * @param value - the `value` member of a successful `GET state`, or anything.
   * @returns `{ version, config, sessions, hits }`.
   */
  function project(value) {
    var source = value !== null && typeof value === 'object' ? value : {}
    var rawConfig = source.config !== null && typeof source.config === 'object' ? source.config : {}

    // Booleans are read as "explicit false wins, everything else is on". A host
    // row that simply forgot the field must not silently disarm the guard: for a
    // thing whose whole job is to shout, the safe default is the loud one.
    var config = {
      enabled: rawConfig.enabled !== false,
      minRepeat: positiveOr(rawConfig.minRepeat, 5),
      minUnit: positiveOr(rawConfig.minUnit, 6),
      maxUnit: positiveOr(rawConfig.maxUnit, 1024),
      windowChars: positiveOr(rawConfig.windowChars, 8192),
      densityLines: positiveOr(rawConfig.densityLines, 8),
      densityRatio: numberOr(rawConfig.densityRatio, 0.75),
      // `structLines` is the one field whose off value is meaningful, so it is not run through
      // `positiveOr`: a host that reports 0 has switched the counting rule off, and decoding
      // that as 12 would put a threshold on screen that nothing is enforcing.
      structLines: countOr(rawConfig.structLines, 12),
      structShare: numberOr(rawConfig.structShare, 0.6),
      // The user's own phrases, off by default and staying off unless the list has something
      // usable in it. A host that sends a non-array, or an array of blanks, must decode to
      // "off" rather than to a rule that watches for nothing.
      customPhrases: phraseListOr(rawConfig.customPhrases),
      customRepeat: positiveOr(rawConfig.customRepeat, 5),
      cancel: rawConfig.cancel !== false,
      alarm: rawConfig.alarm !== false,
      sound: rawConfig.sound !== false,
      scopeDefault: rawConfig.scopeDefault === 'selected' ? 'selected' : 'all',
    }

    var sessions = []
    if (Array.isArray(source.sessions)) {
      for (var i = 0; i < source.sessions.length; i += 1) {
        var row = source.sessions[i]
        if (row === null || typeof row !== 'object') continue
        // A row without an identity cannot be acted on (the mute button posts the
        // sessionId), so it is dropped rather than rendered as a dead entry.
        var sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
        if (sessionId === '') continue
        var repeats = countOr(row.repeats, 0)
        sessions.push({
          sessionId: sessionId,
          label: labelOr(row.label, sessionId),
          // Strictly `=== true`: `monitored` is a statement about what the host is
          // doing, not a safety preference. Defaulting a missing field to "watched"
          // would put a claim in the table that nothing on the wire supports.
          monitored: row.monitored === true,
          stream: streamOr(row.stream),
          chars: countOr(row.chars, 0),
          repeats: repeats,
          unit: oneLine(row.unit, 160),
          // Normalized core progress towards the selected threshold (0..1).
          score: scoreOr(row.score, repeats, config.minRepeat),
          lastHitAt: numberOr(row.lastHitAt, null),
        })
      }
    }

    var hits = []
    if (Array.isArray(source.hits)) {
      for (var j = 0; j < source.hits.length; j += 1) {
        var hit = source.hits[j]
        if (hit === null || typeof hit !== 'object') continue
        var id = typeof hit.id === 'string' ? hit.id : ''
        var hitSession = typeof hit.sessionId === 'string' ? hit.sessionId : ''
        if (id === '' || hitSession === '') continue
        hits.push({
          id: id,
          sessionId: hitSession,
          label: labelOr(hit.label, hitSession),
          stream: streamOr(hit.stream),
          // An unrecognised `kind` keeps its row: the tag may be wrong, but the
          // loop it reports really happened, and dropping it loses a hit.
          kind: kindOr(hit.kind),
          unit: oneLine(hit.unit, 160),
          repeats: countOr(hit.repeats, 0),
          at: countOr(hit.at, 0),
          cancelled: hit.cancelled === true,
          dismissed: hit.dismissed === true,
        })
      }
    }

    // Newest first, and the cap is applied after the sort so a host that sends an
    // unsorted (or oversized) list still yields the same screen.
    hits.sort(function (left, right) {
      return right.at - left.at
    })
    if (hits.length > HITS_LIMIT) hits.length = HITS_LIMIT

    return {
      version: positiveOr(source.version, 1),
      config: config,
      sessions: sessions,
      hits: hits,
    }
  }

  /** A finite number, or the fallback. Anything else — strings included — is the fallback. */
  function numberOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback
  }

  /** A count: finite and floored at zero, because a negative repeat count is nonsense. */
  function countOr(value, fallback) {
    var number = numberOr(value, fallback)
    return number < 0 ? 0 : number
  }

  /** A positive magnitude (thresholds, windows): finite and above zero, else the fallback. */
  function positiveOr(value, fallback) {
    var number = numberOr(value, fallback)
    return number > 0 ? number : fallback
  }

  /**
   * The user's phrase list, as the host sent it.
   *
   * Entries are kept verbatim (trimmed) rather than normalized: the user typed these,
   * and the text they see in the box has to be the text being matched. Short entries
   * are dropped here for the same reason the host drops them — a one-character phrase
   * matches everything, so keeping it would draw a rule that is always on.
   */
  function phraseListOr(value) {
    if (!Array.isArray(value)) return []
    var out = []
    for (var i = 0; i < value.length; i += 1) {
      var item = value[i]
      if (typeof item !== 'string') continue
      var phrase = item.trim()
      if (phrase.length < 2) continue
      if (out.indexOf(phrase) === -1) out.push(phrase)
    }
    return out
  }

  /** A non-empty string label, else the session's own id — never blank in the table. */
  function labelOr(value, fallback) {
    return typeof value === 'string' && value !== '' ? oneLine(value, 80) : fallback
  }

  /** Only the two streams the host actually has; anything else is "we do not know". */
  function streamOr(value) {
    return value === 'thinking' || value === 'text' ? value : null
  }

  /**
   * Which rule caught it.
   *
   * A closed list, because the tag is a claim about *why* the alarm fired: `verbatim`
   * says the text really did repeat, and an unknown kind rendered as `verbatim` would
   * tell the reader the one thing the wire did not say. Unrecognised values become
   * `cycle` only because a hit with no tag at all has to render as something; the four
   * names here are the four rules in `src/detect.js`, and a fifth rule must be added in
   * both places or it will be mislabelled here rather than silently.
   */
  function kindOr(value) {
    if (value === 'density' || value === 'struct' || value === 'custom') return value
    return 'cycle'
  }

  /**
   * The bar's value.
   *
   * Prefers the host's own `score` — it knows how far past the threshold a loop
   * is — and derives it from `repeats / minRepeat` only when that is missing, so
   * an older host still draws a moving bar.
   */
  function scoreOr(score, repeats, minRepeat) {
    var direct = numberOr(score, null)
    if (direct !== null) return clamp01(direct)
    if (minRepeat > 0 && typeof repeats === 'number' && isFinite(repeats)) {
      return clamp01(repeats / minRepeat)
    }
    return 0
  }

  /** Clamp to the 0..1 the drawn width can represent (the score itself may exceed 1). */
  function clamp01(value) {
    if (value < 0) return 0
    if (value > 1) return 1
    return value
  }

  /**
   * The first hit worth alarming about: newest, not dismissed, alarm enabled.
   *
   * `null` when there is nothing to say. The card shows exactly this hit, so
   * "why is that card still there" always has one answer.
   */
  function alarmOf(snapshot) {
    if (snapshot === null || snapshot === undefined) return null
    if (snapshot.config === undefined || snapshot.config.alarm === false) return null
    var hits = snapshot.hits || []
    for (var i = 0; i < hits.length; i += 1) {
      if (hits[i].dismissed !== true) return hits[i]
    }
    return null
  }

  /* ----------------------------------------------------------------- audio */

  /**
   * Play the alarm tone.
   *
   * Synthesised rather than shipped: a plugin that carries an `.mp3` is a plugin
   * with a licence question and a 404 in it. Every failure path — no
   * `AudioContext`, a context the autoplay policy refuses to resume, an
   * `OscillatorNode` the platform does not have — ends in silence and *not* in a
   * lost card, which is why the whole thing is one `try`.
   */
  function beep() {
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext
      if (typeof Ctor !== 'function') return
      var context = new Ctor()
      if (typeof context.resume === 'function') {
        var resumed = context.resume()
        if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {})
      }
      var start = context.currentTime + 0.02
      var blip = TONE.blipMs
      var step = blip + TONE.gapMs
      for (var i = 0; i < TONE.repeats; i += 1) {
        var at = start + i * step
        var oscillator = context.createOscillator()
        var gain = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = i % 2 === 0 ? TONE.first : TONE.second
        // A bare start/stop clicks; the ramp is what makes it a tone.
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(0.22, at + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + blip)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start(at)
        oscillator.stop(at + blip + 0.02)
      }
      var closeAt = (start + TONE.repeats * step + 0.2 - context.currentTime) * 1000
      setTimeout(function () {
        try {
          var closed = context.close()
          if (closed && typeof closed.catch === 'function') closed.catch(function () {})
        } catch (error) {
          /* a context that refuses to close is a leak, not a failure */
        }
      }, Math.max(200, closeAt))
    } catch (error) {
      /* silence is an acceptable outcome; a thrown beep is not */
    }
  }

  /* ------------------------------------------------------------------ store */

  /**
   * The one store both surfaces read.
   *
   * Shape of the state machine, and why:
   *
   *  - `status` is `loading` until the first answer lands. Showing "unavailable"
   *    while the very first request is still in flight would flash a scary empty
   *    page on every open.
   *  - `unavailable` means the *route* is not there (a 404/501, or a transport
   *    failure with nothing ever received). It is the one state with an
   *    actionable hint: this profile has not loaded the host half.
   *  - The last good snapshot stays on screen through a transient failure, so a
   *    blip never empties the alarm.
   *
   * The poll is armed at the tight interval and loosened only when the stream
   * proves it is delivering — a client that connects must never be *slower* than
   * one that cannot connect at all.
   */
  function createStore(ctx) {
    var listeners = new Set()
    var disposers = []
    var disposed = false
    var started = false
    var pending = false
    var pollTimer = null
    var stream = null
    var value = null
    var attempted = false
    var reachable = false
    var lastError = null
    var snapshot = {
      status: 'loading',
      version: 0,
      config: project({}).config,
      sessions: [],
      hits: [],
      error: null,
    }

    /** Pull one document from the host half. Never throws, never rejects. */
    function fetchState() {
      if (typeof fetch !== 'function') return Promise.resolve()
      attempted = true
      return fetch(API_STATE, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then(function (response) {
          return response.json().then(function (body) {
            return { status: response.status, body: body }
          })
        })
        .then(function (result) {
          if (result.body !== null && typeof result.body === 'object' && result.body.ok === true) {
            value = result.body.value
            reachable = true
            lastError = null
          } else {
            // A structured refusal is still an answer: the route is there.
            reachable = result.status !== 404 && result.status !== 501 && result.status !== 503
            lastError = describeRefusal(result.body, result.status)
          }
          refresh()
        })
        .catch(function (error) {
          // Transport failure. The last good document stays on screen, but the
          // first failure must still publish so the view leaves `loading`.
          lastError = error === undefined ? null : String((error && error.message) || error)
          refresh()
        })
    }

    function describeRefusal(body, status) {
      if (body !== null && typeof body === 'object' && body.error !== null && typeof body.error === 'object') {
        if (typeof body.error.message === 'string' && body.error.message !== '') return body.error.message
        if (typeof body.error.code === 'string' && body.error.code !== '') return body.error.code
      }
      return 'HTTP ' + status
    }

    function read() {
      // The document is only decoded once it is known to be reachable: an
      // unreachable host must not have its (empty) defaults dressed up as data.
      var decoded = reachable ? project(value) : project(null)
      decoded.status = reachable ? 'ready' : attempted ? 'unavailable' : 'loading'
      decoded.error = lastError
      return decoded
    }

    function publish() {
      if (disposed) return
      snapshot = read()
      for (var fn of Array.from(listeners)) {
        try {
          fn()
        } catch (error) {
          /* a listener must never take the store down */
        }
      }
    }

    function refresh() {
      if (pending || disposed) return
      pending = true
      queueMicrotask(function () {
        pending = false
        publish()
      })
    }

    /**
     * POST one JSON payload to this package's host API.
     *
     * Resolves with the parsed body on every HTTP status: the host answers 4xx
     * with a structured `{ ok: false, error }`, and that text is what the view
     * shows. Only a transport failure rejects. The caller decides whether the
     * refusal is worth reporting.
     */
    function post(action, payload) {
      if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'))
      return fetch(API_BASE + action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (response) {
        return response.json().then(function (body) {
          return { status: response.status, body: body }
        })
      })
    }

    /** The store's write lane: one action, decoded into `{ ok, error }`. */
    function write(action, payload) {
      return post(action, payload).then(
        function (result) {
          if (result.body !== null && typeof result.body === 'object' && result.body.ok === true) {
            return { ok: true, value: result.body.value }
          }
          return { ok: false, error: describeRefusal(result.body, result.status) }
        },
        function (error) {
          return { ok: false, error: String((error && error.message) || error) }
        },
      )
    }

    /**
     * (Re)arm the fallback poll.
     *
     * Called on start and whenever the stream's health changes, so the interval
     * always matches the current channel: tight while the stream is down, loose
     * while it is delivering frames.
     */
    function armPoll(delay) {
      if (pollTimer !== null) clearInterval(pollTimer)
      pollTimer = delay === null ? null : setInterval(fetchState, delay)
    }

    /**
     * Subscribe to the host's change stream.
     *
     * `EventSource` owns the reconnect schedule (the server's `retry:` hint), so
     * this code never manages a backoff. Every transition is used only to pick a
     * poll cadence. Both frame kinds — `alarm` and `state` — mean the same thing
     * here, "re-read the document"; the frames are notifications, never data.
     */
    function openStream() {
      if (typeof EventSource !== 'function') return
      try {
        stream = new EventSource(API_EVENTS)
      } catch (error) {
        stream = null
        return
      }
      stream.addEventListener('open', function () {
        armPoll(POLL_MS)
        // One read on (re)connect: frames published while the stream was down are
        // gone, so the document has to be reconciled explicitly.
        fetchState()
      })
      stream.addEventListener('alarm', function () {
        fetchState()
      })
      stream.addEventListener('state', function () {
        fetchState()
      })
      stream.addEventListener('error', function () {
        // Not fatal: EventSource reconnects by itself. Tighten the poll so the
        // guard keeps converging while it is away.
        armPoll(POLL_MS_DEGRADED)
      })
      disposers.push(function () {
        if (stream !== null) stream.close()
        stream = null
      })
    }

    function start() {
      if (started) return
      started = true
      disposed = false
      openStream()
      // Until the stream reports `open`, assume it is not there: the fallback
      // poll is the only channel, so it runs at the tight interval.
      armPoll(POLL_MS_DEGRADED)
      disposers.push(function () {
        if (pollTimer !== null) clearInterval(pollTimer)
        pollTimer = null
      })
      fetchState()
    }

    return {
      start: start,
      refresh: refresh,
      /** Pull a fresh document now, bypassing the poll interval. */
      sync: fetchState,
      write: write,
      getSnapshot: function () {
        return snapshot
      },
      subscribe: function (listener) {
        listeners.add(listener)
        return function () {
          listeners.delete(listener)
        }
      },
      dispose: function () {
        started = false
        disposed = true
        listeners.clear()
        for (var i = 0; i < disposers.length; i += 1) {
          try {
            disposers[i]()
          } catch (error) {
            /* ignore */
          }
        }
        disposers = []
      },
    }
  }

  /**
   * Subscribe one component to the store.
   *
   * `useSyncExternalStore` needs a stable snapshot object, which is exactly what
   * the store keeps: a new object per publish, the same object between them.
   */
  function useSnapshot(store) {
    return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  }

  /* ------------------------------------------------------------------ pieces */

  /** One horizontal meter: a track, a fill, and the number it stands for. */
  function ScoreBar(props) {
    var score = clamp01(props.score === undefined ? 0 : props.score)
    return h(
      'div',
      { className: 'rg-bar' },
      h('div', {
        className: cx('rg-bar-fill', score >= 1 ? 'rg-bar-fill--hot' : null),
        style: { width: percentOf(score) },
      }),
      h('span', { className: 'rg-bar-label' }, percentOf(score)),
    )
  }

  /** A labelled row of copy, used by the monitor page and the alarm card alike. */
  function Field(props) {
    return h(
      'div',
      { className: 'rg-field' },
      h('div', { className: 'rg-field-label' }, props.label),
      h('div', { className: cx('rg-field-value', props.className) }, props.children),
    )
  }

  /**
   * One threshold control.
   *
   * Uncontrolled after mount, deliberately: the input's own text is the truth
   * while the user types, and the host's echo replaces it only when a real patch
   * succeeded. A controlled input fed by a 2-second poll would fight the
   * keyboard.
   */
  function Threshold(props) {
    var range = props.range
    var state = React.useState(function () {
      return String(props.value)
    })
    var text = state[0]
    var setText = state[1]

    React.useEffect(
      function () {
        setText(String(props.value))
      },
      [props.value],
    )

    function commit() {
      var parsed = numberInRange(text, range)
      if (parsed === null) {
        setText(String(props.value))
        return
      }
      if (parsed === props.value) return
      props.onCommit(parsed)
    }

    return h(
      'label',
      { className: 'rg-threshold' },
      h(
        'span',
        { className: 'rg-threshold-head' },
        h('span', { className: 'rg-threshold-name' }, props.label),
        h('span', { className: 'rg-threshold-hint' }, props.hint),
      ),
      h('input', {
        className: 'rg-number',
        type: 'number',
        value: text,
        min: range.min,
        max: range.max,
        step: range.step,
        disabled: props.disabled === true,
        'aria-label': props.label,
        onChange: function (event) {
          setText(event.target.value)
        },
        onBlur: commit,
        onKeyDown: function (event) {
          if (event.key === 'Enter') commit()
        },
      }),
    )
  }

  /**
   * One on/off row: the checkbox, its name, and the sentence that says what the
   * switch actually does.
   *
   * Three of these now share the panel, and the *hint* is the load-bearing half —
   * "Interrupt the turn" is a promise about what happens to a running model, and
   * a user who has to read the source to find out what a checkbox does has not
   * really been given the switch.
   */
  function Switch(props) {
    return h(
      'div',
      { className: 'rg-row' },
      h(
        'label',
        { className: 'rg-switch' },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          disabled: props.disabled,
          onChange: function (event) {
            props.onChange(event.target.checked)
          },
        }),
        h('span', { className: 'rg-switch-text' }, props.label),
      ),
      h('span', { className: 'rg-hint' }, props.hint),
    )
  }

  /** The master switch plus the thresholds, i.e. everything that writes config. */
  function ConfigPanel(props) {
    var config = props.config
    var busy = props.busy

    function patch(next) {
      props.write({ patch: next })
    }

    return h(
      'div',
      { className: 'rg-panel' },
      h(Switch, {
        label: props.t('label.master'),
        hint: props.t('label.masterHint'),
        checked: config.enabled,
        disabled: busy,
        onChange: function (next) {
          patch({ enabled: next })
        },
      }),
      h(Switch, {
        label: props.t('label.autoCancel'),
        hint: props.t('label.autoCancelHint'),
        checked: config.cancel,
        disabled: busy,
        onChange: function (next) {
          patch({ cancel: next })
        },
      }),
      h(Switch, {
        label: props.t('label.sound'),
        hint: props.t('label.soundHint'),
        checked: config.sound,
        disabled: busy,
        onChange: function (next) {
          patch({ sound: next })
        },
      }),
      h(
        'div',
        { className: 'rg-thresholds' },
        h(Threshold, {
          label: props.t('label.minRepeat'),
          hint: props.t('label.minRepeatHint'),
          value: config.minRepeat,
          range: THRESHOLD_REPEAT,
          disabled: busy,
          onCommit: function (value) {
            patch({ minRepeat: value })
          },
        }),
        h(Threshold, {
          label: props.t('label.densityRatio'),
          hint: props.t('label.densityRatioHint'),
          value: config.densityRatio,
          range: THRESHOLD_RATIO,
          disabled: busy,
          onCommit: function (value) {
            patch({ densityRatio: value })
          },
        }),
        h(Threshold, {
          label: props.t('label.structShare'),
          hint: props.t('label.structShareHint'),
          value: config.structShare,
          range: THRESHOLD_SHARE,
          disabled: busy,
          onCommit: function (value) {
            patch({ structShare: value })
          },
        }),
      ),
    )
  }

  /**
   * The user's own phrases: a switch, and the list it turns on.
   *
   * Off by default and off until the list has something usable in it, because the
   * default has to be the guard everyone already has. Someone whose model gets stuck on
   * a phrase the shape rules cannot derive turns it on and types the phrase; everyone
   * else never sees a difference.
   *
   * The textarea is uncontrolled while typing for the same reason the number fields are:
   * a controlled box fed by a poll fights the keyboard. It commits on blur, so a phrase
   * is saved when the user leaves the box rather than on every keystroke.
   */
  function PhrasePanel(props) {
    var config = props.config
    var phrases = config.customPhrases
    var joined = phrases.join('\n')

    // "Turned on" is local state rather than `phrases.length > 0`, because the first thing a
    // user does with this rule is switch it on — and at that moment the list is still empty.
    // Deriving the box's visibility from the list would make the switch appear broken: the
    // click saves an empty list, the host echoes it back, and no box ever appears.
    var wantState = React.useState(function () {
      return phrases.length > 0
    })
    var wanted = wantState[0]
    var setWanted = wantState[1]

    var state = React.useState(function () {
      return joined
    })
    var text = state[0]
    var setText = state[1]

    React.useEffect(
      function () {
        setText(joined)
      },
      [joined],
    )

    function commit() {
      var next = phraseListOf(text)
      if (next.join('\n') === joined) return
      props.write({ patch: { customPhrases: next } })
    }

    return h(
      'div',
      { className: 'rg-panel' },
      h(Switch, {
        label: props.t('label.custom'),
        hint: props.t('label.customHint'),
        checked: wanted,
        disabled: props.busy,
        onChange: function (next) {
          setWanted(next)
          // Switching off clears the list rather than just hiding it: a rule that is off but
          // still holds phrases would come back on the next save of an unrelated field, and
          // "off" would then depend on the order of edits.
          if (next) return
          setText('')
          props.write({ patch: { customPhrases: [] } })
        },
      }),
      wanted
        ? h(
          'div',
          { className: 'rg-phrases' },
          h('textarea', {
            className: 'rg-phrases-input',
            rows: 4,
            value: text,
            disabled: props.busy,
            placeholder: props.t('label.customPlaceholder'),
            'aria-label': props.t('label.custom'),
            onChange: function (event) {
              setText(event.target.value)
            },
            onBlur: commit,
          }),
          h(
            'div',
            { className: 'rg-phrases-foot' },
            h('span', { className: 'rg-hint' }, props.t('label.customNote')),
            h(Threshold, {
              label: props.t('label.customRepeat'),
              hint: props.t('label.customRepeatHint'),
              value: config.customRepeat,
              range: CUSTOM_REPEAT,
              disabled: props.busy,
              onCommit: function (value) {
                props.write({ patch: { customRepeat: value } })
              },
            }),
          ),
        )
        : h('p', { className: 'rg-hint rg-phrases-off' }, props.t('label.customOff')),
    )
  }

  /** The live session table: one row per watched session, with the bar filling. */
  function SessionTable(props) {
    var sessions = props.sessions
    var t = props.t

    if (sessions.length === 0) {
      return h('div', { className: 'rg-empty' }, t('label.empty.sessions'))
    }

    var rows = []
    for (var i = 0; i < sessions.length; i += 1) {
      rows.push(
        h(
          'tr',
          { key: sessions[i].sessionId, className: sessions[i].monitored ? null : 'rg-row-muted' },
          h(
            'td',
            { className: 'rg-cell-label' },
            h('span', { className: 'rg-session-name', title: sessions[i].label }, sessions[i].label),
            h(
              'span',
              { className: 'rg-badges' },
              sessions[i].monitored
                ? h('span', { className: 'rg-badge' }, t('label.monitored'))
                : h('span', { className: 'rg-badge rg-badge--off' }, t('label.muted')),
              sessions[i].stream === null
                ? null
                : h('span', { className: 'rg-badge' }, t('stream.' + sessions[i].stream)),
            ),
          ),
          h('td', { className: 'rg-cell-bar' }, h(ScoreBar, { score: sessions[i].score })),
          h(
            'td',
            { className: 'rg-cell-unit' },
            sessions[i].unit === '' ? h('span', { className: 'rg-dim' }, '—') : h('code', { className: 'rg-unit' }, sessions[i].unit),
          ),
          h(
            'td',
            { className: 'rg-cell-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'rg-button rg-button--ghost',
                onClick: function () {
                  props.onToggle(sessions[i].sessionId, !sessions[i].monitored)
                },
              },
              sessions[i].monitored ? t('label.mute') : t('label.unmute'),
            ),
          ),
        ),
      )
    }

    return h(
      'table',
      { className: 'rg-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', null, t('label.sessions')),
          h('th', { className: 'rg-cell-bar' }, '—'),
          h('th', { className: 'rg-cell-unit' }, t('label.unit')),
          h('th', { className: 'rg-cell-actions' }, ''),
        ),
      ),
      h('tbody', null, rows),
    )
  }

  /** The hit history, newest first, dismissed entries included but marked. */
  function HitList(props) {
    var hits = props.hits
    var t = props.t

    if (hits.length === 0) {
      return h('div', { className: 'rg-empty' }, t('label.empty.hits'))
    }

    var shown = hits.slice(0, HISTORY_LIMIT)
    var items = []
    for (var i = 0; i < shown.length; i += 1) {
      var hit = shown[i]
      items.push(
        h(
          'li',
          { key: hit.id, className: cx('rg-hit', hit.dismissed ? 'rg-hit--dismissed' : null) },
          h(
            'div',
            { className: 'rg-hit-head' },
            h('span', { className: 'rg-hit-time' }, clockOf(hit.at)),
            h('span', { className: 'rg-hit-session', title: hit.label }, hit.label),
            h('span', { className: 'rg-badge' }, t('kind.' + hit.kind)),
            h('span', { className: 'rg-badge' }, t('stream.' + hit.stream)),
            hit.cancelled
              ? h('span', { className: 'rg-badge rg-badge--good' }, t('label.cancelled'))
              : h('span', { className: 'rg-badge rg-badge--off' }, t('label.alarmOnly')),
          ),
          h('code', { className: 'rg-unit' }, hit.unit),
          h('div', { className: 'rg-hit-foot' }, t('label.repeats') + ' ' + hit.repeats),
        ),
      )
    }

    return h(
      'div',
      { className: 'rg-history' },
      h('ul', { className: 'rg-hit-list' }, items),
      hits.length > shown.length ? h('div', { className: 'rg-hint' }, t('label.more', { count: shown.length })) : null,
    )
  }

  /** The unavailable / disabled banner. Renders nothing when all is well. */
  function StatusBanner(props) {
    var snapshot = props.snapshot
    var t = props.t

    if (snapshot.status === 'loading') {
      return h('div', { className: 'rg-banner' }, t('label.loading'))
    }
    if (snapshot.status === 'unavailable') {
      return h(
        'div',
        { className: 'rg-banner rg-banner--error' },
        h('div', { className: 'rg-banner-title' }, t('status.unavailable')),
        h('div', { className: 'rg-banner-hint' }, t('status.unavailableHint')),
        snapshot.error === null ? null : h('div', { className: 'rg-banner-hint' }, snapshot.error),
      )
    }
    if (snapshot.config.enabled === false) {
      return h(
        'div',
        { className: 'rg-banner' },
        h('div', { className: 'rg-banner-title' }, t('status.disabled')),
        h('div', { className: 'rg-banner-hint' }, t('status.disabledHint')),
      )
    }
    return null
  }

  /* ------------------------------------------------------------------- tab */

  /**
   * The 监控 tab.
   *
   * Receives `sessionId` and `t` from the conversation view slot; neither is
   * required here — the guard watches every session, so the tab is a global
   * dashboard that happens to be mounted inside one session's view area.
   */
  function RiceGuardView(props) {
    var store = props.store
    var t = props.t || function (key, params) {
      return translate(ZH, key, params)
    }
    var snapshot = useSnapshot(store)

    var errorState = React.useState(null)
    var error = errorState[0]
    var setError = errorState[1]
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]

    /**
     * Run one write, keep the button disabled while it is in flight, and surface
     * the refusal inline.
     *
     * The store is re-read on success: the host's echo is the truth, and waiting
     * for the next poll would make a switch look broken for two seconds.
     */
    function run(action, payload) {
      setBusy(true)
      store
        .write(action, payload)
        .then(function (result) {
          setBusy(false)
          if (result.ok === true) {
            setError(null)
            store.sync()
          } else {
            setError(result.error)
          }
        })
        .catch(function (failure) {
          setBusy(false)
          setError(String((failure && failure.message) || failure))
        })
    }

    return h(
      'div',
      { className: 'rg-root' },
      h(
        'header',
        { className: 'rg-header' },
        // Title and state share one row: the state is a status word, not a
        // column heading, and stacking it under the title pushed the subtitle
        // down for nothing.
        h(
          'div',
          { className: 'rg-header-row' },
          h('h2', { className: 'rg-title' }, t('title.monitor')),
          h(
            'span',
            { className: 'rg-state' },
            snapshot.status === 'ready'
              ? [
                  // The dot is decoration and the word is the label. They used to be
                  // one element — the word rendered *inside* a 6px circle, so the two
                  // overlapped on top of each other. A dot has no text.
                  h('span', { key: 'dot', className: 'rg-dot rg-dot--live', 'aria-hidden': 'true' }),
                  t('label.live'),
                ]
              : snapshot.status === 'loading'
                ? t('label.loading')
                : t('label.reconnecting'),
          ),
        ),
        h('p', { className: 'rg-subtitle' }, t('subtitle')),
      ),
      h(StatusBanner, { snapshot: snapshot, t: t }),
      error === null
        ? null
        : h('div', { className: 'rg-banner rg-banner--error' }, t('status.error', { message: error })),
      h(ConfigPanel, {
        config: snapshot.config,
        busy: busy,
        t: t,
        write: function (payload) {
          run('config', payload)
        },
      }),
      h(PhrasePanel, {
        config: snapshot.config,
        busy: busy,
        t: t,
        write: function (payload) {
          run('config', payload)
        },
      }),
      h(
        'section',
        { className: 'rg-section' },
        h('h3', { className: 'rg-section-title' }, t('label.sessions')),
        h(SessionTable, {
          sessions: snapshot.sessions,
          t: t,
          onToggle: function (sessionId, monitored) {
            run('monitor', { sessionId: sessionId, monitored: monitored })
          },
        }),
      ),
      h(
        'section',
        { className: 'rg-section' },
        h(
          'div',
          { className: 'rg-section-head' },
          h('h3', { className: 'rg-section-title' }, t('label.hits')),
          snapshot.hits.length === 0
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'rg-button rg-button--ghost rg-button--small',
                  disabled: busy,
                  onClick: function () {
                    run('hits', { clearAll: true })
                  },
                },
                t('label.clearHits'),
              ),
        ),
        h(HitList, { hits: snapshot.hits, t: t }),
      ),
    )
  }

  /* ----------------------------------------------------------------- alarm */

  /**
   * The alarm card.
   *
   * It has no timer and no auto-close path: the only way it leaves the screen is
   * the dismiss button, which is a POST the host has to accept. A card that
   * vanished on its own would be the one alarm the user was away for.
   *
   * The card follows `props.snapshot` — which is refreshed by the stream, and by
   * the poll under it — so a reload with an undismissed hit brings the alarm back
   * rather than losing it.
   */
  function AlarmCard(props) {
    var store = props.store
    var t = props.t || function (key, params) {
      return translate(ZH, key, params)
    }
    var snapshot = useSnapshot(store)
    var hit = alarmOf(snapshot)

    var failureState = React.useState(null)
    var failure = failureState[0]
    var setFailure = failureState[1]
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]

    // Sound once per hit id. The ref is what makes it "once": the card re-renders
    // on every state frame, and a beep per render would be a siren.
    var soundedRef = React.useRef(null)
    React.useEffect(
      function () {
        if (hit === null) return
        if (soundedRef.current === hit.id) return
        soundedRef.current = hit.id
        if (snapshot.config.sound !== false) beep()
      },
      [hit === null ? null : hit.id, snapshot.config.sound],
    )

    if (hit === null) return null

    function dismiss() {
      setBusy(true)
      store
        .write('hits', { id: hit.id, dismissed: true })
        .then(function (result) {
          setBusy(false)
          if (result.ok === true) {
            setFailure(null)
            store.sync()
          } else {
            setFailure(result.error)
          }
        })
        .catch(function (error) {
          setBusy(false)
          setFailure(String((error && error.message) || error))
        })
    }

    return h(
      'div',
      { className: 'rg-alarm', role: 'alertdialog', 'aria-live': 'assertive', 'aria-label': t('alarm.title') },
      h(
        'div',
        { className: 'rg-alarm-head' },
        h('span', { className: 'rg-alarm-mark', 'aria-hidden': 'true' }, '!'),
        h(
          'div',
          { className: 'rg-alarm-heading' },
          h('div', { className: 'rg-alarm-title' }, t('alarm.title')),
          h(
            'div',
            { className: 'rg-alarm-meta' },
            // `stream` is nullable once the wire is decoded, and "in undefined" is
            // worse than saying nothing: the session label is the load-bearing part.
            hit.stream === null
              ? hit.label
              : hit.label + ' · ' + t('alarm.stream', { stream: t('stream.' + hit.stream) }),
          ),
        ),
        h('span', { className: 'rg-badge' }, t('kind.' + hit.kind)),
      ),
      h(Field, { label: t('alarm.unit'), className: 'rg-alarm-unit' }, h('code', { className: 'rg-unit' }, hit.unit)),
      h(
        'div',
        { className: 'rg-alarm-stats' },
        h('span', { className: 'rg-alarm-repeats' }, t('alarm.repeats', { count: hit.repeats })),
        h('span', { className: 'rg-alarm-time' }, clockOf(hit.at)),
      ),
      h(
        'div',
        { className: cx('rg-alarm-note', hit.cancelled ? 'rg-alarm-note--done' : 'rg-alarm-note--live') },
        hit.cancelled ? t('alarm.cancelled') : t('alarm.notCancelled'),
      ),
      failure === null ? null : h('div', { className: 'rg-banner rg-banner--error' }, t('alarm.dismissFailed', { message: failure })),
      h(
        'div',
        { className: 'rg-alarm-actions' },
        h(
          'button',
          { type: 'button', className: 'rg-button rg-button--primary', disabled: busy, onClick: dismiss },
          busy ? t('alarm.dismissing') : t('alarm.dismiss'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'rg-button rg-button--ghost',
            onClick: function () {
              openMonitorTab()
            },
          },
          t('alarm.openTab'),
        ),
      ),
    )
  }

  /**
   * Ask the shell to show the 监控 tab.
   *
   * A best-effort convenience: the alarm renders in an overlay that knows nothing
   * about the conversation view's own navigation, so this dispatches the same
   * synthetic click a user would make and gives up quietly if the tab is not
   * mounted. Nothing about the alarm depends on it working.
   */
  function openMonitorTab() {
    try {
      if (typeof document === 'undefined') return
      var buttons = document.querySelectorAll('[role="tab"], [data-view-id]')
      for (var i = 0; i < buttons.length; i += 1) {
        var node = buttons[i]
        var id = node.getAttribute('data-view-id') || node.getAttribute('data-tab-id') || ''
        var text = node.textContent || ''
        if (id === 'rice-guard' || text.trim() === translate(ZH, 'view.monitor')) {
          node.click()
          return
        }
      }
    } catch (error) {
      /* the tab is a convenience, not the alarm */
    }
  }

  /* ---------------------------------------------------------------- plugin */

  var inject = ['slots', 'locale']

  /** Install the stylesheet once, tagged so a reload cannot double-inject it. */
  function installCss() {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
    var tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-rice-guard'
    tag.dataset.pluginCss = CSS_TAG_ID
    tag.textContent = css
    document.head.appendChild(tag)
  }

  function apply(ctx) {
    installCss()

    var translateFn = function (key, params) {
      return translate(ZH, key, params)
    }
    ctx.effect(function () {
      return ctx.locale.register(NS, { zh: ZH, en: EN })
    }, 'dsh-rice-guard: dictionaries')
    if (ctx.locale !== undefined && typeof ctx.locale.bind === 'function') {
      var bound = ctx.locale.bind(NS)
      translateFn = function (key, params) {
        try {
          var value = bound(key, params)
          return value === undefined || value === key ? translate(ZH, key, params) : value
        } catch (error) {
          return translate(ZH, key, params)
        }
      }
    }

    // One store for both surfaces. The overlay is mounted whether or not any
    // conversation is open, so the store is started here rather than lazily by
    // the tab: an alarm must arrive while the user is looking at something else.
    var store = createStore(ctx)
    ctx.effect(function () {
      store.start()
      return function () { store.dispose() }
    }, 'dsh-rice-guard: shared store')
    // Store lifetime belongs to the plugin, not the selected conversation tab.

    // Optional dock integration: no manifest dependency and no retry timer.
    ctx.effect(function () {
      try {
        var dock = require_('dsh-dock/client').dockBridge
        if (!dock || typeof dock.register !== 'function') return
        return dock.register({
          id: 'rice-guard', name: '米饭守卫', order: 120,
          description: '监控思考与输出的重复内容', package: 'dsh-rice-guard',
          View: function () { return h(RiceGuardView, { store: store, t: translateFn }) }
        })
      } catch (error) { /* Dock is optional; the tab and alarm remain independent. */ }
    }, 'dsh-rice-guard: optional dock')

    /**
     * Reference-counted start/stop.
     *
     * Both surfaces share the store, so neither may stop it on unmount: the tab
     * closing would silence the alarm. The count is what makes the last consumer
     * out the one that stops the poll, and a store with no consumers is a store
     * with nothing to say.
     */
    function retain() {
      store.start()
      return function () {}
    }

    ctx.slots.inject('conversation.view', function () {
      return ctx.slots.register(
        {
          name: 'conversation.view',
          id: 'rice-guard',
          order: 120,
          locale: NS,
          label: function () {
            return translateFn('view.monitor')
          },
          inject: function () {
            var release = retain()
            /**
             * Diagnostic handle.
             *
             * The tab is a slot occupant inside a shell this plugin does not own,
             * so a browser test has no component tree to reach and no props to
             * pass: the store behind the page is otherwise invisible from the
             * outside. Exposing it costs one property and turns "the table is
             * empty" into a question with an answer.
             */
            if (typeof window === 'object' && window !== null) {
              window.__riceGuard = { store: store, release: release }
            }
            return { store: store, t: translateFn }
          },
        },
        RiceGuardView,
      )
    })

    // No `inject` here on purpose: the overlay is a root-scoped slot, and the
    // card's job is to be visible before any session exists.
    ctx.slots.inject('shell.overlay', function () {
      return ctx.slots.register(
        {
          name: 'shell.overlay',
          id: 'rice-guard-alarm',
          order: 30,
          locale: NS,
          inject: function () {
            retain()
            return { store: store, t: translateFn }
          },
        },
        AlarmCard,
      )
    })
  }

  return {
    apply: apply,
    inject: inject,
    RiceGuardView: RiceGuardView,
    AlarmCard: AlarmCard,
    createStore: createStore,
    project: project,
    alarmOf: alarmOf,
  }
}
