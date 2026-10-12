/**
 * Exploration: can a skeleton detector catch counter loops without firing on ordinary content?
 *
 * THE BLIND SPOT (measured, see CONTRACT.md)
 * A loop whose only change is an increasing counter passes both shipped detectors:
 *
 *   第 1 步：读取配置文件完成。
 *   第 2 步：读取配置文件完成。
 *
 * `cycle` compares literal periods and `density` compares whole normalized lines. Every line
 * here differs from every other, so both see nothing, and the model runs to the token ceiling
 * — 7092 characters in the measurement, against 32 characters for a verbatim loop. Two
 * hundred times the damage, and the monitor tab's bar reads 0% the whole way.
 *
 * THE CANDIDATE
 * Replace digit runs with `#` and compare those skeletons. Two lines with the same skeleton
 * differ *only* in their numbers, which is the definition of a counter loop.
 *
 * THE RISK, AND WHY IT IS SMALLER THAN IT LOOKS
 * A numeric table also has lines that differ only in numbers — but only if its *labels* are
 * identical too (`| 项目1 | 10 |` vs `| 项目2 | 20 |`). Real tables vary their labels (电缆 /
 * 开关 / 配电箱), so their skeletons differ and they never reach the threshold. What the
 * skeleton actually selects for is "identical text, varying numbers", which is not a thing
 * ordinary prose does.
 *
 * This file measures that claim rather than asserting it. It is exploration: it does not
 * import the shipped core, and nothing here ships until the false-positive column is empty
 * across thresholds a user could plausibly set.
 */

const THRESHOLDS = [5, 6, 8, 10, 12, 16]

// ── the candidate detector ────────────────────────────────────────────────────────────────

function skeleton(line) {
  return line.replace(/\d+/gu, '#')
}

function isBlank(line) {
  return line.trim() === ''
}

function hasContent(text) {
  const seen = new Set()
  for (const ch of text) {
    if (ch === ' ' || ch === '\t') continue
    seen.add(ch)
    if (seen.size >= 2) return true
  }
  return false
}

/**
 * Longest run of consecutive lines sharing one skeleton.
 *
 * Contiguity is the whole signal: a skeleton that recurs with other text between it is a
 * table of contents, not a loop. `{ run, skeleton, sample }` — `sample` is the first line of
 * the run, which is what a human should be shown.
 */
function scanStruct(text, minLines) {
  const lines = text.split('\n').filter((line) => !isBlank(line))
  let best = { run: 0, skeleton: '', sample: '' }
  let run = 0
  let current = ''
  let sample = ''

  for (const line of lines) {
    const key = skeleton(line)
    // A skeleton with one distinct character is a divider (`----`, `====`), which the shipped
    // cycle detector already refuses for the same reason.
    const usable = hasContent(key) && key.length >= 4
    if (usable && key === current) {
      run += 1
    } else {
      run = usable ? 1 : 0
      current = usable ? key : ''
      sample = line
    }
    if (run > best.run) best = { run, skeleton: current, sample }
  }

  return best
}

// ── feeding a detector the way the host does ──────────────────────────────────────────────

/**
 * Push text in chunks and report when a run first reaches `minLines`.
 *
 * Chunked on purpose: the host sees 20-80 character deltas, so a detector that only works on
 * whole documents would report a latency the real plugin cannot achieve.
 */
function feed(text, minLines, chunk = 16) {
  let fed = 0
  for (let i = 0; i < text.length; i += chunk) {
    fed = Math.min(i + chunk, text.length)
    const seen = scanStruct(text.slice(0, fed), minLines)
    if (seen.run >= minLines) {
      return { hit: true, chars: fed, sample: seen.sample, run: seen.run }
    }
  }
  return { hit: false, chars: text.length, sample: '', run: 0 }
}

// ── samples ───────────────────────────────────────────────────────────────────────────────

