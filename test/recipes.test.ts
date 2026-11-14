import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/main/agent/loop'
import {
  deleteRecipe,
  getRecipes,
  importRecipeFiles,
  listRecipes,
  saveRecipe,
  setRecipeEnabled
} from '../src/main/recipes/store'
import {
  buildRecipeAppendix,
  buildRecipeCatalog,
  parseRecipeMarkdown,
  serializeRecipeMarkdown,
  slugifyRecipeName,
  uniqueRecipeId
} from '../src/shared/recipes'
import type { AgentEvent, ChatMessage, Recipe } from '../src/shared/types'

describe('parseRecipeMarkdown / serializeRecipeMarkdown', () => {
  it('reads name and description from frontmatter', () => {
    const parsed = parseRecipeMarkdown(
      '---\nname: Triage bugs\ndescription: Use when a bug is reported\n---\n\n1. Reproduce it\n'
    )
    expect(parsed).toEqual({
      name: 'Triage bugs',
      description: 'Use when a bug is reported',
      body: '1. Reproduce it'
    })
  })

  it('supports quoted values and folded descriptions', () => {
    const parsed = parseRecipeMarkdown(
      '---\nname: "A: B"\ndescription: >\n  first line\n  second line\n---\nBody'
    )
    expect(parsed.name).toBe('A: B')
    expect(parsed.description).toBe('first line second line')
  })

  it('falls back to the heading and first paragraph without frontmatter', () => {
    const parsed = parseRecipeMarkdown('# Deploy checklist\n\nRun the smoke tests first.\n\n- step', 'x')
    expect(parsed.name).toBe('Deploy checklist')
    expect(parsed.description).toBe('Run the smoke tests first.')
  })

  it('uses the fallback name for a bare paragraph and tolerates CRLF', () => {
    const parsed = parseRecipeMarkdown('---\r\nname: Win\r\n---\r\nText here', 'fallback')
    expect(parsed.name).toBe('Win')
    expect(parseRecipeMarkdown('Just text', 'fallback').name).toBe('fallback')
  })

  it('round-trips awkward characters', () => {
    const recipe = { name: 'Say "hi": now', description: 'line1\nline2', body: '# Steps\n- one' }
    expect(parseRecipeMarkdown(serializeRecipeMarkdown(recipe))).toEqual(recipe)
  })
})

describe('recipe ids', () => {
  it('slugifies names and never returns an empty id', () => {
    expect(slugifyRecipeName('  Triage: Bugs & Issues! ')).toBe('triage-bugs-issues')
    expect(slugifyRecipeName('Café Déjà')).toBe('cafe-deja')
    expect(slugifyRecipeName('!!!')).toBe('recipe')
  })

  it('suffixes an id that is already taken', () => {
    expect(uniqueRecipeId('Foo', ['foo', 'foo-2'])).toBe('foo-3')
    expect(uniqueRecipeId('Foo', [])).toBe('foo')
  })
})

describe('buildRecipeCatalog / buildRecipeAppendix', () => {
  const r = (id: string, enabled = true, description = `desc ${id}`): Recipe => ({
    id,
    name: id,
    description,
    body: 'b',
    enabled
  })

  it('is empty when no recipe is enabled, so it costs no prompt tokens', () => {
    expect(buildRecipeCatalog([])).toBe('')
    expect(buildRecipeCatalog([r('a', false)])).toBe('')
  })

  it('lists only enabled recipes and truncates long descriptions', () => {
    const catalog = buildRecipeCatalog([r('a'), r('b', false), r('c', true, 'x'.repeat(500))])
    expect(catalog).toContain('- a: desc a')
    expect(catalog).not.toContain('- b:')
    expect(catalog).toMatch(/- c: x{100,}…/)
    expect(catalog).toContain('use_recipe')
  })

  it('notes how many recipes were left out past the cap', () => {
    const many = Array.from({ length: 35 }, (_, i) => r(`r${i}`))
    expect(buildRecipeCatalog(many)).toContain('(5 more not listed)')
  })

  it('appends full bodies after the request', () => {
    const out = buildRecipeAppendix([{ name: 'One', body: ' steps ' }])
    expect(out.startsWith('\n\n---')).toBe(true)
    expect(out).toContain('### Recipe: One\nsteps')
    expect(buildRecipeAppendix([])).toBe('')
  })
})

