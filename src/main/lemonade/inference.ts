// Measures the chat requests this app makes, for the Monitoring view.
//
// lemond keeps inference statistics (`/stats`) for ordinary models, but an Omni
// collection is run by the server's own internal agent loop, which never updates
// them: the view would sit at zero while the model is plainly working. So the
// client reports every streamed request here. Requests the server already counts
// are only used to show "generating" and a live rate; requests it doesn't count
// also feed the totals and the "last request" figures.
//
// Those figures start as estimates from the streamed text. The server's log does
// better: llama.cpp prints exact timings for every model call (prompt and
// generation), Omni's included, and the Monitoring feed forwards them here. When
// a request has them, they replace the estimate.

const LIVE_WINDOW_MS = 3000
/** How long the speed of a just-finished model call stays on the live reading. */
const TIMING_HOLD_MS = 4000
/** A timing line can land just after the request it belongs to has ended. */
const TIMING_GRACE_MS = 3000
const MAX_FINISHED = 200
/** Rough characters per token, for text we have no exact token count for. */
const CHARS_PER_TOKEN = 4

/** Estimated token count of streamed text. Long base64 runs (the audio and
 * images an Omni reply carries inline) are not tokens the model generated. */
export function estimateTokens(text: string): number {
  const readable = text.replace(/[A-Za-z0-9+/=]{64,}/g, '')
  return readable.length === 0 ? 0 : Math.max(1, Math.round(readable.length / CHARS_PER_TOKEN))
}

/** Exact timing of one model call, from a llama.cpp `print_timing` log line. */
export interface BackendTiming {
  kind: 'prompt' | 'decode'
  ms: number
  tokens: number
  tokensPerSecond: number | null
}

const TIMING_LINE =
  /\b(prompt eval|eval) time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*[\d.]+\s*ms per token,\s*([\d.]+)\s*tokens per second\)/

/** Read a llama.cpp timing from a server log message; null for any other line. */
export function parseBackendTiming(message: string): BackendTiming | null {
  if (!message.includes('print_timing')) return null
  const m = TIMING_LINE.exec(message)
  if (!m) return null
  const ms = Number(m[2])
  const tokens = Number(m[3])
  const tps = Number(m[4])
  if (!Number.isFinite(ms) || !Number.isFinite(tokens)) return null
  return {
    kind: m[1] === 'eval' ? 'decode' : 'prompt',
    ms,
    tokens,
    tokensPerSecond: Number.isFinite(tps) ? tps : null
  }
}

/** The most recent finished request the server did not count itself. */
export interface AppLastRequest {
  /** Wall-clock time it finished, ms since the epoch. */
  time: number
  tokensPerSecond: number | null
  timeToFirstToken: number | null
  inputTokens: number
  outputTokens: number
  /** True when the figures are estimated from the streamed text rather than
   * taken from the server's own timings. */
  estimated: boolean
}

/** Point-in-time view of this app's requests. */
export interface AppInferenceSnapshot {
  /** Requests streaming right now. */
  active: number
  /** Combined rate of the streams, tokens/s. */
  liveTokensPerSecond: number
  /** Finished requests the server did not count, and their tokens. */
  uncountedRequests: number
  uncountedInputTokens: number
  uncountedOutputTokens: number
  last: AppLastRequest | null
}

/** One in-flight request. Report output as it streams, then finish it. */
export interface TrackedRequest {
  /** Record streamed text (content, reasoning or tool-call arguments). */
  text(delta: string): void
  /** The request is over. `ok` false (aborted or failed) records nothing. */
  end(ok: boolean): void
}

interface Req {
  startedAt: number
  endedAt: number | null
  firstTokenAt: number | null
  outputTokens: number
  inputTokens: number
  serverCounted: boolean
  chunks: { at: number; tokens: number }[]
  timings: BackendTiming[]
}

