/**
 * Detection core for dsh-loop-guard.
 *
 * Pure: no I/O, no timers, no context, no dependencies. It is a function of the text it is
 * fed, which is what makes it testable without a harness and reusable by both the host half
 * and the harnesses.
 *
 * WHY THIS FILE IS NOT PART OF THE HOST HALF
 * The interesting question — "has this stopped being new?" — is a question about text, not
 * about DSH. Keeping it separate means the threshold tuning and the loop shape can be argued
 * about with plain strings, and the host half stays a thin adapter over a `push()` call.
 *
 * TWO DETECTORS, BECAUSE THERE ARE TWO WAYS TO STOP BEING NEW
 *
 * 1. `cycle` — verbatim repetition. The model emits the same unit contiguously: the same
 *    sentence, the same list item, the same paragraph, until the token ceiling. This is the
 *    failure the user described ("Let me go. Let me go. ... 100 times").
 *
 * 2. `density` — repeated lines separated by other text or varying whitespace.
 *    Lines are compared after whitespace normalization, but digits remain content:
 *    a numeric table must not be mistaken for a runaway counter. This conservative
 *    detector does not diagnose loops whose only changes are increasing counters.
 *
 * The cycle detector runs first because it is the cheaper and more specific signal; density
 * is consulted only when no cycle was found, so a genuine loop is never reported as a
 * vaguer one.
 */

export const DEFAULTS = {
  minRepeat: 5,
  minUnit: 6,
  maxUnit: 1024,
  windowChars: 8192,
  checkEvery: 32,
  densityLines: 8,
  densityRatio: 0.75,
}

/** The two streams are watched independently: a loop in thinking must not hide one in text. */
const STREAMS = ['thinking', 'text']

/**
 * A scan is bounded by this many character comparisons. It exists so that pathological input
 * (long text that is *almost* periodic for many periods at once) cannot turn one chunk into
 * a multi-million-comparison stall. Hitting the budget is not an error: the scan returns the
 * best answer it reached, and the next check gets a fresh budget.
 */
const WORK_BUDGET = 200000

/** How much of a repeated unit is worth showing a human. */
const UNIT_DISPLAY_CHARS = 120

function shorten(unit) {
  if (unit.length <= UNIT_DISPLAY_CHARS) return unit
  return unit.slice(0, UNIT_DISPLAY_CHARS - 1) + '…'
}

function isBreak(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n'
}

/**
 * Rotate a repeating unit so it begins where a human would say it begins.
 *
 * Every rotation of a periodic unit repeats exactly as well: "me go. Let " is as true a period
 * of "Let me go. Let me go. " as "Let me go. " is. Alignment is therefore not a property of
 * the text — it is a property of where the words are. The buffer ends wherever the last chunk
 * ended, which is almost always mid-copy, so without this the alarm card would show a unit cut
 * through the middle of a word and read like a bug in the guard.
 *
 * Display only: the count, the decision, and the latch are all unaffected. Text with no word
 * breaks at all (CJK prose, base64) has no better rotation to find and is returned unchanged.
 */
