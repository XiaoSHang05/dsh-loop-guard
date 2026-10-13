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
 * FOUR RULES, IN THE ORDER THEY ARE CONSULTED
 *
 * 1. `custom` — a phrase the user typed. Some models get stuck on a sentence this file has no
 *    reason to know, and a list of phrases is the only rule that can be told what to look for.
 *    It runs first because a human asked for it by name.
 *
 * 2. `cycle` — verbatim repetition. The model emits the same unit contiguously: the same
 *    sentence, the same list item, the same paragraph, until the token ceiling. This is the
 *    failure the user described ("Let me go. Let me go. ... 100 times").
 *
 * 3. `struct` — a counting loop: one sentence shape with a fresh number glued on each line.
 *    `第 1 步：读取完成。` and `第 2 步：读取完成。` are different strings and different lines,
 *    so neither rule above sees them; blanking the digits makes them one skeleton.
 *
 * 4. `density` — repeated lines separated by other text or varying whitespace.
 *    Lines are compared after whitespace normalization, but digits remain content:
 *    a numeric table must not be mistaken for a runaway counter.
 *
 * The order is by specificity, and a rule is consulted only when the ones before it found
 * nothing: a genuine loop is never reported as a vaguer one.
 */

export const DEFAULTS = {
  minRepeat: 5,
  minUnit: 6,
  maxUnit: 1024,
  windowChars: 8192,
  checkEvery: 32,
  densityLines: 8,
  densityRatio: 0.75,
  structLines: 12,
  structShare: 0.6,
  // Off by default, and empty: this rule exists to be told what to look for, so a default
  // phrase would be this file guessing. An empty list costs one length check per scan.
  customPhrases: [],
  customRepeat: 5,
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
 * otherwise identical lines.
 *
 * This is deliberate, and it is what makes a third detector necessary: a counting loop
 * (`第 1 步：…`, `第 2 步：…`) writes a different line every time, so it is invisible both to the
 * character cycle (the characters never repeat) and to this one (the lines never match). Making
 * numbers equal here would fix that and break something worse — every honest table of ports,
 * offsets or versions would collapse into one repeated line and the density detector would fire
 * on ordinary data. The numbers are not the signal; the sentence carrying them is. That is what
 * `skeleton` reads instead.
 */
function normalizeLine(line) {
  return line.trim().replace(/\s+/gu, ' ')
}

/**
 * A line with its numbers blanked: `第 1 步：读取完成。` and `第 2 步：读取完成。` share one.
 *
 * `#` is the placeholder because it cannot occur in the output of `replace(/\d+/gu, ...)`, so a
 * skeleton can never collide with a real line by accident.
 */
function skeleton(line) {
  return normalizeLine(line).replace(/\d+/gu, '#')
}

/**
 * The longest run of consecutive lines at the end of `text` that share one skeleton, and how
 * much of it is words.
 *
 * Two axes, because neither alone separates a runaway from honest data — this was measured
 * against every assistant message this machine has ever logged (see `_probe/struct-*.mjs`):
 *
 *   lines   a 12-port listing is 12 lines; so is a 12-line loop
 *   letters / (letters + digits)
 *           a listing is a format with numbers poured into it (34% at its most verbal), a
 *           counting loop is a sentence with one fresh number glued on (50% and up). This is
 *           the statistic that actually separates them, and it is scale-free: it does not move
 *           when the lines get longer.
 *
 * The heaviest honest run in 970 MB of real output is 12 lines at 34%; the honest ceiling over
 * 8 lines is 50%. A caller passing the defaults therefore has four lines and 26 points of room,
 * which is what makes this a threshold rather than a coincidence.
 */
function scanSkeleton(text, config) {
  // `structLines: 0` turns the rule off, the way `minRepeat: 0` turns the cycle rule off. A
  // harness that wants to argue about the other two detectors needs a way to say so, and a
  // caller who does not want this rule should not have to pick an impossible share to express
  // that. Returning a zero-length run also zeroes the progress bar, so "off" does not read as
  // "one line from firing".
  if (config.structLines <= 0) return { qualifies: false, lines: 0, share: 0, sample: '' }

  const lines = text.split('\n')
  // The final element is never a line: text ending in a newline leaves an empty one, and text
  // cut mid-line leaves an unfinished one whose skeleton can still change. Counting either as a
  // line would make the run count depend on where the chunk boundary fell.
  lines.pop()

  let key = null
  let run = []
  let best = []

  const measure = (candidate) => {
    const joined = candidate.join('\n')
    const digits = (joined.match(/\d/gu) ?? []).length
    const letters = (joined.match(/\p{L}/gu) ?? []).length
    return {
      lines: candidate.length,
      letters,
      digits,
      sample: candidate[0],
      share: letters + digits === 0 ? 0 : letters / (letters + digits),
    }
  }

  for (const line of lines) {
    const next = isBlank(line) ? null : skeleton(line)
    // `hasContent` on the skeleton is what keeps a page of `-----` separators out: they share a
    // skeleton and would otherwise be the longest run on the page.
    if (next === null || !hasContent(next) || next.length < 4) {
      // A blank line ends the run: the rule counts *adjacent* lines, and treating a gap as
      // transparent would merge two unrelated blocks into one apparent loop.
      if (run.length > best.length) best = run
      key = null
      run = []
      continue
    }
    if (next === key) {
      run.push(line)
    } else {
      if (run.length > best.length) best = run
      key = next
      run = [line]
    }
  }
  if (run.length > best.length) best = run

  // The longest run in the window, not the last one. A loop is a run that keeps growing at the
  // end of the buffer, so the two agree while it is happening — but a blank line arriving in the
  // same chunk as the twelfth line would otherwise reset the run before it was ever measured.
  if (best.length < config.structLines) {
    return { qualifies: false, lines: best.length, share: 0, sample: '' }
  }

  const found = measure(best)
  return {
    qualifies: found.lines >= config.structLines && found.share >= config.structShare,
    lines: found.lines,
    share: found.share,
    sample: found.sample,
  }
}

/**
 * Share of a span that must be the phrase itself for its occurrences to read as a loop.
 *
 * A loop is the phrase with a little between it: five copies of `Let me go. ` back to back fill
 * their span completely. Five mentions of the same phrase spread across an answer fill almost
 * none of it. This ratio is what separates the two, and it is derived rather than configured so
 * the user has one number to understand instead of two.
 */
const CUSTOM_DENSITY = 0.25

/**
 * How many occurrences of one phrase are collected before the scan stops looking.
 *
 * A two-character phrase in an 8 KB window can occur thousands of times; the count is reported
 * to a human, and nobody reads a number that large. The cap is also what bounds the cost of
 * this rule on pathological input.
 */
const CUSTOM_MAX_HITS = 200

/**
 * The first custom phrase that has repeated enough, and how many times it was said.
 *
 * `{ phrase, count, qualifies }`. A phrase is a string the user typed, so this rule can look
 * for something no shape-based rule could derive — some models get stuck on a sentence that is
 * particular to them.
 *
 * The count is over the whole window rather than the last `customRepeat` of them, because the
 * question a person asks about a loop is "how many times did it say this", and the window is
 * what bounds the answer. Whether those occurrences are a loop or merely a phrase used often is
 * decided by how densely they pack their span, not by how many there are.
 */
function scanCustom(text, config) {
  const phrases = config.customPhrases
  const need = config.customRepeat
  if (!Array.isArray(phrases) || phrases.length === 0 || !(need >= 2)) {
    return { phrase: '', count: 0, qualifies: false }
  }

  let best = { phrase: '', count: 0, qualifies: false }

  for (const raw of phrases) {
    const phrase = typeof raw === 'string' ? raw : ''
    if (phrase.length < 2) continue

    const hits = []
    let at = text.indexOf(phrase)
    while (at !== -1 && hits.length < CUSTOM_MAX_HITS) {
      hits.push(at)
      at = text.indexOf(phrase, at + phrase.length)
    }
    if (hits.length > best.count) best = { phrase, count: hits.length, qualifies: false }
    if (hits.length < need) continue

    // The last `need` occurrences are the ones that decide it: a phrase mentioned a few times
    // early in the window and then looped would be judged by its sparse beginning if the first
    // `need` were used instead, and the loop would be missed.
    const tail = hits.slice(-need)
    const span = tail[tail.length - 1] + phrase.length - tail[0]
    if ((phrase.length * need) / span < CUSTOM_DENSITY) continue

    return { phrase, count: hits.length, qualifies: true }
  }

  return best
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

    // The user's own phrases, asked after the derived cycle and before the shape rules. A
    // phrase the user typed is a statement about what this model does — it is more specific
    // than any shape this file could derive, but it is not more specific than a verbatim loop,
    // which is why it comes second.
    const custom = scanCustom(text, config)
    const customScore = config.customRepeat <= 0 ? 0 : Math.min(custom.count / config.customRepeat, 1)

    if (custom.qualifies) {
      latest[stream] = { repeats: custom.count, unit: shorten(custom.phrase), score: 1 }
      if (latched[stream]) return null
      latched[stream] = true
      return { stream, kind: 'custom', unit: shorten(custom.phrase), repeats: custom.count, at: Date.now() }
    }

    // Only asked when no cycle was found, so a verbatim loop is never downgraded to the
    // vaguer signal it would also match.
    const density = scanDensity(text, config)
    const ratio = density.total === 0 ? 0 : density.duplicates / density.total

    // Between the cycle and the density: a counting loop is a real loop (so it outranks the
    // fuzzy line-repetition signal) but it is not a verbatim one (so a verbatim loop, found
    // above, must not be reported as this).
    const struct = scanSkeleton(text, config)

    if (struct.qualifies) {
      latest[stream] = { repeats: struct.lines, unit: shorten(struct.sample), score: 1 }
      if (latched[stream]) return null
      latched[stream] = true
      return { stream, kind: 'struct', unit: shorten(struct.sample), repeats: struct.lines, at: Date.now() }
    }

    if (ratio >= config.densityRatio) {
      latest[stream] = { repeats: density.duplicates, unit: shorten(density.sample), score: 1 }
      if (latched[stream]) return null
      latched[stream] = true
      return { stream, kind: 'density', unit: shorten(density.sample), repeats: density.duplicates, at: Date.now() }
    }

    // Neither detector fired. The bar shows whichever signal is closer to its own threshold:
    // a counting loop is the closest thing to a hit the cycle detector can see, and reporting
    // its near-zero repeat count would draw an empty bar over a loop one line from alarming.
    // The skeleton rule needs both of its axes at once, so its progress is the weaker of the
    // two — a run with the lines but not the words is not most of the way to an alarm.
    // A switched-off rule must not drive the bar either: `structLines: 0` means the caller does
    // not want this signal, so its progress is zero rather than "one line from firing".
    const structScore = config.structLines <= 0
      ? 0
      : Math.min(
        struct.lines / config.structLines,
        config.structShare === 0 ? 1 : struct.share / config.structShare,
        1,
      )

    // Progress is only reported from a run of two or more lines. A run of one is not a
    // repetition — every single line is a run of one — so reading the bar from it would park
    // every idle session at 1/structLines and put `repeats: 1` on the wire for prose that
    // repeats nothing. Two adjacent lines sharing a skeleton is the first moment there is
    // anything to show.
    // The user's own rule is offered to the bar first when it is configured, because it is the
    // one signal the user can see the cause of: they typed the phrase, so a bar driven by it is
    // a bar they can explain. A positive score already implies the list was a non-empty array
    // of usable phrases, so this reads the scan's own answer rather than re-inspecting config.
    if (customScore > 0 && customScore >= ratio && customScore >= cycleScore && customScore >= structScore) {
      latest[stream] = { repeats: custom.count, unit: '', score: customScore }
    } else if (struct.lines >= 2 && structScore >= ratio && structScore >= cycleScore) {
      latest[stream] = { repeats: struct.lines, unit: '', score: structScore }
    } else if (ratio >= cycleScore) {
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
