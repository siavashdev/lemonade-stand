import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitorSample } from '@shared/types'
import {
  InferenceTracker,
  estimateTokens,
  parseBackendTiming,
  type AppInferenceSnapshot,
  type BackendTiming
} from '../src/main/lemonade/inference'
import {
  MonitorHub,
  MonitorPoller,
  mergeInference,
  parseInferenceStats,
  parseSystemStats
} from '../src/main/lemonade/monitor'
import { subscribeMonitor } from '../src/renderer/monitorFeed'
import { chartBands, chartPaths, detectRequest, niceMax } from '../src/renderer/monitorFormat'

describe('parseSystemStats', () => {
  it('reads the primary GPU details alongside the totals', () => {
    const stats = parseSystemStats({
      cpu_percent: 12.5,
      memory_gb: 33,
      gpu_percent: 71,
      vram_gb: 21.5,
      primary_gpu_id: 'b',
      gpus: [
        { id: 'a', name: 'Other', memory_total_gb: 4 },
        { id: 'b', name: 'Radeon 8060S', memory_total_gb: 61.8 }
      ],
      npu_percent: null
    })
    expect(stats).toMatchObject({
      cpuPercent: 12.5,
      memoryGb: 33,
      gpuPercent: 71,
      vramGb: 21.5,
      vramTotalGb: 61.8,
      gpuName: 'Radeon 8060S',
      npuPercent: null
    })
  })

  it('reports missing fields as null and rejects non-objects', () => {
    expect(parseSystemStats({})).toMatchObject({ cpuPercent: null, gpuName: null, vramTotalGb: null })
    expect(parseSystemStats(null)).toBeNull()
    expect(parseSystemStats('nope')).toBeNull()
  })
})

describe('parseInferenceStats', () => {
  it('reads the last-request fields, totals and live block', () => {
    const stats = parseInferenceStats({
      time_to_first_token: 0.008,
      tokens_per_second: 177.6,
      input_tokens: 1,
      output_tokens: 253,
      prompt_tokens: 15,
      cache_tokens: 14,
      request_count_total: 9,
      output_tokens_total: 1817,
      live: { active_requests: 2, estimated_tokens_per_second: 40.5 }
    })
    expect(stats).toMatchObject({
      tokensPerSecond: 177.6,
      timeToFirstToken: 0.008,
      cacheTokens: 14,
      requestCountTotal: 9,
      outputTokensTotal: 1817,
      activeRequests: 2,
      liveTokensPerSecond: 40.5
    })
  })

  it('tolerates a server without the live block or timings', () => {
    const stats = parseInferenceStats({ tokens_per_second: null, request_count_total: 0 })
    expect(stats).toMatchObject({ tokensPerSecond: null, activeRequests: null, liveTokensPerSecond: null })
  })
})

describe('MonitorPoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls both endpoints on an interval and marks the sample online', async () => {
    const fetchJson = vi.fn(async (path: string) =>
      path === '/stats' ? { tokens_per_second: 5 } : { cpu_percent: 1 }
    )
    const samples: MonitorSample[] = []
    const poller = new MonitorPoller(fetchJson, (s) => samples.push(s), 1000)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({
      online: true,
      system: { cpuPercent: 1 },
      inference: { tokensPerSecond: 5 }
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(samples).toHaveLength(3)
    poller.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(samples).toHaveLength(3)
  })

  it('reports offline when neither endpoint answers, and one missing endpoint stays online', async () => {
    let up = false
    const samples: MonitorSample[] = []
    const poller = new MonitorPoller(
      async (path) => (up && path === '/stats' ? { tokens_per_second: 1 } : null),
      (s) => samples.push(s),
      1000
    )
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(samples[0]).toMatchObject({ online: false, system: null, inference: null })
    up = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(samples[1]).toMatchObject({ online: true, system: null })
    poller.stop()
  })

  it('drops a poll that was in flight when it was stopped', async () => {
    let release: (v: unknown) => void = () => {}
    const pending = new Promise((resolve) => (release = resolve))
    const samples: MonitorSample[] = []
    const poller = new MonitorPoller(() => pending, (s) => samples.push(s), 1000)
    poller.start()
    poller.stop()
    release({})
    await vi.advanceTimersByTimeAsync(2000)
    expect(samples).toHaveLength(0)
  })
})

