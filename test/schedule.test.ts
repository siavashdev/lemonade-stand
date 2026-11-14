import { describe, expect, it } from 'vitest'
import {
  describeTrigger,
  isMissed,
  lastFireAt,
  nextFireAt,
  normalizeTrigger
} from '../src/shared/schedule'

// Local-time constructor; 2026-11-16 is a Monday.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi)

describe('normalizeTrigger', () => {
  it('reads weekly days from names, numbers, and group words', () => {
    expect(normalizeTrigger({ type: 'weekly', days: ['Monday', 'thu'], at: '9am' })).toEqual({
      type: 'weekly',
      days: [1, 4],
      at: '09:00'
    })
    expect(normalizeTrigger({ type: 'weekly', days: 'weekdays', at: '08:00' })).toMatchObject({
      days: [1, 2, 3, 4, 5]
    })
    expect(normalizeTrigger({ type: 'weekly', days: [7, 0], at: '08:00' })).toMatchObject({
      days: [0]
    })
  })

  it('falls back to on-open when a required field is missing or invalid', () => {
    expect(normalizeTrigger({ type: 'weekly', at: '08:00' })).toEqual({ type: 'on-open' })
    expect(normalizeTrigger({ type: 'monthly', day: 32, at: '08:00' })).toEqual({ type: 'on-open' })
    expect(normalizeTrigger({ type: 'monthly', day: 5 })).toEqual({ type: 'on-open' })
    expect(normalizeTrigger({ type: 'interval' })).toEqual({ type: 'on-open' })
  })

  it('clamps intervals and keeps the legacy daily forms working', () => {
    expect(normalizeTrigger({ type: 'interval', everyMinutes: 1 })).toEqual({
      type: 'interval',
      everyMinutes: 5
    })
    expect(normalizeTrigger({ type: 'interval', everyHours: 2 })).toEqual({
      type: 'interval',
      everyMinutes: 120
    })
    expect(normalizeTrigger({ type: 'daily', at: '8:30 pm' })).toEqual({ type: 'daily', at: '20:30' })
    expect(normalizeTrigger(undefined, '0800')).toEqual({ type: 'daily', at: '08:00' })
  })
})

describe('nextFireAt / lastFireAt', () => {
  const weekly = { type: 'weekly', days: [1, 4], at: '09:00' } as const

  it('finds the next weekly fire, skipping non-selected days and past times', () => {
    // Monday 10:00 is after the 09:00 fire, so the next one is Thursday.
    expect(nextFireAt(weekly, at(2026, 11, 16, 10))).toBe(at(2026, 11, 19, 9).getTime())
    expect(nextFireAt(weekly, at(2026, 11, 16, 8))).toBe(at(2026, 11, 16, 9).getTime())
  })

  it('clamps a monthly day to the last day of a short month', () => {
    const monthly = { type: 'monthly', day: 31, at: '07:00' } as const
    expect(nextFireAt(monthly, at(2026, 4, 1))).toBe(at(2026, 4, 30, 7).getTime())
    expect(nextFireAt(monthly, at(2026, 2, 1))).toBe(at(2026, 2, 28, 7).getTime())
    expect(lastFireAt(monthly, at(2026, 5, 10))).toBe(at(2026, 4, 30, 7).getTime())
  })

  it('has no calendar fire for on-open and interval', () => {
    expect(nextFireAt({ type: 'on-open' })).toBeNull()
    expect(nextFireAt({ type: 'interval', everyMinutes: 30 })).toBeNull()
  })
})

describe('isMissed', () => {
  const weekly = { type: 'weekly', days: [1], at: '09:00' } as const
  const now = at(2026, 11, 18, 12) // Wednesday; last fire was Monday 09:00

  it('catches up a weekly fire that came and went unhandled', () => {
    expect(isMissed({ trigger: weekly, lastRunAt: at(2026, 11, 9, 9).getTime() }, now)).toBe(true)
    expect(isMissed({ trigger: weekly, lastRunAt: at(2026, 11, 16, 9, 1).getTime() }, now)).toBe(false)
    expect(isMissed({ trigger: weekly, lastStoppedAt: at(2026, 11, 16, 9, 1).getTime() }, now)).toBe(
      false
    )
  })

  it('does not catch up a never-run weekly task, but still does for daily', () => {
    expect(isMissed({ trigger: weekly }, now)).toBe(false)
    expect(isMissed({ trigger: { type: 'daily', at: '09:00' } }, now)).toBe(true)
  })

  it('never reports on-open or interval as missed', () => {
    expect(isMissed({ trigger: { type: 'on-open' } }, now)).toBe(false)
    expect(isMissed({ trigger: { type: 'interval', everyMinutes: 60 } }, now)).toBe(false)
  })
})

describe('describeTrigger', () => {
  it('labels each trigger type', () => {
    expect(describeTrigger({ type: 'weekly', days: [1, 2, 3, 4, 5], at: '08:00' })).toBe(
      'Weekdays at 08:00'
    )
    expect(describeTrigger({ type: 'weekly', days: [1, 4], at: '08:00' })).toBe(
      'Weekly on Mon, Thu at 08:00'
    )
    expect(describeTrigger({ type: 'monthly', day: 22, at: '08:00' })).toBe(
      'Monthly on the 22nd at 08:00'
    )
    expect(describeTrigger({ type: 'interval', everyMinutes: 120 })).toBe('Every 2 hours')
    expect(describeTrigger({ type: 'interval', everyMinutes: 45 })).toBe('Every 45 minutes')
  })
})
