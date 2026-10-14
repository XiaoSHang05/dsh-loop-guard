// Deliberately restore eight known bugs, then prove the harnesses reject them.
// Always restore original bytes. Run only when nobody else is editing these files.
//
// The fourth mutation is the one that matters for the counting rule: dropping the share axis
// leaves a rule that fires on any twelve same-shaped lines, which is exactly the file-listing
// false positive that axis exists to prevent. If the negative cases in `_probe/detect.mjs` do
// not reject it, they are decoration.
//
// The fifth drops the density test from the custom-phrase rule, leaving "count the occurrences".
// That version fires on any phrase a user lists and then uses normally — the prose case in the
// same harness — so it is the mutation that proves the rule is about looping rather than about
// the phrase merely appearing.
//
// The sixth is the bug that was actually written first: deriving the phrase box's visibility
// from the saved list instead of from the switch. At the moment a user turns the rule on the
// list is still empty, so the switch saves an empty list, the host echoes it back, and no box
// ever appears — the feature looks broken and nothing in the code looks wrong.
//
// The seventh and eighth are the two that were just reported from the running screen: the dot
// carrying its own label (6px wide, so the word spilled straight over the circle) and the clear
// control wired to the per-hit dismissal. The last one matters most — `dismiss` treats a body
// without `id` as an error, so a clear button that forgot `clearAll` would look right, click
// fine, and clear nothing.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const root=new URL('../',import.meta.url)
const mutations=[
  ['src/index.js',"if (config.cancel && typeof agent?.cancel === 'function') {",'if (false) {','_probe/host/stream.mjs'],
  ['src/detect.js',"return line.trim().replace(/\\s+/gu, ' ')","return line.trim().replace(/\\s+/gu, ' ').replace(/\\d+/gu, '#')",'_probe/detect.mjs'],
  ['src/client.js','if (started) return','if (false) return','_probe/render/mount.mjs'],
  ['src/detect.js','qualifies: found.lines >= config.structLines && found.share >= config.structShare,','qualifies: found.lines >= config.structLines,','_probe/detect.mjs'],
  ['src/detect.js','if ((phrase.length * need) / span < CUSTOM_DENSITY) continue','if (false) continue','_probe/detect.mjs'],
  ['src/client.js','      wanted\n        ? h(','      phrases.length > 0\n        ? h(','_probe/render/mount.mjs'],
  ['src/client.js',"h('span', { key: 'dot', className: 'rg-dot rg-dot--live', 'aria-hidden': 'true' }),", "h('span', { key: 'dot', className: 'rg-dot rg-dot--live', 'aria-hidden': 'true' }, t('label.live')),",'_probe/render/mount.mjs'],
  ['src/client.js',"run('hits', { clearAll: true })","run('hits', { dismissed: true })",'_probe/render/mount.mjs'],
]
for(const [file,from,to,test] of mutations){
  const path=new URL(file,root), before=await readFile(path)
  // Match against LF-normalised text: these files are CRLF on Windows and LF elsewhere, and a
  // pattern with a hard-coded "\r\n" would silently stop matching on a clone — the mutation
  // would then never be applied, the harness would pass, and the run would report success.
  const text=before.toString('utf8').replaceAll('\r\n','\n')
  assert.equal(text.split(from).length,2,'mutation matches once: '+file)
  try {
    await writeFile(path,text.replace(from,to))
    if(file.includes('client')) assert.equal(spawnSync(process.execPath,['scripts/build-client.mjs'],{cwd:root,stdio:'ignore'}).status,0)
    const run=spawnSync(process.execPath,[test],{cwd:root,stdio:'ignore',timeout:15000})
    assert.ok(run.status!==null && run.status!==0,'harness must reject mutation: '+test)
    console.log('mutation rejected: '+file+' by '+test)
  } finally {
    await writeFile(path,before)
    if(file.includes('client')) assert.equal(spawnSync(process.execPath,['scripts/build-client.mjs'],{cwd:root,stdio:'ignore'}).status,0)
  }
}
console.log('mutation: 8/8 checks passed; original files restored')