function sample(count: number | null): MonitorSample {
  return {
    time: Date.now(),
    online: true,
    system: null,
    inference: {
      tokensPerSecond: 50,
      timeToFirstToken: 0.2,
      inputTokens: 10,
      outputTokens: 100,
      promptTokens: 10,
      cacheTokens: 0,
      requestCountTotal: count,
      inputTokensTotal: null,
      outputTokensTotal: null,
      activeRequests: 0,
      liveTokensPerSecond: 0,
      estimated: false
    }
  }
}

describe('detectRequest', () => {
  it('reports a request only when the server counter goes up', () => {
    expect(detectRequest(sample(3), sample(4))).toMatchObject({ tokensPerSecond: 50, outputTokens: 100 })
    expect(detectRequest(sample(3), sample(3))).toBeNull()
  })

  it('ignores the first poll and a counter reset after a server restart', () => {
    expect(detectRequest(null, sample(7))).toBeNull()
    expect(detectRequest(sample(7), sample(1))).toBeNull()
    expect(detectRequest(sample(null), sample(1))).toBeNull()
  })
})

describe('estimateTokens', () => {
  it('estimates about one token per four characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('hi')).toBe(1)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })

  it('does not count the base64 audio or images an Omni reply carries inline', () => {
    const audio = 'A'.repeat(5000)
    expect(estimateTokens(`Here you go: data:audio/mpeg;base64,${audio}`)).toBe(
      estimateTokens('Here you go: data:audio/mpeg;base64,')
    )
  })
})

describe('InferenceTracker', () => {
  let clock = 0
  const tracker = (): InferenceTracker => new InferenceTracker(() => clock)
  beforeEach(() => {
    clock = 1_000_000
  })

  it('reports a request as active while it streams, and a live rate', () => {
    const t = tracker()
    const req = t.begin(false, 'prompt')
    clock += 500
    req.text('x'.repeat(40))
    clock += 500
    const snap = t.snapshot()
    expect(snap.active).toBe(1)
    expect(snap.liveTokensPerSecond).toBeCloseTo(10, 5)
    req.end(true)
    expect(t.snapshot().active).toBe(0)
    expect(t.snapshot().liveTokensPerSecond).toBe(0)
  })

  it('records a finished request the server does not count, with estimated figures', () => {
    const t = tracker()
    const req = t.begin(false, 'word '.repeat(16))
    clock += 2000
    req.text('word '.repeat(16))
    clock += 2000
    req.end(true)
    const snap = t.snapshot()
    expect(snap.uncountedRequests).toBe(1)
    expect(snap.uncountedInputTokens).toBe(20)
    expect(snap.uncountedOutputTokens).toBe(20)
    expect(snap.last).toMatchObject({
      time: clock,
      inputTokens: 20,
      outputTokens: 20,
      timeToFirstToken: 2,
      tokensPerSecond: 5
    })
  })

  it('does not double count requests the server already counts, nor failed ones', () => {
    const t = tracker()
    const counted = t.begin(true, 'p')
    counted.text('hello world')
    counted.end(true)
    const failed = t.begin(false, 'p')
    failed.text('partial')
    failed.end(false)
    const snap = t.snapshot()
    expect(snap.uncountedRequests).toBe(0)
    expect(snap.last).toBeNull()
  })

  it('ignores a second end() for the same request', () => {
    const t = tracker()
    const req = t.begin(false, 'p')
    req.text('hello world')
    req.end(true)
    req.end(true)
    expect(t.snapshot().uncountedRequests).toBe(1)
  })

  const decode = (tokens: number, ms: number): BackendTiming => ({
    kind: 'decode',
    tokens,
    ms,
    tokensPerSecond: tokens / (ms / 1000)
  })
  const prompt = (tokens: number, ms: number): BackendTiming => ({
    kind: 'prompt',
    tokens,
    ms,
    tokensPerSecond: tokens / (ms / 1000)
  })

  it("replaces the estimate with the server's exact timings once they arrive", () => {
    const t = tracker()
    const req = t.begin(false, 'word '.repeat(16))
    clock += 4000
    req.text('word '.repeat(16))
    t.recordTiming(prompt(469, 2832))
    t.recordTiming(decode(97, 4533.74))
    clock += 100
    req.end(true)
    const snap = t.snapshot()
    expect(snap.last).toMatchObject({ inputTokens: 469, outputTokens: 97, estimated: false })
    expect(snap.last?.tokensPerSecond).toBeCloseTo(21.4, 1)
    expect(snap.uncountedInputTokens).toBe(469)
    expect(snap.uncountedOutputTokens).toBe(97)
  })

  it('adds up several model calls in one request, such as a tool loop', () => {
    const t = tracker()
    const req = t.begin(false, 'p')
    t.recordTiming(decode(50, 1000))
    t.recordTiming(decode(50, 3000))
    req.end(true)
    expect(t.snapshot().last).toMatchObject({ outputTokens: 100 })
    expect(t.snapshot().last?.tokensPerSecond).toBeCloseTo(25, 5)
  })

  it('attaches a timing that arrives just after the request ended, but not a late one', () => {
    const t = tracker()
    const req = t.begin(false, 'p')
    req.text('hello there')
    req.end(true)
    clock += 500
    t.recordTiming(decode(40, 2000))
    expect(t.snapshot().last).toMatchObject({ outputTokens: 40, estimated: false })
    clock += 10_000
    t.recordTiming(decode(999, 1000))
    expect(t.snapshot().last).toMatchObject({ outputTokens: 40 })
  })

  it('holds a finished model call\'s speed on the live reading for a few seconds', () => {
    const t = tracker()
    const req = t.begin(false, 'p')
    req.text('hello there')
    t.recordTiming(decode(100, 4000))
    req.end(true)
    expect(t.snapshot().liveTokensPerSecond).toBeCloseTo(25, 5)
    clock += 3000
    expect(t.snapshot().liveTokensPerSecond).toBeCloseTo(25, 5)
    clock += 2000
    expect(t.snapshot().liveTokensPerSecond).toBe(0)
  })
})

describe('parseBackendTiming', () => {
  const line = (rest: string): string => `175.06.445.325 I slot print_timing: id  0 | task 3370 | ${rest}`

  it('reads generation and prompt timings from llama.cpp log lines', () => {
    expect(
      parseBackendTiming(line('       eval time =    4533.74 ms /    97 tokens (   47.23 ms per token,    21.17 tokens per second)'))
    ).toEqual({ kind: 'decode', ms: 4533.74, tokens: 97, tokensPerSecond: 21.17 })
    expect(
      parseBackendTiming(line('prompt eval time =    2832.39 ms /   469 tokens (    6.04 ms per token,   165.58 tokens per second)'))
    ).toEqual({ kind: 'prompt', ms: 2832.39, tokens: 469, tokensPerSecond: 165.58 })
  })

  it('ignores the other lines the server logs', () => {
    expect(parseBackendTiming(line('      total time =    7366.13 ms /   566 tokens'))).toBeNull()
    expect(parseBackendTiming('POST /api/v1/chat/completions - Collection (streaming): X')).toBeNull()
    // Same wording from a different llama.cpp printer (counts runs, not tokens).
    expect(
      parseBackendTiming('llama_perf_context_print: eval time = 120.00 ms / 10 runs ( 12.00 ms per token, 83.33 tokens per second)')
    ).toBeNull()
  })
})

describe('mergeInference', () => {
  const server = (over: Partial<NonNullable<ReturnType<typeof parseInferenceStats>>> = {}) => ({
    ...parseInferenceStats({
      tokens_per_second: 30,
      time_to_first_token: 0.2,
      request_count_total: 5,
      input_tokens_total: 50,
      output_tokens_total: 500,
      live: { active_requests: 0, estimated_tokens_per_second: 0 }
    })!,
    ...over
  })
  const app = (over: Partial<AppInferenceSnapshot> = {}): AppInferenceSnapshot => ({
    active: 0,
    liveTokensPerSecond: 0,
    uncountedRequests: 0,
    uncountedInputTokens: 0,
    uncountedOutputTokens: 0,
    last: null,
    ...over
  })
  const last = (time: number): AppInferenceSnapshot['last'] => ({
    time,
    tokensPerSecond: 8,
    timeToFirstToken: 3,
    inputTokens: 100,
    outputTokens: 40,
    estimated: true
  })

  it('returns the server stats untouched when the app has nothing to add', () => {
    const s = server()
    expect(mergeInference(s, app(), 0)).toBe(s)
    expect(mergeInference(null, app(), 0)).toBeNull()
  })

  it('shows an Omni request as active even though the server reports nothing', () => {
    const merged = mergeInference(server({ requestCountTotal: 0 }), app({ active: 1, liveTokensPerSecond: 12 }), 0)
    expect(merged).toMatchObject({ activeRequests: 1, liveTokensPerSecond: 12 })
  })

  it('adds the app-only requests to the totals and prefers its newer last request', () => {
    const merged = mergeInference(
      server(),
      app({ uncountedRequests: 2, uncountedInputTokens: 200, uncountedOutputTokens: 80, last: last(2000) }),
      1000
    )
    expect(merged).toMatchObject({
      requestCountTotal: 7,
      inputTokensTotal: 250,
      outputTokensTotal: 580,
      tokensPerSecond: 8,
      timeToFirstToken: 3,
      promptTokens: 100,
      estimated: true
    })
  })

  it("keeps the server's last request when it is newer than the app's", () => {
    const merged = mergeInference(server(), app({ uncountedRequests: 1, last: last(1000) }), 2000)
    expect(merged).toMatchObject({ tokensPerSecond: 30, estimated: false, requestCountTotal: 6 })
  })

  it('works when the server has no stats endpoint at all', () => {
    const merged = mergeInference(null, app({ uncountedRequests: 1, uncountedOutputTokens: 5, last: last(5) }), 0)
    expect(merged).toMatchObject({ requestCountTotal: 1, outputTokensTotal: 5, estimated: true })
  })
})

describe('MonitorHub', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const fetchJson = async (path: string): Promise<unknown> =>
    path === '/stats' ? { request_count_total: 1 } : { cpu_percent: 2 }
  const hub = (): MonitorHub => new MonitorHub(fetchJson, () => null, 3, 1000)

  it('polls while anyone is subscribed and stops when the last viewer leaves', async () => {
    const h = hub()
    const a: MonitorSample[] = []
    const b: MonitorSample[] = []
    h.subscribe(1, (s) => a.push(s))
    await vi.advanceTimersByTimeAsync(0)
    h.subscribe(2, (s) => b.push(s))
    await vi.advanceTimersByTimeAsync(1000)
    expect(a.length).toBe(2)
    // The second viewer got the sample taken before it joined, then the live one.
    expect(b.length).toBe(2)
    h.unsubscribe(1)
    expect(h.active).toBe(true)
    h.unsubscribe(2)
    expect(h.active).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(a.length).toBe(2)
  })

  it('replays recent history to a new viewer, capped, and drops it once stale', async () => {
    const h = hub()
    h.subscribe(1, () => {})
    await vi.advanceTimersByTimeAsync(5000)
    h.unsubscribe(1)
    const quick: MonitorSample[] = []
    h.subscribe(2, (s) => quick.push(s))
    expect(quick.length).toBe(3)
    h.unsubscribe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    const late: MonitorSample[] = []
    h.subscribe(3, (s) => late.push(s))
    expect(late).toHaveLength(0)
    h.unsubscribe(3)
  })

  it('starts and stops its extra feeds together with polling', async () => {
    const events: string[] = []
    const h = new MonitorHub(fetchJson, () => null, 3, 1000, {
      onStart: () => events.push('start'),
      onStop: () => events.push('stop')
    })
    h.subscribe(1, () => {})
    h.subscribe(2, () => {})
    h.unsubscribe(1)
    expect(events).toEqual(['start'])
    h.unsubscribe(2)
    h.unsubscribe(2)
    expect(events).toEqual(['start', 'stop'])
    h.subscribe(3, () => {})
    h.restart()
    h.stop()
    expect(events).toEqual(['start', 'stop', 'start', 'start', 'stop'])
  })

  it('starts the history over when restarted for another server', async () => {
    const h = hub()
    h.subscribe(1, () => {})
    await vi.advanceTimersByTimeAsync(2000)
    h.restart()
    const seen: MonitorSample[] = []
    h.subscribe(2, (s) => seen.push(s))
    expect(seen).toHaveLength(0)
    h.stop()
  })
})


