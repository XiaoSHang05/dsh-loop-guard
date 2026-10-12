/**
 * Harness for the detection core (`src/detect.js`).
 *
 * WHY THIS IS A SEPARATE HARNESS FROM THE HOST ONE
 * The host harness proves the wiring: a frame arrives, a detector is fed, a cancel is called.
 * It cannot prove that the detector is any good, because the text it feeds is a fixture that
 * already agrees with the detector. This one argues about text and nothing else — it is the
 * only place where the thresholds can be wrong without anything else being wrong.
 *
 * THE NEGATIVE CASES ARE THE POINT
 * A detector that fires on everything passes every positive case here. The cases that matter
 * are the ones that must stay quiet: an answer that restates its own headings, a code block,
 * a table, a list of similar-looking items, and prose that merely quotes a phrase twice. A
 * loop guard that cries wolf on ordinary work is worse than no loop guard, because it will be
 * switched off — and then the real runaway runs to the token ceiling unwatched.
 */
import { createDetector, DEFAULTS } from '../src/detect.js'

let passed = 0
const failed = []

function check(label, ok, detail) {
  if (ok) {
    passed += 1
    return
  }
  failed.push(label + (detail === undefined ? '' : '  → ' + detail))
}

/** Feed text in slices, the way a stream really arrives, and return the first hit. */
function feed(detector, stream, text, slice) {
  const size = slice === undefined ? 1 : slice
  for (let i = 0; i < text.length; i += size) {
    const hit = detector.push(stream, text.slice(i, i + size))
    if (hit !== null) return hit
  }
  return null
}

function quiet(label, text, stream) {
  const detector = createDetector()
  const hit = feed(detector, stream === undefined ? 'text' : stream, text)
  check(label, hit === null, hit === null ? undefined : 'fired: ' + JSON.stringify(hit))
  return detector
}

function loud(label, text, stream, expect) {
  const detector = createDetector()
  const hit = feed(detector, stream === undefined ? 'text' : stream, text)
  check(label, hit !== null, 'stayed quiet')
  if (hit !== null && expect !== undefined) {
    check(label + ' [kind]', hit.kind === expect, 'kind=' + hit.kind)
  }
  return hit
}

/* ------------------------------------------------------------------ the user's case */

{
  // The acceptance case, verbatim: "Let me go." repeated 100 times. The user asked for it to
  // be caught within 5–10 copies; the alarm's whole value is its latency.
  const detector = createDetector()
  const hit = feed(detector, 'text', 'Let me go. '.repeat(100), 7)
  check('the acceptance case fires', hit !== null)
  check('the acceptance case is a cycle', hit !== null && hit.kind === 'cycle')
  check('it fires within the user’s 5–10 copies', hit !== null && hit.repeats >= 5 && hit.repeats <= 10,
    hit === null ? undefined : 'repeats=' + hit.repeats)
  check('the reported unit is the repeated sentence', hit !== null && hit.unit.indexOf('Let me go.') === 0,
    hit === null ? undefined : JSON.stringify(hit.unit))
}

/* ------------------------------------------------------------------------ positives */

loud('a paragraph repeated verbatim is a cycle',
  'the quick brown fox jumps over the lazy dog. '.repeat(20), 'text', 'cycle')

loud('a single long sentence repeated is a cycle',
  'I will now check the configuration file for the missing entry. '.repeat(12), 'text', 'cycle')

loud('a line repeated with a newline between is a cycle',
  'retrying the connection\n'.repeat(20), 'text', 'cycle')

loud('thinking loops are caught on the thinking stream',
  'hmm, that is not right. '.repeat(20), 'thinking', 'cycle')

loud('a short unit still counts when repeated enough',
  'abc'.repeat(30), 'text', 'cycle')

loud('a loop that starts mid-buffer is caught',
  'Here is a normal opening sentence that is not repeated at all. ' + 'and now the loop begins. '.repeat(20),
  'text', 'cycle')

