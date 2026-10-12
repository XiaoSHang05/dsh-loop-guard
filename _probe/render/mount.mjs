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
  const switches=[...document.querySelectorAll('.lg-switch input')]
  check(switches.length===3,'panel offers master, interrupt and tone')
  check(switches.every(input=>input.checked===true),'all three default to on')
  await act(async()=>{switches[1].click();await wait(5)})
  check((await host.request('GET','state')).json.value.config.cancel===false,'interrupt switch reaches the host')
  await act(async()=>{switches[1].click();await wait(5)})
  await act(async()=>{switches[2].click();await wait(5)})
  check((await host.request('GET','state')).json.value.config.sound===false,'tone switch reaches the host')
  await act(async()=>{switches[2].click();await wait(5)})
  await act(async()=>{switches[0].click();await wait(5)})
  check((await host.request('GET','state')).json.value.config.enabled===false,'master switch updates actual host')
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
