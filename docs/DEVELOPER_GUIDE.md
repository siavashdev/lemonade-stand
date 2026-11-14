# Logs

Lemonade Stand has two log viewers, both under the hamburger button (☰) next to
the app name in the top bar. Each has a search box, a level filter, **Follow**
(keeps the newest line in view; scrolling up pauses it), **Copy** (copies the
lines currently shown) and **Clear** (empties the view, not the log itself).

## Lemonade Server logs

The live log of the Lemonade server the app is connected to: its retained
backlog first, then each new line as it is written.

- The main process opens the server's log WebSocket
  (`ws://<host>:<port>/logs/stream`) and relays it to the window
  ([`src/main/lemonade/logs.ts`](../src/main/lemonade/logs.ts)). The renderer's
  Content-Security-Policy only allows its own origin, so it can't connect itself.
- The address is derived from the connection's base URL: the `/api/v1` suffix is
  dropped and any reverse-proxy prefix is kept. The API key, if set, is sent as
  `?api_key=`.
- The stream is open only while the viewer is open. If the server goes away it
  reconnects with a growing delay (1 s up to 10 s) and asks for the full backlog
  again each time, because the server restarts its sequence numbers when it
  restarts. Changing the server in **Connection** moves the stream to the new one.

## Lemonade Stand logs

The app's own output: everything the main process writes with `console.log`,
`console.info`, `console.warn`, `console.error` and `console.debug`, plus the
window's own console (tagged `ui`). A leading `[tag]` in a message becomes its
tag column. The newest 5000 lines are kept in memory
([`src/main/logger.ts`](../src/main/logger.ts)); nothing is written to disk
unless you turn on the log file below.

## Log file (optional)

Writing a log file as well, for attaching to a bug report, is opt-in.
You change log level by either an environment variable like LOG_LEVEL=debug or
create a settings.json file within below folder if not exists:
C:\Users\<username>\AppData\Roaming\lemonade-stand\config\

Set the log level to debug like below:
```json
{ "logLevel": "debug" }
```

The log file will be placed in below folder:
C:\Users\<username>\AppData\Roaming\lemonade-stand\logs\

When it is on, the **Lemonade Stand logs** viewer shows the file's path with a
**Show file** button, and the file starts with everything logged before it was
opened.

# Recipes

Recipes (SKILL.md-style skills) are saved procedures the agent loads on demand.
They are deliberately *progressive*: local models have small context windows, so
only each recipe's one-line description is put in the system prompt and the full
body is loaded when needed.

- **Storage.** [`src/main/recipes/store.ts`](../src/main/recipes/store.ts) keeps one
  folder per recipe, `recipes/<id>/SKILL.md`, in the writable config dir (dev:
  the project root, gitignored; packaged: `%APPDATA%`). The file is plain
  `name`/`description` frontmatter plus the body, so it stays portable. Whether a
  recipe is on is app state kept in `disabledRecipes` in `settings.json`, not in
  the file. Ids come from the name (`uniqueRecipeId`) and are sanitized so they
  can't escape the folder; bodies over `MAX_RECIPE_CHARS` are rejected.
- **Parsing.** [`src/shared/recipes.ts`](../src/shared/recipes.ts) holds the pure
  helpers shared with the renderer: `parseRecipeMarkdown` (tolerates a missing
  header by deriving the name from the first heading and the description from the
  first paragraph), `serializeRecipeMarkdown`, `buildRecipeCatalog` and
  `buildRecipeAppendix`.
- **Agent loop.** `Agent` takes a `getRecipes()` provider, read fresh each turn so
  edits apply without a restart. `fullSystemPrompt()` appends the catalogue (empty
  when nothing is enabled, so users without recipes pay nothing) and `run()` adds
  the built-in `use_recipe` tool only when a recipe is enabled. `use_recipe` is
  in-process and needs no approval; it returns the body (or the list of valid ids
  for an unknown or disabled one) and emits `recipe_used` for the transcript. It is
  in `BUILTIN_TOOLS`, so it doesn't count as real work for the forced-planning logic.
