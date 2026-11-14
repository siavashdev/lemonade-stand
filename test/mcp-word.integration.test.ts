import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpManager, resolveStdioLaunch } from '../src/main/mcp/manager'
import { loadCatalog, serverFromCatalog } from '../src/main/config'

const ROOT = join(__dirname, '..')

// Boots the Pantry's real "word" entry (markdown-to-word, bundled as a package
// dependency and launched through the app's McpManager) and converts Markdown
// to a .docx on disk. The server config is built from config/catalog.json so
// the test fails if the shipped entry stops working.
describe('word MCP server (integration)', () => {
  let dir: string
  let manager: McpManager

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lemonade-word-test-'))
    const entry = loadCatalog(ROOT).find((e) => e.id === 'word')
    expect(entry, 'catalog.json has no "word" entry').toBeDefined()
    manager = new McpManager()
    await manager.connectAll([serverFromCatalog(entry!)])
  })

  afterAll(async () => {
    await manager?.closeAll()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('connects and exposes word__convert_markdown_to_word', () => {
    const runtime = manager.getRuntime('word')
    expect(runtime?.connected, `connect error: ${runtime?.error}`).toBe(true)
    expect(manager.getTools().map((t) => t.qualifiedName)).toContain(
      'word__convert_markdown_to_word'
    )
  })

  it('writes a real .docx (a zip package) from Markdown', async () => {
    const target = join(dir, 'menu.docx')
    const result = await manager.callTool('word__convert_markdown_to_word', {
      markdown: '# Menu\n\n- Lemonade\n- Iced tea\n\n| Item | Price |\n| --- | --- |\n| Lemonade | $2 |\n',
      output_path: target
    })
    expect(result.text.toLowerCase()).not.toContain('error')
    expect(existsSync(target)).toBe(true)
    expect(statSync(target).size).toBeGreaterThan(1000)
    // .docx is a zip package, which always starts with the "PK" signature.
    expect(readFileSync(target).subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('refuses to overwrite an existing file unless overwrite is set', async () => {
    const target = join(dir, 'menu.docx')
    const before = statSync(target).size
    const refused = await manager.callTool('word__convert_markdown_to_word', {
      markdown: '# Replaced\n\nA much longer body so the size would change. '.repeat(40),
      output_path: target
    })
    expect(refused.text.toLowerCase()).toMatch(/exist|overwrite/)
    expect(statSync(target).size).toBe(before)

    await manager.callTool('word__convert_markdown_to_word', {
      markdown: '# Replaced\n\nA much longer body so the size would change. '.repeat(40),
      output_path: target,
      overwrite: true
    })
    expect(statSync(target).size).not.toBe(before)
  })

  it('rejects an output path that is not a .docx', async () => {
    const target = join(dir, 'notes.txt')
    const result = await manager.callTool('word__convert_markdown_to_word', {
      markdown: '# Nope',
      output_path: target
    })
    expect(result.text.toLowerCase()).toContain('docx')
    expect(existsSync(target)).toBe(false)
  })
})

// The packaged app runs bundled npm servers on Electron's own Node
// (ELECTRON_RUN_AS_NODE), not the Node running vitest. markdown-to-word's CLI
// parses argv differently under Electron, so launch it exactly as the app
// would, but through the real Electron binary.
describe('word MCP server on Electron-as-Node (integration)', () => {
  const electronPath = createRequire(import.meta.url)('electron') as string
  let dir: string
  let client: Client

  beforeAll(async () => {
    expect(existsSync(electronPath), 'Electron binary is not installed').toBe(true)
    dir = mkdtempSync(join(tmpdir(), 'lemonade-word-electron-test-'))
    const entry = loadCatalog(ROOT).find((e) => e.id === 'word')!
    const server = serverFromCatalog(entry)
    if (server.transport !== 'stdio') throw new Error('word entry must be stdio')
    const launch = resolveStdioLaunch(server)
    client = new Client({ name: 'lemonade-stand-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({ command: electronPath, args: launch.args, env: launch.env })
    )
  })

  afterAll(async () => {
    await client?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('starts and writes a .docx', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('convert_markdown_to_word')
    const target = join(dir, 'menu.docx')
    await client.callTool({
      name: 'convert_markdown_to_word',
      arguments: { markdown: '# Menu\n\n- Lemonade\n', output_path: target }
    })
    expect(readFileSync(target).subarray(0, 2).toString('latin1')).toBe('PK')
  })
})
