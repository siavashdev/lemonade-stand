import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, UIEvent } from 'react'
import type { LogEntry } from '@shared/types'
import { DocumentTextIcon, ServerIcon } from './icons'
import {
  LEVEL_FILTERS,
  SEVERITY_LABEL,
  appendCapped,
  createLogBatcher,
  filterLogEntries,
  formatLogEntry,
  shortTime
} from './logFormat'

/** Which log a viewer shows: the Lemonade server's, or this app's own. */
export type LogSource = 'server' | 'app'

// Most lines kept in memory; as new ones arrive the oldest fall off.
const MAX_LINES = 5000
// Most lines drawn at once (the newest matching ones), so a full buffer still
// scrolls and filters smoothly. Narrow with the search box to dig further back.
const MAX_RENDERED = 1500
// A busy server can emit hundreds of lines a second; live lines are collected
// and committed together at this interval instead of one re-render per line.
const FLUSH_MS = 100

interface StreamStatus {
  state: 'connecting' | 'live' | 'closed'
  message?: string
}

const COPY: Record<LogSource, { title: string; blurb: string }> = {
  server: {
    title: 'Lemonade Server logs',
    blurb: 'Live output from the Lemonade server this app is connected to.'
  },
  app: {
    title: 'Lemonade Stand logs',
    blurb: "What this app has been doing: its own output plus the interface's console."
  }
}

// React keys for rows. A line's own `seq` isn't enough: the server restarts its
// counter when it restarts, and a position-based key would remount every row each
// time the oldest lines fall off. So each entry object gets an id the first time
// it is drawn, which stays with it for as long as it is retained.
const rowKeys = new WeakMap<LogEntry, number>()
let nextRowKey = 1
function rowKey(entry: LogEntry): number {
  let key = rowKeys.get(entry)
  if (key === undefined) {
    key = nextRowKey++
    rowKeys.set(entry, key)
  }
  return key
}

const LogLine = memo(function LogLine({ entry }: { entry: LogEntry }): JSX.Element {
  return (
    <div className={`log-line sev-${entry.severity}`}>
      <span className="log-ts" title={entry.timestamp}>
        {shortTime(entry.timestamp)}
      </span>
      <span className="log-sev">{SEVERITY_LABEL[entry.severity]}</span>
      <span className="log-tag" title={entry.tag}>
        {entry.tag}
      </span>
      <span className="log-msg">{entry.message}</span>
    </div>
  )
})

/**
 * A read-only log viewer shown from the hamburger menu. `server` streams the
 * Lemonade server's own log (backlog first, then live); `app` shows what this
 * app has logged. Both can be searched, filtered by level, followed live, and
 * copied.
 */
