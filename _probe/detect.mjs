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

quiet('different numbers remain different content',
  Array.from({ length: 40 }, (_, i) => 'Step 3: processing item ' + i).join('\n') + '\n')
quiet('timestamped retry lines are not classified from text alone',
  Array.from({ length: 40 }, (_, i) => 'attempt ' + i + ': connection timed out, will retry').join('\n') + '\n')

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
