import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LemonadeClient, mergeSystemMessages } from '../src/main/lemonade/client'

describe('mergeSystemMessages()', () => {
  it('folds compaction-pinned system messages into one leading message', () => {
    const out = mergeSystemMessages([
      { role: 'system', content: 'base' },
      { role: 'system', content: 'summary' },
      { role: 'system', content: 'plan' },
      { role: 'user', content: 'hi' }
    ])
    expect(out).toEqual([
      { role: 'system', content: 'base\n\nsummary\n\nplan' },
      { role: 'user', content: 'hi' }
    ])
  })

  it('moves a mid-conversation system message to the front', () => {
    const out = mergeSystemMessages([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'late' }
    ])
    expect(out.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('returns an already-valid list untouched', () => {
    const msgs = [
      { role: 'system' as const, content: 'base' },
      { role: 'user' as const, content: 'hi' }
    ]
    expect(mergeSystemMessages(msgs)).toBe(msgs)
  })
})

// Exercises the real LemonadeClient against a tiny in-process stand-in for a
// Lemonade server (v2026.46-style behaviour): Omni collections that aren't fully
// downloaded, failures delivered *inside* a normal chat reply, a collection that
// ignores ctx_size on /load, and a model catalogue where speech models the user
// never downloaded sort ahead of the ones they did.

interface Recorded {
  method: string
  path: string
  body: string
}

interface FakeServer {
  url: string
  requests: Recorded[]
  /** Model entries served at /models/{id}. */
  entries: Record<string, unknown>
  /** The full catalogue at /models?show_all=true. */
  catalogue: unknown[]
  /** Ids listed by the downloaded-only /models. */
  downloaded: string[]
  /** What /health reports as loaded. */
  loaded: unknown[]
  /** The jobs /downloads reports. */
  downloads: unknown[]
  /** Called for POST /chat/completions; returns the assistant's message content. */
  chatReply: (body: Record<string, unknown>) => string
  /** When set, /chat/completions streams its first chunk and then never finishes. */
  chatHang: boolean
  /** Called for POST /pull and POST /load so a test can evolve server state. */
  onPost: (path: string, body: Record<string, unknown>) => void | Promise<void>
  close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function startFakeServer(): Promise<FakeServer> {
  const fake: FakeServer = {
    url: '',
    requests: [],
    entries: {},
    catalogue: [],
    downloaded: [],
    loaded: [],
    downloads: [],
    chatReply: () => 'ok',
    chatHang: false,
    onPost: () => {},
    close: async () => {}
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req)
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/^\/api\/v1/, '')
      fake.requests.push({ method: req.method ?? 'GET', path: path + url.search, body })
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'GET' && path === '/health') {
        return json(200, { status: 'ok', all_models_loaded: fake.loaded })
      }
      if (req.method === 'GET' && path === '/downloads') {
        return json(200, fake.downloads)
      }
      if (req.method === 'GET' && path === '/models') {
        const all = url.searchParams.get('show_all') === 'true'
        const data = all
          ? fake.catalogue
          : (fake.catalogue as { id: string }[]).filter((m) => fake.downloaded.includes(m.id))
        return json(200, { object: 'list', data })
      }
      if (req.method === 'GET' && path.startsWith('/models/')) {
        const entry = fake.entries[decodeURIComponent(path.slice('/models/'.length))]
        return entry ? json(200, entry) : json(404, { error: 'not found' })
      }
      if (req.method === 'POST' && (path === '/pull' || path === '/load')) {
        await fake.onPost(path, body ? (JSON.parse(body) as Record<string, unknown>) : {})
        return json(200, { status: 'success' })
      }
      if (req.method === 'POST' && path === '/audio/transcriptions') {
        return json(200, { text: 'hello world' })
      }
      if (req.method === 'POST' && path === '/chat/completions') {
        const content = fake.chatReply(JSON.parse(body) as Record<string, unknown>)
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: unknown, finish: string | null): string =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test',
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        res.write(chunk({ role: 'assistant' }, null))
        if (fake.chatHang) return
        res.write(chunk({ content }, null))
        res.write(chunk({}, 'stop'))
        res.end('data: [DONE]\n\n')
        return
      }
      json(404, { error: `unhandled ${req.method} ${path}` })
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  return fake
}

