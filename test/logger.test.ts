import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  classifyConsoleCall,
  formatLogTimestamp,
  getAppLogs,
  getLogFilePath,
  initFileLogging,
  installConsoleCapture,
  LogBuffer,
  recordUiLog,
  splitLogTag,
  subscribeAppLogs
} from '../src/main/logger'

describe('formatLogTimestamp', () => {
  it('zero-pads every field and uses local time', () => {
    expect(formatLogTimestamp(new Date(2026, 10, 3, 4, 5, 6, 7))).toBe('2026-11-03 04:05:06.007')
    expect(formatLogTimestamp(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12-31 23:59:59.999')
  })
})

describe('splitLogTag', () => {
  it('peels a leading [tag] marker off the message', () => {
    expect(splitLogTag('[mcp] connected to filesystem', 'main')).toEqual({
      tag: 'mcp',
      message: 'connected to filesystem'
    })
    expect(splitLogTag('[server:llm.v2-x]   spaced', 'main')).toEqual({
      tag: 'server:llm.v2-x',
      message: 'spaced'
    })
  })

  it('keeps every line of a multi-line message', () => {
    expect(splitLogTag('[agent] first\nsecond', 'main')).toEqual({
      tag: 'agent',
      message: 'first\nsecond'
    })
  })

  it('falls back to the default tag when there is no marker', () => {
    expect(splitLogTag('plain message', 'main')).toEqual({ tag: 'main', message: 'plain message' })
    expect(splitLogTag('[123] starts with a digit', 'main').tag).toBe('main')
    expect(splitLogTag('mid [tag] text', 'main').tag).toBe('main')
    expect(splitLogTag(`[${'x'.repeat(40)}] too long to be a tag`, 'main').tag).toBe('main')
  })

  it('accepts a marker with nothing after it', () => {
    expect(splitLogTag('[ready]', 'main')).toEqual({ tag: 'ready', message: '' })
  })
})

describe('classifyConsoleCall', () => {
  it('maps console methods onto severities, using a leading [tag] as the tag', () => {
    expect(classifyConsoleCall('log', '[mcp] connected')).toEqual({
      severity: 'info',
      tag: 'mcp',
      message: 'connected'
    })
    expect(classifyConsoleCall('info', 'x').severity).toBe('info')
    expect(classifyConsoleCall('warn', 'careful')).toEqual({
      severity: 'warning',
      tag: 'main',
      message: 'careful'
    })
    expect(classifyConsoleCall('error', 'boom').severity).toBe('error')
    expect(classifyConsoleCall('debug', 'x').severity).toBe('debug')
  })

  it("files Node's own process warnings as warnings from 'node', not errors", () => {
    const text =
      '(node:28376) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n' +
      '(Use `electron --trace-deprecation ...` to show where the warning was created)'
    expect(classifyConsoleCall('error', text)).toEqual({ severity: 'warning', tag: 'node', message: text })
    expect(classifyConsoleCall('error', '(node:1) ExperimentalWarning: x').severity).toBe('warning')
  })

  it('leaves a real error that merely mentions a warning alone', () => {
    expect(classifyConsoleCall('error', 'DeprecationWarning: nope').severity).toBe('error')
    expect(classifyConsoleCall('error', '[mcp] (node:1) failed').severity).toBe('error')
    // Only console.error carries Node's warnings.
    expect(classifyConsoleCall('log', '(node:1) [DEP1] DeprecationWarning: x').severity).toBe('info')
  })
})

describe('LogBuffer', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5, 6)

  it('numbers lines in order and stamps them', () => {
    const buffer = new LogBuffer()
    const first = buffer.add('info', 'main', 'hello', at)
    const second = buffer.add('error', 'mcp', 'boom', at)
    expect(first).toEqual({
      seq: 1,
      timestamp: '2026-01-02 03:04:05.006',
      severity: 'info',
      tag: 'main',
      message: 'hello'
    })
    expect(second.seq).toBe(2)
    expect(buffer.snapshot().map((e) => e.message)).toEqual(['hello', 'boom'])
  })

  it('keeps only the newest lines once full', () => {
    const buffer = new LogBuffer(3)
    for (let i = 1; i <= 5; i++) buffer.add('info', 'main', `line ${i}`)
    expect(buffer.snapshot().map((e) => e.message)).toEqual(['line 3', 'line 4', 'line 5'])
    // Sequence numbers keep counting, so a viewer can still tell what it has seen.
    expect(buffer.snapshot().map((e) => e.seq)).toEqual([3, 4, 5])
  })

  it('hands out copies, so callers cannot disturb the buffer', () => {
    const buffer = new LogBuffer()
    buffer.add('info', 'main', 'kept')
    buffer.snapshot().length = 0
    expect(buffer.snapshot()).toHaveLength(1)
  })

  it('clips a runaway line and says how much was cut', () => {
    const buffer = new LogBuffer()
    const entry = buffer.add('info', 'main', 'x'.repeat(4005))
    expect(entry.message).toBe(`${'x'.repeat(4000)}… (+5 chars)`)
    expect(buffer.add('info', 'main', 'y'.repeat(4000)).message).toHaveLength(4000)
  })

  it('notifies subscribers until they unsubscribe', () => {
    const buffer = new LogBuffer()
    const seen: string[] = []
    const unsubscribe = buffer.subscribe((e) => seen.push(e.message))
    buffer.add('info', 'main', 'one')
    unsubscribe()
    buffer.add('info', 'main', 'two')
    expect(seen).toEqual(['one'])
  })

  it('keeps logging when a subscriber throws, and still reaches the others', () => {
    const buffer = new LogBuffer()
    const seen: string[] = []
    buffer.subscribe(() => {
      throw new Error('broken subscriber')
    })
    buffer.subscribe((e) => seen.push(e.message))
    expect(() => buffer.add('info', 'main', 'still works')).not.toThrow()
    expect(seen).toEqual(['still works'])
    expect(buffer.snapshot()).toHaveLength(1)
  })
})

