import type { ModelInfo } from '@shared/types'

// Pure helpers for interpreting what a Lemonade server says about its models.
// Kept free of I/O so the quirks of newer server versions can be unit-tested.

/** Shape (subset) of one model entry in lemond's /models and /models/{id} replies. */
export interface ModelsEntry {
  id?: string
  labels?: string[]
  max_context_window?: number
  size?: number
  downloaded?: boolean
  /** Recipe type, e.g. 'llamacpp' or 'collection.omni' for Omni routers. */
  recipe?: string
  /** For Omni collections: the ids of the component models bundled together.
   * Empty until the collection's manifest has been downloaded. */
  components?: string[]
  /** For Omni collections: each component's full entry (including whether it is
   * downloaded). Present on newer servers once the manifest is known. */
  models?: ModelsEntry[]
  /** For Omni collections: a per-collection system prompt / persona, if any. */
  system_prompt?: string
}

/**
 * Coarse modality for grouping in the model picker, from a model's capability
 * labels. Newer servers stamp every chat model with an explicit `chat` label and
 * add modalities the app never had to tell apart before (audio generation,
 * classification, upscaling); older ones carry no `chat` label, so anything
 * unrecognised still falls back to 'llm'. Omni routers are treated as chat models
 * so they surface in the agent's model list.
 */
export function modelTypeFromLabels(labels: readonly string[], omni: boolean): string {
  if (omni || labels.includes('chat')) return 'llm'
  if (labels.includes('tts')) return 'tts'
  if (labels.includes('transcription') || labels.includes('realtime-transcription'))
    return 'transcription'
  if (labels.includes('image')) return 'image'
  if (labels.includes('audio-generation')) return 'audio'
  if (labels.includes('embeddings')) return 'embedding'
  if (labels.includes('reranking')) return 'reranking'
  if (labels.includes('classification')) return 'classification'
  return 'llm'
}

/** Whether an Omni collection is usable, and what is missing if it isn't. */
export interface CollectionStatus {
  /** True for an Omni collection (a router over several component models). */
  isCollection: boolean
  /** The component model ids; empty until the collection's manifest is pulled. */
  components: string[]
  /** Components not (yet) downloaded. */
  missing: string[]
}

/**
 * Work out an Omni collection's readiness from its registry entry. A component's
 * downloaded state comes from the entry's own `models[]` when the server provides
 * it, else from `downloaded` (the ids of every downloaded model); a component
 * neither source can vouch for is assumed present rather than blocking chat on a
 * guess. The collection's own `downloaded` flag is deliberately ignored: servers
 * around v2026.46 flip it to false the moment a collection is loaded, even with
 * every component on disk, so it can't be trusted.
 */
export function collectionStatus(
  entry: ModelsEntry | null | undefined,
  downloaded?: ReadonlySet<string>
): CollectionStatus {
  if (!entry || entry.recipe !== 'collection.omni') {
    return { isCollection: false, components: [], missing: [] }
  }
  const components = entry.components ?? []
  const known = new Map<string, boolean>()
  for (const m of entry.models ?? []) {
    if (m.id) known.set(m.id, m.downloaded === true)
  }
  const missing = components.filter((id) => {
    const fromEntry = known.get(id)
    if (fromEntry !== undefined) return !fromEntry
    return downloaded ? !downloaded.has(id) : false
  })
  return { isCollection: true, components, missing }
}

/** An Omni collection can chat only once its manifest is pulled (so it lists
 * components) and every component is on disk. */
export function isCollectionReady(status: CollectionStatus): boolean {
  return status.isCollection && status.components.length > 0 && status.missing.length === 0
}

/** A plain-language explanation of why an Omni collection can't chat yet and what
 * to do about it, shown instead of the server's cryptic error. */
export function describeCollectionNotReady(
  model: string,
  status: CollectionStatus,
  downloading: boolean
): string {
  const problem =
    status.components.length === 0
      ? `The Omni model "${model}" isn't downloaded on the Lemonade server yet.`
      : `The Omni model "${model}" is missing ${status.missing.length} of its ` +
        `${status.components.length} component models (${status.missing.join(', ')}).`
  const next = downloading
    ? ' A download is already in progress: watch the Models button in the status bar and ' +
      'try again once it finishes.'
    : ' Open Models and download it (or pick another model), then try again.'
  return problem + next
}

// The server's collection orchestrator reports failures *inside* a normal
// assistant reply (a message that is nothing but "\n\nError: <reason>" with a
// clean "stop" finish) rather than as an HTTP error, so the client would
// otherwise show the failure as the model's answer. The reason is a single line.
const COLLECTION_ERROR = /^\s*Error:\s+([^\n]+?)\s*$/

/** The failure reason when a collection reply is really an in-band error, else
 * null (an ordinary answer). */
export function parseCollectionError(content: string | null | undefined): string | null {
  if (!content) return null
  const match = COLLECTION_ERROR.exec(content)
  return match ? match[1] : null
}

/** The window the server really runs, parsed from a "request (X tokens) exceeds
 * the available context size (N tokens)" failure; null for any other message. */
export function parseContextOverflow(
  message: string
): { requested: number; available: number } | null {
  const match = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(
    message
  )
  return match ? { requested: Number(match[1]), available: Number(match[2]) } : null
}

/**
 * The downloaded model of `type` to use for a feature (speech, dictation). The
 * configured `preferred` id wins (compared case-insensitively, since server ids
 * are mixed-case like `Whisper-Base` while config is typically lower-case), then
 * any downloaded model from the same family (`whisper-*`), then any downloaded
 * model of the type. Never returns one that isn't downloaded: asking the server
 * for an absent model makes it download that model *inside* the request, which
 * hangs the feature for as long as the download takes.
 */
export function pickDownloadedModel(
  models: readonly ModelInfo[],
  type: string,
  preferred: string
): ModelInfo | undefined {
  const downloaded = models.filter((m) => m.type === type && m.downloaded)
  const want = preferred.toLowerCase()
  const family = want.split('-')[0]
  return (
    downloaded.find((m) => m.id.toLowerCase() === want) ??
    (family ? downloaded.find((m) => m.id.toLowerCase().startsWith(`${family}-`)) : undefined) ??
    downloaded[0]
  )
}
