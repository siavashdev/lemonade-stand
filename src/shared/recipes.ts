// Recipe (skill) helpers shared by the main process and the renderer. A recipe is
// a SKILL.md-style markdown document: optional `---` frontmatter carrying `name`
// and `description`, then the instructions as the body. Dependency-free on
// purpose so both build targets can import it.

import type { Recipe } from './types'

/** Largest recipe body accepted, in characters. Recipes are loaded into the
 * model's context, so an oversized one would crowd out the conversation. */
export const MAX_RECIPE_CHARS = 32_000

/** Body size (characters) above which the editor warns the recipe is heavy. */
export const LARGE_RECIPE_CHARS = 8_000

/** Longest description shown to the model in the recipe catalogue. */
const MAX_CATALOG_DESCRIPTION = 160

/** Most recipes listed in the system prompt catalogue. */
export const MAX_CATALOG_RECIPES = 30

/** Rough token estimate (~4 characters per token), for the editor's size hint. */
export function estimateRecipeTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Lowercase kebab-case id for a recipe name; never empty. */
export function slugifyRecipeName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug || 'recipe'
}

/** Pick an id for `name` that doesn't collide with any in `taken`. */
export function uniqueRecipeId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slugifyRecipeName(name)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    const inner = v.slice(1, -1)
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner
  }
  return v
}

/** Parse the flat `key: value` lines of a frontmatter block. Supports quoted
 * values and `>` / `|` folded blocks, which is all SKILL.md files use. */
function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1].toLowerCase()
    const rest = m[2].trim()
    if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
      const parts: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        parts.push(lines[++i].trim())
      }
      out[key] = parts.join(rest.startsWith('>') ? ' ' : '\n').trim()
    } else {
      out[key] = unquote(rest)
    }
  }
  return out
}

export interface ParsedRecipe {
  name: string
  description: string
  body: string
}

/**
 * Parse recipe markdown. Tolerant of files with no frontmatter: the name falls
 * back to the first heading (else `fallbackName`) and the description to the
 * first paragraph, so any pasted markdown becomes a usable recipe.
 */
export function parseRecipeMarkdown(raw: string, fallbackName = 'Untitled recipe'): ParsedRecipe {
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  let meta: Record<string, string> = {}
  const fm = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  if (fm) {
    meta = parseFrontmatter(fm[1])
    text = text.slice(fm[0].length)
  }
  const body = text.trim()

  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body)
  const name = (meta.name || heading?.[1] || fallbackName).trim().slice(0, 80)

  let description = (meta.description ?? '').trim()
  if (!description) {
    const firstParagraph = body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#') && !p.startsWith('```'))
    description = (firstParagraph ?? '').replace(/\s+/g, ' ')
  }
  return { name, description: description.slice(0, 400), body }
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/** Serialize a recipe as SKILL.md (frontmatter + body). Round-trips through
 * `parseRecipeMarkdown` and stays compatible with other SKILL.md consumers. */
export function serializeRecipeMarkdown(r: Pick<Recipe, 'name' | 'description' | 'body'>): string {
  return `---\nname: ${quoteYaml(r.name)}\ndescription: ${quoteYaml(r.description)}\n---\n\n${r.body.trim()}\n`
}

/**
 * The recipe catalogue appended to the system prompt: one line per enabled
 * recipe, plus the instruction to load a matching one via `use_recipe`. Empty
 * when there is nothing to list, so users without recipes pay no prompt tokens.
 */
export function buildRecipeCatalog(recipes: Pick<Recipe, 'id' | 'description' | 'enabled'>[]): string {
  const enabled = recipes.filter((r) => r.enabled)
  if (enabled.length === 0) return ''
  const shown = enabled.slice(0, MAX_CATALOG_RECIPES)
  const lines = shown.map((r) => {
    const d = r.description.replace(/\s+/g, ' ').trim()
    const short = d.length > MAX_CATALOG_DESCRIPTION ? `${d.slice(0, MAX_CATALOG_DESCRIPTION - 1)}\u2026` : d
    return `- ${r.id}: ${short}`
  })
  if (enabled.length > shown.length) lines.push(`- (${enabled.length - shown.length} more not listed)`)
  return (
    'Recipes are saved step-by-step procedures. Before starting a task, check whether one of these ' +
    'matches it; if so, call the use_recipe tool with its id FIRST and follow the instructions it ' +
    'returns. Do not call use_recipe if none apply.\nAvailable recipes:\n' +
    lines.join('\n')
  )
}

/** Text appended to a user message (or a scheduled prompt) so the model follows
 * the chosen recipes without having to discover them itself. It goes after the
 * request so the message still starts with what the user typed (titles, previews). */
export function buildRecipeAppendix(recipes: Pick<Recipe, 'name' | 'body'>[]): string {
  if (recipes.length === 0) return ''
  const blocks = recipes.map((r) => `### Recipe: ${r.name}\n${r.body.trim()}`)
  return '\n\n---\nFollow these recipe instructions for the request above:\n\n' + blocks.join('\n\n')
}
