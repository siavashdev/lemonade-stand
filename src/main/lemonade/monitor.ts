import type { InferenceStats, MonitorSample, SystemStats } from '@shared/types'
import type { AppInferenceSnapshot } from './inference'

// Feeds the in-app Monitoring view and status-bar pill. lemond reports host usage
// at `/system-stats` and inference activity at `/stats`; the poller reads both
// about once a second, but only while a window is showing them (the pill whenever
// the app window is visible, plus the Monitoring view). Either
// endpoint can be missing on older servers, or report null for hardware it
// can't see, so every field is optional.

/** Fetch a path relative to the server's base URL as JSON, or null on failure. */
export type FetchJson = (path: string, timeoutMs: number) => Promise<unknown>

const POLL_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 2500

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Decode a `/system-stats` payload; null when it isn't an object. */
export function parseSystemStats(raw: unknown): SystemStats | null {
  const r = record(raw)
  if (!r) return null
  const gpus = Array.isArray(r.gpus) ? r.gpus.map(record).filter((g) => g !== null) : []
  const primary = gpus.find((g) => g.id === r.primary_gpu_id) ?? gpus[0] ?? null
  return {
    cpuPercent: num(r.cpu_percent),
    memoryGb: num(r.memory_gb),
    gpuPercent: num(r.gpu_percent),
    vramGb: num(r.vram_gb),
    vramTotalGb: primary ? num(primary.memory_total_gb) : null,
    gpuName: primary && typeof primary.name === 'string' ? primary.name : null,
    npuPercent: num(r.npu_percent)
  }
}

/** Decode a `/stats` payload; null when it isn't an object. */
export function parseInferenceStats(raw: unknown): InferenceStats | null {
  const r = record(raw)
  if (!r) return null
  const live = record(r.live)
  return {
    tokensPerSecond: num(r.tokens_per_second),
    timeToFirstToken: num(r.time_to_first_token),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    promptTokens: num(r.prompt_tokens),
    cacheTokens: num(r.cache_tokens),
    requestCountTotal: num(r.request_count_total),
    inputTokensTotal: num(r.input_tokens_total),
    outputTokensTotal: num(r.output_tokens_total),
    activeRequests: live ? num(live.active_requests) : null,
    liveTokensPerSecond: live ? num(live.estimated_tokens_per_second) : null,
    estimated: false
  }
}

const NO_STATS: InferenceStats = {
  tokensPerSecond: null,
  timeToFirstToken: null,
  inputTokens: null,
  outputTokens: null,
  promptTokens: null,
  cacheTokens: null,
  requestCountTotal: null,
  inputTokensTotal: null,
  outputTokensTotal: null,
  activeRequests: null,
  liveTokensPerSecond: null,
  estimated: false
}

/**
 * Combine the server's `/stats` with what this app measured itself. The server
 * doesn't count requests handled by an Omni collection's internal loop, so
 * without this the view would stay at zero while the model works. Requests the
 * server did count are not added again: they only contribute to the activity
 * state. `serverChangedAt` is when the server's request counter last moved; the
 * app's last request is shown only if it finished after that.
 */
export function mergeInference(
  server: InferenceStats | null,
  app: AppInferenceSnapshot | null,
  serverChangedAt: number
): InferenceStats | null {
  if (!app || (app.active === 0 && app.uncountedRequests === 0)) return server
  const base = server ?? NO_STATS
  const add = (total: number | null, extra: number): number | null =>
    total === null && extra === 0 ? null : (total ?? 0) + extra
  const last = app.last && app.last.time > serverChangedAt ? app.last : null
  return {
    ...base,
    activeRequests: Math.max(base.activeRequests ?? 0, app.active),
    liveTokensPerSecond: Math.max(base.liveTokensPerSecond ?? 0, app.liveTokensPerSecond),
    requestCountTotal: add(base.requestCountTotal, app.uncountedRequests),
    inputTokensTotal: add(base.inputTokensTotal, app.uncountedInputTokens),
    outputTokensTotal: add(base.outputTokensTotal, app.uncountedOutputTokens),
    ...(last
      ? {
          tokensPerSecond: last.tokensPerSecond,
          timeToFirstToken: last.timeToFirstToken,
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          promptTokens: last.inputTokens,
          cacheTokens: null,
          estimated: last.estimated
        }
      : {})
  }
}

