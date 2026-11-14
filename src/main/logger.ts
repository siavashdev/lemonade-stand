import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import type { LogEntry, LogSeverity } from '@shared/types'

// The app's own diagnostics. Every console.log/info/warn/error/debug from the
// main process (plus the renderer's console, relayed by index.ts) is kept in a
// bounded in-memory buffer so the in-app "Lemonade Stand logs" viewer can show
// what the app has been doing , always, with nothing written to disk. Writing a
// rolling text file as well is opt-in (LOG_LEVEL=debug or `"logLevel": "debug"`
// in config/settings.json) for sharing with a bug report.

const MAX_ENTRIES = 5000
// A single runaway line (a huge JSON blob, a base64 payload) must not be able to
// bloat the buffer, so lines are clipped when recorded.
const MAX_MESSAGE_CHARS = 4000

/** Zero-padded `YYYY-MM-DD HH:mm:ss.mmm` in local time, matching the shape of
 * the server's own timestamps so both viewers read the same. */
export function formatLogTimestamp(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`
  )
}

/** Split a leading `[tag]` marker off a console message, so
 * `"[mcp] connected …"` becomes tag `mcp` and message `connected …`. Messages
 * without a marker keep `fallback` as their tag. */
export function splitLogTag(text: string, fallback: string): { tag: string; message: string } {
  const match = /^\[([A-Za-z][\w:.-]{0,31})\]\s*([\s\S]*)$/.exec(text)
  return match ? { tag: match[1], message: match[2] } : { tag: fallback, message: text }
}

// Node reports its process warnings ("(node:1234) [DEP0040] DeprecationWarning:
// …") through console.error. They are notices, not failures, so they are filed
// as warnings rather than showing up red on every launch.
const NODE_WARNING = /^\(node:\d+\) (?:\[[A-Z0-9_]+\] )?\w*Warning:/

/** How one console call is filed in the log: its severity, tag and message. */
export function classifyConsoleCall(
  method: 'log' | 'info' | 'warn' | 'error' | 'debug',
  text: string
): { severity: LogSeverity; tag: string; message: string } {
  if (method === 'error' && NODE_WARNING.test(text)) {
    return { severity: 'warning', tag: 'node', message: text }
  }
  const severity: LogSeverity =
    method === 'warn' ? 'warning' : method === 'error' ? 'error' : method === 'debug' ? 'debug' : 'info'
  return { severity, ...splitLogTag(text, 'main') }
}

/** A bounded, ordered, subscribable list of log lines. */
export class LogBuffer {
  private entries: LogEntry[] = []
  private nextSeq = 1
  private listeners = new Set<(entry: LogEntry) => void>()

  constructor(private readonly max = MAX_ENTRIES) {}

  /** Append a line, evicting the oldest once full, and notify subscribers. */
  add(severity: LogSeverity, tag: string, message: string, now: Date = new Date()): LogEntry {
    const clipped =
      message.length > MAX_MESSAGE_CHARS
        ? `${message.slice(0, MAX_MESSAGE_CHARS)}… (+${message.length - MAX_MESSAGE_CHARS} chars)`
        : message
    const entry: LogEntry = {
      seq: this.nextSeq++,
      timestamp: formatLogTimestamp(now),
      severity,
      tag,
      message: clipped
    }
    this.entries.push(entry)
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
    for (const listener of this.listeners) {
      try {
        listener(entry)
      } catch {
        // A faulty subscriber must never break logging itself.
      }
    }
    return entry
  }

  /** A copy of the retained lines, oldest first. */
  snapshot(): LogEntry[] {
    return this.entries.slice()
  }

  /** Receive every line added from now on. Returns an unsubscribe function. */
  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

const appLog = new LogBuffer()
let logFilePath: string | null = null
let consoleCaptured = false

/** Record one line from the renderer (its console), tagged `ui`. */
export function recordUiLog(severity: LogSeverity, message: string): void {
  const entry = appLog.add(severity, 'ui', message)
  writeToFile(entry)
}

/** The app's retained log lines, oldest first. */
export function getAppLogs(): LogEntry[] {
  return appLog.snapshot()
}

/** Receive each new app log line. Returns an unsubscribe function. */
export function subscribeAppLogs(listener: (entry: LogEntry) => void): () => void {
  return appLog.subscribe(listener)
}

/** The active log file path, or null when file logging is off. */
export function getLogFilePath(): string | null {
  return logFilePath
}

/**
 * Mirror console.log/info/warn/error/debug into the in-memory buffer (still
 * printing to the real console as before). Call once, as early as possible, so
 * startup output is captured too. Idempotent.
 */
export function installConsoleCapture(): void {
  if (consoleCaptured) return
  consoleCaptured = true
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
  let recording = false
  for (const method of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]): void => {
      original(...args)
      // Guard against re-entrancy: nothing below may log through the console.
      if (recording) return
      recording = true
      try {
        const { severity, tag, message } = classifyConsoleCall(method, format(...args))
        writeToFile(appLog.add(severity, tag, message))
      } catch {
        // Best-effort: logging must never throw into the app.
      } finally {
        recording = false
      }
    }
  }
}

/**
 * Also write every line to `lemonade-stand.log` in `dir`. No-op when `enabled`
 * is false. Lines already captured this run are written first, so the file
 * starts with the app's startup output. Returns the log file path (or null when
 * disabled / not writable).
 */
export function initFileLogging(dir: string, enabled: boolean, header?: string): string | null {
  if (!enabled) return null
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'lemonade-stand.log')
    appendFileSync(
      file,
      `\n===== session started ${new Date().toISOString()}${header ? ` ${header}` : ''} =====\n`
    )
    for (const entry of appLog.snapshot()) appendFileSync(file, formatFileLine(entry))
    logFilePath = file
  } catch (err) {
    // If the log location isn't writable, keep running without file logging.
    console.error('[logger] could not open log file:', err)
    return null
  }
  return logFilePath
}

function formatFileLine(entry: LogEntry): string {
  return `[${entry.timestamp}] [${entry.severity}] [${entry.tag}] ${entry.message}\n`
}

function writeToFile(entry: LogEntry): void {
  if (!logFilePath) return
  try {
    appendFileSync(logFilePath, formatFileLine(entry))
  } catch {
    // Best-effort: never let logging throw into the app.
  }
}
