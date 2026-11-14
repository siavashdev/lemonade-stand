import type { MonitorSample } from '@shared/types'

/** Samples kept for the charts: about three minutes at one poll a second. */
export const MONITOR_WINDOW = 180

/** How many finished requests the "Recent requests" list remembers. */
export const MAX_REQUEST_ROWS = 12

/** A request the server finished since the previous poll. */
export interface RequestRecord {
  time: number
  tokensPerSecond: number | null
  timeToFirstToken: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheTokens: number | null
  /** The figures are this app's estimates rather than the server's. */
  estimated: boolean
}

/** Append `sample`, dropping the oldest so at most `max` remain. */
export function appendSample(history: MonitorSample[], sample: MonitorSample, max = MONITOR_WINDOW): MonitorSample[] {
  const next = [...history, sample]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * The request that finished between two polls, if any. The server only keeps
 * statistics for its latest request, so the request counter ticking up is the
 * signal to read them. A counter that goes down means the server restarted, and
 * the first poll has nothing to compare against: neither reports a request.
 */
export function detectRequest(prev: MonitorSample | null, next: MonitorSample): RequestRecord | null {
  const before = prev?.inference?.requestCountTotal
  const after = next.inference?.requestCountTotal
  if (before == null || after == null || after <= before || !next.inference) return null
  const s = next.inference
  return {
    time: next.time,
    tokensPerSecond: s.tokensPerSecond,
    timeToFirstToken: s.timeToFirstToken,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheTokens: s.cacheTokens,
    estimated: s.estimated
  }
}

/** Round `value` up to a tidy axis maximum (1, 2, 5 × a power of ten), at least `floor`. */
export function niceMax(value: number, floor = 1): number {
  const v = Math.max(value, floor)
  const pow = 10 ** Math.floor(Math.log10(v))
  for (const step of [1, 2, 5, 10]) {
    if (v <= step * pow) return step * pow
  }
  return 10 * pow
}

/**
 * SVG path data for a line chart and the filled area beneath it. `values` fill
 * the window from the right (the newest sample sits at the right edge), and a
 * null leaves a gap rather than dropping to zero.
 */
export function chartPaths(
  values: (number | null)[],
  capacity: number,
  width: number,
  height: number,
  max: number
): { line: string; area: string } {
  const x = (i: number): number =>
    capacity <= 1 ? width : ((capacity - values.length + i) / (capacity - 1)) * width
  const y = (v: number): number => height - Math.min(Math.max(v / max, 0), 1) * height
  const fmt = (n: number): string => n.toFixed(1)
  let line = ''
  let area = ''
  let run: { x: number; y: number }[] = []
  const flush = (): void => {
    if (run.length > 0) {
      const pts = run.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ')
      line += `${line ? ' ' : ''}${pts}`
      const first = run[0]
      const last = run[run.length - 1]
      area += `${area ? ' ' : ''}${pts} L${fmt(last.x)} ${fmt(height)} L${fmt(first.x)} ${fmt(height)} Z`
    }
    run = []
  }
  values.forEach((v, i) => {
    if (v === null) flush()
    else run.push({ x: x(i), y: y(v) })
  })
  flush()
  return { line, area }
}

/**
 * Horizontal spans (in chart units) where `flags` are true, for shading the
 * moments a request was running. Slots are laid out like `chartPaths` (newest at
 * the right edge) and each span reaches half a slot either side of its samples.
 */
export function chartBands(
  flags: boolean[],
  capacity: number,
  width: number
): { x: number; width: number }[] {
  const step = capacity <= 1 ? width : width / (capacity - 1)
  const center = (i: number): number => (capacity - flags.length + i) * step
  const bands: { x: number; width: number }[] = []
  let start = -1
  const close = (end: number): void => {
    const x0 = Math.max(0, center(start) - step / 2)
    const x1 = Math.min(width, center(end) + step / 2)
    if (x1 > x0) bands.push({ x: x0, width: x1 - x0 })
    start = -1
  }
  flags.forEach((on, i) => {
    if (on && start < 0) start = i
    if (!on && start >= 0) close(i - 1)
  })
  if (start >= 0) close(flags.length - 1)
  return bands
}

/** `12.3` style rate, with fewer decimals as the number grows. */
export function formatRate(value: number | null): string {
  if (value === null) return '–'
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

/** A token count with thousands separators. */
export function formatCount(value: number | null): string {
  return value === null ? '–' : Math.round(value).toLocaleString()
}

export function formatPercent(value: number | null): string {
  return value === null ? '–' : `${value.toFixed(0)}%`
}

export function formatGb(value: number | null): string {
  return value === null ? '–' : `${value.toFixed(1)} GB`
}

/** Seconds as `0.42 s`, or milliseconds under a tenth of a second. */
export function formatSeconds(value: number | null): string {
  if (value === null) return '–'
  return value < 0.1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`
}
