/**
 * Project-level `AGENTS.md` sync — the second delivery channel for the global
 * prompt.
 *
 * The system-prompt section reaches dsh only. `AGENTS.md` at the project root is
 * the channel every tool that speaks the convention reads, and it is the one
 * that survives leaving dsh (another editor, another CLI, a teammate). This
 * module mirrors the prompt into that file as a **managed block**: the plugin
 * owns exactly the text between its two marker comments and nothing else, so a
 * project's own rules are never touched, and deleting the block is the whole
 * uninstall.
 *
 * Timing: the block is written on `agent/session-start` — which the harness
 * emits before the session's first prompt assembly, so the very first step
 * already sees the file — and re-checked on every `agent/pre-step` so a stale or
 * hand-edited copy is repaired on the next turn. The re-check is a single `stat`
 * once the block matches, hence free enough for every step.
 *
 * Nothing here throws into the agent loop: a failure degrades to one warning,
 * and the system-prompt section still carries the prompt for that session.
 *
 * @module dsh-global-system-prompt/project
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Identifier carried by both marker comments. */
export const BLOCK_ID = 'dsh-global-system-prompt'

/** Opening marker of the managed block. */
export const BLOCK_BEGIN = `<!-- BEGIN ${BLOCK_ID} -->`

/** Closing marker of the managed block. */
export const BLOCK_END = `<!-- END ${BLOCK_ID} -->`

/** Largest `AGENTS.md` this plugin is willing to rewrite (bytes). */
export const MAX_AGENTS_BYTES = 1024 * 1024

/** How many transitions the web panel can list. */
const MAX_HISTORY = 8

/**
 * Markers are matched by their leading keyword rather than by an exact string,
 * so a newer version that decorates its own markers (`<!-- BEGIN x (v2) -->`)
 * is still recognized — and so a user who keeps a note inside the marker
 * comment does not silently fork the file.
 */
const BEGIN_PATTERN = /<!--\s*BEGIN\s+dsh-global-system-prompt\b[^>]*?-->/g
const END_PATTERN = /<!--\s*END\s+dsh-global-system-prompt\b[^>]*?-->/g

const BOM = '\uFEFF'

/**
 * Walk up from a session working directory to the nearest project root.
 * @param cwd - absolute session working directory.
 * @param markers - file or directory names that mark a project root (`.git` by default).
 * @param options - `fallback: 'cwd'` returns the cwd when no marker matches, `'skip'` returns undefined.
 * @returns the absolute project root, or undefined when the fallback is `'skip'`.
 */
export function findProjectRoot(cwd, markers = ['.git'], options = {}) {
  const { fallback = 'cwd' } = options
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return undefined
  const start = resolve(cwd)
  const list = Array.isArray(markers) ? markers : []
  let current = start
  for (;;) {
    for (const marker of list) {
      if (typeof marker !== 'string' || marker.length === 0) continue
      if (existsSync(join(current, marker))) return current
    }
    const parent = dirname(current)
    if (parent === current) return fallback === 'skip' ? undefined : start
    current = parent
  }
}

/**
 * Pair every opening marker with the closing marker that follows it.
 * @param text - the file body (BOM already stripped).
 * @returns ordered `{ start, end }` spans, or undefined when the markers do not pair up.
 */
function blockSpans(text) {
  const begins = [...text.matchAll(BEGIN_PATTERN)]
  const ends = [...text.matchAll(END_PATTERN)]
  if (begins.length !== ends.length) return undefined
  const spans = []
  for (let index = 0; index < begins.length; index += 1) {
    const begin = begins[index]
    const end = ends[index]
    // Equal counts plus source order is only meaningful when each END follows
    // its BEGIN; a stray `END` before any `BEGIN` is a hand-mangled file.
    if (end.index < begin.index) return undefined
    spans.push({ start: begin.index, end: end.index + end[0].length })
  }
  return spans
}

/**
 * Build the managed block.
 *
 * The generated note names the source file so a human reading the repository
 * knows where the text comes from; the preamble is the part addressed to the
 * model, and it is what makes the block read as an instruction rather than as
 * documentation.
 * @param text - the global prompt body, verbatim.
 * @param options - `file` (source path, for the note) and `preamble` (model-facing line).
 * @returns the block, newline-separated, without a trailing newline.
 */
