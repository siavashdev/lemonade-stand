import OpenAI, { toFile } from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import type { ContextBreakdown, ContextInfo, DownloadJob, ModelInfo } from '@shared/types'
import {
  collectionStatus,
  describeCollectionNotReady,
  isCollectionReady,
  modelTypeFromLabels,
  parseCollectionError,
  parseContextOverflow,
  pickDownloadedModel,
  type CollectionStatus,
  type ModelsEntry
} from './models'
import { InferenceTracker } from './inference'
// Fallback context window used only when no override is configured and the
// server can't be reached to report the loaded model's runtime context.
const DEFAULT_CONTEXT_SIZE = 4096

// Context size a model is loaded with when the caller doesn't pick one. 8192 is
// the smallest power-of-two that fits the tool-heavy agent prompt (~4.3K) AND
// leaves room to generate a file, so it avoids the common overflow error while
// staying memory-frugal. Every LLM this server ships supports far more.
export const DEFAULT_LOAD_CONTEXT = 8192

// How long a "this Omni collection is fully downloaded" check stays trusted
// before chat() asks the server again.
const COLLECTION_READY_TTL_MS = 30_000

// How long the downloaded TTS / speech-to-text model picked for a feature is
// reused before the server's model list is consulted again.
const AUDIO_MODEL_TTL_MS = 5 * 60_000

// Shape (subset) of lemond's /health response we rely on for context info.
interface HealthModel {
  model_name?: string
  type?: string
  max_context_window?: number
  recipe_options?: { ctx_size?: number }
  loaded?: boolean
}
interface HealthResponse {
  model_loaded?: string
  all_models_loaded?: HealthModel[]
}

// Shape (subset) of a Lemonade /downloads job snapshot. Byte totals come under
// several aliases depending on server version; we read the most complete one.
interface DownloadEntry {
  id?: string
  model_name?: string
  status?: string
  running?: boolean
  file_index?: number
  total_files?: number
  bytes_total?: number
  total_download_size?: number
  cumulative_bytes_downloaded?: number
  overall_bytes_downloaded?: number
  bytes_downloaded?: number
  percent?: number
  complete?: boolean
  error?: string
}

// Result of comparing an outgoing request against the model's context budget.
export interface ContextBudget {
  estimatedTokens: number
  /** Effective context window (tokens). */
  contextSize: number
  /** Tokens reserved for the reply. */
  reserve: number
  /** Usable prompt tokens = contextSize - reserve. */
  budget: number
  /** true when the estimate exceeds the usable budget (request should not be sent). */
  overflow: boolean
  /** true when the estimate is close to the budget but not yet over it. */
  warn: boolean
  source: ContextInfo['source']
}

// Whether any message carries an inline image part (multimodal content array).
// Used to skip the vision-capability lookup entirely for the common all-text case.
function messagesHaveImages(messages: ChatCompletionMessageParam[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((part) => (part as { type?: string }).type === 'image_url')
  )
}

// Replace a message's inline image parts with a short text note, flattening the
// content back to a plain string. Sent to text-only models so the request stays
// valid (no "image input is not supported" 500) while the model is still told an
// image was attached and why it can't see it. Non-multimodal messages pass through.
function stripImageContent(message: ChatCompletionMessageParam): ChatCompletionMessageParam {
  if (!Array.isArray(message.content)) return message
  let removed = 0
  const texts: string[] = []
  for (const part of message.content) {
    if ((part as { type?: string }).type === 'image_url') removed++
    else if ((part as { type?: string }).type === 'text')
      texts.push((part as { text: string }).text)
  }
  if (removed === 0) return message
  const note =
    `[${removed} image attachment${removed === 1 ? '' : 's'} omitted: the current model can't ` +
    `view images. Load a vision-capable model to analyze pictures.]`
  const body = texts.filter(Boolean).join('\n')
  const content = (body ? `${body}\n\n` : '') + note
  return { ...message, content } as ChatCompletionMessageParam
}

// Many chat templates (Qwen3.x and others) raise "System message must be at the
// beginning" unless there is at most one system message and it comes first.
// Compaction pins a summary and plan as extra system messages, so fold every
// system message into a single leading one before the request goes out.
export function mergeSystemMessages(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const system = messages.filter((m) => m.role === 'system')
  if (system.length === 0 || (system.length === 1 && messages[0].role === 'system')) return messages
  const text = (m: ChatCompletionMessageParam): string =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
  const merged: ChatCompletionMessageParam = {
    role: 'system',
    content: system.map(text).join('\n\n')
  }
  return [merged, ...messages.filter((m) => m.role !== 'system')]
}

// Thin wrapper over the OpenAI SDK pointed at a running lemond. Lemonade
// implements the OpenAI-compatible surface under /api/v1, so the stock SDK
// works unchanged; we only supply baseURL + (optional) apiKey.
export class LemonadeClient {
  private client: OpenAI
  private model: string
  private baseURL: string
  private apiKey: string
  private contextOverride?: number
  private completionReserve: number
  // Hard cap on the reply length (max_completion_tokens). Bounds runaway
  // reasoning/output. 0 = no cap (server default).
  private maxCompletionTokens: number
  // Cached server-reported context size, so we don't refetch every step. Only a
  // successful lookup is cached; failures fall back and retry next turn.
  private cachedServerContext?: number
  // Cached model max context window from the last successful /health lookup.
  private cachedMaxContext?: number
  // The downloaded TTS / speech-to-text model last picked for a feature, reused
  // for a few minutes so each spoken reply or dictation doesn't re-list the
  // server's models. Keeps a stale/renamed configured id from silently breaking
  // the feature, without ever picking a model the server would have to download.
  private resolvedAudioModels = new Map<'tts' | 'stt', { id: string; at: number }>()
  // Which model ids are Omni collections (true) or ordinary models (false), as
  // learned from /models/{id}. chat() only needs to vet collections, so ordinary
  // models are looked up once and then skipped.
  private collectionKinds = new Map<string, boolean>()
  // When each Omni collection was last confirmed fully downloaded, so a chat
  // turn doesn't re-check on every agent step.
  private collectionReadyAt = new Map<string, number>()
  // Cached per-model vision capability (id -> supports image input), populated
  // whenever listModels() runs. Lets chat() strip inline images before sending
  // them to a text-only model, which would otherwise 500 with "image input is
  // not supported" and abort the whole turn.
  private visionCapable = new Map<string, boolean>()
  /** The chat requests this app makes, reported to the Monitoring view. */
  readonly inference = new InferenceTracker()
  // Context size to request when the user switches models. This starts with the
  // saved setting and follows successful context edits, while budgeting itself
  // still uses the server's runtime value after a load.
  private preferredContextSize?: number
  // A newer model load (or a server change) cancels the older one. In
  // particular, a slow startup Omni pull must not switch the model back after
  // the user has already selected another model.
  private activeLoad: AbortController | null = null