interface Figures {
  inputTokens: number
  outputTokens: number
  tokensPerSecond: number | null
  estimated: boolean
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

/** A finished request's numbers: exact when the server's timings are in, else
 * estimated from the text. The rate is over the whole request in the estimate,
 * since an Omni reply arrives in large pieces and a rate over just the streaming
 * part would be inflated. */
function figures(req: Req): Figures {
  const decode = req.timings.filter((t) => t.kind === 'decode')
  if (decode.length > 0) {
    const ms = sum(decode.map((t) => t.ms))
    const tokens = sum(decode.map((t) => t.tokens))
    const prompt = req.timings.filter((t) => t.kind === 'prompt')
    return {
      inputTokens: prompt.length > 0 ? sum(prompt.map((t) => t.tokens)) : req.inputTokens,
      outputTokens: tokens,
      tokensPerSecond: ms > 0 ? tokens / (ms / 1000) : null,
      estimated: false
    }
  }
  const seconds = ((req.endedAt ?? req.startedAt) - req.startedAt) / 1000
  return {
    inputTokens: req.inputTokens,
    outputTokens: req.outputTokens,
    tokensPerSecond: req.outputTokens > 0 && seconds > 0 ? req.outputTokens / seconds : null,
    estimated: true
  }
}

export class InferenceTracker {
  private readonly active = new Set<Req>()
  private finished: Req[] = []
  // Requests dropped off the end of `finished`, kept only as totals.
  private folded = { requests: 0, inputTokens: 0, outputTokens: 0 }
  private lastDecode: { at: number; tokensPerSecond: number } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Start tracking a request. `serverCounted` says whether lemond records its own
   * statistics for it; `prompt` is the text sent, for the input estimate.
   */
  begin(serverCounted: boolean, prompt: string): TrackedRequest {
    const req: Req = {
      startedAt: this.now(),
      endedAt: null,
      firstTokenAt: null,
      outputTokens: 0,
      inputTokens: estimateTokens(prompt),
      serverCounted,
      chunks: [],
      timings: []
    }
    this.active.add(req)
    return {
      text: (delta) => {
        const tokens = estimateTokens(delta)
        if (tokens === 0) return
        const at = this.now()
        req.firstTokenAt ??= at
        req.outputTokens += tokens
        req.chunks.push({ at, tokens })
      },
      end: (ok) => {
        if (!this.active.delete(req)) return
        if (!ok) return
        req.endedAt = this.now()
        req.chunks = []
        this.finished.push(req)
        if (this.finished.length > MAX_FINISHED) this.fold(this.finished.shift()!)
      }
    }
  }

  /**
   * Take in the exact timing of a model call from the server's log. It belongs to
   * the request being served, or to one that ended moments ago (the log line can
   * arrive just after the reply does). Timings from other clients are ignored for
   * the totals but still feed the live reading.
   */
  recordTiming(timing: BackendTiming): void {
    const now = this.now()
    if (timing.kind === 'decode' && timing.tokensPerSecond !== null) {
      this.lastDecode = { at: now, tokensPerSecond: timing.tokensPerSecond }
    }
    let owner: Req | null = null
    for (const req of this.active) {
      if (!owner || req.startedAt > owner.startedAt) owner = req
    }
    if (!owner) {
      const recent = this.finished.at(-1)
      if (recent && recent.endedAt !== null && now - recent.endedAt <= TIMING_GRACE_MS) owner = recent
    }
    owner?.timings.push(timing)
  }

  snapshot(): AppInferenceSnapshot {
    const now = this.now()
    let recent = 0
    let oldest = now
    for (const req of this.active) {
      oldest = Math.min(oldest, req.startedAt)
      for (const chunk of req.chunks) {
        if (now - chunk.at <= LIVE_WINDOW_MS) recent += chunk.tokens
      }
      // Chunks older than the window can't count again; drop them as we go.
      req.chunks = req.chunks.filter((c) => now - c.at <= LIVE_WINDOW_MS)
    }
    const windowSeconds = Math.min(LIVE_WINDOW_MS, Math.max(1000, now - oldest)) / 1000
    let live = recent / windowSeconds
    // A model call that just finished reports its exact speed; hold it briefly so
    // the reading shows up even when the reply itself arrived in one piece.
    if (this.lastDecode && now - this.lastDecode.at <= TIMING_HOLD_MS) {
      live = Math.max(live, this.lastDecode.tokensPerSecond)
    }

    const uncounted = this.finished.filter((r) => !r.serverCounted)
    let inputTokens = this.folded.inputTokens
    let outputTokens = this.folded.outputTokens
    for (const req of uncounted) {
      const f = figures(req)
      inputTokens += f.inputTokens
      outputTokens += f.outputTokens
    }
    const lastReq = uncounted.at(-1)
    const lastFigures = lastReq ? figures(lastReq) : null
    return {
      active: this.active.size,
      liveTokensPerSecond: live,
      uncountedRequests: this.folded.requests + uncounted.length,
      uncountedInputTokens: inputTokens,
      uncountedOutputTokens: outputTokens,
      last:
        lastReq && lastFigures
          ? {
              time: lastReq.endedAt ?? lastReq.startedAt,
              tokensPerSecond: lastFigures.tokensPerSecond,
              timeToFirstToken:
                lastReq.firstTokenAt === null ? null : (lastReq.firstTokenAt - lastReq.startedAt) / 1000,
              inputTokens: lastFigures.inputTokens,
              outputTokens: lastFigures.outputTokens,
              estimated: lastFigures.estimated
            }
          : null
    }
  }

  private fold(req: Req): void {
    if (req.serverCounted) return
    const f = figures(req)
    this.folded.requests++
    this.folded.inputTokens += f.inputTokens
    this.folded.outputTokens += f.outputTokens
  }
}
