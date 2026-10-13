import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import { mount } from '../host/fixture.mjs'
import { load } from '../client/load.mjs'
const dom = new JSDOM('<!doctype html><html><head></head><body><main></main></body></html>',{url:'http://localhost/',pretendToBeVisual:true})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true})
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true})
const require=createRequire(import.meta.url), React=require('react'), {createRoot}=require('react-dom/client'), {act}=React
const api=load(React), host=mount(), root=createRoot(document.querySelector('main'))
let n=0, sounds=0, rejectDismiss=false
function check(ok,label){assert.ok(ok,label);n++}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
window.AudioContext=class {
  currentTime=0;destination={};constructor(){sounds++}
  resume(){return Promise.resolve()} close(){return Promise.resolve()}
  createOscillator(){return {frequency:{},connect(){},start(){},stop(){}}}
  createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}}}
}
const streams=[]
window.EventSource=class {
  listeners={};constructor(){streams.push(this)}
  addEventListener(name,fn){this.listeners[name]=fn}
  close(){this.closed=true}
}
globalThis.EventSource=window.EventSource
globalThis.fetch=async (url,init={})=>{
  const action=String(url).split('/').pop()
  if(action==='hits'&&rejectDismiss) return {ok:false,status:500,json:async()=>({ok:false,error:{message:'test refusal'}})}
  const answer=await host.request(init.method||'GET',action,init.body?JSON.parse(init.body):undefined)
  return {ok:answer.res.status===200,status:answer.res.status,json:async()=>answer.json}
}
const store=api.createStore({}), cleanups=[]
try {
  await act(async()=>{store.start();store.start();await wait(5)})
  check(streams.length===1,'store start idempotent')
  await act(async()=>{root.render(React.createElement(React.Fragment,null,React.createElement(api.AlarmCard,{store}),React.createElement(api.LoopGuardView,{store})))})
  check(document.querySelector('.lg-root'),'real monitor mounts')
  check(!document.querySelector('.lg-alarm'),'no empty alarm')
  host.emit({session:{id:'dom-session'},cancel(){}},'reasoning-delta','Let me go. '.repeat(8))
  await act(async()=>{streams[0].listeners.alarm();await wait(5)})
  check(document.querySelector('.lg-alarm'),'host hit travels through fetch/store to real DOM')
  check(document.querySelector('.lg-alarm').textContent.includes('Let me go.'),'readable period')
  check(sounds===1,'audio requested once per hit')
  await act(async()=>{await store.sync()})
  check(sounds===1,'poll refresh never repeats sound')
  await act(async()=>{await wait(300)})
  check(document.querySelector('.lg-alarm'),'alarm persists without user dismissal')
  rejectDismiss=true
  await act(async()=>{document.querySelector('.lg-alarm-actions button').click();await wait(5)})
  check(document.querySelector('.lg-alarm'),'failed POST preserves alarm')
  check(document.querySelector('.lg-alarm').textContent.includes('test refusal'),'failure visible')
  rejectDismiss=false
  await act(async()=>{document.querySelector('.lg-alarm-actions button').click();await wait(5)})
  check(!document.querySelector('.lg-alarm'),'successful real host dismiss removes alarm')
  check(document.querySelector('.lg-history'),'history remains available')
  // A dot is 6px wide. The state word used to be rendered inside it, so the two
  // drew on top of each other; the assertion is that no text lives in a dot.
  const dot=document.querySelector('.lg-dot')
  check(dot!==null,'the live dot is rendered')
  check(dot.textContent==='','the dot holds no text of its own')
  check(document.querySelector('.lg-state').textContent.trim()==='实时','the state word is readable beside the dot')
  const clearButton=[...document.querySelectorAll('button')].find(b=>b.textContent==='清除历史')
  check(clearButton!==undefined,'history offers a clear control')
  check(document.querySelectorAll('.lg-hit').length>0,'there is a hit to clear')
  await act(async()=>{clearButton.click();await wait(5)})
  check(document.querySelectorAll('.lg-hit').length===0,'clear empties the recorded history')
  check(document.querySelector('.lg-empty'),'the emptied list says so instead of rendering nothing')
  check([...document.querySelectorAll('button')].find(b=>b.textContent==='清除历史')===undefined,
    'the clear control hides once there is nothing to clear')
  const switches=[...document.querySelectorAll('.lg-switch input')]
  check(switches.length===4,'panel offers master, interrupt, tone and the user\'s own phrases')
  check(switches.every(input=>input.checked===true)===false,'the phrase switch is the one that defaults to off')
  check(switches.slice(0,3).every(input=>input.checked===true),'the three guard switches default to on')
  check(switches[3].checked===false,'the phrase rule is off until the user turns it on')
  check(!document.querySelector('.lg-phrases-input'),'no phrase box while the rule is off')
  await act(async()=>{switches[1].click();await wait(5)})
  check((await host.request('GET','state')).json.value.config.cancel===false,'interrupt switch reaches the host')
  await act(async()=>{switches[1].click();await wait(5)})
  await act(async()=>{switches[2].click();await wait(5)})
  check((await host.request('GET','state')).json.value.config.sound===false,'tone switch reaches the host')
  await act(async()=>{switches[2].click();await wait(5)})
  await act(async()=>{switches[0].click();await wait(5)})
  check((await host.request('GET','state')).json.value.config.enabled===false,'master switch updates actual host')
  await act(async()=>{switches[0].click();await wait(5)})

  // The user's own phrases, driven through the real DOM: the switch reveals the box, the
  // box's contents reach the host, and the host's echo comes back into the field.
  await act(async()=>{switches[3].click();await wait(5)})
  const box=document.querySelector('.lg-phrases-input')
  check(box!==null,'turning the rule on reveals the phrase box')
  check((await host.request('GET','state')).json.value.config.customPhrases.length===0,
    'switching on with an empty box saves an empty list, not a placeholder')
  // Typing and committing are two separate events in a browser, and the box commits on blur
  // from React state — so the harness must let the input land before blurring. Firing both in
  // one act() would commit the previous render's text, which is a harness bug, not a UI bug.
  //
  // `focusout`, not `blur`: React 17 and later delegate from the root container, and the event
  // it listens for to emulate onBlur is the bubbling `focusout`. A non-bubbling `blur` reaches
  // no listener at the root, so the commit never runs and the harness would report a UI bug
  // that exists only in the harness.
  const typeInto=async(value)=>{
    const box=document.querySelector('.lg-phrases-input')
    await act(async()=>{
      const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set
      setter.call(box,value)
      box.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
      await wait(5)
    })
    await act(async()=>{
      box.dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true}))
      await wait(15)
    })
  }
  await typeInto('Let me go.\n  \n我该继续了。')
  const saved=(await host.request('GET','state')).json.value.config.customPhrases
  check(saved.length===2,'a blank line is dropped and the two real phrases are saved')
  check(saved[0]==='Let me go.'&&saved[1]==='我该继续了。','phrases are saved verbatim, in the order typed')

  // And it actually catches one. The fixture is deliberately *not* a verbatim copy: each line
  // carries its own tail, so the text never becomes periodic and the cycle rule has nothing to
  // find. A plain `'Let me go. '.repeat(12)` would be caught by the cycle rule first — which is
  // correct behaviour, and also means it cannot test this rule.
  host.emit({session:{id:'dom-session'},cancel(){}},'text-delta',
    Array.from({length:8},(_,i)=>`Let me go. step ${i+1}`).join('\n')+'\n')
  await act(async()=>{streams[0].listeners.alarm();await wait(5)})
  const card=document.querySelector('.lg-alarm')
  check(card!==null,'a configured phrase raises the alarm card')
  check(card.textContent.includes('自定义短语'),'the card names the rule that fired, not a generic one')

  await typeInto('')
  check((await host.request('GET','state')).json.value.config.customPhrases.length===0,'clearing the box clears the rule')
  await act(async()=>{root.unmount()})
  store.dispose()
  check(streams[0].closed===true,'dispose closes stream')
  const before=streams.length
  api.apply({
    effect(fn){const cleanup=fn();if(typeof cleanup==='function')cleanups.push(cleanup)},
    locale:{register(){return ()=>{}},bind(){return key=>key}},
    slots:{inject(name,fn){return fn()},register(){return ()=>{}}}
  })
  check(streams.length===before+1,'global alarm store starts without opening monitor tab')
  for(const fn of cleanups)fn()
  check(streams.at(-1).closed===true,'plugin cleanup owns shared store')
  console.log(`mount: ${n}/${n} checks passed`)
} finally {store.dispose();host.cleanup();dom.window.close()}
