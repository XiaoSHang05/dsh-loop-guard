/**
 * Do the counting rule's negative cases actually exercise the rule?
 *
 * WHY THIS EXISTS
 * Mutation testing answered "no". Dropping the share axis — leaving a rule that fires on any
 * twelve same-shaped lines — left `_probe/detect.mjs` fully green. The negative cases were
 * passing for the wrong reason: `checkEvery` is 32 characters, so a twelve-line fixture can end
 * between two scan points and the rule never looks at twelve lines at all. A test that passes
 * because the code never ran is not evidence.
 *
 * This prints, for each candidate fixture, how long it is, how many lines it has, and whether
 * the rule fires. Run: node _probe/struct-neg.mjs
 */
import { createDetector } from '../src/detect.js'

const cases = {
  'file listing (12 lines)': Array.from({ length: 12 }, (_, i) =>
    '- [' + i + '] `0' + (51 + i) + '_off' + (28215881 + i * 7) + '.bin`'),
  'file listing (20 lines)': Array.from({ length: 20 }, (_, i) =>
    '- [' + i + '] `0' + (51 + i) + '_off' + (28215881 + i * 7) + '.bin`'),
  'port listing (12 lines)': Array.from({ length: 12 }, (_, i) => 'port ' + (8001 + i) + ' is listening'),
  'port listing (20 lines)': Array.from({ length: 20 }, (_, i) => 'port ' + (8001 + i) + ' is listening'),
  'coordinate dump (20 lines)': Array.from({ length: 20 }, (_, i) =>
    '7. 1300 rot90: (4146430.063,1761157.9)-(4146430.063,1760117.9), dp ' + i),
  'counting loop (20 lines)': Array.from({ length: 20 }, (_, i) => '第 ' + (i + 1) + ' 步：读取配置文件完成。'),
  'counting loop (20 lines, en)': Array.from({ length: 20 }, (_, i) => 'Step ' + (i + 1) + ': reading config done.'),
}

function share(lines) {
  const joined = lines.join('\n')
  const digits = (joined.match(/\d/gu) ?? []).length
  const letters = (joined.match(/\p{L}/gu) ?? []).length
  return letters + digits === 0 ? 0 : letters / (letters + digits)
}

console.log('fixture'.padEnd(30) + 'lines'.padStart(6) + 'chars'.padStart(7) + 'share'.padStart(8) + '  verdict')
for (const [name, lines] of Object.entries(cases)) {
  const text = lines.join('\n') + '\n'
  const detector = createDetector()
  let hit = null
  for (let i = 0; i < text.length && hit === null; i += 1) hit = detector.push('text', text.slice(i, i + 1))
  console.log(
    name.padEnd(30) +
    String(lines.length).padStart(6) +
    String(text.length).padStart(7) +
    (share(lines) * 100).toFixed(0).padStart(7) + '%' +
    '  ' + (hit === null ? 'quiet' : 'FIRED kind=' + hit.kind + ' lines=' + hit.repeats),
  )
}
