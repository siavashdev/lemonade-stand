import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@shared/types'
import {
  collectionStatus,
  describeCollectionNotReady,
  isCollectionReady,
  modelTypeFromLabels,
  parseCollectionError,
  parseContextOverflow,
  pickDownloadedModel,
  type ModelsEntry
} from '../src/main/lemonade/models'

describe('modelTypeFromLabels', () => {
  it('files each modality under its own type', () => {
    expect(modelTypeFromLabels(['tts'], false)).toBe('tts')
    expect(modelTypeFromLabels(['transcription'], false)).toBe('transcription')
    expect(modelTypeFromLabels(['realtime-transcription'], false)).toBe('transcription')
    expect(modelTypeFromLabels(['image', 'edit'], false)).toBe('image')
    expect(modelTypeFromLabels(['audio-generation'], false)).toBe('audio')
    expect(modelTypeFromLabels(['embeddings'], false)).toBe('embedding')
    expect(modelTypeFromLabels(['reranking'], false)).toBe('reranking')
    expect(modelTypeFromLabels(['classification'], false)).toBe('classification')
  })

  it('treats chat models and Omni collections as llm', () => {
    expect(modelTypeFromLabels(['chat', 'tool-calling'], false)).toBe('llm')
    expect(modelTypeFromLabels(['chat', 'vision'], false)).toBe('llm')
    expect(modelTypeFromLabels([], true)).toBe('llm')
    // An Omni router also carries media labels; it must still surface as a chat model.
    expect(modelTypeFromLabels(['image', 'tts', 'transcription'], true)).toBe('llm')
  })

  it('treats an unlabelled model (older servers) as llm', () => {
    expect(modelTypeFromLabels([], false)).toBe('llm')
    expect(modelTypeFromLabels(['tool-calling', 'reasoning'], false)).toBe('llm')
  })
})

describe('collectionStatus', () => {
  const COMPONENTS = ['llm-a', 'sd-b', 'stt-c', 'tts-d']
  const omni = (over: Partial<ModelsEntry> = {}): ModelsEntry => ({
    id: 'omni',
    recipe: 'collection.omni',
    components: COMPONENTS,
    ...over
  })

  it('is not a collection for an ordinary or unknown model', () => {
    expect(collectionStatus({ id: 'x', recipe: 'llamacpp' })).toEqual({
      isCollection: false,
      components: [],
      missing: []
    })
    expect(collectionStatus(null).isCollection).toBe(false)
    expect(collectionStatus(undefined).isCollection).toBe(false)
  })

  it('has no components until the manifest is pulled', () => {
    const status = collectionStatus(omni({ components: [] }))
    expect(status).toEqual({ isCollection: true, components: [], missing: [] })
    expect(isCollectionReady(status)).toBe(false)
    expect(isCollectionReady(collectionStatus(omni({ components: undefined })))).toBe(false)
  })

  it('reads each component state from the entry when the server provides it', () => {
    const status = collectionStatus(
      omni({
        models: [
          { id: 'llm-a', downloaded: true },
          { id: 'sd-b', downloaded: false },
          { id: 'stt-c', downloaded: true },
          { id: 'tts-d' }
        ]
      })
    )
    expect(status.missing).toEqual(['sd-b', 'tts-d'])
    expect(isCollectionReady(status)).toBe(false)
  })

  it('is ready when every component is downloaded, whatever the collection flag says', () => {
    const status = collectionStatus(
      omni({ downloaded: false, models: COMPONENTS.map((id) => ({ id, downloaded: true })) })
    )
    expect(status.missing).toEqual([])
    expect(isCollectionReady(status)).toBe(true)
  })

  it('falls back to the downloaded-model list when the entry has no per-component state', () => {
    const status = collectionStatus(omni(), new Set(['llm-a', 'stt-c', 'unrelated']))
    expect(status.missing).toEqual(['sd-b', 'tts-d'])
    expect(isCollectionReady(collectionStatus(omni(), new Set(COMPONENTS)))).toBe(true)
  })

  it('prefers the entry over the fallback list', () => {
    const status = collectionStatus(
      omni({ models: [{ id: 'llm-a', downloaded: false }] }),
      new Set(COMPONENTS)
    )
    expect(status.missing).toEqual(['llm-a'])
  })

  it('assumes a component is present when nothing can vouch for it', () => {
    expect(collectionStatus(omni()).missing).toEqual([])
  })

  it('is never ready for something that is not a collection', () => {
    expect(isCollectionReady(collectionStatus({ id: 'x', recipe: 'llamacpp' }))).toBe(false)
  })
})

