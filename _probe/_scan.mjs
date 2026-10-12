/**
 * One-off asar grep: find which packaged files mention a needle.
 *
 * The asar reader is loaded once and every candidate file is scanned in memory,
 * so a needle that appears in a generated region of a 200-file dependency tree
 * is found in one pass instead of one `asar.mjs read` per file.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HEADER_PICKLE_PREFIX = 8

function load(archivePath) {
  const buffer = readFileSync(archivePath)
  const headerSize = buffer.readUInt32LE(4)
  const headerBuf = buffer.subarray(HEADER_PICKLE_PREFIX, HEADER_PICKLE_PREFIX + headerSize)
  const stringLength = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.subarray(8, 8 + stringLength).toString('utf8'))
  const files = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const full = prefix === '' ? name : `${prefix}/${name}`
      if (value.files !== undefined) walk(value, full)
      else files.push({ path: full, size: value.size ?? 0, offset: Number(value.offset ?? '0') })
    }
  }
  walk(header, '')
  return { buffer, base: HEADER_PICKLE_PREFIX + headerSize, files }
}

const [archivePath, needle, filter] = process.argv.slice(2)
const archive = load(resolve(archivePath))
let scanned = 0
for (const entry of archive.files) {
  if (filter !== undefined && !entry.path.includes(filter)) continue
  if (entry.size > 4_000_000) continue
  const start = archive.base + entry.offset
  const text = archive.buffer.subarray(start, start + entry.size).toString('utf8')
  scanned += 1
  if (!text.includes(needle)) continue
  const at = text.indexOf(needle)
  console.log(`\n=== ${entry.path}  (${entry.size} bytes)`)
  console.log(text.slice(Math.max(0, at - 900), at + 500))
}
console.error(`# scanned ${scanned} files`)