- **Manual attach and Pitchers.** The renderer appends the chosen recipes' bodies to
  the user message (`buildRecipeAppendix`), so the instruction persists in that
  conversation's history. `pourPitcher` does the same for a Pitcher's `recipes`
  ids, because a headless run shouldn't depend on the model choosing to load one.
- **IPC.** `recipe:list|save|delete|set-enabled|import|export` in
  [`src/main/index.ts`](../src/main/index.ts), exposed through the preload bridge.
  Imports are capped at 256 KB per file and never overwrite an existing recipe.
- Tests: [`test/recipes.test.ts`](../test/recipes.test.ts).

# Influencing a running turn

The composer stays enabled while a turn runs. Messages sent then go through the
`agent:influence` IPC (`influenceMessage` in the preload bridge) into an
[`InfluenceChannel`](../src/main/agent/influence.ts), one per interactive turn (created in
the `agent:send` handler in [`src/main/index.ts`](../src/main/index.ts); Pitcher
pours get none, so scheduled runs can't be influenced).

- **Influence (Enter).** `Agent.run` drains the channel at the top of each loop
  iteration, when every earlier tool call already has its result, and appends
  each message as a user message wrapped by `wrapInfluence` (it tells the model to
  adjust its plan). A final answer written while an influence is pending is still
  shown, but the turn continues instead of ending, and the unfinished-plan nudge
  is skipped. `influence_applied { id }` tells the renderer to move the message from
  its queue into the transcript.
- **Interrupt now (Ctrl+Enter).** `chatWithOverflowRetry` gives every completion
  its own `AbortController` (bound to the channel, combined with the run's
  signal). An interrupt aborts only that controller; `Agent.run` sees the abort
  with the run signal still live, drops the partial reply (nothing is pushed, so
  no orphaned `tool_calls`), emits `completion_interrupted` and loops, injecting
  the influence. When no completion is in flight (a tool is running, or a prompt is
  open) it degrades to a normal influence. A real Stop aborts the run signal and ends
  the turn as before.
- **Hand-back.** `agent:influence` returns false once the turn is over or stopped. The
  renderer also restores any influence still queued when `done` arrives (including
  after Stop) to the composer, so typed text is never lost.
- A `history_compacted` event already contains the influences applied so far, so the
  renderer clears its per-turn `collected` list when it adopts it.
- Tests: [`test/agent-influence.test.ts`](../test/agent-influence.test.ts).

# Monitor

A **Monitoring pill** in the status bar ([`src/renderer/MonitorPill.tsx`](../src/renderer/MonitorPill.tsx):
idle/working dot, live tok/s with a sparkline, CPU) is always visible; clicking it,
or **Monitoring** in the hamburger menu, opens
[`src/renderer/MonitorPanel.tsx`](../src/renderer/MonitorPanel.tsx), which graphs
the server's host usage and inference speed. Both read samples through
[`monitorFeed.ts`](../src/renderer/monitorFeed.ts): the main process keys its
subscribers by window, so each window holds a single subscription that the pill
and the view share (late listeners get the samples already received replayed).
The pill keeps its own state so the once-a-second updates don't re-render the
app, and it stops listening while the window is hidden or minimized.

- [`MonitorPoller`](../src/main/lemonade/monitor.ts) in the main process reads
  the server's `GET /system-stats` (CPU, RAM, GPU, GPU memory, NPU) and
  `GET /stats` (last-request tokens/s and time to first token, token counters,
  and the `live` block with active streams and an estimated tokens/s) once a
  second, through the same authenticated client as the rest of the app. Polls
  never overlap.
- **Omni models are invisible to `/stats`.** The server runs an Omni collection
  with its own internal loop and never updates those counters (verified: a chat
  to a plain model moves `/stats`, the same chat to `LMX-Omni-5.5B-Lite` does
  not). So [`InferenceTracker`](../src/main/lemonade/inference.ts) measures the
  app's own streamed requests: `LemonadeClient.chat()` reports each request and
  its streamed text (content, reasoning, tool-call arguments). `mergeInference`
  combines both sources: every app request makes the view show *Generating* and
  feeds the live rate, but only requests the server doesn't count (collections)
  are added to the totals and the "last request" figures, so nothing is counted
  twice. The app's last request is preferred only if it finished after the
  server's counter last moved.
- **Exact Omni timings come from the server log.** llama.cpp prints a
  `print_timing` line for every model call (`prompt eval time = … / N tokens (…
  tokens per second)` and `eval time = …`), Omni's internal calls included, and
  the log WebSocket (`/logs/stream`) carries them. While monitoring is active the
  main process runs a second `ServerLogStream` (started and stopped by
  `MonitorHub`'s `lifecycle` hooks) and `parseBackendTiming` feeds each line to
  `InferenceTracker.recordTiming`. A timing belongs to the request in flight, or
  to one that ended in the last 3 s (the line can arrive just after the reply).
  A request with decode timings reports their sums, exact, and a call's speed is
  also held on the live reading for 4 s, which is the only live signal an Omni
  reply allows. A request without any (another backend, or no log access) falls
  back to estimates: ~4 characters per token with base64 runs (inline
  audio/images) ignored and the rate taken over the whole request. Those carry
  `estimated: true` and the UI marks them with `~`. The prompt figure is the
  prompt tokens llama.cpp processed, so a prefix-cache hit makes it small.
- Each poll becomes one `MonitorSample` ([`src/shared/types.ts`](../src/shared/types.ts))
  pushed over the `monitor:sample` IPC channel. An endpoint that fails or isn't
  there leaves its half of the sample `null`, and any field the server reports
  as null stays null, so the UI shows *n/a* rather than zero.
- `MonitorHub` shares one poller between every window showing monitoring data and
  keeps the last 180 samples (about three minutes). A new viewer first gets that
  history replayed, then live samples; the poller runs only while at least one
  window is subscribed (so, while the app window is visible, because of the pill)
  and drops history that's more than 5 s old when it starts again. Changing the
  server in **Connection** restarts it with fresh history.
- **Detached window.** The overlay's pop-out button calls `monitor:pop-out`, and
  so does dragging the overlay's title bar: pointer capture keeps
  `pointermove`/`pointerup` coming even outside the window and the overlay follows
  the pointer. A renderer can't paint outside its own window, so rather than
  requiring the pointer to leave it, the drag detaches once the panel hangs more
  than 80 px over any window edge (or the pointer is outside); a fixed banner
  announces it, and releasing sends the pointer's screen position (`screenX/Y`)
  so the window opens there. Chromium treats
  `-webkit-app-region: drag` as a union across the page regardless of stacking,
  so `.mon-panel` opts out with `no-drag` (it can sit over the top bar). The main
  process opens an ordinary framed `BrowserWindow`
  (`openMonitorWindow` in [`src/main/index.ts`](../src/main/index.ts)) that loads the
  same page with `#monitor`; [`main.tsx`](../src/renderer/main.tsx) then renders
  just `MonitorPanel variant="windowed"`. It is not parented to the main window,
  so it can be dragged anywhere. It follows the theme through the `storage`
  event, and is closed with the main window so the app can quit. `monitor:focus-window`
  lets the top button bring an existing window forward instead of opening the overlay.
- The renderer draws the charts as plain SVG
  ([`src/renderer/monitorFormat.ts`](../src/renderer/monitorFormat.ts)). The
  generation-speed chart also shades the samples where `activeRequests > 0`
  (`chartBands`): an Omni reply arrives in one piece, so its live rate stays at
  zero while it works and the shading is the only visible sign of activity.
  `/stats` only describes the latest request, so a finished request is
  detected when the request counter goes up and its numbers are added to
  **Recent requests**; requests that finish within one poll of each other
  show as one row.
- Opening or closing it never touches a running chat: the overlay is only
  renderer UI state, the agent loop lives in the main process, and the poller
  just issues read-only `GET`s. Because the overlay covers the window, it shows
  a notice if a tool call is waiting for approval in the chat; the detached
  window has no such problem.