describe('niceMax', () => {
  it('rounds up to 1, 2 or 5 times a power of ten, never below the floor', () => {
    expect(niceMax(0, 10)).toBe(10)
    expect(niceMax(13, 10)).toBe(20)
    expect(niceMax(31, 10)).toBe(50)
    expect(niceMax(51, 10)).toBe(100)
    expect(niceMax(177)).toBe(200)
  })
})

describe('subscribeMonitor', () => {
  const sampleAt = (time: number): MonitorSample => ({ time, online: true, system: null, inference: null })
  let handler: ((s: MonitorSample) => void) | null
  let opened: number
  let closed: number

  beforeEach(() => {
    handler = null
    opened = 0
    closed = 0
    vi.stubGlobal('window', {
      api: {
        onMonitorSample: (h: (s: MonitorSample) => void) => {
          opened++
          handler = h
          return () => {
            closed++
            handler = null
          }
        }
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shares one subscription between listeners and replays what it already has', () => {
    const a: number[] = []
    const b: number[] = []
    const offA = subscribeMonitor((s) => a.push(s.time))
    handler?.(sampleAt(1))
    handler?.(sampleAt(2))
    const offB = subscribeMonitor((s) => b.push(s.time))
    expect(opened).toBe(1)
    expect(b).toEqual([1, 2])
    handler?.(sampleAt(3))
    expect(a).toEqual([1, 2, 3])
    expect(b).toEqual([1, 2, 3])
    offA()
    expect(closed).toBe(0)
    offB()
    expect(closed).toBe(1)
  })

  it('starts clean after everyone has left', () => {
    const off = subscribeMonitor(() => {})
    handler?.(sampleAt(1))
    off()
    const seen: number[] = []
    const again = subscribeMonitor((s) => seen.push(s.time))
    expect(seen).toEqual([])
    again()
  })
})

describe('chartBands', () => {
  it('shades the spans where flags are true, right-aligned, half a slot either side', () => {
    // 5 slots over width 40 -> step 10; three samples occupy slots 2..4 (x 20, 30, 40).
    expect(chartBands([false, true, true], 5, 40)).toEqual([{ x: 25, width: 15 }])
    expect(chartBands([true, false, true], 5, 40)).toEqual([
      { x: 15, width: 10 },
      { x: 35, width: 5 }
    ])
  })

  it('draws nothing when nothing was running', () => {
    expect(chartBands([false, false], 5, 40)).toEqual([])
    expect(chartBands([], 5, 40)).toEqual([])
  })
})

describe('chartPaths', () => {
  it('right-aligns the newest sample and clamps to the axis', () => {
    const { line } = chartPaths([0, 200], 3, 100, 50, 100)
    // Two samples in a 3-slot window: x = 50 and 100; the 200 clamps to the top.
    expect(line).toBe('M50.0 50.0 L100.0 0.0')
  })

  it('leaves a gap at null values and closes each area run', () => {
    const { line, area } = chartPaths([10, null, 10], 3, 100, 50, 100)
    expect(line.match(/M/g)).toHaveLength(2)
    expect(area.match(/Z/g)).toHaveLength(2)
  })

  it('draws nothing when every value is null', () => {
    expect(chartPaths([null, null], 5, 100, 50, 100)).toEqual({ line: '', area: '' })
  })
})