  constructor(
    baseURL: string,
    apiKey: string,
    model: string,
    contextOverride?: number,
    completionReserve = 512,
    maxCompletionTokens = 0
  ) {
    this.client = new OpenAI({
      baseURL,
      // The SDK requires a non-empty key even when the server doesn't enforce
      // one; send a placeholder so unauthenticated local servers still work.
      apiKey: apiKey || 'lemonade'
    })
    this.model = model
    this.baseURL = baseURL
    this.apiKey = apiKey
    this.contextOverride = contextOverride && contextOverride > 0 ? contextOverride : undefined
    this.preferredContextSize = this.contextOverride
    this.completionReserve = completionReserve
    this.maxCompletionTokens = maxCompletionTokens > 0 ? maxCompletionTokens : 0
  }

  /** The current reply-length cap (max_completion_tokens); 0 means no cap. */
  get replyCap(): number {
    return this.maxCompletionTokens
  }

  /** Update the reply-length cap live (no server reload needed). A value <= 0
   * disables the cap. Takes effect on the next chat completion. */
  setMaxCompletionTokens(tokens: number): void {
    this.maxCompletionTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0
  }

  /** Tokens to hold back for the reply when budgeting the prompt. When a reply
   * cap is set we must reserve at least that many, so the preflight leaves room
   * for the full capped reply instead of letting it overflow the window. */
  private get effectiveReserve(): number {
    return this.maxCompletionTokens > 0
      ? Math.max(this.completionReserve, this.maxCompletionTokens)
      : this.completionReserve
  }

  /** The id of the model currently configured as the agent's chat model. */
  get activeModel(): string {
    return this.model
  }

  /** The Lemonade server this client currently targets (base URL + API key),
   * surfaced so the UI can show and edit the active connection. */
  get connection(): { baseUrl: string; apiKey: string } {
    return { baseUrl: this.baseURL, apiKey: this.apiKey }
  }

  /**
   * Repoint this client at a different Lemonade server. Recreates the OpenAI
   * client with the new base URL / key and clears every server-derived cache so
   * nothing from the old server leaks across (context sizes, resolved TTS and
   * transcription model ids, Omni collection state). Callers persist the choice
   * and re-probe health.
   */
  setConnection(baseURL: string, apiKey: string): void {
    this.activeLoad?.abort()
    this.activeLoad = null
    this.baseURL = baseURL
    this.apiKey = apiKey
    this.client = new OpenAI({ baseURL, apiKey: apiKey || 'lemonade' })
    this.cachedServerContext = undefined
    this.cachedMaxContext = undefined
    this.resolvedAudioModels.clear()
    this.collectionKinds.clear()
    this.collectionReadyAt.clear()
    this.visionCapable.clear()
  }