export function LogViewer({
  source,
  onClose
}: {
  source: LogSource
  onClose: () => void
}): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [status, setStatus] = useState<StreamStatus>({ state: 'connecting' })
  // The on-disk copy of the app log, when file logging is enabled.
  const [filePath, setFilePath] = useState<string | null>(null)
  const [levelId, setLevelId] = useState('all')
  const [query, setQuery] = useState('')
  // Keep the newest line in view. Scrolling up turns it off; scrolling back to
  // the bottom (or pressing Follow) turns it back on.
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const batcherRef = useRef<ReturnType<typeof createLogBatcher> | null>(null)

  useEffect(() => {
    setEntries([])
    setStatus({ state: 'connecting' })
    const batcher = createLogBatcher(
      (batch) => setEntries((prev) => appendCapped(prev, batch, MAX_LINES)),
      FLUSH_MS
    )
    batcherRef.current = batcher
    if (source === 'server') {
      // The main process owns the WebSocket (the renderer's CSP can't connect out)
      // and relays its status, then the server's backlog, then each new line.
      const off = window.api.onServerLog((event) => {
        if (event.type === 'status') {
          setStatus({ state: event.state, message: event.message })
        } else if (event.type === 'snapshot') {
          batcher.reset()
          setEntries(event.entries.slice(-MAX_LINES))
        } else {
          batcher.push(event.entry)
        }
      })
      return () => {
        off()
        batcher.dispose()
        if (batcherRef.current === batcher) batcherRef.current = null
      }
    }

    // App log: subscribe to live lines first, then read the backlog; lines that
    // arrive in between are merged in, skipping any the backlog already holds.
    let cancelled = false
    let ready = false
    const early: LogEntry[] = []
    const off = window.api.onAppLog((entry) => {
      if (ready) batcher.push(entry)
      else early.push(entry)
    })
    window.api
      .getAppLogs()
      .then((snapshot) => {
        if (cancelled) return
        const newest = snapshot.entries.at(-1)?.seq ?? 0
        setEntries(
          appendCapped(
            snapshot.entries,
            early.filter((e) => e.seq > newest),
            MAX_LINES
          )
        )
        setFilePath(snapshot.filePath)
        setStatus({ state: 'live' })
        ready = true
      })
      .catch((err) =>
        setStatus({ state: 'closed', message: err instanceof Error ? err.message : String(err) })
      )
    return () => {
      cancelled = true
      off()
      batcher.dispose()
      if (batcherRef.current === batcher) batcherRef.current = null
    }
  }, [source])

  const minLevel = LEVEL_FILTERS.find((f) => f.id === levelId)?.min ?? 0
  const visible = useMemo(
    () => filterLogEntries(entries, minLevel, query),
    [entries, minLevel, query]
  )
  const shown = visible.length > MAX_RENDERED ? visible.slice(visible.length - MAX_RENDERED) : visible

  // Stay pinned to the newest line while following.
  useEffect(() => {
    const el = bodyRef.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [visible, follow])

  function onScroll(e: UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 32)
  }

  async function copyVisible(): Promise<void> {
    try {
      await navigator.clipboard.writeText(visible.map(formatLogEntry).join('\n'))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access denied; leave the button as it was.
    }
  }

  const meta = COPY[source]
  const filtering = query.trim() !== '' || minLevel > 0
  const statusLabel =
    status.state === 'live' ? 'Live' : status.state === 'connecting' ? 'Connecting…' : 'Disconnected'

  return (
    <div className="pantry-overlay logs-overlay" onClick={onClose}>
      <section
        className="logs-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={meta.title}
      >
        <header className="pantry-head">
          <div>
            <h2>
              {source === 'server' ? <ServerIcon /> : <DocumentTextIcon />} {meta.title}
            </h2>
            <p className="pantry-sub">{meta.blurb}</p>
          </div>
          <button className="pantry-close" onClick={onClose} aria-label="Close" title="Close">
            ✕
          </button>
        </header>

        <div className="logs-toolbar">
          <input
            type="search"
            className="models-search-input logs-search"
            placeholder="Search logs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search logs"
          />
          <select
            className="logs-select"
            value={levelId}
            onChange={(e) => setLevelId(e.target.value)}
            aria-label="Filter by level"
          >
            {LEVEL_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <button
            className={`logs-btn ${follow ? 'on' : ''}`}
            onClick={() => setFollow((f) => !f)}
            aria-pressed={follow}
            title="Keep the newest line in view"
          >
            Follow
          </button>
          <button
            className="logs-btn"
            onClick={() => void copyVisible()}
            disabled={visible.length === 0}
            title="Copy the lines currently shown"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            className="logs-btn"
            onClick={() => {
              batcherRef.current?.reset()
              setEntries([])
            }}
            disabled={entries.length === 0}
            title="Clear this view (the log itself is kept)"
          >
            Clear
          </button>
        </div>

        <div className="logs-body" ref={bodyRef} onScroll={onScroll} role="log" aria-live="off" tabIndex={0}>
          {entries.length === 0 && (
            <div className="logs-empty">
              {status.state === 'connecting'
                ? 'Connecting…'
                : (status.message ??
                  (status.state === 'closed' ? 'Disconnected.' : 'No log lines yet.'))}
            </div>
          )}
          {entries.length > 0 && visible.length === 0 && (
            <div className="logs-empty">No lines match the current search or level.</div>
          )}
          {visible.length > shown.length && (
            <div className="logs-note">
              Showing the newest {shown.length.toLocaleString()} of {visible.length.toLocaleString()} matching
              lines. Narrow the search to see older ones.
            </div>
          )}
          {shown.map((entry) => (
            <LogLine key={rowKey(entry)} entry={entry} />
          ))}
        </div>

        <footer className="logs-foot">
          <span className={`logs-state ${status.state}`}>
            <span className="logs-dot" aria-hidden="true" />
            {statusLabel}
          </span>
          <span>
            {filtering
              ? `${visible.length.toLocaleString()} of ${entries.length.toLocaleString()} lines`
              : `${entries.length.toLocaleString()} lines`}
          </span>
          {status.message && entries.length > 0 && (
            <span className="logs-foot-msg">{status.message}</span>
          )}
          {source === 'app' &&
            (filePath ? (
              <span className="logs-foot-file">
                Also saved to <code>{filePath}</code>
                <button className="link-inline" onClick={() => void window.api.revealAppLogFile()}>
                  Show file
                </button>
              </span>
            ) : (
              <span className="logs-foot-file">
                Kept in memory only. Set <code>LOG_LEVEL=debug</code> to also write a log file.
              </span>
            ))}
        </footer>
      </section>
    </div>
  )
}
