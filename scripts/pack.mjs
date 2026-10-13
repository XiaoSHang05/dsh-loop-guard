// A standalone folder, not a copy of the working directory or its linked dependencies.
import { readFile, writeFile, mkdir, lstat, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const out=resolve(process.argv[2]||join(root,'..','交付',pkg.name+'-'+pkg.version))
try {await lstat(out);throw new Error('destination already exists: '+out)} catch(error) {if(error.code!=='ENOENT')throw error}
const files=[
  'package.json','package-lock.json','cordis.patch.yml','.gitattributes',
  'README.md','LICENSE','CONTRACT.md','VALIDATION.md','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md',
  'src/index.js','src/detect.js','src/client.js','src/client.css','lib/client.js',
  'scripts/build-client.mjs','scripts/check.mjs','scripts/test.mjs','scripts/pack.mjs',
  '_probe/detect.mjs','_probe/mutation.mjs','_probe/env.mjs','_probe/history-scan.mjs',
  '_probe/struct-real-fp.mjs','_probe/live.mjs',
  '_probe/host/fixture.mjs','_probe/host/routes.mjs','_probe/host/stream.mjs','_probe/host/repl.mjs',
  '_probe/client/load.mjs','_probe/client/alarm.mjs','_probe/client/stream.mjs',
  '_probe/contract/wire.mjs','_probe/render/mount.mjs','_probe/render/package.json',
  '.github/workflows/ci.yml',
]
for(const file of files) {
  const info=await lstat(join(root,file))
  if(!info.isFile()||info.isSymbolicLink())throw new Error('not a regular source file: '+file)
}
await mkdir(out,{recursive:true})
const entries=[]
for(const file of files) {
  const target=join(out,file)
  await mkdir(dirname(target),{recursive:true});await copyFile(join(root,file),target)
  const source=await readFile(join(root,file)),copy=await readFile(target)
  if(!source.equals(copy))throw new Error('copy mismatch: '+file)
  entries.push({path:file,bytes:copy.length,sha256:createHash('sha256').update(copy).digest('hex')})
}
let sourceCommit=null
try {sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,stdio:['ignore','pipe','ignore'],encoding:'utf8'}).trim()}catch{}
await writeFile(join(out,'DELIVERABLE.json'),JSON.stringify({name:pkg.name,version:pkg.version,sourceCommit,createdAt:new Date().toISOString(),files:entries},null,2)+'\n')
console.log(JSON.stringify({folder:out,files:entries.length+1,bytes:entries.reduce((sum,file)=>sum+file.bytes,0),sourceCommit},null,2))
