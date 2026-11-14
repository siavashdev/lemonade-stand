import type { LogEntry, LogSeverity } from '@shared/types'

// Pure helpers behind the log viewers (kept free of React so they can be tested).

/** Ordering of severities, so "warnings and above" is a single comparison. */
export const SEVERITY_RANK: Record<LogSeverity, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warning: 3,
  error: 4,
  fatal: 5
}

/** Fixed-width-ish labels shown in the level column. */
export const SEVERITY_LABEL: Record<LogSeverity, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  fatal: 'FATAL'
}

/** The choices in the viewer's level filter; `min` is the lowest rank shown. */
export const LEVEL_FILTERS: { id: string; label: string; min: number }[] = [
  { id: 'all', label: 'All levels', min: 0 },
  { id: 'info', label: 'Info and above', min: SEVERITY_RANK.info },
  { id: 'warning', label: 'Warnings and errors', min: SEVERITY_RANK.warning },
  { id: 'error', label: 'Errors only', min: SEVERITY_RANK.error }
]

/** Entries at or above `min` severity whose tag or message contains `query`
 * (case-insensitive). An empty query matches everything. */
export function filterLogEntries(
  entries: readonly LogEntry[],
  min: number,
  query: string
): LogEntry[] {
  const needle = query.trim().toLowerCase()
  return entries.filter((e) => {
    if (SEVERITY_RANK[e.severity] < min) return false
    if (!needle) return true
    return e.message.toLowerCase().includes(needle) || e.tag.toLowerCase().includes(needle)
  })
}

/** One entry as plain text, the way it is copied: `time [LEVEL] (tag) message`. */
export function formatLogEntry(entry: LogEntry): string {
  return `${entry.timestamp} [${SEVERITY_LABEL[entry.severity]}] (${entry.tag}) ${entry.message}`
}

/** The time-of-day part of a `YYYY-MM-DD HH:mm:ss.mmm` timestamp (the full value
 * is kept as a tooltip); anything else is returned unchanged. */
export function shortTime(timestamp: string): string {
  const space = timestamp.indexOf(' ')
  return space === -1 ? timestamp : timestamp.slice(space + 1)
}

/** `list` followed by `batch`, trimmed to the newest `max` entries. */
export function appendCapped(
  list: readonly LogEntry[],
  batch: readonly LogEntry[],
  max: number
): LogEntry[] {
  const next = list.concat(batch)
  return next.length > max ? next.slice(next.length - max) : next
}

/** Collect rapid log entries and commit them as one render-sized batch. */
export function createLogBatcher(
  commit: (batch: LogEntry[]) => void,
  delayMs: number
): {
  push: (entry: LogEntry) => void
  reset: () => void
  dispose: () => void
} {
  let pending: LogEntry[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    push(entry) {
      pending.push(entry)
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        const batch = pending
        pending = []
        if (batch.length > 0) commit(batch)
      }, delayMs)
    },
    reset() {
      pending = []
    },
    dispose() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = []
    }
  }
}
