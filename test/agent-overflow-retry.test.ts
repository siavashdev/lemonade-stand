import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/main/agent/loop'
import type { AgentEvent, ChatMessage } from '../src/shared/types'

const OVERFLOW = 'request (16405 tokens) exceeds the available context size (16384 tokens)'

function setup(chat: ReturnType<typeof vi.fn>) {
  const lemonade = {
    chat,
    summarize: vi.fn(async () => 'short summary'),
    checkBudget: vi.fn(async () => ({
      estimatedTokens: 10,
      contextSize: 16384,
      reserve: 512,
      budget: 15872,
      overflow: false,
      warn: false,
      source: 'server'
    })),
    contextBreakdown: vi.fn(async () => ({}))
  }
  const mcp = { getOpenAiTools: () => [] }
  // maxSteps 5, no system prompt, auto-compaction off so only the retry compacts.
  const agent = new Agent(lemonade as never, mcp as never, 5, '', 0)
  const events: AgentEvent[] = []
  const history: ChatMessage[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'c' },
    { role: 'user', content: 'four' }
  ]
  const run = (): Promise<void> =>
    agent.run(history, (e) => events.push(e), async () => true)
  return { lemonade, events, run }
}

describe('Agent context-overflow retry', () => {
  it('compacts and retries once when the server rejects the prompt as too long', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new Error(OVERFLOW))
      .mockResolvedValueOnce({ message: { role: 'assistant', content: 'done' } })
    const { lemonade, events, run } = setup(chat)

    await run()

    expect(chat).toHaveBeenCalledTimes(2)
    expect(lemonade.summarize).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.type === 'history_compacted')).toBe(true)
    expect(events).toContainEqual({ type: 'assistant_text', text: 'done' })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('retries only once, then reports the error', async () => {
    const chat = vi.fn().mockRejectedValue(new Error(OVERFLOW))
    const { events, run } = setup(chat)

    await run()

    expect(chat).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual({ type: 'error', message: OVERFLOW })
  })

  it('does not retry unrelated errors', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('boom'))
    const { lemonade, run } = setup(chat)

    await run()

    expect(chat).toHaveBeenCalledTimes(1)
    expect(lemonade.summarize).not.toHaveBeenCalled()
  })
})