const OMNI = 'LMX-Omni-5.5B-Lite'
const COMPONENTS = ['Qwen3.5-4B-MTP-GGUF', 'SD-Turbo', 'Whisper-Tiny', 'kokoro-v1']

/** The registry entry for the collection once its manifest is pulled. */
function omniEntry(downloadedComponents: string[]): Record<string, unknown> {
  return {
    id: OMNI,
    recipe: 'collection.omni',
    // v2026.46 reports false here even when every component is on disk.
    downloaded: false,
    components: COMPONENTS,
    models: COMPONENTS.map((id) => ({ id, downloaded: downloadedComponents.includes(id) }))
  }
}

let fake: FakeServer
let client: LemonadeClient

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fake = await startFakeServer()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fake.close()
})

const chatPosts = (): Recorded[] => fake.requests.filter((r) => r.path === '/chat/completions')

describe('chat() with an Omni collection that is not ready', () => {
  it('explains a collection with no downloaded components, without chatting', async () => {
    fake.entries[OMNI] = { id: OMNI, recipe: 'collection.omni', downloaded: false, components: [], models: [] }
    client = new LemonadeClient(fake.url, '', OMNI)
    await expect(client.chat([{ role: 'user', content: 'hello' }], [])).rejects.toThrow(
      /isn't downloaded on the Lemonade server yet/
    )
    expect(chatPosts()).toHaveLength(0)
  })

  it('names the components that are still missing', async () => {
    fake.entries[OMNI] = omniEntry(['Qwen3.5-4B-MTP-GGUF', 'Whisper-Tiny'])
    client = new LemonadeClient(fake.url, '', OMNI)
    await expect(client.chat([{ role: 'user', content: 'hello' }], [])).rejects.toThrow(
      /missing 2 of its 4 component models \(SD-Turbo, kokoro-v1\)/
    )
    expect(chatPosts()).toHaveLength(0)
  })

  it('points at the running download instead of telling the user to start one', async () => {
    fake.entries[OMNI] = omniEntry(['Qwen3.5-4B-MTP-GGUF'])
    fake.downloads = [{ id: 'job-1', model_name: OMNI, status: 'downloading', running: true, percent: 40 }]
    client = new LemonadeClient(fake.url, '', OMNI)
    await expect(client.chat([{ role: 'user', content: 'hello' }], [])).rejects.toThrow(
      /A download is already in progress/
    )
  })

  it('uses the downloaded list when the server returns only some component states', async () => {
    fake.entries[OMNI] = {
      id: OMNI,
      recipe: 'collection.omni',
      components: COMPONENTS,
      models: [{ id: COMPONENTS[0], downloaded: true }]
    }
    fake.catalogue = COMPONENTS.map((id) => ({ id }))
    fake.downloaded = [COMPONENTS[0]]
    client = new LemonadeClient(fake.url, '', OMNI)
    await expect(client.chat([{ role: 'user', content: 'hello' }], [])).rejects.toThrow(
      /missing 3 of its 4 component models \(SD-Turbo, Whisper-Tiny, kokoro-v1\)/
    )
    expect(chatPosts()).toHaveLength(0)
  })
})