export function renderProjectBlock(text, options = {}) {
  const body = String(text ?? '').trim()
  const preamble = String(options.preamble ?? '').trim()
  const source = typeof options.file === 'string' && options.file.length > 0 ? options.file : '(unset)'
  const lines = [
    BLOCK_BEGIN,
    '<!--',
    `  Managed by the ${BLOCK_ID} plugin. The rules below are synced from:`,
    `  ${source}`,
    '  Edits inside this block are overwritten on the next sync; delete the block,',
    '  markers included, to stop syncing.',
    '-->',
  ]
  if (preamble.length > 0) lines.push('', preamble)
  if (body.length > 0) lines.push('', body)
  lines.push('', BLOCK_END)
  return lines.join('\n')
}

/**
 * Insert, replace, or refresh the managed block inside one file's text.
 *
 * Idempotent by construction: running it twice with the same block reports
 * `unchanged` the second time, which is what lets the caller skip the write.
 * A duplicated block (an older copy of this plugin, a bad merge) collapses into
 * one instead of accumulating.
 * @param existing - the file's current text.
 * @param block - the desired block from {@link renderProjectBlock}.
 * @returns `{ ok, action, content }`, where `ok: false` means the markers were
 * unbalanced and the file was left alone.
 */
export function upsertManagedBlock(existing, block) {
  const text = typeof existing === 'string' ? existing : ''
  const bom = text.startsWith(BOM) ? BOM : ''
  const body = bom.length > 0 ? text.slice(1) : text
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const rendered = eol === '\n' ? block : block.replaceAll('\n', eol)

  const spans = blockSpans(body)
  if (spans === undefined) return { ok: false, reason: 'unbalanced', content: text }

  if (spans.length === 0) {
    if (body.trim().length === 0) return { ok: true, action: 'created', content: `${bom}${rendered}${eol}` }
    return {
      ok: true,
      action: 'appended',
      content: `${bom}${body.trimEnd()}${eol}${eol}${rendered}${eol}`,
    }
  }

  let out = body
  // Drop every extra copy of the block (last to first, so indices stay valid).
  for (let index = spans.length - 1; index >= 1; index -= 1) {
    out = out.slice(0, spans[index].start) + out.slice(spans[index].end)
  }
  out = out.slice(0, spans[0].start) + rendered + out.slice(spans[0].end)
  const content = bom + out
  return { ok: true, action: content === text ? 'unchanged' : 'replaced', content }
}

/**
 * Remove every managed block from one file's text.
 * @param existing - the file's current text.
 * @returns `{ ok, removed, content }`, where `content: ''` means the file held
 * nothing but the block.
 */
export function removeManagedBlock(existing) {
  const text = typeof existing === 'string' ? existing : ''
  const bom = text.startsWith(BOM) ? BOM : ''
  const body = bom.length > 0 ? text.slice(1) : text
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  const spans = blockSpans(body)
  if (spans === undefined) return { ok: false, removed: false, content: text }
  if (spans.length === 0) return { ok: true, removed: false, content: text }

  let out = body
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    out = out.slice(0, spans[index].start) + out.slice(spans[index].end)
  }
  const trimmed = out.trim()
  return {
    ok: true,
    removed: true,
    content: trimmed.length === 0 ? '' : `${bom}${trimmed}${eol}`,
  }
}

/**
 * Whether two paths name the same file (case-insensitively on Windows).
 * @param left - first path.
 * @param right - second path.
 * @returns true when they resolve to the same name.
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = resolve(left)
  const b = resolve(right)
  return a === b || (process.platform === 'win32' && a.toLowerCase() === b.toLowerCase())
}

/** `statSync` that reports a missing or unreadable file as undefined. */
function statOrUndefined(file) {
  try {
    return statSync(file)
  } catch {
    return undefined
  }
}

/**
 * Read a text file, reporting absence instead of throwing.
 * @param file - absolute path.
 * @returns `{ exists, content }`.
 * @throws when the file exists but cannot be read.
 */
