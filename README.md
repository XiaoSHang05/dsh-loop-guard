# dsh-loop-guard

A watchdog for the DeepSeek Harness that notices when a model starts repeating itself and
stops the turn.

The failure it exists for: a model enters a degenerate loop and emits the same text over and
over — the same sentence, the same paragraph, the same list — until it hits the token ceiling.
The user's word for it is *"唱歌"* (singing). It costs a full turn's worth of time and tokens,
and nothing in DSH notices.

```
thinking ─┐                                    ┌─ alarm card (manual dismiss + tone)
          ├─ detector ─── loop found ──────────┤
text    ──┘                                    └─ agent.cancel(turn)
```

## Why this is possible at all

DSH already exposes both halves of the problem, and nothing that solves it:

| Need | What DSH provides |
| --- | --- |
| See output as it is produced | `agent/assistant-stream`, one event per chunk, carrying `text-delta` and `reasoning-delta` |
| Stop the turn | `agent.cancel(cause, { keepInbox: true })` |
| Tell the user | the `shell.overlay` client slot |

The loop detector itself is not there. `@deepseek-ai/dsh-llm` has no repetition check, no
frequency or presence penalty, and no n-gram guard — that gap is what this package fills.

## Install

```sh
dsh plugin --profile desktop add link:<path to this checkout>
```

Then **restart DSH**. The host half is read once at process start; a plugin's JavaScript is not
hot-reloaded.

The plugin has no dependencies. It does not require the room plugin, does not require the
function dock, and does not require any other plugin to be present.

## What it watches

Two streams, independently:

- **`text-delta`** — what the user reads. This is where the "singing" lands.
- **`reasoning-delta`** — what the model thinks. Loops happen here too, and they are invisible
  until the turn finally ends.

Each `(session, stream)` pair gets its own buffer. A loop in the thinking stream does not mask
one in the text stream, and a session that is fine is not made to look guilty by another
session that is not.

## The two detectors

**Cycle.** The tail of the buffer is checked for a unit repeated contiguously. The search walks
candidate periods from `minUnit` to `maxUnit` and asks whether the last `minRepeat` copies are
identical. This is the one that catches `Let me go. Let me go. Let me go. …`

Two details that matter more than they look:

- The period is only defined up to rotation. `"me go. Let "` repeats exactly as well as
  `"Let me go. "`, and the buffer ends wherever the last chunk happened to end. The reported
  unit is rotated to start at a word boundary and prefers a capital, so the card shows
  `Let me go.` and not `go. Let me `.
- A unit of whitespace never counts, and neither does a unit built from a single distinct
  character. `====` and `----` are dividers, not loops, and a guard that fires on a markdown
  rule is a guard the user turns off.

**Density.** The recent lines are compared pairwise by character-bigram Jaccard similarity. If
enough of them are near-duplicates, that is a loop even when no single unit repeats verbatim.
This is the one that catches `Step 3: processing item 7`, `Step 3: processing item 8`, … — a
shape the cycle detector cannot see, because no two copies are identical.

**Latching.** One loop produces **one** hit, not one hit per chunk. Without the latch a single
runaway turn would emit hundreds of alarms and bury the one the user needs to read.

## What happens on a hit

1. A hit is recorded: session, stream, kind, the repeated unit, the repeat count, the time.
2. The turn is cancelled — `agent.cancel({ kind: 'hook', reason: 'loop-guard: repeated output' },
   { keepInbox: true })`. `keepInbox` is deliberate: it aborts the runaway turn and leaves
   queued work queued. The stop button in the GUI does exactly the same thing.
3. An `alarm` frame goes out over the change stream, and the card appears.

The card **never dismisses itself.** It has a dismiss button and a three-blip tone. A card that
vanished on its own would be the one alarm the user was away for.

## The monitor tab

A 监控 tab next to 对话 / 轨迹 / 编队 / 群聊:

- the master switch;
- the two thresholds that actually change behaviour (`minRepeat`, `densityRatio`);
- the live session table — score bar, current repeated unit, chars seen;
- the hit history, newest first.