describe('recipe store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recipes-'))
    // The app's config dir always exists; settings are written into it.
    mkdirSync(join(dir, 'config'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const input = { name: 'Triage bugs', description: 'When bugs arrive', body: 'Do it', enabled: true }

  it('saves, lists, updates and deletes a recipe', () => {
    const saved = saveRecipe(dir, input)
    expect(saved.id).toBe('triage-bugs')
    expect(listRecipes(dir)).toEqual([saved])

    saveRecipe(dir, { ...saved, body: 'Updated' })
    expect(listRecipes(dir)).toHaveLength(1)
    expect(listRecipes(dir)[0].body).toBe('Updated')

    deleteRecipe(dir, saved.id)
    expect(listRecipes(dir)).toEqual([])
  })

  it('gives a same-named recipe a distinct id instead of overwriting', () => {
    const a = saveRecipe(dir, input)
    const b = saveRecipe(dir, input)
    expect(b.id).not.toBe(a.id)
    expect(listRecipes(dir)).toHaveLength(2)
  })

  it('persists the enabled flag outside the SKILL.md', () => {
    const saved = saveRecipe(dir, input)
    setRecipeEnabled(dir, saved.id, false)
    expect(listRecipes(dir)[0].enabled).toBe(false)
    setRecipeEnabled(dir, saved.id, true)
    expect(listRecipes(dir)[0].enabled).toBe(true)
  })

  it('rejects empty and oversized recipes', () => {
    expect(() => saveRecipe(dir, { ...input, name: ' ' })).toThrow(/name/)
    expect(() => saveRecipe(dir, { ...input, body: '' })).toThrow(/instructions/)
    expect(() => saveRecipe(dir, { ...input, body: 'x'.repeat(40_000) })).toThrow(/too long/)
  })

  it('imports files, reporting the ones it cannot use', () => {
    const outcome = importRecipeFiles(dir, [
      { name: 'good.md', content: '---\nname: Good\ndescription: d\n---\nSteps' },
      { name: 'empty.md', content: '---\nname: Empty\n---\n' }
    ])
    expect(outcome.imported).toBe(1)
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0]).toContain('empty.md')
    expect(listRecipes(dir).map((r) => r.name)).toEqual(['Good'])
  })

  it('looks recipes up by id and ignores unknown ids', () => {
    const saved = saveRecipe(dir, input)
    expect(getRecipes(dir, [saved.id, 'nope']).map((r) => r.id)).toEqual([saved.id])
  })

  it('cannot be tricked into leaving the recipes folder', () => {
    deleteRecipe(dir, '../..')
    expect(listRecipes(dir)).toEqual([])
  })
})

describe('Agent recipes', () => {
  const recipe = (id: string, enabled = true): Recipe => ({
    id,
    name: `Name ${id}`,
    description: `Use for ${id}`,
    body: `Steps for ${id}`,
    enabled
  })

  function setup(recipes: Recipe[], chat: ReturnType<typeof vi.fn>) {
    const lemonade = {
      chat,
      checkBudget: vi.fn(async () => ({
        estimatedTokens: 1,
        contextSize: 8192,
        reserve: 512,
        budget: 7680,
        overflow: false,
        warn: false,
        source: 'server'
      })),
      contextBreakdown: vi.fn(async () => ({}))
    }
    const mcp = { getOpenAiTools: () => [], callTool: vi.fn() }
    const agent = new Agent(lemonade as never, mcp as never, 5, 'BASE', 0, () => recipes)
    const events: AgentEvent[] = []
    const history: ChatMessage[] = [{ role: 'user', content: 'go' }]
    const run = (): Promise<void> => agent.run(history, (e) => events.push(e), async () => true)
    return { lemonade, mcp, events, history, run }
  }

  const toolNames = (chat: ReturnType<typeof vi.fn>): string[] =>
    (chat.mock.calls[0][1] as { function: { name: string } }[]).map((t) => t.function.name)

  it('adds no catalogue or tool when there are no enabled recipes', async () => {
    const chat = vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' } })
    const { history, run } = setup([recipe('a', false)], chat)

    await run()

    expect(history[0]).toEqual({ role: 'system', content: 'BASE' })
    expect(toolNames(chat)).not.toContain('use_recipe')
  })

  it('lists enabled recipes in the system prompt and offers use_recipe', async () => {
    const chat = vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' } })
    const { history, run } = setup([recipe('a'), recipe('b', false)], chat)

    await run()

    const system = history[0].content as string
    expect(system.startsWith('BASE')).toBe(true)
    expect(system).toContain('- a: Use for a')
    expect(system).not.toContain('- b:')
    expect(toolNames(chat)).toContain('use_recipe')
  })

  it('returns the recipe body when the model calls use_recipe', async () => {
    const call = {
      id: 'c1',
      type: 'function',
      function: { name: 'use_recipe', arguments: JSON.stringify({ id: 'a' }) }
    }
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ message: { role: 'assistant', content: null, tool_calls: [call] } })
      .mockResolvedValueOnce({ message: { role: 'assistant', content: 'done' } })
    const { events, history, mcp, run } = setup([recipe('a')], chat)

    await run()

    expect(events).toContainEqual({ type: 'recipe_used', id: 'a', name: 'Name a' })
    const toolMsg = history.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('Steps for a')
    expect(mcp.callTool).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: 'assistant_text', text: 'done' })
  })

  it('tells the model the valid ids when it asks for an unknown or disabled recipe', async () => {
    const call = {
      id: 'c1',
      type: 'function',
      function: { name: 'use_recipe', arguments: JSON.stringify({ id: 'b' }) }
    }
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ message: { role: 'assistant', content: null, tool_calls: [call] } })
      .mockResolvedValueOnce({ message: { role: 'assistant', content: 'done' } })
    const { events, history, run } = setup([recipe('a'), recipe('b', false)], chat)

    await run()

    expect(events.some((e) => e.type === 'recipe_used')).toBe(false)
    const toolMsg = history.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('No enabled recipe with id "b"')
    expect(toolMsg?.content).toContain('Available ids: a')
  })
})
