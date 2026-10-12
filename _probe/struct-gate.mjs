/**
 * The skeleton rule's two axes, against the shapes that decide them.
 *
 * The real corpus says the honest ceiling over 12 lines is 34% letters and the heaviest honest
 * run is 543 characters — but a corpus is evidence about what has been written, not about what
 * can be written. This probe therefore runs the *synthetic* enumerations too: the ones a person
 * would hand you as counterexamples (ports, versions, email addresses, a table of numbers).
 *
 * The question it answers: at which line gate does every synthetic enumeration go quiet, and
 * what does that gate cost in detection speed on the shapes we actually want to catch.
 *
 * Usage: node _probe/struct-gate.mjs
 */

import { createDetector } from '../src/detect.js'

const GATES = [12, 14, 16, 18, 20, 24, 30]

/** Things a person writes on purpose, all of which share a skeleton and none of which loop. */
const ENUMERATIONS = {
  端口清单: (i) => `  port ${8001 + i} is listening`,
  版本表: (i) => `- v1.2.${i} released today`,
  邮箱清单: (i) => `user${i + 1}@test.com`,
  代码索引: (i) => `  list.push(${i + 1})`,
  文件清单: (i) => `- [0] \`051_off${28215881 + i}.bin\``,
  测试用例: (i) => `  test(${i + 1}) should pass`,
  日期序列: (i) => `2026-10-${10 + i} shipped`,
  IP列表: (i) => `10.0.${i}.1 is up`,
  SQL批量: (i) => `INSERT INTO t VALUES (${i + 1});`,
  表格行: (i) => `| 项目${i + 1} | ${i + 1}0 | ${i + 1}00 |`,
  用户列表: (i) => `- user${i + 1} has access`,
  章节编号: (i) => `### ${i + 1}. 说明段落`,
  CAD坐标: (i) => `- (3940712.246,175806${i})→(3941100.864,175806${i})`,
  十六进制: (i) => `  0x${(0x14c + i).toString(16)} = ${348 + i}`,
  坐标对数: (i) => `12. ${1000 + i} rot90: (4161603.663,1758${i})`,
}

/** The blind spot: a sentence with one fresh number glued on, repeated without end. */
const LOOPS = {
  第N步: (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  检查项: (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  好现在处理: (i) => `好，现在处理第 ${i + 1} 个问题。`,
  方括号进度: (i) => `[${i + 1}/400] 正在分析代码结构...`,
  已处理N条: (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  StepN: (i) => `Step ${i + 1}: reading config done.`,
  第N次尝试: (i) => `第 ${i + 1} 次尝试：连接数据库超时。`,
  第N项: (i) => `第 ${i + 1} 项：检查完毕。`,
  中文进度: (i) => `正在处理第 ${i + 1} 个文件，请稍候。`,
  完成度: (i) => `完成度 ${i + 1}%：继续扫描目录。`,
}

const ROWS = 60

function firstHit(make, gate) {
  const detector = createDetector({ structLines: gate, structShare: 0.6 })
  let chars = 0
  for (let i = 0; i < ROWS; i += 1) {
    const line = make(i) + '\n'
    chars += line.length
    const hit = detector.push('text', line)
    if (hit) return { line: i + 1, chars, kind: hit.kind }
  }
  return null
}

const pad = (text, width) => String(text).padStart(width)

console.log('★ 合成枚举（诚实内容）：在「≥N 行 且 字母占比≥60%」下第几行被误报；— = 安静')
console.log('形状'.padEnd(12) + GATES.map((g) => pad(`≥${g}行`, 9)).join(''))
for (const [name, make] of Object.entries(ENUMERATIONS)) {
  const cells = GATES.map((gate) => {
    const hit = firstHit(make, gate)
    return pad(hit ? `第${hit.line}行` : '—', 9)
  })
  console.log(name.padEnd(12) + cells.join(''))
}

console.log()
console.log('★ 真循环：命中时的行数/字数（漏 = 该门槛下达不到字母占比）')
console.log('形状'.padEnd(12) + GATES.map((g) => pad(`≥${g}行`, 12)).join(''))
for (const [name, make] of Object.entries(LOOPS)) {
  const cells = GATES.map((gate) => {
    const hit = firstHit(make, gate)
    return pad(hit ? `${hit.line}行/${hit.chars}字` : '漏', 12)
  })
  console.log(name.padEnd(12) + cells.join(''))
}
