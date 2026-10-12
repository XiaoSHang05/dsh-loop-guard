# dsh-loop-guard — frozen interface contract

Every half of this package is written against this file. If a change is needed here, it is
needed in all three places (host half, client half, harnesses), and this file is edited first.

## What the plugin is for

A model can enter a degenerate loop and emit the same text over and over until it hits the
token ceiling. The user's words for it: *"唱歌"* (singing). DSH exposes everything needed to
notice and stop it, and nothing that does:

- `agent/assistant-stream` fires once per chunk, carrying `text-delta` (what the user reads)
  and `reasoning-delta` (what the model thinks). Both are watched here.
- `agent.cancel(cause, { keepInbox: true })` aborts the in-flight turn and keeps queued work.

This package watches the stream, decides that the tail has stopped being new, raises an alarm
the user must dismiss, and cancels the turn.

## Package layout

| Path | Half | Owner |
| --- | --- | --- |
| `src/detect.js` | pure detection core, no I/O, no deps | Lead |
| `src/index.js` | host half: subscribes the stream, owns config + hits, serves HTTP | Teammate B |
| `src/client.js` | client half: monitor tab + alarm card | Teammate A |
| `src/client.css` | client styles, DSH theme variables only | Teammate A |
| `lib/client.js` | GENERATED from `src/client.js` + `src/client.css` | build script |
| `scripts/build-client.mjs`, `scripts/check.mjs`, `scripts/test.mjs` | scaffolding | Teammate C |
| `cordis.patch.yml` | bundle patch | Lead |
| `_probe/**` | harnesses | Teammate C + Lead |

## Detection core (`src/detect.js`) — exact export shape

```js
export const DEFAULTS = {
  minRepeat: 5,        // contiguous copies of one unit that count as a loop
  minUnit: 6,          // shortest unit worth calling a repetition (chars)
  maxUnit: 1024,       // longest unit searched (chars)
  windowChars: 8192,   // tail window the search runs over
  checkEvery: 32,      // run the search at most every N appended chars
  densityLines: 8,     // lines examined by the second detector
  densityRatio: 0.75,  // share of those lines that must be duplicates
}

export function createDetector(options)  // -> detector
```

`detector.push(stream, text)` where `stream` is `'thinking'` or `'text'`.
Returns `null`, or on the first hit of a loop:

```js
{
  stream: 'thinking' | 'text',
  kind: 'cycle' | 'density',
  unit: string,      // cycle: word-aligned; density: normalized line in original order; <= 120 chars
  repeats: number,   // how many contiguous copies were seen (cycle) / duplicate lines (density)
  at: number,        // Date.now() at detection
}
```

`unit` is display text, not a slice of the buffer. A cycle's period is only defined up to
rotation (`"me go. Let "` repeats exactly as well as `"Let me go. "`), and the buffer ends
wherever the last chunk ended — so the core rotates the unit to start at a word boundary and
prefers a capital. Show it as-is; do not re-slice it. Text with no word breaks (CJK, base64)
is returned unrotated.

Other methods:

- `detector.snapshot()` → `{ [stream]: { chars, repeats, unit, score } }` for the live view.
  `score` is normalized progress towards the winning detector's threshold (0..1).
- `detector.reset()` — clears buffers and the "already reported" latch. The latch means one
  loop produces **one** hit, not one hit per chunk.
- `detector.configure(patch)` — merges options; returns the effective options.

Rules the core guarantees (and the harness must prove):

1. A unit made only of whitespace never counts, and neither does a unit built from a single
   distinct character (`====`, `----`): a divider is not a loop.
2. A hit latches: pushing the same repeated text 100 more times yields no second hit until
   `reset()`.
3. `push()` returns a hit for the *tail* only — text repeated in the middle and then moved on
   from is not a loop.
4. Ordering: `text` and `thinking` are independent; a loop in one does not mask the other.
5. `snapshot()[stream].score` is clamped to `[0, 1]` and reaches exactly `1` at the hit. A loop
   that runs 400 copies does not report a score of 400.

