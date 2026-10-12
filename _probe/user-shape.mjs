/**
 * Does the shipped detector already catch the shape the user described?
 *
 * Before building anything, this asks the shipped `createDetector` the only question that
 * matters: feed it the user's own example and see whether it fires.
 *
 *   node _probe/user-shape.mjs
 *
 * The user's case, verbatim: "一 then a newline, 二 then a newline, 四 then a newline, 1 then a
 * newline, 2 then a newline, 4" — a block of lines cycling, where no two *adjacent* lines are
 * equal, so no single line repeats back-to-back.
 *
 * The guess under test is that this is already covered. The character-level cycle detector
 * searches for a repeating *character* period, and "一\n二\n四\n" is six characters that come
 * back around — the fact that the lines differ from each other does not stop the six-character
 * string from being periodic. If that is right, this shape needs no new detector, and the
 * earlier "three-line loop is missed" reading was an artifact of feeding too little text.
 */

import { createDetector } from '../src/detect.js'

const SHAPES = {
  '一 / 二 / 四': ['一', '二', '四'],
  '一 / 二 / 四（带空行）': ['一', '', '二', '', '四'],
  '甲 / 乙': ['甲', '乙'],
  '第一条 / 第二条 / 第三条': ['第一条：检查配置', '第二条：检查依赖', '第三条：检查权限'],
  'step a / step b / step c': ['step a: read config', 'step b: read deps', 'step c: read perms'],
  '第 N 步（计数器，每行都不同）': null,
  'A / B / C / D / E 五行': ['A', 'B', 'C', 'D', 'E'],
}

function feed(lines, limit = 400) {
  const detector = createDetector()
  const history = []
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i % lines.length] + '\n'
    history.push(line)
    const hit = detector.push('text', line)
    if (hit !== null) {
      return { hit, lines: history.filter((l) => l.trim() !== '').length, chars: history.join('').length }
    }
  }
  const snap = detector.snapshot()
  return { hit: null, lines: 400, chars: history.join('').length, snap }
}

console.log('喂到 400 行仍未报 = 漏\n')
console.log(`${'形状'.padEnd(30)} ${'结果'.padEnd(10)} ${'命中时'.padEnd(14)} 规则 / 片段`)
console.log('─'.repeat(100))

for (const [name, block] of Object.entries(SHAPES)) {
  const lines = block === null ? Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 步：读取配置文件完成。`) : block
  const seen = feed(lines)
  if (seen.hit === null) {
    console.log(`${name.padEnd(30)} ${'漏'.padEnd(10)} ${`${seen.lines} 行`.padEnd(14)} 最接近 repeats=${seen.snap?.text.repeats ?? 0}`)
  } else {
    const unit = seen.hit.unit.replace(/\n/gu, '⏎')
    console.log(
      `${name.padEnd(30)} ${'✅ 抓到'.padEnd(10)} ${`${seen.lines} 行 / ${seen.chars} 字`.padEnd(14)} ` +
        `${seen.hit.kind} ×${seen.hit.repeats} 「${unit.slice(0, 40)}」`,
    )
  }
}

console.log('\n── 同一个形状，喂多喂少的差别 ──')
for (const [label, count] of [['10 行', 10], ['20 行', 20], ['40 行', 40], ['60 行', 60]]) {
  const detector = createDetector()
  let hit = null
  for (let i = 0; i < count; i += 1) {
    hit = detector.push('text', ['一', '二', '四'][i % 3] + '\n')
    if (hit !== null) break
  }
  console.log(`  一/二/四 · 只喂 ${label.padEnd(6)} ⇒ ${hit === null ? '漏' : `第 ${count} 行内抓到`}`)
}
