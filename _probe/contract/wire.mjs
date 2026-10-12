import assert from 'node:assert/strict'
import { mount } from '../host/fixture.mjs'
import { load, staticReact } from '../client/load.mjs'
const host = mount(), api = load(staticReact)
let n=0
function check(ok,label) {assert.ok(ok,label);n++}
try {
  host.emit({session:{id:'contract-session'},cancel(){}},'reasoning-delta','Let me go. '.repeat(8))
  const wire=(await host.request('GET','state')).json.value
  const view=api.project(wire)
  check(view.hits.length===1,'real host output accepted by real client decoder')
  check(view.hits[0].stream==='thinking','thinking spelling shared')
  check(view.hits[0].unit===wire.hits[0].unit.trim(),'display unit preserves words, trims boundary whitespace')
  check(view.hits[0].cancelled===true,'actual cancel result shared')
  check(view.sessions[0].sessionId==='contract-session','session identity not attempt')
  check(view.sessions[0].score===1,'normalized score shared')
  check(api.alarmOf(view).id===wire.hits[0].id,'alarm selected from host hit')
  await host.request('POST','hits',{id:wire.hits[0].id,dismissed:true})
  check(api.alarmOf(api.project((await host.request('GET','state')).json.value))===null,'real dismiss answer removes alarm')
  check(api.project({...wire,sessions:[{...wire.sessions[0],score:400}]}).sessions[0].score===1,'defensive score clamp')
  console.log(`wire: ${n}/${n} checks passed`)
} finally {host.cleanup()}
