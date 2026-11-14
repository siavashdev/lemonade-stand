import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpManager, resolveStdioLaunch } from '../src/main/mcp/manager'
import { loadCatalog, serverFromCatalog } from '../src/main/config'

const ROOT = join(__dirname, '..')

// Boots the Pantry's real "playwright" entry (@playwright/mcp, bundled as a
// package dependency). Listing tools doesn't launch a browser, so this runs
// without Chrome installed.
describe('playwright MCP server (integration)', () => {
  let manager: McpManager

  beforeAll(async () => {
    const entry = loadCatalog(ROOT).find((e) => e.id === 'playwright')
    expect(entry, 'catalog.json has no "playwright" entry').toBeDefined()
    manager = new McpManager()
    await manager.connectAll([serverFromCatalog(entry!)])
  })

  afterAll(async () => {
    await manager?.closeAll()
  })

  it('connects and exposes the browser tools', () => {
    const runtime = manager.getRuntime('playwright')
    expect(runtime?.connected, `connect error: ${runtime?.error}`).toBe(true)
    const names = manager.getTools().map((t) => t.qualifiedName)
    expect(names).toContain('playwright__browser_navigate')
    expect(names).toContain('playwright__browser_snapshot')
  })
})

// The packaged app runs bundled npm servers on Electron's own Node
// (ELECTRON_RUN_AS_NODE), so launch it the way the app would, through the real
// Electron binary.
describe('playwright MCP server on Electron-as-Node (integration)', () => {
  const electronPath = createRequire(import.meta.url)('electron') as string
  let client: Client

  beforeAll(async () => {
    expect(existsSync(electronPath), 'Electron binary is not installed').toBe(true)
    const entry = loadCatalog(ROOT).find((e) => e.id === 'playwright')!
    const server = serverFromCatalog(entry)
    if (server.transport !== 'stdio') throw new Error('playwright entry must be stdio')
    const launch = resolveStdioLaunch(server)
    expect(launch.command, 'should run bundled package, not npx').toBe(process.execPath)
    client = new Client({ name: 'lemonade-stand-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({ command: electronPath, args: launch.args, env: launch.env })
    )
  })

  afterAll(async () => {
    await client?.close()
  })

  it('starts and lists browser tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('browser_navigate')
  })
})