const LOOPS = {
  'A 第 N 步：读取配置文件完成。': Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 步：读取配置文件完成。`).join('\n'),
  'B 检查项 N/400：文件存在 —— 通过。': Array.from({ length: 400 }, (_, i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`).join('\n'),
  'C 好，现在处理第 N 个问题。': Array.from({ length: 400 }, (_, i) => `好，现在处理第 ${i + 1} 个问题。`).join('\n'),
  'D [N/400] 正在分析代码结构...': Array.from({ length: 400 }, (_, i) => `[${i + 1}/400] 正在分析代码结构...`).join('\n'),
  'E 第 N 次尝试：连接数据库超时。': Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 次尝试：连接数据库超时。`).join('\n'),
  'F 步骤 N：验证配置项。': Array.from({ length: 400 }, (_, i) => `步骤 ${i + 1}：验证配置项。`).join('\n'),
}

const NORMAL = {
  '① 材料表（标签各不相同）': [
    '| 项目 | 数量 | 金额 |',
    '| --- | --- | --- |',
    '| 电缆 | 120 | 3600 |',
    '| 开关 | 45 | 2250 |',
    '| 配电箱 | 8 | 4800 |',
    '| 变压器 | 2 | 56000 |',
    '| 电表 | 300 | 15000 |',
    '| 互感器 | 12 | 9600 |',
    '| 母线 | 60 | 7200 |',
    '| 绝缘子 | 240 | 4800 |',
    '| 接线端子 | 500 | 2500 |',
    '| 电缆头 | 80 | 6400 |',
    '| 接地线 | 150 | 3000 |',
    '| 避雷器 | 6 | 3600 |',
  ].join('\n'),

  '② 编号步骤（每步内容不同）': [
    '1. 打开配置文件 config.json',
    '2. 找到 database 这一段',
    '3. 把 host 改成 127.0.0.1',
    '4. 保存文件并关闭编辑器',
    '5. 重启后端服务',
    '6. 用 curl 验证连接',
    '7. 检查服务日志',
    '8. 确认没有报错',
    '9. 提交这次变更',
    '10. 通知团队',
    '11. 更新部署文档',
    '12. 归档这张工单',
  ].join('\n'),

  '③ 代码（循环变量递增）': [
    'for (let i = 0; i < rows.length; i++) {',
    '  const row = rows[i]',
    '  if (row === undefined) continue',
    '  total += row.value',
    '  if (total > limit) break',
    '  console.log(i, row)',
    '}',
  ].join('\n'),

  '④ 日志（时间戳变、消息也变）': [
    '[12:00:01] 开始处理批次',
    '[12:00:02] 读取输入文件完成',
    '[12:00:04] 校验字段格式',
    '[12:00:05] 发现 3 条异常记录',
    '[12:00:07] 写入临时表',
    '[12:00:09] 汇总统计完成',
    '[12:00:11] 生成报表',
    '[12:00:12] 归档源文件',
    '[12:00:14] 发送通知邮件',
    '[12:00:15] 批次处理结束',
  ].join('\n'),

  '⑤ 财务数字（标签不同）': [
    '营业收入 1200000 元',
    '营业成本 800000 元',
    '毛利润 400000 元',
    '销售费用 120000 元',
    '管理费用 80000 元',
    '研发费用 150000 元',
    '营业利润 50000 元',
    '所得税 12500 元',
    '净利润 37500 元',
    '每股收益 0.15 元',
  ].join('\n'),

  '⑥ 版本号递增的依赖表': [
    '- lodash 4.17.21',
    '- express 4.18.2',
    '- typescript 5.2.2',
    '- vite 4.4.9',
    '- vitest 0.34.4',
    '- eslint 8.48.0',
    '- prettier 3.0.3',
    '- zod 3.22.2',
    '- jsdom 22.1.0',
    '- puppeteer 21.1.0',
  ].join('\n'),

  '⑦ 数字清单（每项说明不同）': [
    '1 号柜：进线开关 630A',
    '2 号柜：出线开关 400A',
    '3 号柜：电容补偿 200kvar',
    '4 号柜：计量表 0.5S 级',
    '5 号柜：备用位置',
    '6 号柜：母线联络',
    '7 号柜：避雷器',
    '8 号柜：接地刀闸',
  ].join('\n'),

  '⑧ JSON 对象数组': [
    '  {',
    '    "id": 1,',
    '    "name": "第一项",',
    '    "enabled": true',
    '  },',
    '  {',
    '    "id": 2,',
    '    "name": "第二项",',
    '    "enabled": false',
    '  },',
    '  {',
    '    "id": 3,',
    '    "name": "第三项",',
    '    "enabled": true',
    '  }',
  ].join('\n'),

  '⑨ 施工进度（日期与内容都变）': [
    '2026-10-01 基础开挖完成',
    '2026-10-03 垫层浇筑完成',
    '2026-10-05 钢筋绑扎完成',
    '2026-10-07 模板支设完成',
    '2026-10-09 混凝土浇筑完成',
    '2026-10-12 拆模养护开始',
    '2026-10-15 回填夯实完成',
    '2026-10-18 设备基础验收',
    '2026-10-21 柜体就位安装',
    '2026-10-24 二次接线完成',
  ].join('\n'),

  '⑩ 参数表（键名相同、值不同）—— 最接近的边界': [
    'maxRepeat: 10',
    'minUnit: 6',
    'maxUnit: 1024',
    'windowChars: 8192',
    'densityLines: 8',
    'densityRatio: 0.75',
    'checkEvery: 32',
    'minRepeat: 5',
    'cancel: true',
    'sound: true',
    'alarm: true',
    'scopeDefault: all',
  ].join('\n'),
}

// ── report ────────────────────────────────────────────────────────────────────────────────

function pad(text, width) {
  const s = String(text)
  // CJK occupies two columns in a terminal, so count by display width rather than code units.
  let wide = 0
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) wide += 1
  const visible = s.length + wide
  return visible >= width ? s : s + ' '.repeat(width - visible)
}

console.log('═══ 循环样本：能不能抓到，几行抓到，流出多少字 ═══\n')
console.log(`${pad('样本', 34)} ${THRESHOLDS.map((t) => pad(`${t} 行`, 10)).join('')}`)
console.log('─'.repeat(34 + 10 * THRESHOLDS.length))
for (const [name, text] of Object.entries(LOOPS)) {
  const cells = THRESHOLDS.map((t) => {
    const r = feed(text, t)
    return pad(r.hit ? `${r.run}行/${r.chars}字` : '—', 10)
  })
  console.log(`${pad(name, 34)} ${cells.join('')}`)
}

console.log('\n═══ 正常样本：会不会误报（✓ = 安静，✗ = 误报）═══\n')
console.log(`${pad('样本', 40)} ${THRESHOLDS.map((t) => pad(`${t} 行`, 8)).join('')}`)
console.log('─'.repeat(40 + 8 * THRESHOLDS.length))
let falsePositives = 0
for (const [name, text] of Object.entries(NORMAL)) {
  const cells = THRESHOLDS.map((t) => {
    const r = feed(text, t)
    if (r.hit) falsePositives += 1
    return pad(r.hit ? `✗${r.run}` : '✓', 8)
  })
  console.log(`${pad(name, 40)} ${cells.join('')}`)
}

console.log(`\n误报总数：${falsePositives}`)
