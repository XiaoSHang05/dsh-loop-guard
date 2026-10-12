import { readFileSync } from 'node:fs'
export function load(React) {
  let spec
  const window = globalThis.window || {}
  window.__ModuleLoader__ = {load(value) {spec=value}}
  new Function('window',readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'))(window)
  return spec.factory(name => {if(name==='react') return React; throw new Error('optional module absent: '+name)})
}
export const staticReact = {
  createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState:value=>[value,()=>{}], useRef:value=>({current:value}), useEffect:()=>{},
  useMemo:fn=>fn(), useCallback:fn=>fn, useSyncExternalStore:(s,g)=>g(), Fragment:'fragment'
}