function alignUnit(unit) {
  const n = unit.length
  if (n < 2) return unit

  let bestIndex = -1
  let bestScore = -1
  for (let i = 0; i < n; i += 1) {
    const first = unit[i]
    if (isBreak(first)) continue
    const previous = unit[(i - 1 + n) % n]
    if (i !== 0 && !isBreak(previous)) continue

    let score = 0
    // A capital is the strongest hint that a sentence starts here.
    if (first >= 'A' && first <= 'Z') score += 2
    // A unit that ends on a break or a sentence end is a whole sentence, not a fragment.
    if (isBreak(previous) || previous === '.' || previous === '!' || previous === '?') score += 1
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  if (bestIndex <= 0) return unit
  return unit.slice(bestIndex) + unit.slice(0, bestIndex)
}

/** The unit as the alarm and the monitor tab should show it. */
function displayUnit(unit) {
  return shorten(alignUnit(unit))
}

function isBlank(text) {
  return text.trim() === ''
}

/**
 * A unit made of one character repeated is a divider, not a loop.
 *
 * `====================` and `--------------------` are ordinary things to write in a code
 * comment, and with `minRepeat: 5` a 30-character divider is long enough to look exactly like a
 * runaway. Requiring two distinct non-space characters costs nothing real — text that loops
 * loops on words — and it is the difference between a guard that is trusted and one that fires
 * on a section header.
 */
function hasContent(unit) {
  const seen = new Set()
  for (const ch of unit) {
    if (isBreak(ch)) continue
    seen.add(ch)
    if (seen.size >= 2) return true
  }
  return false
}

/**
 * Normalize whitespace only. Different numbers remain different content, even in
 * otherwise identical lines; detecting counter loops would also flag ordinary data.
 */
function normalizeLine(line) {
  return line.trim().replace(/\s+/gu, ' ')
}

/**
 * How many positions at the end of `text` satisfy `text[i] === text[i - period]`.
 *
 * For a unit repeated k times contiguously, this is exactly (k - 1) * period, so the copy
 * count is `floor(matched / period) + 1`. The scan stops at `cap` because proving the
 * threshold costs `minRepeat + 1` copies and nothing more; counting a 500-copy loop exactly
 * would buy a bigger number in the alarm and cost real time in the stream.
 */
function runLength(text, period, cap, budget) {
  const n = text.length
  const max = Math.min(cap, n - period)
  let matched = 0
  while (matched < max) {
    if (text[n - 1 - matched] !== text[n - 1 - matched - period]) break
    matched += 1
    if (budget.spent >= budget.limit) break
  }
  budget.spent += matched + 1
  return matched
}

/**
 * Best verbatim cycle in the tail, whether or not it reaches the threshold.
 *
 * Returns `{ unit, repeats, qualifies }`. `repeats` is reported even below the threshold so
 * the monitor tab can draw a bar that fills as a loop forms, rather than a bar that is empty
 * until it is suddenly an alarm.
 */
function scanCycle(text, config) {
  const budget = { spent: 0, limit: WORK_BUDGET }
  // A period needs at least two copies to be visible at all, so the search is bounded by
  // half the buffer — NOT by `minRepeat`. Bounding it by `minRepeat` would hide the unit
  // until the threshold was already reached, and the monitor tab's bar would jump from
  // empty to alarm instead of filling as the loop forms.
  const longest = Math.min(config.maxUnit, Math.floor(text.length / 2))
  let best = { unit: '', repeats: 0, qualifies: false }

  for (let period = config.minUnit; period <= longest; period += 1) {
    // Only the last `period` characters are ever the candidate unit: a cycle is contiguous,
    // so the unit is by definition what just repeated.
    const unit = text.slice(text.length - period)
    if (!hasContent(unit)) continue

    const wanted = period * (config.minRepeat + 1)
    const matched = runLength(text, period, wanted, budget)
    const repeats = matched >= period ? Math.floor(matched / period) + 1 : 0
    const qualifies = repeats >= config.minRepeat

    if (qualifies) {
      // First qualifying period wins. It is the shortest unit that already repeats enough,
      // which is also the earliest moment we could have known — and the alarm's latency is
      // the whole point of the plugin.
      return { unit, repeats, qualifies: true }
    }
    if (repeats > best.repeats) best = { unit, repeats, qualifies: false }
    if (budget.spent >= budget.limit) break
  }

  return best
}

/**
 * Share of the last `densityLines` lines that are duplicates of an earlier one.
 *
 * `{ duplicates, total, sample }` — `sample` is a duplicate line, for the alarm text.
 */
function scanDensity(text, config) {
  const lines = text.split('\n').filter((line) => !isBlank(line))
  if (lines.length < config.densityLines) return { duplicates: 0, total: lines.length, sample: '' }

  const window = lines.slice(-config.densityLines).map(normalizeLine)
  const seen = new Set()
  let duplicates = 0
  let sample = ''
  for (const line of window) {
    if (!hasContent(line)) continue
    if (seen.has(line)) {
      duplicates += 1
      if (sample === '') sample = line
    } else {
      seen.add(line)
    }
  }
  return { duplicates, total: window.length, sample }
}

export function createDetector(options) {
  const config = Object.assign({}, DEFAULTS, options || {})

  /** Per stream: the tail text, the chars appended since the last scan, and the latch. */
  const buffers = { thinking: '', text: '' }
  const since = { thinking: 0, text: 0 }
  const latched = { thinking: false, text: false }
  const latest = { thinking: { repeats: 0, unit: '', score: 0 }, text: { repeats: 0, unit: '', score: 0 } }

  function examine(stream) {
    const text = buffers[stream]
    // The floor is deliberately not `minUnit * minRepeat`: a caller who raises `minRepeat`
    // far above the density threshold (the harness does, to isolate the density detector)
    // would otherwise switch the density detector off as a side effect.
    if (text.length < config.minUnit * 2) return null

    const cycle = scanCycle(text, config)
    // The cycle's own progress, as a share of the threshold. Clamped: past the threshold the
    // bar is full, and a loop that never ends must not report a score of 400.
    const cycleScore = config.minRepeat === 0 ? 0 : Math.min(cycle.repeats / config.minRepeat, 1)

    if (cycle.qualifies) {
      latest[stream] = { repeats: cycle.repeats, unit: displayUnit(cycle.unit), score: 1 }
      if (latched[stream]) return null
      // One loop, one alarm. Without the latch a single runaway turn would emit an alarm per
      // chunk — hundreds of identical cards, which is the failure mode of the alarm itself.
      latched[stream] = true
      return { stream, kind: 'cycle', unit: displayUnit(cycle.unit), repeats: cycle.repeats, at: Date.now() }
    }

    // Only asked when no cycle was found, so a verbatim loop is never downgraded to the
    // vaguer signal it would also match.
    const density = scanDensity(text, config)
    const ratio = density.total === 0 ? 0 : density.duplicates / density.total

    if (ratio >= config.densityRatio) {
      latest[stream] = { repeats: density.duplicates, unit: shorten(density.sample), score: 1 }
      if (latched[stream]) return null
      latched[stream] = true
      return { stream, kind: 'density', unit: shorten(density.sample), repeats: density.duplicates, at: Date.now() }
    }

    // Neither detector fired. The bar shows whichever signal is closer to its own threshold:
    // a counting loop is the closest thing to a hit the cycle detector can see, and reporting
    // its near-zero repeat count would draw an empty bar over a loop one line from alarming.
    if (ratio >= cycleScore) {
      latest[stream] = { repeats: density.duplicates, unit: '', score: Math.min(ratio, 1) }
    } else {
      latest[stream] = { repeats: cycle.repeats, unit: '', score: cycleScore }
    }
    return null
  }

  return {
    push(stream, text) {
      if (STREAMS.indexOf(stream) === -1) return null
      if (typeof text !== 'string' || text === '') return null

      let buffer = buffers[stream] + text
      if (buffer.length > config.windowChars) buffer = buffer.slice(-config.windowChars)
      buffers[stream] = buffer

      since[stream] += text.length
      if (since[stream] < config.checkEvery) return null
      since[stream] = 0
      return examine(stream)
    },

    snapshot() {
      const out = {}
      for (const stream of STREAMS) {
        out[stream] = {
          chars: buffers[stream].length,
          repeats: latest[stream].repeats,
          unit: latest[stream].unit,
          score: latest[stream].score,
        }
      }
      return out
    },

    reset(stream) {
      const targets = stream === undefined ? STREAMS : [stream]
      for (const name of targets) {
        if (STREAMS.indexOf(name) === -1) continue
        buffers[name] = ''
        since[name] = 0
        latched[name] = false
        latest[name] = { repeats: 0, unit: '', score: 0 }
      }
    },

    configure(patch) {
      Object.assign(config, patch || {})
      return Object.assign({}, config)
    },

    options() {
      return Object.assign({}, config)
    },
  }
}