/*
 * The counting loop: `第 1 步…` / `第 2 步…` — every line differs by one number, so the cycle
 * detector sees no period and the density detector sees no duplicate line. It was the one shape
 * that could run to the token ceiling unwatched (measured: 6,692–9,492 characters emitted with
 * the progress bar still reading 0%).
 *
 * These two cases used to assert the opposite, and at the time they were right: "different
 * numbers remain different content" was an honest description of what the detector did, and the
 * only way to keep a retry log quiet. The skeleton rule is what changed that, so the assertion
 * changes with it — and both halves of the old claim stay pinned, because the rule can be
 * switched off. A test that only asserted the new behaviour would have thrown away the property
 * that made the old one worth writing.
 */
{
  const steps = Array.from({ length: 40 }, (_, i) => 'Step 3: processing item ' + i).join('\n') + '\n'
  const retries = Array.from({ length: 40 }, (_, i) =>
    'attempt ' + i + ': connection timed out, will retry').join('\n') + '\n'

  const hit = loud('a counting loop fires on the skeleton rule', steps, 'text', 'struct')
  check('the counting loop reports its run length, not a repeat count',
    hit !== null && hit.repeats >= 12 && hit.repeats <= 40,
    hit === null ? undefined : 'repeats=' + hit.repeats)

  loud('a retry loop with a fresh attempt number fires on the skeleton rule', retries, 'text', 'struct')

  // With the rule off, the old property must still hold. That is what makes the rule above a
  // choice rather than a correction of a bug — and it is the only reason a caller who wants a
  // retry log left alone has a way to say so.
  for (const [label, text] of [['step', steps], ['retry', retries]]) {
    const off = createDetector({ structLines: 0 })
    const quietHit = feed(off, 'text', text)
    check('with the skeleton rule off, a counting ' + label + ' loop is not classified from text alone',
      quietHit === null, quietHit === null ? undefined : 'fired: ' + JSON.stringify(quietHit))
  }
}

{
  // The measured honest ceiling: the heaviest same-skeleton run in 970 MB of this machine's own
  // logged output is 12 lines at 34% letters. It is a listing, not a loop, and it must stay
  // quiet — which is what fixes the share threshold. Anything at or below 34% has to pass, so
  // 60% is a threshold with room around it rather than a number fitted to one sample.
  //
  // Both fixtures are 20 lines, not 12, and that is deliberate. `checkEvery` is 32 characters,
  // so a twelve-line fixture can end between two scan points: the rule never looks at twelve
  // lines, the case stays quiet, and it would stay quiet with the share axis deleted. A negative
  // case that passes because the code never ran is decoration — this is the same "sample too
  // short" mistake the stream probes made, one layer down.
  const listing = Array.from({ length: 20 }, (_, i) =>
    '- [' + i + '] `0' + (51 + i) + '_off' + (28215881 + i * 7) + '.bin`').join('\n') + '\n'
  quiet('a file listing with numbers in every line is not a counting loop', listing)
  quiet('a coordinate dump is not a counting loop',
    Array.from({ length: 20 }, (_, i) =>
      '7. 1300 rot90: (4146430.063,1761157.9)-(4146430.063,1760117.9), dp ' + i).join('\n') + '\n')

  /*
   * The known limit, asserted rather than hidden.
   *
   * `port 8001 is listening` × 20 is an honest enumeration and the rule fires on it, because it
   * is the same text as a counting loop: one sentence, one fresh number per line, nothing in the
   * syntax to say whether it will ever stop. The share axis cannot separate them either — this
   * listing is 79% letters and the lightest real loop (`[N/400] 正在分析代码结构...`) is 67%, so
   * the two ranges overlap. The only honest options are to fire on both or on neither, and firing
   * on a long enumeration costs one dismissible alarm while not firing on the loop costs the
   * whole turn.
   *
   * So this case pins the behaviour. If someone later raises the share threshold to quiet this
   * listing, they will also have silenced the loop above, and this assertion is where that shows
   * up. The escape hatch for a caller who disagrees is `structLines: 0` or a higher line count.
   */
  loud('a long verbal enumeration fires too — the documented limit, not a surprise',
    Array.from({ length: 20 }, (_, i) => 'port ' + (8001 + i) + ' is listening').join('\n') + '\n',
    'text', 'struct')
}

