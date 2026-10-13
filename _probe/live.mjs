import { BASE, authCookie } from './env.mjs'

// What the running host actually serves, read from the host rather than
// inferred from a probe URL.
//
// This file previously navigated to `BASE + '/api'` and concluded the shell had
// moved under `/api`. `BASE` already ends in `/`, so those probes were really
// asking for `//api/...` — a different path that the server happens to answer.
// Every conclusion drawn from that build was about the mistake, not the host.
// The join below is the whole fix: `new URL(relative, BASE)` never doubles a
// slash, so a probe can only report what is on the wire.
const at = (path) => new URL(path.replace(/^\//u, ''), BASE).href

const shell = await fetch(at('/'), { headers: { cookie: authCookie() } })
const html = await shell.text()
const match = html.match(/__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/u)
if (!match) throw new Error('no boot payload in the shell HTML')
const boot = JSON.parse(match[1])

const baseTag = (html.match(/<base[^>]*>/u) ?? ['(none)'])[0]
console.log('shell', shell.status, 'base tag', baseTag, 'rev', boot.rev, 'entries', boot.entries.length)

const guard = boot.entries.find((entry) => entry.id === 'dsh-loop-guard')
console.log('loop-guard entry:', guard ? JSON.stringify(guard) : 'ABSENT')

// The boot entry url is relative and the shell declares `<base href="./">`, so
// it resolves against the shell's own directory. Resolve it the same way the
// browser does instead of prefixing a guess.
if (guard !== undefined) {
  const bundle = await fetch(new URL(guard.url, new URL('./', at('/'))).href, {
    headers: { cookie: authCookie() },
  })
  const text = await bundle.text()
  console.log(
    'bundle',
    bundle.status,
    bundle.headers.get('content-type'),
    text.length,
    'bytes',
  )
}

// The host half, on the one prefix this plugin registers.
for (const path of ['/dsh-loop-guard/api/health', '/dsh-loop-guard/api/state']) {
  const res = await fetch(at(path), { headers: { cookie: authCookie() } })
  const text = await res.text()
  console.log(path, '->', res.status, text.slice(0, 80))
}
