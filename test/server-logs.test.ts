import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerLogEvent } from '@shared/types'
import {
  parseServerLogMessage,
  ServerLogStream,
  serverLogsUrl,
  toServerLogEntry,
  type LogSocket
} from '../src/main/lemonade/logs'

describe('serverLogsUrl', () => {
  it('maps the chat base URL onto the stream endpoint at the server root', () => {
    expect(serverLogsUrl('http://localhost:13305/api/v1', '')).toBe('ws://localhost:13305/logs/stream')
    expect(serverLogsUrl('http://localhost:13305/api/v1/', '')).toBe('ws://localhost:13305/logs/stream')
    expect(serverLogsUrl('http://host:8000/v1', '')).toBe('ws://host:8000/logs/stream')
    expect(serverLogsUrl('http://localhost:13305', '')).toBe('ws://localhost:13305/logs/stream')
  })

  it('uses wss for https', () => {
    expect(serverLogsUrl('https://lemon.example.com/api/v1', '')).toBe(
      'wss://lemon.example.com/logs/stream'
    )
  })

  it('keeps a reverse-proxy prefix in front of the version segment', () => {
    expect(serverLogsUrl('http://host/lemonade/api/v1', '')).toBe('ws://host/lemonade/logs/stream')
  })

  it('sends the API key as a query parameter, encoded', () => {
    const url = serverLogsUrl('http://localhost:13305/api/v1', 'a b&c')
    expect(url).toBeDefined()
    expect(new URL(url as string).searchParams.get('api_key')).toBe('a b&c')
    expect(url).not.toContain('a b&c')
  })

  it('returns undefined for addresses that are not http(s) URLs', () => {
    expect(serverLogsUrl('not a url', '')).toBeUndefined()
    expect(serverLogsUrl('ftp://host/api/v1', '')).toBeUndefined()
    expect(serverLogsUrl('', '')).toBeUndefined()
  })
})

describe('toServerLogEntry', () => {
  it('splits the server line into columns and drops the repeated prefix', () => {
    expect(
      toServerLogEntry({
        line: '2026-11-13 20:46:56.055 [Info] (main) Starting Lemonade Server...',
        seq: 1,
        severity: 'Info',
        tag: 'main',
        timestamp: '2026-11-13 20:46:56.055'
      })
    ).toEqual({
      seq: 1,
      timestamp: '2026-11-13 20:46:56.055',
      severity: 'info',
      tag: 'main',
      message: 'Starting Lemonade Server...'
    })
  })

  it('normalizes the server severity words, including the short "Warn"', () => {
    const sev = (severity: unknown): string | undefined =>
      toServerLogEntry({ line: 'x', severity })?.severity
    expect(sev('Warn')).toBe('warning')
    expect(sev('Warning')).toBe('warning')
    expect(sev('ERROR')).toBe('error')
    expect(sev('Fatal')).toBe('fatal')
    expect(sev('Debug')).toBe('debug')
    expect(sev('Trace')).toBe('trace')
    expect(sev('Notice')).toBe('info')
    expect(sev(undefined)).toBe('info')
  })

  it('keeps a line that has no recognisable prefix, tagged "server" when no tag is given', () => {
    expect(toServerLogEntry({ line: 'plain text' })).toEqual({
      seq: 0,
      timestamp: '',
      severity: 'info',
      tag: 'server',
      message: 'plain text'
    })
  })

  it('keeps every line of a multi-line message', () => {
    const entry = toServerLogEntry({ line: '2026-11-13 20:46:56.055 [Error] (Router) first\nsecond' })
    expect(entry?.message).toBe('first\nsecond')
  })

  it('rejects malformed entries', () => {
    expect(toServerLogEntry(null)).toBeNull()
    expect(toServerLogEntry('text')).toBeNull()
    expect(toServerLogEntry({})).toBeNull()
    expect(toServerLogEntry({ line: '' })).toBeNull()
    expect(toServerLogEntry({ line: 42 })).toBeNull()
  })
})

