import type { LogEntry, LogSeverity, ServerLogEvent } from '@shared/types'

// Streams the Lemonade server's own logs for the in-app "Lemonade Server logs"
// viewer. lemond serves them over a WebSocket (`/logs/stream`): the client sends
// a `logs.subscribe` message, gets back a `logs.snapshot` of up to 5000 retained
// lines, then a `logs.entry` for every new one. The connection is opened from the
// main process because the renderer's CSP only allows its own origin.

/** Delays between reconnect attempts while the viewer stays open; the last one
 * repeats, so a server that's down (or restarting) is retried every 10 s. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000]

/**
 * The log-stream WebSocket URL for a configured chat base URL. The chat base ends
 * in the REST version prefix (`…/api/v1`); the stream lives at the server root,
 * so that suffix is dropped while any reverse-proxy prefix in front of it is kept
 * (`http://host/lemonade/api/v1` → `ws://host/lemonade/logs/stream`). The API key,
 * when set, travels as the `api_key` query parameter (the WebSocket API can't
 * send an Authorization header). Returns undefined for an unparseable base URL.
 */
export function serverLogsUrl(baseUrl: string, apiKey: string): string | undefined {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/(?:api\/)?v\d+$/, '')
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const target = new URL(`${scheme}//${url.host}${prefix}/logs/stream`)
  if (apiKey) target.searchParams.set('api_key', apiKey)
  return target.toString()
}

/** Map the server's severity word (Trace, Debug, Info, Warning, Error, Fatal, or
 * the short `Warn` its log lines use) onto the shared lower-case scale. */
function normalizeSeverity(value: unknown): LogSeverity {
  switch (typeof value === 'string' ? value.toLowerCase() : '') {
    case 'trace':
      return 'trace'
    case 'debug':
      return 'debug'
    case 'warn':
    case 'warning':
      return 'warning'
    case 'error':
      return 'error'
    case 'fatal':
      return 'fatal'
    default:
      return 'info'
  }
}

// lemond formats each line as "<date> <time> [Level] (Tag) message". The viewer
// shows timestamp, level and tag in their own columns, so peel that prefix off
// the message instead of printing it twice.
const SERVER_LINE_PREFIX = /^\S+ \S+ \[[A-Za-z]+\] \([^)]*\) ([\s\S]*)$/

/** Convert one wire-format log entry into the shared shape; null when malformed. */
export function toServerLogEntry(raw: unknown): LogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const line = typeof r.line === 'string' ? r.line : ''
  if (!line) return null
  const stripped = SERVER_LINE_PREFIX.exec(line)
  return {
    seq: typeof r.seq === 'number' ? r.seq : 0,
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
    severity: normalizeSeverity(r.severity),
    tag: typeof r.tag === 'string' && r.tag ? r.tag : 'server',
    message: stripped ? stripped[1] : line
  }
}

/** Decode one text frame from the log stream into a viewer event; null when the
 * frame isn't something the viewer understands. */
export function parseServerLogMessage(raw: string): ServerLogEvent | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  switch (m.type) {
    case 'logs.snapshot': {
      const entries = Array.isArray(m.entries)
        ? m.entries.map(toServerLogEntry).filter((e): e is LogEntry => e !== null)
        : []
      return { type: 'snapshot', entries }
    }
    case 'logs.entry': {
      const entry = toServerLogEntry(m.entry)
      return entry ? { type: 'entry', entry } : null
    }
    case 'error': {
      const detail =
        typeof m.message === 'string' ? m.message : typeof m.error === 'string' ? m.error : ''
      return {
        type: 'status',
        state: 'live',
        message: `The server reported an error on the log stream${detail ? `: ${detail}` : '.'}`
      }
    }
    default:
      return null
  }
}

/** The slice of the WebSocket API the stream uses, so tests can substitute a fake. */
export interface LogSocket {
  addEventListener(type: string, listener: (event: never) => void): void
  send(data: string): void
  close(): void
}

type SocketFactory = (url: string) => LogSocket

// Node 22+ (Electron 43 ships Node 24) provides a global WebSocket client. It is
// resolved lazily so merely importing this module never requires it.
const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as LogSocket

/**
 * One live connection to the server's log stream, reconnecting with backoff for
 * as long as it is started. Each (re)connect asks the server for its full backlog
 * again rather than resuming by sequence number: the server restarts its counter
 * when it restarts, so a stale resume point would silently skip lines.
 */
export class ServerLogStream {
  private socket: LogSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private attempt = 0
  // Bumped whenever a socket is replaced or torn down, so late events from an
  // abandoned socket are recognised and ignored.
  private generation = 0

  constructor(
    private readonly connection: () => { baseUrl: string; apiKey: string },
    private readonly emit: (event: ServerLogEvent) => void,
    private readonly socketFactory: SocketFactory = defaultSocketFactory
  ) {}

  /** Whether the stream is currently wanted (started and not stopped). */
  get active(): boolean {
    return this.running
  }

  /** (Re)open the stream. The viewer gets a fresh status + backlog each time. */
  start(): void {
    this.running = true
    this.teardown()
    this.attempt = 0
    this.connect()
  }

  /** Close the stream and stop reconnecting. */
  stop(): void {
    this.running = false
    this.teardown()
  }

  private teardown(): void {
    this.generation++
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const socket = this.socket
    this.socket = null
    try {
      socket?.close()
    } catch {
      // Already closed.
    }
  }

  private connect(): void {
    const { baseUrl, apiKey } = this.connection()
    const url = serverLogsUrl(baseUrl, apiKey)
    if (!url) {
      this.emit({
        type: 'status',
        state: 'closed',
        message: `Can't open the log stream: "${baseUrl}" isn't a valid server address.`
      })
      return
    }
    this.emit({ type: 'status', state: 'connecting' })
    const generation = ++this.generation
    const stale = (): boolean => generation !== this.generation
    let socket: LogSocket
    try {
      socket = this.socketFactory(url)
    } catch (err) {
      this.emit({
        type: 'status',
        state: 'closed',
        message: `Can't open the log stream: ${err instanceof Error ? err.message : String(err)}`
      })
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    let detail = ''
    socket.addEventListener('open', () => {
      if (stale()) return
      socket.send(JSON.stringify({ type: 'logs.subscribe', after_seq: null }))
      this.emit({ type: 'status', state: 'live' })
    })
    socket.addEventListener('message', (event: { data?: unknown }) => {
      if (stale()) return
      // A frame arrived, so the link is healthy: restart the backoff ladder.
      this.attempt = 0
      const text = typeof event.data === 'string' ? event.data : ''
      const parsed = text ? parseServerLogMessage(text) : null
      if (parsed) this.emit(parsed)
    })
    socket.addEventListener('error', (event: { message?: string }) => {
      // The WebSocket API hides the reason; keep whatever text it offers so the
      // status line can say more than "disconnected".
      if (!stale() && event.message) detail = event.message
    })
    socket.addEventListener('close', () => {
      if (stale()) return
      this.socket = null
      this.emit({
        type: 'status',
        state: 'closed',
        message:
          `Couldn't reach the server's log stream${detail ? ` (${detail})` : ''}. ` +
          'It may be offline, restarting, or need an API key. Retrying…'
      })
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (!this.running || this.timer) return
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt++, RECONNECT_DELAYS_MS.length - 1)]
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.running) this.connect()
    }, delay)
  }
}
