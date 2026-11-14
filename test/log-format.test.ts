import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@shared/types'
import {
  appendCapped,
  createLogBatcher,
  filterLogEntries,
  formatLogEntry,
  LEVEL_FILTERS,
  SEVERITY_RANK,
  shortTime
} from '../src/renderer/logFormat'

const entry = (seq: number, over: Partial<LogEntry> = {}): LogEntry => ({
  seq,
  timestamp: '2026-11-13 20:46:56.055',
  severity: 'info',
  tag: 'main',
  message: `line ${seq}`,
  ...over
})

describe('level filters', () => {
  it('offer all / info+ / warnings+ / errors, in increasing strictness', () => {
    expect(LEVEL_FILTERS.map((f) => f.id)).toEqual(['all', 'info', 'warning', 'error'])
    const mins = LEVEL_FILTERS.map((f) => f.min)
    expect([...mins].sort((a, b) => a - b)).toEqual(mins)
  })
})

describe('filterLogEntries', () => {
  const entries = [
    entry(1, { severity: 'debug', message: 'cache warmed' }),
    entry(2, { severity: 'info', message: 'Loaded model Qwen3', tag: 'lemonade' }),
    entry(3, { severity: 'warning', message: 'slow response' }),
    entry(4, { severity: 'error', message: 'Connection refused', tag: 'mcp' }),
    entry(5, { severity: 'fatal', message: 'out of memory' })
  ]
  const ids = (list: LogEntry[]): number[] => list.map((e) => e.seq)

  it('keeps entries at or above the chosen level', () => {
    expect(ids(filterLogEntries(entries, 0, ''))).toEqual([1, 2, 3, 4, 5])
    expect(ids(filterLogEntries(entries, SEVERITY_RANK.info, ''))).toEqual([2, 3, 4, 5])
    expect(ids(filterLogEntries(entries, SEVERITY_RANK.warning, ''))).toEqual([3, 4, 5])
    expect(ids(filterLogEntries(entries, SEVERITY_RANK.error, ''))).toEqual([4, 5])
  })

  it('searches message and tag, ignoring case and surrounding spaces', () => {
    expect(ids(filterLogEntries(entries, 0, '  MODEL '))).toEqual([2])
    expect(ids(filterLogEntries(entries, 0, 'mcp'))).toEqual([4])
    expect(ids(filterLogEntries(entries, 0, 'nothing like this'))).toEqual([])
  })

  it('combines the level and the search', () => {
    expect(ids(filterLogEntries(entries, SEVERITY_RANK.warning, 'o'))).toEqual([3, 4, 5])
    expect(ids(filterLogEntries(entries, SEVERITY_RANK.error, 'slow'))).toEqual([])
  })

  it('does not modify the list it is given', () => {
    const before = entries.slice()
    filterLogEntries(entries, SEVERITY_RANK.error, 'x')
    expect(entries).toEqual(before)
  })
})

describe('formatLogEntry', () => {
  it('writes time, level, tag and message on one line for copying', () => {
    expect(formatLogEntry(entry(1, { severity: 'warning', tag: 'Router', message: 'careful' }))).toBe(
      '2026-11-13 20:46:56.055 [WARN] (Router) careful'
    )
    expect(formatLogEntry(entry(1, { severity: 'error' }))).toContain('[ERROR]')
  })
})

describe('shortTime', () => {
  it('keeps just the time of day', () => {
    expect(shortTime('2026-11-13 20:46:56.055')).toBe('20:46:56.055')
  })

  it('leaves anything else alone', () => {
    expect(shortTime('20:46:56.055')).toBe('20:46:56.055')
    expect(shortTime('')).toBe('')
  })
})

describe('appendCapped', () => {
  it('appends a batch', () => {
    expect(appendCapped([entry(1)], [entry(2), entry(3)], 10).map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('drops the oldest entries beyond the cap', () => {
    const list = [entry(1), entry(2), entry(3)]
    expect(appendCapped(list, [entry(4), entry(5)], 4).map((e) => e.seq)).toEqual([2, 3, 4, 5])
    expect(appendCapped([], [entry(1), entry(2), entry(3)], 2).map((e) => e.seq)).toEqual([2, 3])
  })

  it('returns a new array and leaves the inputs untouched', () => {
    const list = [entry(1)]
    const batch = [entry(2)]
    const next = appendCapped(list, batch, 5)
    expect(next).not.toBe(list)
    expect(list).toHaveLength(1)
    expect(batch).toHaveLength(1)
  })
})

describe('createLogBatcher', () => {
  afterEach(() => vi.useRealTimers())

  it('commits rapid entries together', () => {
    vi.useFakeTimers()
    const batches: LogEntry[][] = []
    const batcher = createLogBatcher((batch) => batches.push(batch), 100)
    batcher.push(entry(1))
    batcher.push(entry(2))
    vi.advanceTimersByTime(99)
    expect(batches).toEqual([])
    vi.advanceTimersByTime(1)
    expect(batches.map((batch) => batch.map((item) => item.seq))).toEqual([[1, 2]])
    batcher.dispose()
  })

  it('drops queued entries on reset and dispose', () => {
    vi.useFakeTimers()
    const batches: LogEntry[][] = []
    const batcher = createLogBatcher((batch) => batches.push(batch), 100)
    batcher.push(entry(1))
    batcher.reset()
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([])

    batcher.push(entry(2))
    batcher.dispose()
    vi.advanceTimersByTime(100)
    expect(batches).toEqual([])
  })
})
