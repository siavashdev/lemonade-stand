import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/main/agent/loop'
import { InfluenceChannel } from '../src/main/agent/influence'
import type { AgentEvent, ChatMessage } from '../src/shared/types'

const finalReply = (content: string) => ({ message: { role: 'assistant', content } })

const planCall = {
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: {
          name: 'update_plan',
          arguments: JSON.stringify({ steps: [{ title: 'only step', status: 'completed' }] })
        }
      }
    ]
  }
}

function setup(chat: ReturnType<typeof vi.fn>) {
  const lemonade = {
    chat,
    summarize: vi.fn(async () => 'summary'),
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
  const agent = new Agent(lemonade as never, mcp as never, 5, '', 0)
  const events: AgentEvent[] = []
  const history: ChatMessage[] = [{ role: 'user', content: 'do the thing' }]
  const influence = new InfluenceChannel()
  const stop = new AbortController()
  const run = (): Promise<void> =>
    agent.run(
      history,
      (e) => events.push(e),
      async () => true,
      stop.signal,
      undefined,
      undefined,
      undefined,
      influence
    )
  return { events, influence, stop, run }
}

describe('InfluenceChannel', () => {
  it('only interrupts while a completion is in flight', () => {
    const influence = new InfluenceChannel()
    expect(influence.push({ id: 'a', content: 'x' }, true)).toBe(false)
    expect(influence.hasPending()).toBe(true)

    const controller = new AbortController()
    influence.bindCompletion(controller)
    expect(influence.push({ id: 'b', content: 'y' }, true)).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(influence.consumeInterrupt()).toBe(true)
    expect(influence.consumeInterrupt()).toBe(false)
    expect(influence.drain().map((s) => s.id)).toEqual(['a', 'b'])
  })
})

describe('Agent influence', () => {
  it('injects an influence queued mid-completion before the next model call', async () => {
    let seen = ''
    let ctx!: ReturnType<typeof setup>
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        ctx.influence.push({ id: 'i1', content: 'use python instead' }, false)
        return planCall
      })
      .mockImplementationOnce(async (messages: unknown) => {
        seen = JSON.stringify(messages)
        return finalReply('done')
      })
    ctx = setup(chat)

    await ctx.run()

    expect(chat).toHaveBeenCalledTimes(2)
    expect(seen).toContain('use python instead')
    expect(seen).toContain('while you were still working')
    expect(ctx.events).toContainEqual({ type: 'influence_applied', id: 'i1' })
  })

  it('keeps the turn going when an influence arrives during the final answer', async () => {
    let ctx!: ReturnType<typeof setup>
    const chat = vi
      .fn()
      .mockImplementationOnce(async () => {
        ctx.influence.push({ id: 'i1', content: 'actually, make it shorter' }, false)
        return finalReply('long answer')
      })
      .mockResolvedValueOnce(finalReply('short answer'))
    ctx = setup(chat)

    await ctx.run()

    expect(chat).toHaveBeenCalledTimes(2)
    const texts = ctx.events.filter((e) => e.type === 'assistant_text')
    expect(texts).toEqual([
      { type: 'assistant_text', text: 'long answer' },
      { type: 'assistant_text', text: 'short answer' }
    ])
    expect(ctx.events.filter((e) => e.type === 'done')).toHaveLength(1)
  })

  it('interrupt aborts only the in-flight completion and re-asks with the influence', async () => {
    let ctx!: ReturnType<typeof setup>
    let firstSignal: AbortSignal | undefined
    let seen = ''
    const chat = vi
      .fn()
      .mockImplementationOnce(
        (_m: unknown, _t: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            firstSignal = signal
            signal.addEventListener('abort', () => reject(new Error('Request was aborted.')))
            setTimeout(() => ctx.influence.push({ id: 'i1', content: 'stop, do X' }, true), 0)
          })
      )
      .mockImplementationOnce(async (messages: unknown) => {
        seen = JSON.stringify(messages)
        return finalReply('ok')
      })
    ctx = setup(chat)

    await ctx.run()

    expect(chat).toHaveBeenCalledTimes(2)
    expect(firstSignal?.aborted).toBe(true)
    expect(ctx.stop.signal.aborted).toBe(false)
    expect(seen).toContain('stop, do X')
    expect(ctx.events).toContainEqual({ type: 'completion_interrupted' })
    expect(ctx.events).toContainEqual({ type: 'influence_applied', id: 'i1' })
    expect(ctx.events.some((e) => e.type === 'error')).toBe(false)
    expect(ctx.events).toContainEqual({ type: 'assistant_text', text: 'ok' })
  })

  it('a user Stop still ends the turn without re-asking', async () => {
    let ctx!: ReturnType<typeof setup>
    const chat = vi.fn().mockImplementationOnce(
      (_m: unknown, _t: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Request was aborted.')))
          setTimeout(() => ctx.stop.abort(), 0)
        })
    )
    ctx = setup(chat)

    await ctx.run()

    expect(chat).toHaveBeenCalledTimes(1)
    expect(ctx.events.some((e) => e.type === 'error' || e.type === 'completion_interrupted')).toBe(
      false
    )
    expect(ctx.events.at(-1)).toEqual({ type: 'done' })
  })
})
