/**
 * Static checks: the things that are true or false about this package without running it.
 *
 * This is the cheap gate. `node scripts/test.mjs` is the expensive one — it mounts the real
 * halves and drives them. Everything here answers a question a reviewer would otherwise have
 * to answer by eye: is the shipped bundle actually built from the current source, does every
 * file parse, does the client half use a capability it never declared, did a colour sneak into
 * the stylesheet, does the manifest point at files that exist, did a machine-specific path
 * leak into a file a reader is supposed to clone.
 *
 * No git. The checks must pass in a checkout with no history and in a tarball with no `.git`.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const run = promisify(execFile)

const failures = []
const notes = []

function fail(message) {
  failures.push(message)
}

function note(message) {
  notes.push(message)
}

async function read(relative) {
  return readFile(join(root, relative), 'utf8')
}

/** Parse a file with the same engine that will run it; report the first line that hurts. */
async function parses(relative) {
  try {
    await run(process.execPath, ['--check', join(root, relative)])
  } catch (error) {
    const first = String(error.stderr || error.message).trim().split('\n')[0]
    fail(`${relative} does not parse: ${first}`)
  }
}

/** Every source file a reader could clone, minus the two directories that are not source. */
async function sourceFiles(directory, out = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) await sourceFiles(absolute, out)
    else if (/\.(?:m?js|cjs|ya?ml|json|md|css)$/u.test(entry.name)) out.push(absolute)
  }
  return out
}

