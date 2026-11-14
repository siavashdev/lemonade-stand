import type { MessageContentPart } from '../../shared/types'

export type InfluenceContent = string | MessageContentPart[]

export interface InfluenceItem {
  id: string
  content: InfluenceContent
}

/**
 * Carries mid-turn user messages ("influences") into a running agent turn.
 *
 * A normal influence waits in the queue until the loop reaches its next step
 * boundary. An interrupt additionally aborts the model completion that is in
 * flight, so the loop can discard it and re-ask with the influence included.
 */
export class InfluenceChannel {
  private queue: InfluenceItem[] = []
  private completion: AbortController | null = null
  private interrupted = false

  /** Queue an influence. Returns true when it cut short an in-flight completion. */
  push(item: InfluenceItem, interrupt: boolean): boolean {
    this.queue.push(item)
    if (!interrupt || !this.completion || this.completion.signal.aborted) return false
    this.interrupted = true
    this.completion.abort()
    return true
  }

  hasPending(): boolean {
    return this.queue.length > 0
  }

  drain(): InfluenceItem[] {
    return this.queue.splice(0)
  }

  /** Register the controller of the completion now running (null once it ends). */
  bindCompletion(controller: AbortController | null): void {
    this.completion = controller
    if (controller) this.interrupted = false
  }

  /** True once if the last completion was aborted by an interrupt. */
  consumeInterrupt(): boolean {
    const was = this.interrupted
    this.interrupted = false
    return was
  }
}

/** Frame an influence so the model treats it as a change of direction, not a new task. */
export function wrapInfluence(content: InfluenceContent): InfluenceContent {
  const lead =
    'The user sent this while you were still working. Take it into account right away: ' +
    'adjust your plan and approach (update the plan if you have one) and carry on from where you are.\n\n'
  if (typeof content === 'string') return `${lead}${content}`
  return [{ type: 'text', text: lead }, ...content]
}