Everything the tab draws is reconstructible from `GET state`. The change stream decides *when*
to re-read that document, never *what* it says — so a dropped frame costs freshness and never
correctness, and a client that receives no frame at all still converges by polling.

## Configuration

One set of thresholds for the whole host. Written in `cordis.patch.yml`, exposed through the
plugin's `Config` (so it appears in the settings panel), and adjustable live from the monitor
tab.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Off watches nothing and cancels nothing. |
| `watchText` | `true` | Watch `text-delta`. |
| `watchReasoning` | `true` | Watch `reasoning-delta`. |
| `minRepeat` | `5` | Contiguous copies that count as a loop. |
| `minUnit` | `6` | Shortest unit worth calling a repetition (chars). |
| `maxUnit` | `1024` | Longest unit searched (chars). |
| `windowChars` | `8192` | Tail window the search runs over. |
| `checkEvery` | `32` | Run the search at most every N appended chars. |
| `densityLines` | `8` | Lines examined by the density detector. |
| `densityRatio` | `0.75` | Share of those lines that must be near-duplicates. |
| `cancel` | `true` | `false` makes this an alarm-only build without editing code. |
| `alarm` | `true` | `false` raises no card. |
| `sound` | `true` | Play the tone with the card. |
| `scopeDefault` | `'all'` | Watch everything by default; the mute list is the only thing that narrows it. |
| `excludedSessions` | `[]` | Sessions never watched. |

## Layout

| Path | What it is |
| --- | --- |
| `src/detect.js` | the detection core — pure, no I/O, no dependencies, unit-tested on its own |
| `src/index.js` | the host half: stream subscription, config, hits, cancel, HTTP + SSE |
| `src/client.js` | the client half: the monitor tab and the alarm card |
| `src/client.css` | client styles, DSH theme variables only |
| `lib/client.js` | GENERATED from the two files above by `scripts/build-client.mjs` |
| `cordis.patch.yml` | the bundle patch that inserts the plugin row |
| `CONTRACT.md` | the frozen interface both halves are written against |

The client half is not an ES module and is not JSX. `React`, the stylesheet text and the
ModuleLoader `require` arrive as parameters, so the build script is a pure concatenation and
the shipped artifact stays readable and diffable. There is no bundler in the toolchain, by
design: what gets installed is what you can read.

## Tests

```sh
node scripts/test.mjs
```

Four harnesses, each covering one layer:

| Harness | Layer |
| --- | --- |
| `_probe/detect.mjs` | the detection core: what must fire, and what must stay quiet |
| `_probe/host/routes.mjs` | the HTTP surface, driven through the real route table |
| `_probe/host/stream.mjs` | the stream subscription: frames in, hits out, `cancel` really called |
| `_probe/render/mount.mjs` | the client half mounted in jsdom |
| `_probe/contract/wire.mjs` | the seam: the host's own output fed to the client's own decoder |

Each one is written to fail when the behaviour it describes is broken. Where a check was added
for a bug, the bug was put back to prove the check catches it — a harness that cannot go red is
decoration.

## Known limits

- **This stops the bleeding, not the wound.** Text already streamed to the screen cannot be
  recalled. The guard cancels the turn within a few repeats; it does not prevent the repeats.
- **It will sometimes be wrong.** Normal answers repeat things: a list of similar items, a
  markdown table, code quoted back from a file. The defaults are deliberately conservative —
  five contiguous copies of a six-character unit, or three-quarters of the last eight lines —
  and they are adjustable rather than fixed. A guard that cries wolf is a guard that gets
  switched off.
- **Granularity is the turn.** There is no step-only abort in DSH; cancelling aborts the whole
  turn. `keepInbox: true` preserves queued input, but the turn is gone.
- **Only what happens after the subscription.** A loop already in flight when the plugin loads
  is not retroactively detected.
- **Hit history is in memory.** It does not survive a host restart, and it is capped at 50.

## License

MIT — see [LICENSE](LICENSE).