{
  const detector = createDetector({ minRepeat: 50, checkEvery: 1 })
  const text = Array.from({ length: 10 }, (_, i) => i % 2 ? '  foo   bar  ' : 'foo bar').join('\n')
  const hit = detector.push('text', text)
  check('whitespace variants trigger the independent density rule', hit?.kind === 'density')
  check('density sample retains the original word order', hit?.unit === 'foo bar', hit?.unit)
}
quiet('numeric JSON data is not a loop', JSON.stringify(Array.from({length:8}, (_, i) => ({value:i})), null, 2))
quiet('multiple dividers remain quiet', ('='.repeat(20) + '\n').repeat(10))
{
  const d = quiet('healthy prose remains quiet', 'No repeating information here. The next sentence is about a different topic entirely.')
  check('healthy prose has zero repeats and zero score', d.snapshot().text.repeats === 0 && d.snapshot().text.score === 0)
}

/* ------------------------------------------------------------------------ negatives */

quiet('an ordinary multi-paragraph answer is quiet',
  [
    'I read the file and found the parser rejects CRLF line endings.',
    'The fix is to normalise the line separator before splitting.',
    'I applied it, then ran the suite: 42 tests, all green.',
    'The remaining risk is that a lone CR inside a quoted string is still mishandled.',
    'I left that alone because no fixture covers it yet.',
  ].join('\n'))

quiet('a bulleted list of similar items is quiet',
  [
    'Changes made:',
    '- normalised the line separator in the splitter',
    '- added a regression fixture for CRLF',
    '- updated the docstring on the helper',
    '- bumped the patch version',
  ].join('\n'))

quiet('a code block is quiet',
  '```js\nfunction split(text) {\n  return text.split(/\\r?\\n/u)\n}\n```\n')

quiet('a markdown table is quiet',
  '| field | type | note |\n| --- | --- | --- |\n| id | string | primary key |\n| name | string | display name |\n')

quiet('a phrase quoted twice in prose is quiet',
  'The log says "connection reset" and then, much later, it says "connection reset" again. ' +
  'Those are two separate events, hours apart, and the second one is the one that matters.')

quiet('a healthy long answer is quiet',
  [
    'The parser now normalises line separators before it splits, which is what CRLF needed.',
    'I added a fixture for a lone carriage return inside a quoted string; it passes.',
    'The docstring on the helper had gone stale, so it was rewritten to match behaviour.',
    'Coverage moved from 81 to 84 percent and every new line is exercised by a fixture.',
    'One risk remains: a trailing separator produces an empty final field, still unhandled.',
    'I left that alone on purpose, because no current caller can produce such input.',
    'The review also flagged the error message on the timeout path as unhelpfully vague.',
    'That message now names the host and the elapsed milliseconds instead of "failed".',
    'The last remaining item is the changelog entry, which I will write after this review.',
    'Nothing else in the diff looked worth changing, so the branch is ready to merge.',
  ].join('\n'))

quiet('whitespace alone is never a loop', ' '.repeat(400))

quiet('a repeated single character is below the unit floor', 'x'.repeat(400))

quiet('two copies are not a loop', 'the same sentence. the same sentence. ')

/* ------------------------------------------------------------------ mechanics */

{
  const detector = createDetector()
  let hits = 0
  for (let i = 0; i < 400; i += 1) if (detector.push('text', 'Let me go. ') !== null) hits += 1
  check('one runaway loop produces exactly one alarm', hits === 1, 'hits=' + hits)

  detector.reset()
  let again = 0
  for (let i = 0; i < 60; i += 1) if (detector.push('text', 'Let me go. ') !== null) again += 1
  check('reset re-arms the same loop', again === 1, 'hits=' + again)
}

{
  // The two streams are independent: a latch on one must not silence the other. This is the
  // difference between a guard and a guard that stops working after its first catch.
  const detector = createDetector()
  const inText = feed(detector, 'text', 'Let me go. '.repeat(40), 5)
  const inThinking = feed(detector, 'thinking', 'Let me go. '.repeat(40), 5)
  check('a text alarm does not silence the thinking stream', inText !== null && inThinking !== null)
}

{
  const detector = createDetector()
  for (let i = 0; i < 3; i += 1) detector.push('text', 'Let me go. ')
  const snap = detector.snapshot()
  check('snapshot reports both streams', snap.text !== undefined && snap.thinking !== undefined)
  check('snapshot reports the growing repeat count', snap.text.repeats >= 3, JSON.stringify(snap.text))
  check('snapshot score is below 1 before the alarm', snap.text.score < 1, String(snap.text.score))
  check('an idle stream reports a zero score', snap.thinking.score === 0 && snap.thinking.repeats === 0,
    JSON.stringify(snap.thinking))
}

