import assert from 'node:assert/strict'
import { mount } from './fixture.mjs'
let checks = 0
function check(ok, label) {assert.ok(ok, label); checks++}
const host = mount()
try {
  check(host.hooks.get('agent/assistant-stream').options.global === true, 'cross-plugin subscription is global')
  const stream = await host.request('GET', 'events')
  check(stream.res.headers['content-type'].startsWith('text/event-stream'), 'SSE content type')
  check(stream.res.text.includes('retry: 2000'), 'retry hint')
  let calls = 0, sent = 0, cause, options
  const agent = {session:{id:'test-stream'}, cancel(c, o) {calls++; cause=c; options=o}}
  const unit = 'Let me go. '
  for (let i=0; i<100 && calls===0; i++) {host.emit(agent, 'text-delta', unit); sent++}
  check(calls===1, 'cancel called once')
  check(sent>=5 && sent<=10, 'actual emitted copies before cancellation in 5..10')
  check(cause.kind==='hook' && options.keepInbox===true, 'keep pending work')
  check(stream.res.text.includes('event: alarm'), 'alarm pushes immediately')
  const hit = (await host.request('GET','state')).json.value.hits[0]
  check(hit.cancelled===true && hit.stream==='text', 'truthful hit record')
  host.emit(agent, 'text-delta', unit.repeat(100))
  check(calls===1, 'latch prevents repeat cancel')
  host.emit(agent, 'reasoning-delta', unit.repeat(100), 'second-attempt')
  check(calls===2, 'thinking also cancelled, new attempt rearms')
  const missing = {session:{id:'no-cancel'}}
  host.emit(missing, 'text-delta', unit.repeat(100))
  check((await host.request('GET','state')).json.value.hits[0].cancelled===false, 'missing cancel never reported as success')
  const bad = {session:{id:'throws'}, cancel() {throw new Error('cancel refused')}}
  host.emit(bad,'text-delta',unit.repeat(100))
  check((await host.request('GET','state')).json.value.hits[0].cancelled===false, 'cancel failure preserves alarm')
  await new Promise(resolve => setTimeout(resolve, 550))
  check(stream.res.text.includes('event: state'), 'throttled state push')
  const before = stream.res.text
  stream.req.emit('close')
  host.emit({session:{id:'after-close'},cancel(){}}, 'text-delta',unit.repeat(100))
  check(stream.res.text===before, 'closed subscriber removed')
  const stream2 = await host.request('GET','events'); stream2.res.emit('error',new Error('closed'))
  const before2=stream2.res.text
  host.emit({session:{id:'after-error'},cancel(){}},'text-delta',unit.repeat(100))
  check(stream2.res.text===before2, 'response error removes subscriber safely')
  console.log(`stream: ${checks}/${checks} checks passed; acceptance cancelled after ${sent} copies`)
} finally {host.cleanup()}