describe('chat() with a ready Omni collection', () => {
  beforeEach(() => {
    fake.entries[OMNI] = omniEntry(COMPONENTS)
    client = new LemonadeClient(fake.url, '', OMNI, 131072, 512, 2048)
  })

  it('chats normally, ignoring the server flipping the collection to not-downloaded', async () => {
    fake.chatReply = () => 'Hello! How can I help?'
    const choice = await client.chat([{ role: 'user', content: 'hello' }], [])
    expect(choice.message.content).toBe('Hello! How can I help?')
  })

  it('checks readiness once, not on every agent step', async () => {
    await client.chat([{ role: 'user', content: 'one' }], [])
    await client.chat([{ role: 'user', content: 'two' }], [])
    expect(fake.requests.filter((r) => r.path === `/models/${OMNI}`)).toHaveLength(1)
    expect(chatPosts()).toHaveLength(2)
  })

  it('turns an in-band context-overflow reply into an error and recalibrates the budget', async () => {
    fake.chatReply = () =>
      '\n\nError: request (7805 tokens) exceeds the available context size (4096 tokens), try increasing it'
    // (\D? tolerates whichever digit-group separator the machine's locale uses.)
    await expect(client.chat([{ role: 'user', content: 'big prompt' }], [])).rejects.toThrow(
      /needs about 7\D?805 tokens .* 4\D?096-token context/
    )
    // The configured 131072 override was wrong; budget against what the server runs.
    expect(await client.resolveContextSize()).toEqual({ size: 4096, source: 'server' })
  })

  it('turns the "no chat-capable component" reply into guidance', async () => {
    fake.chatReply = () => "\n\nError: Collection 'LMX-Omni-5.5B-Lite' has no chat-capable component"
    await expect(client.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(
      /component models aren't downloaded/
    )
  })

  it('surfaces any other in-band error with its reason', async () => {
    fake.chatReply = () => '\n\nError: Image generation failed'
    await expect(client.chat([{ role: 'user', content: 'draw' }], [])).rejects.toThrow(
      /reported an error: Image generation failed/
    )
  })

  it("leaves an ordinary reply that merely mentions an error alone", async () => {
    fake.chatReply = () => 'The build printed Error: something. I fixed it.'
    const choice = await client.chat([{ role: 'user', content: 'status?' }], [])
    expect(choice.message.content).toContain('I fixed it')
  })
})

describe('chat() with an ordinary model', () => {
  it('never treats an "Error:" reply as a failure, and checks the model type only once', async () => {
    fake.entries['Qwen3-4B'] = { id: 'Qwen3-4B', recipe: 'llamacpp', downloaded: true }
    fake.chatReply = () => 'Error: this is just what the model said'
    client = new LemonadeClient(fake.url, '', 'Qwen3-4B')
    const first = await client.chat([{ role: 'user', content: 'x' }], [])
    await client.chat([{ role: 'user', content: 'y' }], [])
    expect(first.message.content).toBe('Error: this is just what the model said')
    expect(fake.requests.filter((r) => r.path === '/models/Qwen3-4B')).toHaveLength(1)
  })
})

describe('force stop', () => {
  it('aborts a chat stream that has no caller left to cancel it', async () => {
    fake.chatHang = true
    client = new LemonadeClient(fake.url, '', 'Plain-Model')
    const pending = client.chat([{ role: 'user', content: 'go' }], [])
    const outcome = pending.then(
      () => 'finished',
      () => 'aborted'
    )
    await vi.waitFor(() => expect(chatPosts()).toHaveLength(1))
    expect(client.abortInference()).toBe(1)
    expect(await outcome).toBe('aborted')
    // Nothing left to abort once the stream is gone.
    expect(client.abortInference()).toBe(0)
  })

  it('reports which loaded models the server says are busy or streaming', async () => {
    fake.loaded = [
      { model_name: 'Idle-Model', type: 'llm', is_busy: false, is_streaming: false },
      { model_name: 'Busy-Model', type: 'llm', is_busy: true, is_streaming: true }
    ]
    client = new LemonadeClient(fake.url, '', 'Busy-Model')
    expect(await client.getActivity()).toEqual({
      online: true,
      busy: [{ model: 'Busy-Model', type: 'llm' }]
    })
  })

  it('reports an unreachable server as offline', async () => {
    client = new LemonadeClient('http://127.0.0.1:1/api/v1', '', 'Busy-Model')
    expect(await client.getActivity(500)).toEqual({ online: false, busy: [] })
  })
})

describe('listModels()', () => {
  it('counts an Omni collection as downloaded once its components are, whatever the server flag says', async () => {
    fake.catalogue = [
      { id: OMNI, recipe: 'collection.omni', labels: ['chat'], downloaded: false, components: COMPONENTS },
      { id: 'Qwen3.5-4B-MTP-GGUF', recipe: 'llamacpp', labels: ['chat', 'tool-calling'], downloaded: true },
      { id: 'SD-Turbo', recipe: 'sd-cpp', labels: ['image'], downloaded: true },
      { id: 'Whisper-Tiny', recipe: 'whispercpp', labels: ['transcription'], downloaded: true },
      { id: 'kokoro-v1', recipe: 'kokoro', labels: ['tts'], downloaded: true }
    ]
    fake.downloaded = COMPONENTS
    client = new LemonadeClient(fake.url, '', OMNI)
    const models = await client.listModels()
    expect(models.find((m) => m.id === OMNI)).toMatchObject({ omni: true, downloaded: true, active: true })
  })

  it('keeps a collection with a missing component as not downloaded', async () => {
    fake.catalogue = [
      { id: OMNI, recipe: 'collection.omni', labels: ['chat'], components: COMPONENTS },
      { id: 'Qwen3.5-4B-MTP-GGUF', recipe: 'llamacpp', labels: ['chat'], downloaded: true }
    ]
    fake.downloaded = ['Qwen3.5-4B-MTP-GGUF']
    client = new LemonadeClient(fake.url, '', OMNI)
    const models = await client.listModels()
    expect(models.find((m) => m.id === OMNI)?.downloaded).toBe(false)
  })

  it("ignores the collection's own downloaded flag when a component is missing", async () => {
    fake.catalogue = [
      { id: OMNI, recipe: 'collection.omni', labels: ['chat'], downloaded: true, components: COMPONENTS },
      ...COMPONENTS.map((id) => ({ id, downloaded: id !== 'kokoro-v1' }))
    ]
    fake.downloaded = [OMNI, ...COMPONENTS.filter((id) => id !== 'kokoro-v1')]
    client = new LemonadeClient(fake.url, '', OMNI)
    const models = await client.listModels()
    expect(models.find((m) => m.id === OMNI)?.downloaded).toBe(false)
  })

  it('files non-chat models under their own types', async () => {
    fake.catalogue = [
      { id: 'a', labels: ['chat', 'vision'] },
      { id: 'b', labels: ['classification'] },
      { id: 'c', labels: ['audio-generation'] },
      { id: 'd', labels: ['embeddings'] },
      { id: 'e', labels: ['image', 'edit'] }
    ]
    client = new LemonadeClient(fake.url, '', 'a')
    const types = Object.fromEntries((await client.listModels()).map((m) => [m.id, m.type]))
    expect(types).toEqual({ a: 'llm', b: 'classification', c: 'audio', d: 'embedding', e: 'image' })
  })
})

describe('dictation model choice', () => {
  const catalogue = (whisperDownloaded: boolean): unknown[] => [
    // The server lists its Moonshine models ahead of Whisper, none of them downloaded.
    { id: 'Moonshine-Medium-Streaming', recipe: 'moonshine', labels: ['transcription'], downloaded: false },
    { id: 'Whisper-Base', recipe: 'whispercpp', labels: ['transcription'], downloaded: false },
    { id: 'Whisper-Tiny', recipe: 'whispercpp', labels: ['transcription'], downloaded: whisperDownloaded }
  ]

  it('uses a downloaded Whisper model instead of triggering a download of the first catalogue entry', async () => {
    fake.catalogue = catalogue(true)
    fake.downloaded = ['Whisper-Tiny']
    client = new LemonadeClient(fake.url, '', 'x')
    await expect(client.transcribe('AAAA', 'audio/wav', 'whisper-base')).resolves.toBe('hello world')
    const call = fake.requests.find((r) => r.path === '/audio/transcriptions')
    expect(call?.body).toContain('Whisper-Tiny')
    expect(call?.body).not.toContain('Moonshine')
  })

  it('fails fast with guidance when no speech-to-text model is downloaded', async () => {
    fake.catalogue = catalogue(false)
    fake.downloaded = []
    client = new LemonadeClient(fake.url, '', 'x')
    await expect(client.transcribe('AAAA', 'audio/wav', 'whisper-base')).rejects.toThrow(
      /No speech-to-text model is downloaded/
    )
    expect(fake.requests.some((r) => r.path === '/audio/transcriptions')).toBe(false)
  })
})

describe('loadModel() for an Omni collection', () => {
  it('pulls a not-yet-downloaded collection, loads it, then raises its chat component to the requested context', async () => {
    fake.entries[OMNI] = { id: OMNI, recipe: 'collection.omni', components: [], models: [] }
    fake.onPost = (path) => {
      if (path === '/pull') fake.entries[OMNI] = omniEntry(COMPONENTS)
      if (path === '/load' && fake.loaded.length === 0) {
        // Loading the collection brings its components up at the server's default context.
        fake.loaded = [
          { model_name: 'Qwen3.5-4B-MTP-GGUF', type: 'llm', loaded: true, recipe_options: { ctx_size: 4096 } }
        ]
      }
    }
    client = new LemonadeClient(fake.url, '', 'something-else')
    await expect(client.loadModel(OMNI, 131072)).resolves.toEqual({ ok: true })

    const posts = fake.requests.filter((r) => r.method === 'POST').map((r) => `${r.path} ${r.body}`)
    expect(posts[0]).toContain('/pull')
    expect(posts[1]).toContain(`/load {"model_name":"${OMNI}"`)
    expect(posts[2]).toBe(
      '/load {"model_name":"Qwen3.5-4B-MTP-GGUF","ctx_size":131072,"save_options":true}'
    )
    expect(client.activeModel).toBe(OMNI)
  })

  it('does not reload the chat component when it already has enough context', async () => {
    fake.entries[OMNI] = omniEntry(COMPONENTS)
    fake.loaded = [
      { model_name: 'Qwen3.5-4B-MTP-GGUF', type: 'llm', loaded: true, recipe_options: { ctx_size: 131072 } }
    ]
    client = new LemonadeClient(fake.url, '', 'something-else')
    await client.loadModel(OMNI, 131072)
    const loads = fake.requests.filter((r) => r.method === 'POST' && r.path === '/load')
    expect(loads).toHaveLength(1)
    expect(fake.requests.some((r) => r.path === '/pull')).toBe(false)
  })

  it('lets a newer model choice supersede a slow startup pull', async () => {
    fake.entries[OMNI] = { id: OMNI, recipe: 'collection.omni', components: [], models: [] }
    fake.entries['Qwen3-4B'] = { id: 'Qwen3-4B', recipe: 'llamacpp', downloaded: true }
    let markPullStarted: (() => void) | undefined
    let releasePull: (() => void) | undefined
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve
    })
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve
    })
    fake.onPost = async (path) => {
      if (path !== '/pull') return
      markPullStarted?.()
      await pullGate
      fake.entries[OMNI] = omniEntry(COMPONENTS)
    }

    client = new LemonadeClient(fake.url, '', OMNI, 131072)
    const startupLoad = client.loadModel(OMNI, 131072)
    await pullStarted
    await expect(client.loadModel('Qwen3-4B', 8192)).resolves.toEqual({ ok: true })
    releasePull?.()
    await expect(startupLoad).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/superseded/) })

    expect(client.activeModel).toBe('Qwen3-4B')
    const loadBodies = fake.requests
      .filter((request) => request.method === 'POST' && request.path === '/load')
      .map((request) => request.body)
    expect(loadBodies).toEqual(['{"model_name":"Qwen3-4B","ctx_size":8192}'])
  })

  it('uses the saved context preference when a model is loaded without an explicit size', async () => {
    fake.entries['Qwen3-4B'] = { id: 'Qwen3-4B', recipe: 'llamacpp', downloaded: true }
    client = new LemonadeClient(fake.url, '', 'old-model', 32768)
    await expect(client.loadModel('Qwen3-4B')).resolves.toEqual({ ok: true })
    const load = fake.requests.find((request) => request.method === 'POST' && request.path === '/load')
    expect(load?.body).toBe('{"model_name":"Qwen3-4B","ctx_size":32768}')
    expect(await client.resolveContextSize()).toEqual({ size: 32768, source: 'server' })
  })
})

describe('setConnection()', () => {
  it('does not reuse vision capability learned from the previous server', async () => {
    const id = 'same-id'
    fake.entries[id] = { id, recipe: 'llamacpp', downloaded: true }
    fake.catalogue = [{ id, recipe: 'llamacpp', labels: ['chat', 'vision'], downloaded: true }]
    fake.downloaded = [id]
    client = new LemonadeClient(fake.url, '', id)
    await client.listModels()

    fake.catalogue = [{ id, recipe: 'llamacpp', labels: ['chat'], downloaded: true }]
    client.setConnection(fake.url, '')
    await client.chat(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
          ]
        }
      ],
      []
    )

    const request = JSON.parse(chatPosts()[0].body) as { messages: { content: unknown }[] }
    expect(request.messages[0].content).toEqual(
      expect.stringContaining("current model can't view images")
    )
  })
})