{
  const detector = createDetector()
  feed(detector, 'text', 'Let me go. '.repeat(40), 5)
  check('snapshot score is 1 at the alarm', detector.snapshot().text.score === 1,
    String(detector.snapshot().text.score))
  check('snapshot names the unit at the alarm', detector.snapshot().text.unit.indexOf('Let me go.') === 0,
    JSON.stringify(detector.snapshot().text.unit))
}

{
  // A loop that runs past the threshold must not report a score of 400: the bar is a share of
  // the threshold, and the threshold is 1.
  const detector = createDetector()
  feed(detector, 'text', 'Let me go. '.repeat(400), 5)
  check('the score is clamped at 1', detector.snapshot().text.score === 1,
    String(detector.snapshot().text.score))
}

{
  const detector = createDetector()
  const returned = detector.configure({ minRepeat: 3 })
  check('configure returns the effective options', returned.minRepeat === 3)
  const hit = feed(detector, 'text', 'Let me go. '.repeat(20), 5)
  check('a lowered threshold fires earlier', hit !== null && hit.repeats <= 4,
    hit === null ? 'stayed quiet' : 'repeats=' + hit.repeats)
  check('configure keeps the untouched defaults', returned.minUnit === DEFAULTS.minUnit)
}

{
  const detector = createDetector()
  check('push rejects an unknown stream', detector.push('stdout', 'Let me go. '.repeat(20)) === null)
  check('push tolerates an empty chunk', detector.push('text', '') === null)
  check('push tolerates a non-string chunk', detector.push('text', undefined) === null)
}

{
  // The window is bounded: a stream that never repeats must not grow the buffer forever.
  const detector = createDetector()
  for (let i = 0; i < 20000; i += 1) detector.push('text', String.fromCharCode(97 + (i % 26)))
  check('the buffer is bounded by windowChars', detector.snapshot().text.chars <= DEFAULTS.windowChars,
    String(detector.snapshot().text.chars))
}

{
  // Text repeated *below* the threshold and then moved on from is not a loop. The guard watches
  // the tail, and a model that restated something three times before finding its thread must
  // not be cancelled for it.
  //
  // Note the asymmetry, which is a property of streaming rather than a bug: a run that reaches
  // the threshold *while the text is arriving* is reported, because at that moment it is
  // indistinguishable from a runaway. The guard cannot see the future, and waiting to find out
  // would cost the latency that is the whole point. What this case pins down is that a run
  // below the threshold leaves nothing behind — no lingering state that fires on later text.
  const detector = createDetector()
  const stale = 'this was repeated three times and then abandoned. '.repeat(3)
  const recovered = [
    'The parser now normalises line separators before it splits, which is what CRLF needed.',
    'I added a fixture for a lone carriage return inside a quoted string; it passes.',
    'The docstring on the helper had gone stale, so it was rewritten to match behaviour.',
    'Coverage moved from 81 to 84 percent and every new line is exercised by a fixture.',
  ].join('\n')
  const hit = feed(detector, 'text', stale + recovered, 9)
  check('a sub-threshold run the model moved on from is not reported', hit === null,
    hit === null ? undefined : JSON.stringify(hit))
}

/* ------------------------------------------------------------------ cost bound */

{
  // One chunk must not be able to stall the stream. Near-periodic text for a long stretch is
  // the worst case for the period search, and it is exactly what a real degeneration looks
  // like — so the budget is checked against a shape that occurs, not a synthetic one.
  const detector = createDetector()
  const nasty = 'a'.repeat(3000) + 'b' + 'a'.repeat(3000) + 'b'
  const started = Date.now()
  detector.push('text', nasty)
  const elapsed = Date.now() - started
  check('a pathological chunk stays under 250ms', elapsed < 250, elapsed + 'ms')
}

/* --------------------------------------------------------------------- reporting */

if (failed.length > 0) {
  console.log('detect: ' + failed.length + ' FAILED')
  for (const line of failed) console.log('  FAIL ' + line)
  console.log('detect: ' + passed + '/' + (passed + failed.length) + ' checks passed')
  process.exit(1)
}

console.log('detect: ' + passed + '/' + passed + ' checks passed')
process.exit(0)