describe('parseServerLogMessage', () => {
  const line = (n: number): unknown => ({ line: `2026-11-13 20:46:56.0${n}0 [Info] (t) line ${n}`, seq: n })

  it('decodes a snapshot, dropping malformed entries', () => {
    const event = parseServerLogMessage(
      JSON.stringify({ type: 'logs.snapshot', entries: [line(1), { nope: true }, line(2)] })
    )
    expect(event?.type).toBe('snapshot')
    if (event?.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(event.entries.map((e) => e.message)).toEqual(['line 1', 'line 2'])
  })

  it('treats a snapshot without entries as empty', () => {
    expect(parseServerLogMessage('{"type":"logs.snapshot"}')).toEqual({ type: 'snapshot', entries: [] })
  })

  it('decodes a single entry', () => {
    const event = parseServerLogMessage(JSON.stringify({ type: 'logs.entry', entry: line(7) }))
    expect(event).toMatchObject({ type: 'entry', entry: { seq: 7, message: 'line 7' } })
  })

  it('reports an error frame as a status note, keeping the stream live', () => {
    expect(parseServerLogMessage('{"type":"error","message":"bad key"}')).toEqual({
      type: 'status',
      state: 'live',
      message: 'The server reported an error on the log stream: bad key'
    })
    expect(parseServerLogMessage('{"type":"error"}')).toEqual({
      type: 'status',
      state: 'live',
      message: 'The server reported an error on the log stream.'
    })
  })

  it('ignores frames it does not understand', () => {
    expect(parseServerLogMessage('not json')).toBeNull()
    expect(parseServerLogMessage('42')).toBeNull()
    expect(parseServerLogMessage('null')).toBeNull()
    expect(parseServerLogMessage('{"type":"logs.subscribed"}')).toBeNull()
    expect(parseServerLogMessage('{"type":"logs.entry","entry":{}}')).toBeNull()
  })
})

/** A WebSocket stand-in the test drives by hand. */
class FakeSocket implements LogSocket {
  readonly sent: string[] = []
  closed = false
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener as (event: unknown) => void)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('ServerLogStream', () => {
  let sockets: FakeSocket[]
  let events: ServerLogEvent[]
  let connection: { baseUrl: string; apiKey: string }
  let stream: ServerLogStream

  const states = (): string[] =>
    events.map((e) => (e.type === 'status' ? `status:${e.state}` : e.type))

  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    events = []
    connection = { baseUrl: 'http://localhost:13305/api/v1', apiKey: '' }
    stream = new ServerLogStream(
      () => connection,
      (e) => events.push(e),
      (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      }
    )
  })

  afterEach(() => {
    stream.stop()
    vi.useRealTimers()
  })

  it('connects, subscribes for the whole backlog, then relays what the server sends', () => {
    stream.start()
    expect(stream.active).toBe(true)
    expect(sockets.map((s) => s.url)).toEqual(['ws://localhost:13305/logs/stream'])
    expect(states()).toEqual(['status:connecting'])

    sockets[0].fire('open')
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'logs.subscribe', after_seq: null })
    expect(states()).toEqual(['status:connecting', 'status:live'])

    sockets[0].fire('message', {
      data: JSON.stringify({
        type: 'logs.snapshot',
        entries: [{ line: '2026-11-13 20:46:56.055 [Info] (main) hello', seq: 1 }]
      })
    })
    sockets[0].fire('message', {
      data: JSON.stringify({
        type: 'logs.entry',
        entry: {
          line: '2026-11-13 20:46:57.000 [Warning] (Router) careful',
          seq: 2,
          severity: 'Warning',
          tag: 'Router'
        }
      })
    })
    // Binary or junk frames are skipped rather than breaking the stream.
    sockets[0].fire('message', { data: new Uint8Array([1, 2, 3]) })
    sockets[0].fire('message', { data: 'not json' })
    expect(states()).toEqual(['status:connecting', 'status:live', 'snapshot', 'entry'])
    expect(events[3]).toMatchObject({ entry: { severity: 'warning', tag: 'Router', message: 'careful' } })
  })

  it('sends the API key in the stream URL', () => {
    connection = { baseUrl: 'http://localhost:13305/api/v1', apiKey: 'secret' }
    stream.start()
    expect(sockets[0].url).toBe('ws://localhost:13305/logs/stream?api_key=secret')
  })

  it('reconnects with a growing delay while the server is unreachable', () => {
    stream.start()
    const delays = [1_000, 2_000, 5_000, 10_000, 10_000]
    delays.forEach((delay, i) => {
      sockets[i].fire('close')
      expect(sockets).toHaveLength(i + 1)
      vi.advanceTimersByTime(delay - 1)
      expect(sockets).toHaveLength(i + 1)
      vi.advanceTimersByTime(1)
      expect(sockets).toHaveLength(i + 2)
    })
    const closed = events.filter((e) => e.type === 'status' && e.state === 'closed')
    expect(closed).toHaveLength(delays.length)
    expect(closed[0]).toMatchObject({ message: expect.stringContaining('Retrying') })
  })

  it('starts the delays over once a connection has delivered data', () => {
    stream.start()
    sockets[0].fire('close')
    vi.advanceTimersByTime(1_000)
    sockets[1].fire('close')
    vi.advanceTimersByTime(2_000)
    expect(sockets).toHaveLength(3)

    sockets[2].fire('open')
    sockets[2].fire('message', { data: '{"type":"logs.snapshot","entries":[]}' })
    sockets[2].fire('close')
    vi.advanceTimersByTime(1_000)
    expect(sockets).toHaveLength(4)
  })

  it('includes the reason the socket gave when the connection fails', () => {
    stream.start()
    sockets[0].fire('error', { message: 'ECONNREFUSED' })
    sockets[0].fire('close')
    const closed = events.find((e) => e.type === 'status' && e.state === 'closed')
    expect(closed).toMatchObject({ message: expect.stringContaining('(ECONNREFUSED)') })
  })

  it('rotates through the loopback addresses of a localhost server when connecting fails', () => {
    stream.start()
    sockets[0].fire('close')
    vi.advanceTimersByTime(1_000)
    sockets[1].fire('close')
    vi.advanceTimersByTime(2_000)
    sockets[2].fire('close')
    vi.advanceTimersByTime(5_000)
    expect(sockets.map((s) => s.url)).toEqual([
      'ws://localhost:13305/logs/stream',
      'ws://127.0.0.1:13305/logs/stream',
      'ws://[::1]:13305/logs/stream',
      'ws://localhost:13305/logs/stream'
    ])
  })

  it('keeps the loopback address that worked when it later reconnects', () => {
    stream.start()
    sockets[0].fire('close')
    vi.advanceTimersByTime(1_000)
    sockets[1].fire('open')
    sockets[1].fire('close')
    vi.advanceTimersByTime(2_000)
    expect(sockets[2].url).toBe('ws://127.0.0.1:13305/logs/stream')
  })

  it('picks up a changed server address when it reconnects', () => {
    stream.start()
    connection = { baseUrl: 'http://other-host:9000/v1', apiKey: '' }
    sockets[0].fire('close')
    vi.advanceTimersByTime(1_000)
    expect(sockets[1].url).toBe('ws://other-host:9000/logs/stream')
  })

  it('stop() closes the socket and cancels any pending reconnect', () => {
    stream.start()
    sockets[0].fire('close')
    stream.stop()
    expect(stream.active).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)

    stream.start()
    stream.stop()
    expect(sockets[1].closed).toBe(true)
  })

  it('start() again replaces the connection and ignores the abandoned one', () => {
    stream.start()
    sockets[0].fire('open')
    stream.start()
    expect(sockets).toHaveLength(2)
    expect(sockets[0].closed).toBe(true)
    events.length = 0

    // Late events from the abandoned socket must not reach the viewer or trigger a retry.
    sockets[0].fire('message', { data: '{"type":"logs.snapshot","entries":[]}' })
    sockets[0].fire('close')
    vi.advanceTimersByTime(60_000)
    expect(events).toEqual([])
    expect(sockets).toHaveLength(2)
  })

  it('does not open a socket for an address that is not a valid URL', () => {
    connection = { baseUrl: 'not a url', apiKey: '' }
    stream.start()
    expect(sockets).toHaveLength(0)
    expect(events).toEqual([
      expect.objectContaining({
        type: 'status',
        state: 'closed',
        message: expect.stringContaining('isn\'t a valid server address')
      })
    ])
  })

  it('reports a socket that cannot be created, and keeps trying', () => {
    let attempts = 0
    const failing = new ServerLogStream(
      () => connection,
      (e) => events.push(e),
      () => {
        attempts++
        throw new Error('WebSocket is not defined')
      }
    )
    failing.start()
    expect(events[events.length - 1]).toMatchObject({
      state: 'closed',
      message: expect.stringContaining('WebSocket is not defined')
    })
    vi.advanceTimersByTime(1_000)
    expect(attempts).toBe(2)
    failing.stop()
  })
})
