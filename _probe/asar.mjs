/**
 * Minimal Electron asar reader — list / extract files from a packed .asar.
 *
 * Usage:
 *   node asar.mjs list  <archive> [substring]
 *   node asar.mjs read  <archive> <innerPath>
 *   node asar.mjs dump  <archive> <substring> <outDir>
 *
 * Only what this project needs: the JSON header is parsed once, file payloads
 * are sliced straight out of the archive (offsets are relative to the end of
 * the header block).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HEADER_PICKLE_PREFIX = 8

function readHeader(buffer) {
  // pickle: [uint32 payloadSize][uint32 value]
  const headerSize = buffer.readUInt32LE(4)
  const headerBuf = buffer.subarray(HEADER_PICKLE_PREFIX, HEADER_PICKLE_PREFIX + headerSize)
  // pickle: [uint32 payloadSize][uint32 stringLength][utf8 bytes]
  const stringLength = headerBuf.readUInt32LE(4)
  const json = headerBuf.subarray(8, 8 + stringLength).toString('utf8')
  return { header: JSON.parse(json), headerSize }
}

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (value.files !== undefined) walk(value, full, out)
    else out.push({ path: full, size: value.size ?? 0, offset: value.offset ?? '0' })
  }
}

function load(archivePath) {
  const buffer = readFileSync(archivePath)
  const { header, headerSize } = readHeader(buffer)
  const files = []
  walk(header, '', files)
  const base = HEADER_PICKLE_PREFIX + headerSize
  return { buffer, base, files }
}

function slice(archive, entry) {
  const start = archive.base + Number(entry.offset)
  return archive.buffer.subarray(start, start + entry.size)
}

const [command, archivePath, ...rest] = process.argv.slice(2)
if (command === undefined || archivePath === undefined) {
  console.error('usage: node asar.mjs <list|read|dump> <archive> [args]')
  process.exit(2)
}

const archive = load(resolve(archivePath))

if (command === 'list') {
  const filter = rest[0]
  const rows = archive.files.filter((file) => filter === undefined || file.path.includes(filter))
  rows.sort((a, b) => a.path.localeCompare(b.path))
  for (const row of rows) console.log(`${String(row.size).padStart(9)}  ${row.path}`)
  console.error(`# ${rows.length} of ${archive.files.length} files`)
} else if (command === 'read') {
  const wanted = rest[0]
  const entry = archive.files.find((file) => file.path === wanted)
  if (entry === undefined) {
    console.error(`not found: ${wanted}`)
    process.exit(1)
  }
  process.stdout.write(slice(archive, entry))
} else if (command === 'dump') {
  const filter = rest[0]
  const outDir = resolve(rest[1] ?? './asar-dump')
  const rows = archive.files.filter((file) => file.path.includes(filter))
  for (const row of rows) {
    const target = join(outDir, row.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, slice(archive, row))
  }
  console.error(`# dumped ${rows.length} files to ${outDir}`)
} else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
