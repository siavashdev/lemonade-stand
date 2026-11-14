import type { Pitcher, PitcherTrigger } from './types'

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_SHORT = DAY_NAMES.map((d) => d.slice(0, 3))

export const MIN_INTERVAL_MINUTES = 5
export const MAX_INTERVAL_MINUTES = 24 * 60

/** Parse a forgiving clock string ("8", "8am", "8:30 pm", "0800", "08:00") into
 * a strict 24-hour "HH:MM", or null when it can't be read. */
export function parseClock(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let s = value.trim().toLowerCase()
  if (!s) return null
  const ampm = /(am|pm)/.exec(s)?.[1]
  s = s.replace(/\s*(am|pm)\s*/, '').trim()
  let h: number
  let min = 0
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/)
  if (m) {
    h = parseInt(m[1], 10)
    min = m[2] != null ? parseInt(m[2], 10) : 0
  } else if (/^\d{3,4}$/.test(s)) {
    const digits = s.padStart(4, '0')
    h = parseInt(digits.slice(0, 2), 10)
    min = parseInt(digits.slice(2), 10)
  } else {
    return null
  }
  if (ampm === 'pm' && h < 12) h += 12
  if (ampm === 'am' && h === 12) h = 0
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Parse weekdays from numbers (0=Sunday..6=Saturday), names ("Mon", "tuesday"),
 * or the words "weekdays"/"weekends"/"daily", as an array or a comma list.
 * Returns a sorted, de-duplicated list, or null when nothing valid was found. */
export function parseDays(value: unknown): number[] | null {
  const tokens: unknown[] =
    typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value : []
  const days = new Set<number>()
  for (const raw of tokens) {
    if (typeof raw === 'number' && Number.isInteger(raw)) {
      if (raw >= 0 && raw <= 7) days.add(raw % 7)
      continue
    }
    if (typeof raw !== 'string') continue
    const t = raw.trim().toLowerCase()
    if (!t) continue
    if (/^\d$/.test(t)) {
      if (parseInt(t, 10) <= 7) days.add(parseInt(t, 10) % 7)
    } else if (t.startsWith('weekday')) {
      for (const d of [1, 2, 3, 4, 5]) days.add(d)
    } else if (t.startsWith('weekend')) {
      days.add(0)
      days.add(6)
    } else if (t === 'daily' || t === 'everyday') {
      for (let d = 0; d < 7; d++) days.add(d)
    } else {
      const idx = DAY_SHORT.findIndex((n) => t.startsWith(n.toLowerCase()))
      if (idx >= 0) days.add(idx)
    }
  }
  return days.size ? [...days].sort((a, b) => a - b) : null
}

/**
 * Coerce a model- or user-supplied trigger into a valid PitcherTrigger, or
 * `{ type: 'on-open' }` when it can't be read. `fallbackAt` is a loose top-level
 * time some weak models send beside (not inside) the trigger object.
 */
export function normalizeTrigger(value: unknown, fallbackAt?: unknown): PitcherTrigger {
  const onOpen: PitcherTrigger = { type: 'on-open' }
  if (!value || typeof value !== 'object') {
    const at = parseClock(fallbackAt)
    return at ? { type: 'daily', at } : onOpen
  }
  const rec = value as Record<string, unknown>
  const at = parseClock(rec.at ?? fallbackAt)
  switch (rec.type) {
    case 'on-open':
      return onOpen
    case 'weekly': {
      const days = parseDays(rec.days ?? rec.day)
      return at && days ? { type: 'weekly', days, at } : onOpen
    }
    case 'monthly': {
      const day = Number(rec.day)
      return at && Number.isInteger(day) && day >= 1 && day <= 31
        ? { type: 'monthly', day, at }
        : onOpen
    }
    case 'interval': {
      const minutes =
        rec.everyMinutes != null
          ? Number(rec.everyMinutes)
          : rec.everyHours != null
            ? Number(rec.everyHours) * 60
            : NaN
      if (!Number.isFinite(minutes)) return onOpen
      const clamped = Math.min(
        MAX_INTERVAL_MINUTES,
        Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes))
      )
      return { type: 'interval', everyMinutes: clamped }
    }
    default:
      return at ? { type: 'daily', at } : onOpen
  }
}