  /**
   * Build the headers for our raw `/health` probes. The OpenAI SDK attaches the
   * key to chat/model calls for us, but these hand-rolled `fetch`es don't go
   * through it, so we must send `Authorization` ourselves , otherwise a server
   * launched with an API key answers /health with 401 and the app looks offline.
   */
  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
  }

  /**
   * Probe the running lemond via its OpenAI-compatible `/health` endpoint.
   * Returns true only on a 2xx response within the timeout; any network error
   * (server not running) or non-2xx status resolves to false rather than
   * throwing, so callers can render a simple online/offline indicator.
   */
  async health(timeoutMs = 3000): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseURL}/health`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: controller.signal
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Fetch the /health payload and pick out the entry for this chat model (or the
   * server's currently loaded LLM). This is where the *runtime* context size
   * lives: `recipe_options.ctx_size` is what the model was actually loaded with,
   * which can be smaller than the model's advertised `max_context_window`.
   */
  private async fetchModelHealth(timeoutMs = 3000): Promise<HealthModel | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.baseURL}/health`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: controller.signal
      })
      if (!response.ok) return null
      const body = (await response.json()) as HealthResponse
      const models = body.all_models_loaded ?? []
      // Prefer the entry matching our configured chat model; otherwise fall back
      // to whatever LLM the server currently has loaded. Omni collections have
      // no backend of their own , chat runs on a loaded LLM component , so the
      // collection name never matches an LLM here; the loaded-LLM fallbacks
      // resolve context from that component instead of dropping to the default.
      return (
        models.find((m) => m.type === 'llm' && m.model_name === this.model) ??
        models.find((m) => m.type === 'llm' && m.model_name === body.model_loaded) ??
        models.find((m) => m.type === 'llm' && m.loaded) ??
        models.find((m) => m.type === 'llm') ??
        null
      )
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Resolve the effective context window (in tokens) for the chat model:
   *   1. an explicit override (config/env) always wins;
   *   2. otherwise the loaded model's runtime `ctx_size` from /health;
   *   3. otherwise a conservative built-in fallback.
   * A successful server lookup is cached until the context is changed.
   */
  async resolveContextSize(): Promise<{ size: number; source: ContextInfo['source'] }> {
    if (this.contextOverride) return { size: this.contextOverride, source: 'override' }
    if (this.cachedServerContext) return { size: this.cachedServerContext, source: 'server' }

    const entry = await this.fetchModelHealth()
    if (entry?.max_context_window && entry.max_context_window > 0) {
      this.cachedMaxContext = entry.max_context_window
    }
    const ctx = entry?.recipe_options?.ctx_size
    if (typeof ctx === 'number' && ctx > 0) {
      this.cachedServerContext = ctx
      return { size: ctx, source: 'server' }
    }
    return { size: DEFAULT_CONTEXT_SIZE, source: 'default' }
  }

  /**
   * List the models the server knows about, merged with which one is currently
   * loaded (from /health). A model is flagged `agentReady` when its labels
   * advertise tool-calling , the capability the agent loop depends on.
   */
  async listModels(): Promise<ModelInfo[]> {
    // 1. The plain /models list reports only *downloaded* models. We use it as
    //    the authoritative "is this on disk?" signal, since the full catalogue
    //    (below) can under-report downloaded state for pointer-based Omni
    //    collections whose components are already present.
    const downloadedEntries =
      (await this.getJson<{ data?: ModelsEntry[] }>('/models', 5000))?.data ?? []
    const downloadedIds = new Set<string>()
    for (const e of downloadedEntries) if (e.id) downloadedIds.add(e.id)

    // 2. The full catalogue (show_all=true) is the source of truth for *which*
    //    models to display, so not-yet-downloaded models , and models the user
    //    just uninstalled , stay visible with a Download button instead of
    //    vanishing from the list.
    let entries =
      (await this.getJson<{ data?: ModelsEntry[] }>('/models?show_all=true', 5000))?.data ?? []
    // If the full catalogue couldn't be fetched, fall back to whatever the
    // downloaded-only list returned so the picker still works offline-ish.
    if (entries.length === 0) entries = downloadedEntries

    // Which model ids are currently loaded, per /health.
    const loaded = new Set<string>()
    const health = await this.getJson<HealthResponse>('/health', 3000)
    for (const m of health?.all_models_loaded ?? []) {
      if (m.loaded && m.model_name) loaded.add(m.model_name)
    }

    // A model is on disk when the downloaded-only list says so, or the catalogue
    // entry itself does.
    const onDisk = new Set(downloadedIds)
    for (const e of entries) if (e.id && e.downloaded) onDisk.add(e.id)

    return entries.map((e) => {
      const labels = e.labels ?? []
      // Omni is a router recipe that loads several models at once; the server
      // tags these entries with recipe 'collection.omni'. They're multimodal
      // and well-suited to agentic use.
      const omni = e.recipe === 'collection.omni'
      const components = omni ? (e.components ?? []) : undefined
      // Vision-capable models advertise the 'vision' label (they ship an mmproj
      // projector); Omni routers bundle a vision component. Cache this so chat()
      // can avoid sending images to a model that can't accept them.
      if (e.id) this.visionCapable.set(e.id, omni || labels.includes('vision'))
      // A collection has no weights of its own, so it counts as downloaded once
      // its manifest is pulled and every component is on disk. The server's own
      // flag for it can't be trusted: v2026.46 flips it to false as soon as the
      // collection is loaded, which left a fully installed Omni model showing a
      // "Download" button instead of "Load".
      const collectionOnDisk =
        components !== undefined &&
        components.length > 0 &&
        components.every((c) => onDisk.has(c))
      return {
        id: e.id ?? '',
        type: modelTypeFromLabels(labels, omni),
        labels,
        maxContextWindow: e.max_context_window,
        sizeGb: e.size,
        // Trust the authoritative downloaded-only list first; the full catalogue
        // can report a pointer Omni collection as not-downloaded even when its
        // components are already on disk.
        downloaded: omni ? collectionOnDisk : e.id ? onDisk.has(e.id) : false,
        loaded: e.id ? loaded.has(e.id) : false,
        agentReady: labels.includes('tool-calling') || omni,
        omni,
        components,
        systemPrompt: omni ? e.system_prompt : undefined,
        active: e.id === this.model
      }
    })
  }

  /**
   * Load a model on the server via /load and make it the app's active chat
   * model. Loads with `ctxSize` (default 8192) so the model is immediately
   * usable for tool-heavy agent turns without a manual context bump. Clears
   * cached context so the next budget check reflects the new model. Loading
   * (and any download) can take a while, so the timeout is long.
   */
  async loadModel(
    id: string,
    ctxSize?: number
  ): Promise<{ ok: boolean; error?: string }> {
    this.activeLoad?.abort()
    const operation = new AbortController()
    this.activeLoad = operation
    const requestedContext = ctxSize ?? this.preferredContextSize ?? DEFAULT_LOAD_CONTEXT
    const superseded = (): boolean => this.activeLoad !== operation || operation.signal.aborted
    const supersededResult = (): { ok: false; error: string } => ({
      ok: false,
      error: 'Model load was superseded by a newer request.'
    })

    // Pointer-based Omni collections (e.g. LMX-Omni-*, RPG-HaloTales) resolve
    // their component list only after their manifest is downloaded, and the
    // server's /load intentionally skips downloading for collection recipes.
    // Loading such a collection before it's pulled fails with "GGUF file not
    // found for checkpoint", so pull it first to register + fetch its parts. The
    // same goes for a collection whose manifest is known but whose components
    // aren't all on disk (e.g. after the server's model store was replaced).
    try {
      const status = await this.fetchCollectionStatus(id, operation.signal)
      if (superseded()) return supersededResult()
      if (status?.isCollection && !isCollectionReady(status)) {
        console.info(
          `[lemonade] Omni model "${id}" isn't fully downloaded ` +
            (status.components.length === 0
              ? '(no component list yet)'
              : `(missing ${status.missing.join(', ')})`) +
            '; pulling it before loading, which can take several minutes'
        )
        const pulled = await this.pullModel(id, operation.signal)
        if (superseded()) return supersededResult()
        if (!pulled.ok) return pulled
      }

      const response = await fetch(`${this.baseURL}/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model_name: id, ctx_size: requestedContext }),
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(300_000)])
      })
      if (superseded()) return supersededResult()
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const error = `Server returned ${response.status}: ${detail || 'load failed'}`
        console.warn(`[lemonade] loading "${id}" failed: ${error}`)
        return { ok: false, error }
      }
      this.model = id
      this.contextOverride = undefined
      this.preferredContextSize = requestedContext
      this.cachedServerContext = requestedContext
      this.cachedMaxContext = undefined
      console.info(`[lemonade] loaded "${id}"`)
      // The server ignores `ctx_size` when loading a collection (each component
      // loads with its own saved options), so apply it to the chat component
      // ourselves. Without this an Omni model comes up with a 4096-token window
      // that the agent's tool-heavy prompt can't fit.
      if (status?.isCollection) await this.matchCollectionContext(requestedContext, operation.signal)
      if (superseded()) return supersededResult()
      return { ok: true }
    } catch (err) {
      if (superseded()) return supersededResult()
      const error = err instanceof Error ? err.message : String(err)
      console.warn(`[lemonade] loading "${id}" failed: ${error}`)
      return { ok: false, error }
    } finally {
      if (this.activeLoad === operation) this.activeLoad = null
    }
  }

  /**
   * Make an Omni collection's chat component run with at least `ctxSize` tokens
   * of context. A collection's `/load` doesn't forward `ctx_size` to its parts,
   * so after loading one the LLM component is reloaded directly with the size
   * persisted (`save_options`), mirroring what the context editor does. Best
   * effort: failures are logged and leave the component as it was.
   */
  private async matchCollectionContext(ctxSize: number, signal?: AbortSignal): Promise<void> {
    try {
      const llm = await this.fetchModelHealth()
      const component = llm?.model_name
      const current = llm?.recipe_options?.ctx_size
      if (!component || typeof current !== 'number') return
      if (current >= ctxSize) {
        this.cachedServerContext = current
        return
      }
      console.info(
        `[lemonade] "${component}" (chat component of "${this.model}") runs with a ${current}-token ` +
          `context; reloading it with ${ctxSize}`
      )
      const response = await fetch(`${this.baseURL}/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model_name: component, ctx_size: ctxSize, save_options: true }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
          : AbortSignal.timeout(180_000)
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        console.warn(
          `[lemonade] couldn't raise "${component}" to ${ctxSize} tokens: ` +
            `server returned ${response.status}: ${detail || 'load failed'}`
        )
        return
      }
      this.cachedServerContext = ctxSize
    } catch (err) {
      if (signal?.aborted) return
      console.warn(
        `[lemonade] couldn't raise the chat component's context: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Download a model (and, for Omni collections, its manifest and component
   * models) via the server's /pull. Used to prime a not-yet-downloaded Omni
   * collection before /load, since collection routers only resolve their
   * component list once their manifest is present. Downloads can be large, so
   * the timeout is generous.
   */
  async pullModel(id: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    // Whatever was known about this collection is stale once a pull starts.
    this.collectionReadyAt.delete(id)
    try {
      const response = await fetch(`${this.baseURL}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model_name: id, stream: false }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(1_800_000)])
          : AbortSignal.timeout(1_800_000)
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const error = `Server returned ${response.status}: ${detail || 'pull failed'}`
        console.warn(`[lemonade] pulling "${id}" failed: ${error}`)
        return { ok: false, error }
      }
      console.info(`[lemonade] pulled "${id}"`)
      return { ok: true }
    } catch (err) {
      if (signal?.aborted) {
        return { ok: false, error: 'Model load was superseded by a newer request.' }
      }
      const error = err instanceof Error ? err.message : String(err)
      console.warn(`[lemonade] pulling "${id}" failed: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * Delete a downloaded model from local storage via the server's /delete. If
   * the model is currently loaded, the server unloads it first. Note: deleting
   * an Omni collection removes only the collection entry , its component models
   * stay on disk (delete those individually to reclaim their space).
   */
  async deleteModel(id: string): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    // What's known about this model (a collection's readiness, a speech model
    // picked earlier) is out of date the moment it is deleted.
    this.collectionReadyAt.delete(id)
    this.resolvedAudioModels.clear()
    try {
      const response = await fetch(`${this.baseURL}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model_name: id }),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return {
          ok: false,
          error: `Server returned ${response.status}: ${detail || 'delete failed'}`
        }
      }
      console.info(`[lemonade] deleted "${id}"`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Unload a model from server memory via the server's /unload, freeing its RAM
   * while leaving the server running. The model stays on disk and the server
   * will reload it on demand. Leaves `this.model` untouched: the app's active
   * chat model is a configuration choice independent of what's resident in
   * memory, so an unloaded active model simply reloads on the next request.
   */
  async unloadModel(id: string): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      const response = await fetch(`${this.baseURL}/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model_name: id }),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return {
          ok: false,
          error: `Server returned ${response.status}: ${detail || 'unload failed'}`
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Normalize a raw /downloads job snapshot into the renderer's DownloadJob. */
  private mapDownload(e: DownloadEntry): DownloadJob {
    const status = (e.status ?? 'downloading') as DownloadJob['status']
    return {
      id: e.id ?? (e.model_name ? `model:${e.model_name}` : ''),
      modelName: e.model_name ?? '',
      status: ['downloading', 'paused', 'cancelled', 'completed', 'error'].includes(status)
        ? status
        : 'downloading',
      running: e.running ?? false,
      percent: typeof e.percent === 'number' ? e.percent : 0,
      // Prefer the whole-job cumulative total; fall back to the per-file count.
      bytesDownloaded:
        e.cumulative_bytes_downloaded ??
        e.overall_bytes_downloaded ??
        e.bytes_downloaded ??
        0,
      bytesTotal: e.total_download_size || e.bytes_total || 0,
      fileIndex: e.file_index,
      totalFiles: e.total_files,
      complete: e.complete ?? false,
      error: e.error
    }
  }

  /**
   * Kick off a *server-owned* background download of a model via /pull with
   * `stream:true, subscribe:false`. The server starts the job and returns a
   * snapshot immediately; the download then proceeds independently of this
   * connection, so it survives a renderer reload. Poll {@link listDownloads} to
   * track progress. Returns the initial job snapshot.
   */
  async startDownload(id: string): Promise<DownloadJob> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    this.collectionReadyAt.delete(id)
    try {
      const response = await fetch(`${this.baseURL}/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model_name: id, stream: true, subscribe: false }),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Server returned ${response.status}: ${detail || 'download failed'}`)
      }
      const body = (await response.json()) as DownloadEntry
      console.info(`[lemonade] started downloading "${id}"`)
      return this.mapDownload({ ...body, model_name: body.model_name ?? id })
    } finally {
      clearTimeout(timer)
    }
  }

  /** List the server's current model download jobs (for live progress). */
  async listDownloads(): Promise<DownloadJob[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(`${this.baseURL}/downloads`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: controller.signal
      })
      if (!response.ok) return []
      const body = (await response.json()) as DownloadEntry[]
      return (body ?? []).filter((e) => e.model_name).map((e) => this.mapDownload(e))
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  /** Pause, cancel, or remove a server-owned model download job. */
  async controlDownload(id: string, action: 'pause' | 'cancel' | 'remove'): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      await fetch(`${this.baseURL}/downloads/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ id, action }),
        signal: controller.signal
      })
    } catch {
      // Best-effort; the next poll reflects the real job state regardless.
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET `path` (relative to the base URL) as JSON, or null on any failure
   * (unreachable, timed out, non-2xx, or not JSON). */
  async getJson<T>(
    path: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseURL}${path}`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
      })
      if (!response.ok) return null
      return (await response.json()) as T
    } catch {
      return null
    }
  }

  /** Fetch a single model's registry entry from /models/{id}, or null. */
  private async fetchModelEntry(id: string, signal?: AbortSignal): Promise<ModelsEntry | null> {
    return this.getJson<ModelsEntry>(`/models/${encodeURIComponent(id)}`, 5000, signal)
  }

  /**
   * Whether `id` is an Omni collection and, if so, which of its components are
   * missing. Null when the server can't be asked (down, or it doesn't know the
   * id); callers then proceed and let the real request report the problem. The
   * answer also records whether the model is a collection at all, so chat() can
   * skip this lookup for ordinary models.
   */
  private async fetchCollectionStatus(
    id: string,
    signal?: AbortSignal
  ): Promise<CollectionStatus | null> {
    const entry = await this.fetchModelEntry(id, signal)
    if (!entry) return null
    let status = collectionStatus(entry)
    // Older and transitional servers may omit all or only some component
    // states. Fill every unrepresented component from the downloaded-only list.
    const represented = new Set((entry.models ?? []).flatMap((model) => (model.id ? [model.id] : [])))
    if (
      status.isCollection &&
      status.components.length > 0 &&
      status.components.some((component) => !represented.has(component))
    ) {
      const body = await this.getJson<{ data?: ModelsEntry[] }>('/models', 5000, signal)
      if (body) {
        const downloaded = new Set<string>()
        for (const e of body.data ?? []) if (e.id) downloaded.add(e.id)
        status = collectionStatus(entry, downloaded)
      }
    }
    if (signal?.aborted) return null
    this.collectionKinds.set(id, status.isCollection)
    return status
  }

  /**
   * On startup, make sure the active chat model is loaded with at least the
   * default context window. The server (and its own defaults) may have the
   * model unloaded or loaded at a smaller context after a restart, which is why
   * the app's context budget would otherwise revert to the 4096 fallback. This
   * runs best-effort: any failure (server down, model still downloading) is
   * logged and swallowed so it never blocks app launch.
   */
  async ensureModelLoaded(ctxSize: number = DEFAULT_LOAD_CONTEXT): Promise<void> {
    this.preferredContextSize = ctxSize
    try {
      const entry = await this.fetchModelHealth()
      const current = entry?.recipe_options?.ctx_size
      // Already loaded at a big-enough context -> leave it (don't downgrade a
      // context the user may have raised on purpose).
      if (entry?.loaded && typeof current === 'number' && current >= ctxSize) return
      const result = await this.loadModel(this.model, ctxSize)
      if (!result.ok) {
        console.warn(`[lemonade] couldn't load "${this.model}" at startup: ${result.error}`)
      }
    } catch (err) {
      console.warn('[lemonade] startup model load failed:', err)
    }
  }

  /** Context-window info for the renderer to display. */
  async getContextInfo(): Promise<ContextInfo> {
    const { size, source } = await this.resolveContextSize()
    // The model's advertised max is a display hint. When it's still unknown
    // (e.g. /health didn't report it, or the active model is an Omni collection
    // that has no context of its own) resolve it from the loaded LLM component
    // and cache it for subsequent reads.
    if (this.cachedMaxContext === undefined) {
      this.cachedMaxContext = await this.resolveMaxContextWindow()
    }
    return {
      model: this.model,
      contextSize: size,
      maxContextWindow: this.cachedMaxContext,
      reserve: this.effectiveReserve,
      maxCompletionTokens: this.maxCompletionTokens,
      source
    }
  }

  /**
   * Best-effort resolution of the *display* max context window (a UI hint).
   *
   * For a plain model this is its own catalogue `max_context_window`. For an
   * Omni collection , a router with no context window of its own , chat runs on
   * a loaded LLM component (e.g. Qwen3-…-GGUF), so we resolve the max from that
   * component instead of the collection entry, which reports none. The loaded
   * LLM's name comes from /health (fetchModelHealth already prefers it over the
   * collection name); we then read its catalogue entry for the max.
   */
  private async resolveMaxContextWindow(): Promise<number | undefined> {
    const health = await this.fetchModelHealth()
    // /health sometimes carries it directly (for a plain model or a component).
    if (health?.max_context_window && health.max_context_window > 0) {
      return health.max_context_window
    }
    // Otherwise consult the /models catalogue. Prefer the loaded LLM component's
    // name (set for Omni collections); fall back to the configured model id.
    const llmName = health?.model_name ?? this.model
    const viaComponent = await this.fetchModelEntry(llmName)
    if (viaComponent?.max_context_window && viaComponent.max_context_window > 0) {
      return viaComponent.max_context_window
    }
    // Last resort: the configured model's own entry, when it differs from the
    // component we just tried (a plain model whose health named something else).
    if (llmName !== this.model) {
      const own = await this.fetchModelEntry(this.model)
      if (own?.max_context_window && own.max_context_window > 0) {
        return own.max_context_window
      }
    }
    return undefined
  }

  /**
   * Reload the chat model with a new runtime context size via lemond's /load
   * endpoint. On success the cached budget is updated so the next request is
   * checked against the new window. Reloading can take a while, so the timeout
   * is generous.
   */
  async setContextSize(ctxSize: number): Promise<ContextInfo & { error?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180000)
    try {
      // Omni collections have no backend of their own: chat runs through the
      // server's collection orchestrator, which (re)loads each component from
      // its *saved* recipe_options.json , a transient ctx_size sent to the
      // collection is never forwarded to its parts. So target the loaded LLM
      // component directly and persist the size (save_options) so the next
      // collection turn doesn't reload the component back to its old default.
      const isCollection =
        (await this.fetchModelEntry(this.model))?.recipe === 'collection.omni'
      let target = this.model
      let saveOptions = false
      if (isCollection) {
        const component = (await this.fetchModelHealth())?.model_name
        if (component) {
          target = component
          saveOptions = true
        }
      }
      const response = await fetch(`${this.baseURL}/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ model_name: target, ctx_size: ctxSize, save_options: saveOptions }),
        signal: controller.signal
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const info = await this.getContextInfo()
        return { ...info, error: `Server returned ${response.status}: ${detail || 'load failed'}` }
      }
      // Trust the requested size and refresh the max/window cache from health.
      this.cachedServerContext = ctxSize
      const entry = await this.fetchModelHealth()
      if (entry?.max_context_window && entry.max_context_window > 0) {
        this.cachedMaxContext = entry.max_context_window
      }
      if (typeof entry?.recipe_options?.ctx_size === 'number') {
        this.cachedServerContext = entry.recipe_options.ctx_size
      }
      // /health may not report the model's advertised max; resolve it (via the
      // loaded LLM component for Omni collections) so the UI hint has a value.
      if (this.cachedMaxContext === undefined) {
        this.cachedMaxContext = await this.resolveMaxContextWindow()
      }
      // The user explicitly changed context from the UI. Honor that live choice
      // for the current session even when an env/config override was present,
      // so budget checks and warnings reflect what the server is now running.
      this.contextOverride = undefined
      this.preferredContextSize = this.cachedServerContext
      return {
        model: this.model,
        contextSize: this.cachedServerContext,
        maxContextWindow: this.cachedMaxContext,
        reserve: this.effectiveReserve,
        maxCompletionTokens: this.maxCompletionTokens,
        source: 'server'
      }
    } catch (err) {
      const info = await this.getContextInfo()
      return { ...info, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Rough token estimate for an outgoing request. Serializes the messages and
   * tool schemas and applies the common ~4-chars-per-token heuristic. This is
   * intentionally approximate: it only needs to be good enough to warn before a
   * request would exceed the model's context window.
   */
  estimateTokens(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
  ): number {
    const payload = JSON.stringify(messages) + JSON.stringify(tools ?? [])
    return Math.ceil(payload.length / 4)
  }

  /**
   * Compare an outgoing request against the resolved context budget so the
   * agent can warn (or block) before the server rejects an over-long prompt.
   */
  async checkBudget(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[]
  ): Promise<ContextBudget> {
    const { size, source } = await this.resolveContextSize()
    const estimatedTokens = this.estimateTokens(messages, tools)
    const budget = Math.max(0, size - this.effectiveReserve)
    const overflow = estimatedTokens > budget
    const warn = !overflow && estimatedTokens > budget * 0.85
    return {
      estimatedTokens,
      contextSize: size,
      reserve: this.effectiveReserve,
      budget,
      overflow,
      warn,
      source
    }
  }

  /**
   * Break the estimated prompt size down by category so the UI can show where
   * the context window is going. Uses the same ~4-chars-per-token heuristic as
   * `estimateTokens`, applied to each subset. `systemPrompt` is folded into the
   * system-instructions bucket when the history doesn't already carry a system
   * message (mirroring what the agent loop injects before sending).
   */
  async contextBreakdown(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    systemPrompt: string
  ): Promise<ContextBreakdown> {
    const { size } = await this.resolveContextSize()
    const est = (s: string): number => Math.ceil(s.length / 4)
    const contentOf = (m: ChatCompletionMessageParam): string =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')

    // The loop injects the system prompt only when none is present already.
    const hasSystem = messages.some((m) => m.role === 'system')
    const systemText =
      messages
        .filter((m) => m.role === 'system')
        .map(contentOf)
        .join('') + (hasSystem ? '' : systemPrompt)

    const messagesText = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map(contentOf)
      .join('')
    const toolResultsText = messages
      .filter((m) => m.role === 'tool')
      .map(contentOf)
      .join('')
    const toolDefsText = JSON.stringify(tools ?? [])

    const systemInstructions = est(systemText)
    const toolDefinitions = est(toolDefsText)
    const messagesTokens = est(messagesText)
    const toolResults = est(toolResultsText)

    // Total is estimated the same way the budget check does, so the indicator
    // agrees with the warn/overflow logic. `other` captures JSON structural
    // overhead (roles, ids, keys) not attributed to a content bucket above.
    const effective = hasSystem
      ? messages
      : [{ role: 'system', content: systemPrompt } as ChatCompletionMessageParam, ...messages]
    const usedTokens = this.estimateTokens(effective, tools)
    const categorized = systemInstructions + toolDefinitions + messagesTokens + toolResults
    const other = Math.max(0, usedTokens - categorized)

    return {
      model: this.model,
      contextSize: size,
      reserve: this.effectiveReserve,
      usedTokens,
      categories: {
        systemInstructions,
        toolDefinitions,
        messages: messagesTokens,
        toolResults,
        other
      }
    }
  }

  /**
   * Whether `id` is the id of a model that accepts image input, using the cache
   * populated by listModels(). On a cache miss it refreshes the model list once
   * (which fills the cache) before answering. Defaults to false when the answer
   * can't be determined, so images are stripped rather than risking a 500.
   */
  private async modelSupportsVision(id: string): Promise<boolean> {
    if (!id) return false
    const cached = this.visionCapable.get(id)
    if (cached !== undefined) return cached
    try {
      await this.listModels()
    } catch {
      // Best-effort; fall through to the default below.
    }
    return this.visionCapable.get(id) ?? false
  }

  /** Whether the server currently has a download running for `id`. */
  private async isDownloading(id: string): Promise<boolean> {
    const jobs = await this.listDownloads()
    return jobs.some((j) => j.modelName === id && (j.running || j.status === 'downloading'))
  }

  /**
   * Refuse to chat with an Omni collection that can't answer yet, with a clear
   * reason, instead of sending the request and showing the server's reply.
   *
   * A collection only lists its components once its manifest is pulled, and each
   * component has to be on disk. Chat sent before that makes the server pull the
   * parts *inside the request* (minutes of silence) and then fail with the cryptic
   * "Collection '…' has no chat-capable component", delivered as if it were the
   * model's answer. Ordinary models are recognised on the first call and skipped
   * from then on; a confirmed-ready collection is trusted for a short while.
   */
  private async assertChatModelReady(): Promise<void> {
    const id = this.model
    if (this.collectionKinds.get(id) === false) return
    const readyAt = this.collectionReadyAt.get(id)
    if (readyAt !== undefined && Date.now() - readyAt < COLLECTION_READY_TTL_MS) return
    const status = await this.fetchCollectionStatus(id)
    // Couldn't ask (server down, unknown id) or not a collection: let the real
    // request run and report whatever is actually wrong.
    if (!status?.isCollection) return
    if (isCollectionReady(status)) {
      this.collectionReadyAt.set(id, Date.now())
      return
    }
    this.collectionReadyAt.delete(id)
    const message = describeCollectionNotReady(id, status, await this.isDownloading(id))
    console.warn(`[lemonade] ${message}`)
    throw new Error(message)
  }

  /**
   * Turn an Omni collection's in-band failure (see parseCollectionError) into a
   * real, explained error. Also recalibrates the context window when the failure
   * reveals the server runs a smaller one than the app assumed.
   */
  private collectionFailure(reason: string): Error {
    const id = this.model
    this.collectionReadyAt.delete(id)
    if (/no chat-capable component/i.test(reason)) {
      return new Error(
        `The Omni model "${id}" can't chat yet: its component models aren't downloaded on the ` +
          'Lemonade server. Open Models and download it (or pick another model), then try again.'
      )
    }
    const overflow = parseContextOverflow(reason)
    if (overflow) {
      // Believe the server: budget against the window it really runs from now
      // on, so the agent warns/compacts before sending instead of failing here.
      this.cachedServerContext = overflow.available
      this.contextOverride = undefined
      return new Error(
        `This request needs about ${overflow.requested.toLocaleString()} tokens but "${id}" is ` +
          `running with only a ${overflow.available.toLocaleString()}-token context on the ` +
          'server. Raise it from the context button in the status bar, or start a new session.'
      )
    }
    return new Error(`The Omni model "${id}" reported an error: ${reason}`)
  }

  /**
   * Single chat completion. Tools are passed straight through in OpenAI
   * function-tool shape; the model may respond with tool_calls that the agent
   * loop is responsible for executing.
   *
   * The request is *streamed* even though callers only consume the final,
   * reassembled result. This is deliberate and load-bearing for the stop
   * button: with a non-streamed request, aborting the fetch closes the socket,
   * but the OpenAI-compatible backend (llama.cpp / OGA) doesn't notice the
   * client is gone until it writes the response , which never happens until the
   * whole reply is generated , so it keeps the GPU/NPU busy to completion (the
   * fan keeps spinning). Streaming makes the backend write a chunk per token,
   * so the dropped connection is detected on the next token and generation
   * stops promptly when the user hits stop.
   */
  async chat(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    signal?: AbortSignal,
    onReasoning?: (delta: string) => void
  ): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice> {
    await this.assertChatModelReady()
    // Text-only models reject inline images with a 500 that aborts the turn. If
    // any message carries an image and the loaded model can't see images, strip
    // the image parts and leave a note so the request stays valid and the model
    // can explain the limitation instead of the request failing outright.
    const normalized = mergeSystemMessages(messages)
    const outgoing = messagesHaveImages(normalized)
      ? (await this.modelSupportsVision(this.model))
        ? normalized
        : normalized.map(stripImageContent)
      : normalized
    const stream = this.client.chat.completions.stream(
      {
        model: this.model,
        messages: outgoing,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        // Cap the reply so a ruminating reasoning model can't generate until it
        // exhausts the context window ("overthinks it and takes forever"). 0
        // leaves it uncapped (server default).
        max_completion_tokens: this.maxCompletionTokens > 0 ? this.maxCompletionTokens : undefined
      },
      { signal }
    )
    // Report the request to the Monitoring view. An Omni collection is run by
    // the server's own loop, which doesn't update its /stats, so only those are
    // counted here; the rest just feed the "generating" state and live rate.
    const tracked = this.inference.begin(
      !this.collectionKinds.get(this.model),
      JSON.stringify(outgoing)
    )
    // Accumulate the model's chain-of-thought ourselves. Reasoning models served
    // by llama.cpp / OGA (e.g. Qwen3) stream their thinking in a non-standard
    // `reasoning_content` (or `reasoning`) delta field. The OpenAI SDK's stream
    // accumulator only *concatenates* the standard delta fields (content,
    // tool_calls, ...); unknown fields are Object.assign'd, so each chunk
    // OVERWRITES the previous , finalChatCompletion() would surface at most the
    // last token. So we append the fragments here and reattach the full text to
    // the final message below, where the agent loop's splitReasoning() reads it.
    let reasoning = ''
    stream.on('chunk', (chunk) => {
      const delta = chunk.choices[0]?.delta as
        | { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
        | undefined
      if (typeof delta?.content === 'string') tracked.text(delta.content)
      for (const call of chunk.choices[0]?.delta?.tool_calls ?? []) {
        tracked.text(`${call.function?.name ?? ''}${call.function?.arguments ?? ''}`)
      }
      if (typeof delta?.reasoning_content === 'string') {
        reasoning += delta.reasoning_content
        tracked.text(delta.reasoning_content)
        onReasoning?.(delta.reasoning_content)
      } else if (typeof delta?.reasoning === 'string') {
        reasoning += delta.reasoning
        tracked.text(delta.reasoning)
        onReasoning?.(delta.reasoning)
      }
    })
    // If the caller aborts, tear the stream (and its socket) down immediately so
    // the server stops generating instead of running to completion unheard.
    const onAbort = (): void => stream.controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    let completed = false
    try {
      const response = await stream.finalChatCompletion()
      completed = true
      const choice = response.choices[0]
      if (!choice) throw new Error('lemond returned no choices')
      // An Omni collection reports its failures as the assistant's own reply
      // (see parseCollectionError). Surface them as errors rather than letting
      // them be shown, saved to history, spoken, or used as a chat title.
      if (this.collectionKinds.get(this.model) && !choice.message.tool_calls?.length) {
        const reason = parseCollectionError(choice.message.content)
        if (reason) {
          console.warn(`[lemonade] Omni model "${this.model}" answered with an error: ${reason}`)
          throw this.collectionFailure(reason)
        }
      }
      // Reattach our fully-accumulated reasoning (the SDK reassembly drops it).
      // Authoritative: our concatenation is the complete text, so always prefer it.
      if (reasoning.trim()) {
        ;(choice.message as { reasoning_content?: string }).reasoning_content = reasoning
      }
      return choice
    } catch (err) {
      const overflow = parseContextOverflow(err instanceof Error ? err.message : String(err))
      if (overflow) {
        // Believe the server's real window so later budget checks compact in time.
        this.cachedServerContext = overflow.available
        this.contextOverride = undefined
      }
      throw err
    } finally {
      tracked.end(completed)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Compress a slice of conversation into a dense prose summary the agent can
   * carry forward in place of the raw messages. Runs a plain (tool-free) chat
   * completion so it can't trigger side effects. `priorSummary` folds an earlier
   * compaction back in so summaries don't accumulate as the chat grows.
   */
  async summarize(
    messages: ChatCompletionMessageParam[],
    priorSummary?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const transcript = messages
      .map((m) => {
        const content =
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
        return `${m.role.toUpperCase()}: ${content}`
      })
      .join('\n')
    const body =
      (priorSummary ? `Summary of the conversation so far:\n${priorSummary}\n\n` : '') +
      `Newer messages to fold in:\n${transcript}`
    const choice = await this.chat(
      [
        {
          role: 'system',
          content:
            'You compress conversations so they can continue within a limited context ' +
            'window. Produce a concise summary that preserves facts, decisions, task ' +
            'state, file names, identifiers, and any open questions or next steps. Write a ' +
            'few short paragraphs. Do not add commentary, preamble, or a title.'
        },
        { role: 'user', content: body }
      ],
      [],
      signal
    )
    return choice.message.content?.trim() ?? ''
  }

  /**
   * Ask the model for a short, specific conversation title. Best-effort: on any
   * failure the caller falls back to a trimmed first user message, so a slow or
   * offline server never blocks saving a session.
   */
  async generateTitle(
    messages: ChatCompletionMessageParam[],
    signal?: AbortSignal
  ): Promise<string> {
    const snippet = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, 4)
      .map((m) => {
        const content =
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
        return `${m.role.toUpperCase()}: ${content}`
      })
      .join('\n')
      .slice(0, 2000)
    const choice = await this.chat(
      [
        {
          role: 'system',
          content:
            'Generate a short, specific title (3 to 6 words) for the conversation. Reply ' +
            'with only the title: no quotes, no trailing punctuation, no "Title:" prefix.'
        },
        { role: 'user', content: snippet }
      ],
      [],
      signal
    )
    const raw = choice.message.content?.trim() ?? ''
    // Strip wrapping quotes and any trailing period the model adds anyway.
    return raw.replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 60)
  }

  /**
   * Pick the *downloaded* model of `type` ('tts' | 'transcription') to use for a
   * feature. `preferred` (from config) wins when it's downloaded (compared
   * case-insensitively); otherwise another downloaded model of the same family,
   * then any downloaded one. The choice is cached for a few minutes. If the
   * server can't be reached, or knows no model of that type at all, `preferred`
   * is returned unchanged so the request itself reports the real problem.
   *
   * A model that isn't downloaded is never chosen: the server would download it
   * *inside* the request, so speech or dictation would hang for as long as that
   * takes. This used to pick the first catalogue entry of the type, which after
   * the server added Moonshine speech models (listed ahead of Whisper) meant a
   * ~1 GB download on every first dictation. Throws a clear error when models of
   * the type exist but none is downloaded.
   */
  private async resolveAudioModel(
    feature: 'tts' | 'stt',
    preferred: string
  ): Promise<string> {
    const cached = this.resolvedAudioModels.get(feature)
    if (cached && Date.now() - cached.at < AUDIO_MODEL_TTL_MS) return cached.id
    const type = feature === 'tts' ? 'tts' : 'transcription'
    const models = await this.listModels()
    const ofType = models.filter((m) => m.type === type)
    if (ofType.length === 0) return preferred
    const chosen = pickDownloadedModel(models, type, preferred)
    if (!chosen) {
      const known = ofType.find((m) => m.id.toLowerCase() === preferred.toLowerCase()) ?? ofType[0]
      const kind = feature === 'tts' ? 'text-to-speech' : 'speech-to-text'
      throw new Error(
        `No ${kind} model is downloaded on the Lemonade server. Open Models and download one ` +
          `(for example ${known.id}${known.sizeGb ? `, ${known.sizeGb} GB` : ''}).`
      )
    }
    this.resolvedAudioModels.set(feature, { id: chosen.id, at: Date.now() })
    if (chosen.id !== preferred) {
      console.warn(
        `[${feature}] configured model "${preferred}" isn't downloaded; using "${chosen.id}" instead`
      )
    }
    return chosen.id
  }

  /**
   * Synthesize speech via lemond's OpenAI-compatible /v1/audio/speech endpoint
   * (backed by Kokoro TTS). Returns base64-encoded audio bytes plus the format
   * so the renderer can wrap them in the right MIME type. `stream=true` isn't
   * needed here , replies are short and we play them as one clip. The model id
   * is resolved against the server so a stale/renamed voice can't silently
   * break playback.
   */
  async speak(
    text: string,
    model: string,
    voice: string,
    format: string
  ): Promise<{ base64: string; format: string }> {
    const resolvedModel = await this.resolveAudioModel('tts', model)
    const response = await this.client.audio.speech.create({
      model: resolvedModel,
      voice: voice as never, // lemond accepts backend voice ids beyond the SDK's enum
      input: text,
      response_format: format as never
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    return { base64: bytes.toString('base64'), format }
  }

  /**
   * Transcribe recorded audio via lemond's OpenAI-compatible
   * /v1/audio/transcriptions endpoint (backed by Whisper). `audioBase64` holds
   * the raw recording bytes (typically WebM/Opus from the browser's
   * MediaRecorder) and `mimeType` its content type, used to pick a sensible
   * filename extension so the server can decode it. The model id is resolved
   * against the server so a stale/renamed model can't silently break dictation.
   */
  async transcribe(
    audioBase64: string,
    mimeType: string,
    model: string,
    signal?: AbortSignal
  ): Promise<string> {
    const resolvedModel = await this.resolveAudioModel('stt', model)
    const bytes = Buffer.from(audioBase64, 'base64')
    const ext = mimeType.includes('webm')
      ? 'webm'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('wav')
          ? 'wav'
          : mimeType.includes('mp4') || mimeType.includes('mp4a') || mimeType.includes('m4a')
            ? 'mp4'
            : mimeType.includes('mpeg') || mimeType.includes('mp3')
              ? 'mp3'
              : 'webm'
    const file = await toFile(bytes, `speech.${ext}`, { type: mimeType || 'audio/webm' })
    const response = await this.client.audio.transcriptions.create(
      {
        model: resolvedModel,
        file
      },
      { signal }
    )
    return response.text ?? ''
  }
}