/**
 * Polls the server's monitoring endpoints for as long as it is started. Polls
 * run one after another (never overlapping), so a slow server is simply sampled
 * less often instead of building a backlog of requests.
 */
export class MonitorPoller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  // Bumped on every start/stop so a poll still in flight when the monitor is
  // closed, or the server changed, is dropped instead of reported.
  private generation = 0
  // The server's request counter and when it last went up, so the app's own
  // last request is only preferred when it is the more recent one.
  private serverCount: number | null = null
  private serverChangedAt = 0

  constructor(
    private readonly fetchJson: FetchJson,
    private readonly emit: (sample: MonitorSample) => void,
    private readonly intervalMs = POLL_INTERVAL_MS,
    private readonly appSnapshot: () => AppInferenceSnapshot | null = () => null
  ) {}

  /** Whether polling is currently wanted. */
  get active(): boolean {
    return this.running
  }

  /** (Re)start polling, taking the first sample immediately. */
  start(): void {
    this.stop()
    this.running = true
    this.serverCount = null
    this.serverChangedAt = 0
    void this.poll(this.generation)
  }

  stop(): void {
    this.running = false
    this.generation++
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async poll(generation: number): Promise<void> {
    const [system, server] = await Promise.all([
      this.fetchJson('/system-stats', REQUEST_TIMEOUT_MS).then(parseSystemStats, () => null),
      this.fetchJson('/stats', REQUEST_TIMEOUT_MS).then(parseInferenceStats, () => null)
    ])
    if (generation !== this.generation) return
    const time = Date.now()
    const count = server?.requestCountTotal ?? null
    if (count !== null) {
      if (this.serverCount !== null && count > this.serverCount) this.serverChangedAt = time
      this.serverCount = count
    }
    this.emit({
      time,
      online: system !== null || server !== null,
      system,
      inference: mergeInference(server, this.appSnapshot(), this.serverChangedAt)
    })
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll(generation)
    }, this.intervalMs)
  }
}

/** How long (ms) an idle feed's samples stay worth replaying to a new viewer. */
const HISTORY_STALE_MS = 5000

/**
 * Shares one poller between every window showing the Monitoring view (the
 * overlay in the main window and the detached window). It polls while at least
 * one window is subscribed, and keeps the recent samples so a window that opens
 * (for example when the overlay is popped out) starts with the charts already
 * filled in instead of empty.
 */
export class MonitorHub {
  private readonly sinks = new Map<number, (sample: MonitorSample) => void>()
  private history: MonitorSample[] = []
  private readonly poller: MonitorPoller

  constructor(
    fetchJson: FetchJson,
    appSnapshot: () => AppInferenceSnapshot | null,
    private readonly maxHistory = 180,
    intervalMs = POLL_INTERVAL_MS,
    // Start/stop whatever else feeds on the same viewers, such as the log tap that
    // reads the server's exact model timings.
    private readonly lifecycle?: { onStart(): void; onStop(): void }
  ) {
    this.poller = new MonitorPoller(fetchJson, (s) => this.push(s), intervalMs, appSnapshot)
  }

  get active(): boolean {
    return this.poller.active
  }

  /** Start sending samples to `send`, replaying recent history first. */
  subscribe(id: number, send: (sample: MonitorSample) => void): void {
    const last = this.history.at(-1)
    if (!this.poller.active && last && Date.now() - last.time > HISTORY_STALE_MS) this.history = []
    this.sinks.set(id, send)
    for (const sample of this.history) send(sample)
    if (!this.poller.active) {
      this.poller.start()
      this.lifecycle?.onStart()
    }
  }

  unsubscribe(id: number): void {
    this.sinks.delete(id)
    if (this.sinks.size === 0) this.halt()
  }

  /** Poll afresh (the server changed): earlier samples no longer apply. */
  restart(): void {
    if (!this.poller.active) return
    this.history = []
    this.poller.start()
    this.lifecycle?.onStart()
  }

  /** Drop every subscriber and stop polling. */
  stop(): void {
    this.sinks.clear()
    this.halt()
  }

  private halt(): void {
    if (!this.poller.active) return
    this.poller.stop()
    this.lifecycle?.onStop()
  }

  private push(sample: MonitorSample): void {
    this.history.push(sample)
    if (this.history.length > this.maxHistory) this.history.shift()
    for (const send of this.sinks.values()) send(sample)
  }
}