describe('app log capture', () => {
  // The same patched console serves the rest of this file, so every assertion
  // looks only for its own uniquely-worded lines.
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  )
  installConsoleCapture()

  const find = (text: string): ReturnType<typeof getAppLogs>[number] | undefined =>
    getAppLogs().find((e) => e.message.includes(text))

  it('records console output with the right severity and still prints it', () => {
    console.log('capture-log line')
    console.info('capture-info line')
    console.warn('capture-warn line')
    console.error('capture-error line')
    console.debug('capture-debug line')
    expect(find('capture-log')?.severity).toBe('info')
    expect(find('capture-info')?.severity).toBe('info')
    expect(find('capture-warn')?.severity).toBe('warning')
    expect(find('capture-error')?.severity).toBe('error')
    expect(find('capture-debug')?.severity).toBe('debug')
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1)
  })

  it('uses a leading [tag] as the tag and "main" otherwise', () => {
    console.info('[capture-tag] tagged line')
    console.info('untagged capture line')
    expect(find('tagged line')).toMatchObject({ tag: 'capture-tag', message: 'tagged line' })
    expect(find('untagged capture line')?.tag).toBe('main')
  })

  it('formats printf-style arguments and errors like console does', () => {
    console.error('capture-format %s has %d items', 'list', 3)
    console.warn('capture-object', { a: 1 }, new Error('boom'))
    expect(find('capture-format')?.message).toBe('capture-format list has 3 items')
    const logged = find('capture-object')?.message ?? ''
    expect(logged).toContain('{ a: 1 }')
    expect(logged).toContain('Error: boom')
  })

  it("records Node's process warnings as warnings from 'node'", () => {
    console.error('(node:4242) [DEP0040] DeprecationWarning: capture-node-warning')
    expect(find('capture-node-warning')).toMatchObject({ severity: 'warning', tag: 'node' })
  })

  it('does not wrap the console a second time when installed again', () => {
    installConsoleCapture()
    console.info('capture-once line')
    expect(getAppLogs().filter((e) => e.message.includes('capture-once'))).toHaveLength(1)
  })

  it('records the renderer console as "ui" and notifies subscribers', () => {
    const seen: string[] = []
    const unsubscribe = subscribeAppLogs((e) => seen.push(`${e.tag}:${e.severity}:${e.message}`))
    recordUiLog('warning', 'capture-ui message')
    unsubscribe()
    recordUiLog('warning', 'capture-ui after unsubscribe')
    expect(seen).toEqual(['ui:warning:capture-ui message'])
    expect(find('capture-ui message')?.tag).toBe('ui')
  })

  const dir = mkdtempSync(join(tmpdir(), 'lemonade-stand-log-'))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes no file unless file logging is enabled', () => {
    expect(initFileLogging(dir, false)).toBeNull()
    expect(getLogFilePath()).toBeNull()
  })

  it('writes a file when enabled, starting with what was captured before it opened', () => {
    console.info('capture-before-file line')
    const file = initFileLogging(dir, true, 'version=9.9.9')
    expect(file).toBe(join(dir, 'lemonade-stand.log'))
    expect(getLogFilePath()).toBe(file)
    console.warn('[capture-file] after-open line')
    recordUiLog('error', 'capture-file ui line')

    const text = readFileSync(file as string, 'utf8')
    expect(text).toMatch(/===== session started .* version=9\.9\.9 =====/)
    const before = text.indexOf('capture-before-file line')
    const after = text.indexOf('[capture-file] after-open line')
    expect(before).toBeGreaterThan(-1)
    expect(after).toBeGreaterThan(before)
    expect(text).toMatch(/\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\] \[warning\] \[capture-file\] after-open line/)
    expect(text).toMatch(/\[error\] \[ui\] capture-file ui line/)
  })
})