async function main() {
  const manifest = JSON.parse(await read('package.json'))
  const source = await read('src/client.js')
  const style = await read('src/client.css')
  const host = await read('src/index.js')

  // ---------------------------------------------------------------- the artifact
  // `lib/client.js` is generated. If it is not the file this source builds, every client
  // harness is testing yesterday's code — the most expensive possible way to be wrong.
  let artifact = ''
  try {
    artifact = await read('lib/client.js')
  } catch (error) {
    fail('lib/client.js is missing — run: node scripts/build-client.mjs')
  }

  if (artifact !== '') {
    for (const needle of [
      JSON.stringify(manifest.name),
      'window.__ModuleLoader__.load(',
      'exports.apply = api.apply',
      'exports.inject = api.inject',
    ]) {
      if (!artifact.includes(needle)) fail(`lib/client.js does not contain ${needle}`)
    }
    // The boot block is what the client harnesses reach for by name.
    for (const name of ['project', 'alarmOf', 'createStore', 'LoopGuardView', 'AlarmCard']) {
      if (!artifact.includes(`exports.${name} = api.${name}`)) {
        fail(`lib/client.js does not re-export ${name}; _probe/contract/wire.mjs cannot reach it`)
      }
    }
    if (!artifact.includes(source)) {
      fail('lib/client.js was not built from the current src/client.js — run: node scripts/build-client.mjs')
    }
    if (!artifact.includes(JSON.stringify(style))) {
      fail('lib/client.js was not built from the current src/client.css — run: node scripts/build-client.mjs')
    }
  }

  // ---------------------------------------------------------------- syntax
  for (const relative of [
    'lib/client.js',
    'src/client.js',
    'src/index.js',
    'src/detect.js',
    'scripts/build-client.mjs',
    'scripts/check.mjs',
    'scripts/test.mjs',
    '_probe/detect.mjs',
    '_probe/host/routes.mjs',
    '_probe/host/stream.mjs',
    '_probe/contract/wire.mjs',
    '_probe/render/mount.mjs',
  ]) {
    await parses(relative)
  }

  // ---------------------------------------------------------------- declared capabilities
  // A client half that reads `ctx.uiWorkspace` without declaring the capability gets a
  // runtime `undefined` deep inside a render, which is the worst place to find out.
  const declared = new Set([...(manifest.dsh?.client?.inject ?? []), 'sessions', 'slots', 'locale'])
  for (const probe of ['uiWorkspace', 'uiConversation', 'commands', 'connection', 'webServer', 'configForms']) {
    if (new RegExp(`ctx\\.${probe}\\b`, 'u').test(source) && !declared.has(probe)) {
      fail(`src/client.js uses ctx.${probe} but does not declare it in dsh.client.inject`)
    }
  }

  // The host half is a host plugin: it may touch the context itself, and read services by name.
  for (const probe of ['uiWorkspace', 'uiConversation', 'configForms', 'connection']) {
    if (new RegExp(`ctx\\.${probe}\\b`, 'u').test(host)) {
      fail(`src/index.js uses ctx.${probe}; that is a client-side capability`)
    }
  }

  // ---------------------------------------------------------------- no JSX in the client half
  // The build step concatenates plain JS. A stray JSX expression would ship verbatim and
  // blow up in the browser with a syntax error nothing here would have caught.
  if (/<[A-Z][A-Za-z0-9]*[\s/>]/u.test(source)) {
    fail('src/client.js appears to contain JSX; this build step only concatenates plain JS')
  }

  // ---------------------------------------------------------------- forbidden surfaces
  for (const surface of ['alert(', 'confirm(', 'prompt(']) {
    if (source.includes(surface)) fail(`src/client.js calls ${surface}…)`)
    if (host.includes(surface)) fail(`src/index.js calls ${surface}…)`)
  }

  // ---------------------------------------------------------------- stylesheet colours
  // The theme owns colour. A hex literal here is a dark-mode bug waiting to be reported.
  const colour = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/u.exec(style)
  if (colour !== null) {
    fail(`src/client.css hard-codes a colour (${colour[0]}); use a --dsw-alias-* token instead`)
  }
  if (!style.includes('--dsw-alias-')) {
    fail('src/client.css uses no --dsw-alias-* token; the theme cannot reach it')
  }

  // ---------------------------------------------------------------- manifest
  for (const field of ['name', 'version', 'type', 'main', 'exports', 'dsh']) {
    if (manifest[field] === undefined) fail(`package.json has no "${field}"`)
  }
  if (manifest.dsh?.client?.platform !== 'web') {
    fail('package.json dsh.client.platform must be "web"')
  }
  if (manifest.dsh?.bundle?.patch === undefined) {
    fail('package.json dsh.bundle.patch is undefined; nothing would install the host half')
  }
  if (manifest.exports?.['./client'] === undefined) {
    fail('package.json exports has no "./client" entry; the browser half cannot be served')
  }
  if (!host.includes('export function apply')) fail('src/index.js does not export apply')
  if (!host.includes('export const inject')) fail('src/index.js does not export inject')

  const files = manifest.files
  if (!Array.isArray(files) || files.length === 0) {
    fail('package.json "files" is empty; the published tarball would contain nothing')
  } else {
    for (const entry of files) {
      try {
        await stat(join(root, entry))
      } catch (error) {
        fail(`package.json lists ${entry} in "files" but it does not exist`)
      }
    }
  }

  // ---------------------------------------------------------------- the API surface
  // The contract names six actions and one prefix. The routes are built from a table, so a
  // typo in an action name is invisible until a client 404s.
  for (const action of ['health', 'state', 'config', 'monitor', 'hits', 'events']) {
    if (!host.includes(`'${action}'`) && !host.includes(`'POST ${action}'`)) fail(`src/index.js never mentions the "${action}" action`)
  }
  if (!host.includes("const API_PREFIX = '/dsh-loop-guard/api/'")) {
    fail('src/index.js does not define the frozen API prefix')
  }

  // ---------------------------------------------------------------- no machine-specific paths
  // `_probe/env.mjs` is the one file allowed to know where this machine keeps things; it is
  // also the one file a reader is expected to edit. Anywhere else, an absolute path is a
  // reproducible-build bug: the file only works on the machine that wrote it.
  // Both separator forms, because Windows hands back backslashes while a path written by hand
  // is usually typed with forward slashes. Checking only the native form means the check passes
  // on exactly the spelling nobody uses.
  const needles = [homedir(), homedir().split(sep).join('/'), root, root.split(sep).join('/'), `app${'.asar'}`]
  const allowed = join(root, '_probe', 'env.mjs')
  for (const absolute of await sourceFiles(root)) {
    if (absolute === allowed) continue
    const text = await readFile(absolute, 'utf8')
    for (const needle of needles) {
      if (needle !== '' && text.includes(needle)) {
        const relative = absolute.slice(root.length + 1).split(sep).join('/')
        fail(`${relative} names ${needle} — machine-specific paths belong in _probe/env.mjs, not in a file a reader clones`)
      }
    }
  }

  // ---------------------------------------------------------------- report
  for (const message of notes) console.log(`note: ${message}`)
  if (failures.length > 0) {
    for (const message of failures) console.log(`FAIL: ${message}`)
    console.log(`\n${failures.length} check(s) failed`)
    process.exitCode = 1
    return
  }
  console.log('all checks passed')
}

await main()