function readTextFile(file) {
  try {
    return { exists: true, content: readFileSync(file, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, content: '' }
    throw error
  }
}

/**
 * Replace a file through a staged sibling plus rename, so a reader never sees a
 * half-written `AGENTS.md` (the harness may be reading it at any moment).
 * @param file - absolute path.
 * @param content - the new text.
 */
function writeFileAtomic(file, content) {
  const staged = join(dirname(file), `.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.agents-sync.tmp`)
  try {
    writeFileSync(staged, content, 'utf8')
    renameSync(staged, file)
  } catch (error) {
    rmSync(staged, { force: true })
    throw error
  }
}

/**
 * Create the project-`AGENTS.md` sync this plugin's host half drives.
 * @param prompt - the prompt handle from `createGlobalPrompt`.
 * @param options - normalized options from `normalizeConfig`.
 * @param logger - optional Cordis logger; failures are reported through it.
 * @returns `{ attach, syncCwd, ensure, status }`.
 */
export function createProjectAgentsSync(prompt, options, logger) {
  /** Per-target memory: the block we wrote and the file identity we left behind. */
  const states = new Map()
  const history = []
  /**
   * Refusals are permanent conditions, not events — a 2 MiB `AGENTS.md` stays
   * too large on every step — so each one is reported once per process instead
   * of once per step. A successful sync clears the target's entries.
   */
  const warned = new Set()

  const warn = (message, error) => {
    try {
      logger?.warn?.(`dsh-global-system-prompt: ${message}`, error)
    } catch {
      // Logging is best-effort; the sync must keep working without a logger.
    }
  }

  const warnOnce = (target, cause, message, error) => {
    const key = `${target}\u0000${cause}`
    if (warned.has(key)) return
    warned.add(key)
    warn(message, error)
  }

  const clearWarnings = (target) => {
    for (const key of warned) {
      if (key.startsWith(`${target}\u0000`)) warned.delete(key)
    }
  }

  const record = (entry) => {
    const last = history[history.length - 1]
    // A steady refusal re-records itself every step; refresh the timestamp
    // rather than stacking the same line eight times in the panel.
    if (last !== undefined && last.action === entry.action && last.target === entry.target && last.cause === entry.cause) {
      history[history.length - 1] = entry
      return entry
    }
    history.push(entry)
    if (history.length > MAX_HISTORY) history.shift()
    return entry
  }

  const remember = (target, block, action) => {
    const stats = statOrUndefined(target)
    states.set(target, {
      block,
      mtimeMs: stats?.mtimeMs,
      size: stats?.size ?? -1,
      // No stat means "the target does not exist right now"; the fast path
      // treats a still-missing file as unchanged instead of re-reading.
      missing: stats === undefined,
      action,
      at: Date.now(),
    })
  }

  /**
   * Whether the last outcome for this target still holds.
   * @param target - absolute AGENTS.md path.
   * @param desired - the block the prompt calls for right now.
   * @returns true when neither the prompt nor the file moved since the last sync.
   */
  const upToDate = (target, desired) => {
    const state = states.get(target)
    if (state === undefined || state.block !== desired) return false
    const stats = statOrUndefined(target)
    if (stats === undefined) return state.missing === true
    if (state.missing === true) return false
    return stats.mtimeMs === state.mtimeMs && stats.size === state.size
  }

  /**
   * Synchronize one working directory's project `AGENTS.md`.
   *
   * Never throws: every failure mode is reported through the returned entry (and
   * one warning), because this runs inside the agent loop.
   * @param cwd - absolute session working directory.
   * @param trigger - what asked for the sync (`session-start`, `step`, `manual`).
   * @returns the outcome: `{ action, target, bytes?, cause?, trigger, at }`.
   */
  const syncCwd = (cwd, trigger = 'manual') => {
    const at = Date.now()
    if (!options.enabled || !options.syncProjectAgents) {
      return { action: 'skipped', cause: 'disabled', trigger, at }
    }
    if (typeof cwd !== 'string' || cwd.trim().length === 0) {
      return { action: 'skipped', cause: 'no-cwd', trigger, at }
    }

    const root = findProjectRoot(cwd, options.projectRootMarkers, { fallback: options.projectAgentsFallback })
    if (root === undefined) {
      return { action: 'skipped', cause: 'no-project-root', cwd, trigger, at }
    }
    const target = join(root, options.projectAgentsFileName)
    if (options.instructionsFile !== '' && samePath(target, options.instructionsFile)) {
      // The user-global instruction file is dsh-global-rules' territory.
      warnOnce(target, 'is-instructions-file',
        `not syncing ${target}: it is the user-global instruction file this plugin announces, not a project file`)
      return record({ action: 'skipped', cause: 'is-instructions-file', target, trigger, at })
    }

    const text = prompt.bodyText()
    const desired = text.trim().length === 0
      ? ''
      : renderProjectBlock(text, { file: options.file, preamble: options.projectAgentsPreamble })

    // Fast path: we wrote this exact block and the file has not been touched
    // since. One `stat` per step is the whole cost of the steady state.
    if (upToDate(target, desired)) {
      return { action: 'unchanged', target, trigger, at }
    }

    const stats = statOrUndefined(target)
    if (stats !== undefined && stats.size > MAX_AGENTS_BYTES) {
      warnOnce(target, 'too-large', `not syncing ${target}: it is larger than ${MAX_AGENTS_BYTES} bytes`)
      return record({ action: 'skipped', cause: 'too-large', target, trigger, at })
    }

    let existing
    try {
      existing = readTextFile(target)
    } catch (error) {
      warn(`cannot read ${target}`, error)
      return record({ action: 'error', cause: 'read', target, trigger, at })
    }

    const result = desired.length === 0
      ? removeManagedBlock(existing.content)
      : upsertManagedBlock(existing.content, desired)
    if (!result.ok) {
      warnOnce(target, `markers-${result.reason}`,
        `left ${target} alone: its ${BLOCK_ID} marker comments are ${result.reason}`)
      return record({ action: 'skipped', cause: result.reason, target, trigger, at })
    }

    if (result.content === existing.content) {
      // Remember even a missing target, so "nothing to do" also takes the fast
      // path on the next step instead of re-reading the directory entry.
      remember(target, desired, 'unchanged')
      clearWarnings(target)
      return { action: 'unchanged', target, trigger, at }
    }

    // An emptied global prompt removes the block; a file that held nothing else
    // was created by this plugin, so it goes away with the block.
    if (result.content.trim().length === 0) {
      if (!existing.exists) return { action: 'unchanged', target, trigger, at }
      try {
        rmSync(target, { force: true })
      } catch (error) {
        warn(`cannot remove ${target}`, error)
        return record({ action: 'error', cause: 'remove', target, trigger, at })
      }
      states.delete(target)
      clearWarnings(target)
      return record({ action: 'removed', target, trigger, at })
    }

    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileAtomic(target, result.content)
    } catch (error) {
      warn(`cannot write ${target}`, error)
      return record({ action: 'error', cause: 'write', target, trigger, at })
    }

    const action = existing.exists ? 'updated' : 'created'
    remember(target, desired, action)
    clearWarnings(target)
    return record({
      action,
      target,
      bytes: Buffer.byteLength(result.content, 'utf8'),
      trigger,
      at,
    })
  }

  /**
   * Sync the project of one live agent.
   * @param agent - the agent whose session working directory selects the project.
   * @param trigger - what asked for the sync.
   * @returns the outcome, or undefined when the agent carries no usable cwd.
   */
  const ensure = (agent, trigger = 'step') => {
    try {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return undefined
      return syncCwd(cwd, trigger)
    } catch (error) {
      // The loop's own step must survive anything that happens here.
      warn('project AGENTS.md sync failed', error)
      return undefined
    }
  }

  /**
   * Subscribe to the agent lifecycle. `agent/session-start` fires before the
   * session's first prompt assembly, so the file is in place for step one; the
   * pre-step re-check is what repairs a block that was edited or deleted since.
   *
   * Both listeners are exception-proof on purpose: `agent/session-start` is a
   * publication-time notification (a throw there rolls the agent back) and the
   * pre-step listener sits in the waterfall that drives the turn.
   * @param ctx - the plugin context.
   */
  const attach = (ctx) => {
    ctx.on('agent/session-start', (payload) => {
      try {
        ensure(payload?.agent, 'session-start')
      } catch {
        // `ensure` already swallows its own failures; this guards the payload.
      }
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        ensure(payload?.agent, 'step')
      } catch {
        // A malformed payload must never take the step down.
      }
      return decision
    })
  }

  /**
   * Report the sync state for the settings panel.
   * @returns `{ enabled, fileName, markers, fallback, targets, history }`.
   */
  const status = () => ({
    enabled: options.enabled && options.syncProjectAgents,
    fileName: options.projectAgentsFileName,
    markers: [...options.projectRootMarkers],
    fallback: options.projectAgentsFallback,
    preamble: options.projectAgentsPreamble,
    targets: [...states.entries()]
      .map(([path, state]) => ({ path, action: state.action, at: state.at }))
      .sort((left, right) => right.at - left.at)
      .slice(0, MAX_HISTORY),
    history: history.slice(-MAX_HISTORY).reverse(),
  })

  return { attach, syncCwd, ensure, status }
}