const daysInMonth = (d: Date): number => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()

function occursOn(t: PitcherTrigger, d: Date): boolean {
  switch (t.type) {
    case 'daily':
      return true
    case 'weekly':
      return t.days.includes(d.getDay())
    case 'monthly':
      // A day past the month's end (31 in April) fires on the last day instead.
      return d.getDate() === Math.min(t.day, daysInMonth(d))
    default:
      return false
  }
}

function atOnDay(d: Date, at: string): Date {
  const [h, m] = at.split(':').map((n) => parseInt(n, 10))
  const r = new Date(d)
  r.setHours(h, m, 0, 0)
  return r
}

// Gap between fires never exceeds a month, so this bounds the day scan.
const SCAN_DAYS = 62

/** Epoch ms of the first calendar fire strictly after `after`; null for
 * triggers that aren't tied to the clock (on-open, interval). */
export function nextFireAt(t: PitcherTrigger, after = new Date()): number | null {
  if (t.type === 'on-open' || t.type === 'interval') return null
  for (let i = 0; i <= SCAN_DAYS; i++) {
    const d = new Date(after)
    d.setDate(d.getDate() + i)
    if (!occursOn(t, d)) continue
    const fire = atOnDay(d, t.at)
    if (fire.getTime() > after.getTime()) return fire.getTime()
  }
  return null
}

/** Epoch ms of the most recent calendar fire at or before `now`, or null. */
export function lastFireAt(t: PitcherTrigger, now = new Date()): number | null {
  if (t.type === 'on-open' || t.type === 'interval') return null
  for (let i = 0; i <= SCAN_DAYS; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    if (!occursOn(t, d)) continue
    const fire = atOnDay(d, t.at)
    if (fire.getTime() <= now.getTime()) return fire.getTime()
  }
  return null
}

/**
 * True when the Pitcher's most recent scheduled time has passed with no record
 * of handling it, i.e. the app was closed at that time. A fire counts as handled
 * if it was poured (lastRunAt) or deliberately stopped (lastStoppedAt), so a pour
 * you stopped isn't re-run on the next launch. Weekly and monthly tasks that
 * have never been handled don't catch up: their last fire could be days or weeks
 * before the task was created.
 */
export function isMissed(
  p: Pick<Pitcher, 'trigger' | 'lastRunAt' | 'lastStoppedAt'>,
  now = new Date()
): boolean {
  const last = lastFireAt(p.trigger, now)
  if (last == null) return false
  const handledSince = Math.max(p.lastRunAt ?? 0, p.lastStoppedAt ?? 0)
  if (handledSince === 0 && p.trigger.type !== 'daily') return false
  return handledSince < last
}

function ordinal(n: number): string {
  const rem = n % 100
  if (rem >= 11 && rem <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

function describeInterval(minutes: number): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60
    return h === 1 ? 'Every hour' : `Every ${h} hours`
  }
  return `Every ${minutes} minutes`
}

/** Short human label for a trigger, shown in the Pitchers panel. */
export function describeTrigger(t: PitcherTrigger): string {
  switch (t.type) {
    case 'on-open':
      return 'When the app opens'
    case 'daily':
      return `Daily at ${t.at}`
    case 'weekly': {
      if (t.days.length === 7) return `Daily at ${t.at}`
      if (t.days.join() === '1,2,3,4,5') return `Weekdays at ${t.at}`
      if (t.days.join() === '0,6') return `Weekends at ${t.at}`
      return `Weekly on ${t.days.map((d) => DAY_SHORT[d]).join(', ')} at ${t.at}`
    }
    case 'monthly':
      return `Monthly on the ${ordinal(t.day)} at ${t.at}`
    case 'interval':
      return describeInterval(t.everyMinutes)
  }
}
