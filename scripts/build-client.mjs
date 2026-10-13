/**
 * dsh-loop-guard — build step.
 *
 * There is no bundler in this repository's toolchain (no esbuild / rolldown /
 * tsdown), so this script does the one thing the web shell actually requires:
 * wrap the hand-written client source and the stylesheet into the frozen
 * `window.__ModuleLoader__` CJS artifact that `dsh.client` serves.
 *
 * The output is deliberately unminified. The client half is written as plain
 * ES2022 with `React.createElement` instead of JSX, and the reason is this
 * script: what ships is readable, diffable and auditable by whoever installs
 * the plugin — the same argument as the detection core being dependency-free.
 *
 * Usage:
 *   node scripts/build-client.mjs           # write lib/client.js
 *   node scripts/build-client.mjs --check   # verify lib/client.js is current
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Plugin id — must match `name` in package.json; it keys the ModuleLoader. */
const PLUGIN_ID = 'dsh-loop-guard'

const SOURCE = join(root, 'src', 'client.js')
const STYLE = join(root, 'src', 'client.css')
const OUTPUT = join(root, 'lib', 'client.js')

/**
 * React is the only runtime import: the shell hands the view a React instance
 * and the view renders through `React.createElement`, so no JSX runtime, no
 * `react-dom`, and nothing else needs to resolve.
 */
const HEADER = `/*
 * ${PLUGIN_ID} — client bundle. GENERATED FILE, do not edit.
 * Source: src/client.js + src/client.css — rebuild with \`node scripts/build-client.mjs\`.
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
`

/**
 * The artifact mirrors what `createLoopGuardClient` returns, rather than
 * narrowing it to the two symbols the shell calls.
 *
 * `apply` and `inject` are the shell's contract. The rest are here because this
 * package has a seam that nothing else can reach: `project` is the wire
 * decoder, and `_probe/contract/wire.mjs` proves the host half and the client
 * half agree about the shape of `GET state` by feeding the host's own output to
 * this very function. A decoder nobody outside the bundle can call is a seam
 * that cannot be tested — and the bug that motivates the harness (two green
 * halves that disagree about a value) is exactly the kind that hides there.
 *
 * Extra keys are inert to the module loader.
 */
const FOOTER = `    var api = createLoopGuardClient(React, __css, require);
    exports.apply = api.apply;
    exports.inject = api.inject;
    exports.project = api.project;
    exports.alarmOf = api.alarmOf;
    exports.createStore = api.createStore;
    exports.LoopGuardView = api.LoopGuardView;
    exports.AlarmCard = api.AlarmCard;
    return module.exports;
  }
});
`

/**
 * Render the artifact. The CSS is embedded as a JSON string literal so a
 * stylesheet containing quotes, backslashes or newlines cannot break out of
 * the generated source.
 *
 * Both halves are normalized to LF before embedding. This is not cosmetic: the
 * artifact is a *generated* file, and `scripts/check.mjs` asserts that it
 * contains `src/client.js` verbatim. On Windows with git's default
 * `core.autocrlf=true`, the checked-out source arrives with CRLF while the
 * generated head is written with LF, so the embed stopped matching and a fresh
 * clone failed `npm run check` with `lib/client.js is stale` — before anyone
 * had edited anything. `.gitattributes` pins the repository to LF; this keeps
 * the build correct even in a checkout that predates that file or ignores it.
 */
async function render() {
  const [source, css] = await Promise.all([readFile(SOURCE, 'utf8'), readFile(STYLE, 'utf8')])
  return [
    HEADER,
    `    var __css = ${JSON.stringify(css.replaceAll('\r\n', '\n'))};\n`,
    '\n/* ---------------------------------------------------------------- source */\n\n',
    source.replaceAll('\r\n', '\n'),
    '\n\n/* ------------------------------------------------------------------ boot */\n',
    FOOTER,
  ].join('')
}

async function main() {
  const check = process.argv.includes('--check')
  const artifact = await render()

  if (check) {
    let current = ''
    try {
      current = await readFile(OUTPUT, 'utf8')
    } catch {
      console.error('lib/client.js is missing — run: node scripts/build-client.mjs')
      process.exitCode = 1
      return
    }
    if (current !== artifact) {
      console.error('lib/client.js is stale — run: node scripts/build-client.mjs')
      process.exitCode = 1
      return
    }
    console.log('lib/client.js is up to date')
    return
  }

  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, artifact, 'utf8')
  console.log(`wrote lib/client.js (${Buffer.byteLength(artifact, 'utf8')} bytes)`)
}

await main()
