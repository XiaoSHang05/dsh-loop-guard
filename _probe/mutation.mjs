// Deliberately restore four known bugs, then prove the harnesses reject them.
// Always restore original bytes. Run only when nobody else is editing these files.
//
// The fourth mutation is the one that matters for the counting rule: dropping the share axis
// leaves a rule that fires on any twelve same-shaped lines, which is exactly the file-listing
// false positive that axis exists to prevent. If the negative cases in `_probe/detect.mjs` do
// not reject it, they are decoration.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const root=new URL('../',import.meta.url)
const mutations=[
  ['src/index.js',"if (config.cancel && typeof agent?.cancel === 'function') {",'if (false) {','_probe/host/stream.mjs'],
  ['src/detect.js',"return line.trim().replace(/\\s+/gu, ' ')","return line.trim().replace(/\\s+/gu, ' ').replace(/\\d+/gu, '#')",'_probe/detect.mjs'],
  ['src/client.js','if (started) return','if (false) return','_probe/render/mount.mjs'],
  ['src/detect.js','qualifies: found.lines >= config.structLines && found.share >= config.structShare,','qualifies: found.lines >= config.structLines,','_probe/detect.mjs'],
]
for(const [file,from,to,test] of mutations){
  const path=new URL(file,root), before=await readFile(path)
  const text=before.toString('utf8');assert.equal(text.split(from).length,2,'mutation matches once: '+file)
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
console.log('mutation: 4/4 checks passed; original files restored')