describe('describeCollectionNotReady', () => {
  it('says the model needs downloading when it has no component list yet', () => {
    const text = describeCollectionNotReady(
      'LMX-Omni',
      { isCollection: true, components: [], missing: [] },
      false
    )
    expect(text).toContain('"LMX-Omni" isn\'t downloaded on the Lemonade server yet')
    expect(text).toContain('Open Models and download it')
  })

  it('lists the components still missing', () => {
    const text = describeCollectionNotReady(
      'LMX-Omni',
      { isCollection: true, components: ['a', 'b', 'c'], missing: ['b', 'c'] },
      false
    )
    expect(text).toContain('is missing 2 of its 3 component models (b, c)')
  })

  it('points at the running download instead of asking for another', () => {
    const text = describeCollectionNotReady(
      'LMX-Omni',
      { isCollection: true, components: [], missing: [] },
      true
    )
    expect(text).toContain('A download is already in progress')
    expect(text).not.toContain('Open Models and download it')
  })
})

describe('parseCollectionError', () => {
  it('extracts the reason from a reply that is nothing but an error', () => {
    expect(parseCollectionError("\n\nError: Collection 'X' has no chat-capable component")).toBe(
      "Collection 'X' has no chat-capable component"
    )
    expect(parseCollectionError('Error: boom  \n')).toBe('boom')
  })

  it('leaves real answers alone', () => {
    expect(parseCollectionError('Here is the answer.')).toBeNull()
    expect(parseCollectionError('I hit an Error: something, then fixed it.')).toBeNull()
    expect(parseCollectionError('Error: first\nand then more text')).toBeNull()
    expect(parseCollectionError('Errors: none')).toBeNull()
  })

  it('handles an empty reply', () => {
    expect(parseCollectionError('')).toBeNull()
    expect(parseCollectionError(null)).toBeNull()
    expect(parseCollectionError(undefined)).toBeNull()
  })
})

describe('parseContextOverflow', () => {
  it('reads the requested and available token counts', () => {
    expect(
      parseContextOverflow(
        'request (7805 tokens) exceeds the available context size (4096 tokens), try increasing it'
      )
    ).toEqual({ requested: 7805, available: 4096 })
  })

  it('is case-insensitive about the wording', () => {
    expect(
      parseContextOverflow('Request (10 tokens) Exceeds The Available Context Size (8 tokens)')
    ).toEqual({ requested: 10, available: 8 })
  })

  it('returns null for any other message', () => {
    expect(parseContextOverflow('Image generation failed')).toBeNull()
    expect(parseContextOverflow('')).toBeNull()
  })
})

describe('pickDownloadedModel', () => {
  const model = (id: string, type: string, downloaded: boolean): ModelInfo =>
    ({ id, type, downloaded }) as ModelInfo

  const models = [
    // The server lists its Moonshine models first, none of them downloaded.
    model('Moonshine-Medium-Streaming', 'transcription', false),
    model('Whisper-Base', 'transcription', false),
    model('Whisper-Tiny', 'transcription', true),
    model('Whisper-Small', 'transcription', true),
    model('kokoro-v1', 'tts', true),
    model('Qwen3-4B', 'llm', true)
  ]

  it('prefers the configured model when it is downloaded, ignoring case', () => {
    expect(pickDownloadedModel(models, 'transcription', 'whisper-tiny')?.id).toBe('Whisper-Tiny')
    expect(pickDownloadedModel(models, 'transcription', 'WHISPER-SMALL')?.id).toBe('Whisper-Small')
  })

  it('falls back to a downloaded model from the same family', () => {
    // whisper-base is configured but not downloaded; the other Whisper models are.
    expect(pickDownloadedModel(models, 'transcription', 'whisper-base')?.id).toBe('Whisper-Tiny')
  })

  it('falls back to any downloaded model of the type when the family has none', () => {
    expect(pickDownloadedModel(models, 'transcription', 'parakeet-v3')?.id).toBe('Whisper-Tiny')
  })

  it('never returns a model that is not downloaded', () => {
    const none = [model('Whisper-Base', 'transcription', false), model('kokoro-v1', 'tts', true)]
    expect(pickDownloadedModel(none, 'transcription', 'whisper-base')).toBeUndefined()
    expect(pickDownloadedModel([], 'tts', 'kokoro-v1')).toBeUndefined()
  })

  it('only considers models of the requested type', () => {
    expect(pickDownloadedModel(models, 'tts', 'whisper-tiny')?.id).toBe('kokoro-v1')
  })
})