## HTTP surface (host half)

Prefix `/dsh-loop-guard/api/`. Every response is JSON `{ ok: true, value }` or
`{ ok: false, error: { code, message } }` with a matching status.

| Route | Body | Value |
| --- | --- | --- |
| `GET health` | — | `{ backend: 'present'\|'absent', version: 1 }` |
| `GET state` | — | `{ version: 1, config, sessions, hits }` |
| `POST config` | `{ patch: {...} }` | `{ config }` |
| `POST monitor` | `{ sessionId, monitored: boolean }` | `{ sessionId, monitored }` |
| `POST hits` | `{ id, dismissed: true }` or `{ clearAll: true }` | `{ ok: true }` |
| `GET events` | — | `text/event-stream` |

Status codes: `400` bad body, `404` unknown action, `405` wrong method, `503` no backend.

### `config`

```js
{
  enabled: true,          // master switch; off = watch nothing, cancel nothing
  minRepeat: 5,
  minUnit: 6,
  maxUnit: 1024,
  windowChars: 8192,
  densityLines: 8,
  densityRatio: 0.75,
  cancel: true,           // false = alarm only, never interrupt
  alarm: true,            // false = no card
  sound: true,            // false = silent card
  scopeDefault: 'all',    // 'all' | 'selected'
}
```

### `sessions[]` — one row per session currently being watched

```js
{
  sessionId: string,
  label: string,          // session title if known, else the id
  monitored: boolean,     // false when muted by the user
  stream: 'thinking' | 'text' | null,   // which stream is closest to a loop
  chars: number,          // chars seen on the busiest stream
  repeats: number,        // current contiguous repeat count, 0 when healthy
  unit: string,           // the current repeated unit, '' when healthy
  score: number,          // detector progress 0..1; density and cycle thresholds differ
  lastHitAt: number | null,
}
```

### `hits[]` — newest first, capped at 50

```js
{
  id: string,             // unique, stable; the dismiss key
  sessionId: string,
  label: string,
  stream: 'thinking' | 'text',
  kind: 'cycle' | 'density',
  unit: string,
  repeats: number,
  at: number,             // Date.now()
  cancelled: boolean,     // the host really called agent.cancel
  dismissed: boolean,     // the user closed the card
}
```

### `GET events` — server-sent events

```
retry: 2000

event: alarm
data: {"id":"...","sessionId":"...","label":"...","stream":"text","kind":"cycle","unit":"...","repeats":5,"at":1750000000000,"cancelled":true}

event: state
data: {"sessions":[...]}

: ping
```

- `alarm` is sent the moment a hit is recorded.
- `state` is sent at most once per 500 ms, and only when `sessions` changed.
- The client re-reads `GET state` on every `alarm` and treats `state` frames as a refresh.
- Frames are notifications, never the data channel: a dropped frame costs freshness, not
  correctness.

## Client half

- Tab: `conversation.view`, id `loop-guard`, order `120`, label from the dictionary.
- Overlay: `shell.overlay`, id `loop-guard-alarm`, order `30`.
- Alarm card: **never auto-dismisses**. It has a dismiss button and a sound. A card that
  vanished on its own would be the one alarm the user was away for.
- The monitor tab draws: master switch, the two thresholds that matter (`minRepeat`,
  `densityRatio`), the live session table (score bar + current unit), and the hit history.
- Sound is synthesised with WebAudio (no asset file). It must never throw when audio is
  unavailable — a failed beep must not cost the card.

## Rules that apply to every half

- No hard-coded colours: CSS uses `--dsw-alias-*` variables only.
- No `alert(` / `confirm(` / `prompt(` anywhere (the repo check enforces it).
- `ctx.get(name)` is read lazily per call, never captured at apply time: the loader mounts
  entries concurrently, so a service read during `apply` may still be undefined.
- Every listener is registered inside `apply` and its cleanup returned.
- Anything the client shows must be reconstructible from `GET state` — the SSE stream is an
  accelerator, never the source of truth.
