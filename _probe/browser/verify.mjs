// Read-only verification on the real GUI. No prompts, new sessions, room writes or LLM cost.
import assert from 'node:assert/strict'
export async function run({page,BASE,shot}) {
  await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:60000})
  await page.waitForFunction(()=>document.querySelector('.hIlkoa_sessionRow'),{timeout:30000})
  await page.evaluate(()=>document.querySelector('.hIlkoa_sessionRow').click())
  await page.waitForFunction(()=>[...document.querySelectorAll('.Dc7zOa_tab')].some(node=>node.textContent.trim()==='监控'),{timeout:30000})
  await page.evaluate(()=>[...document.querySelectorAll('.Dc7zOa_tab')].find(node=>node.textContent.trim()==='监控').click())
  await page.waitForSelector('.lg-root',{timeout:15000})
  await page.waitForFunction(()=>document.querySelector('.lg-root').textContent.includes('启用监控'),{timeout:15000})
  const out=await page.evaluate(async()=>{
    const response=await fetch('/dsh-loop-guard/api/state');const json=await response.json()
    return {status:response.status,backend:json.ok,config:json.value?.config,
      tabs:[...document.querySelectorAll('.Dc7zOa_tab')].map(node=>node.textContent.trim()),
      monitor:document.querySelector('.lg-root').innerText,
      events:performance.getEntriesByType('resource').filter(row=>row.name.includes('dsh-loop-guard')).map(row=>row.name.replace(location.origin,''))}
  })
  assert.equal(out.status,200);assert.equal(out.backend,true);assert.ok(out.monitor.includes('重复次数'))
  const box=await page.$eval('.lg-root',node=>{const r=node.getBoundingClientRect();return {width:r.width,height:r.height}})
  assert.ok(box.width>100&&box.height>100,'visible monitor area')
  await shot('loop-guard-monitor')
  return {...out,box}
}
