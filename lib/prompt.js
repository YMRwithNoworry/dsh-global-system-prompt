/**
 * The prompt file: read, cache, escape, and write the text this plugin injects.
 *
 * The system-prompt section evaluates its text provider on every assembly, so
 * this module re-stats the files each time and re-reads them only when they
 * changed. That is what makes an edit (from the settings panel or from any
 * editor) take effect on the next step without a restart.
 *
 * Two files feed the block:
 *
 * 1. the **global prompt** (`file`) — the user's own text, the reason the plugin
 *    exists; and
 * 2. the **user-global instructions** (`instructionsFile`, by default
 *    `$DSH_HOME/AGENTS.md`) — announced by absolute path so the model never has
 *    to search for a file the runtime context mentions only as "AGENTS.md", and
 *    optionally included verbatim for profiles that do not mount the harness's
 *    own instruction loader.
 *
 * @module dsh-global-system-prompt/prompt
 */

import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Prompt sections interpolate `{{variable}}` groups strictly — `renderPrompt`
 * throws on a malformed or unregistered name, which would break the turn — and
 * there is no escape syntax. A zero-width space between the braces keeps the
 * text readable while making the group unrecognizable to the scanner.
 */
const ZERO_WIDTH_SPACE = '\u200B'

/**
 * Neutralize every `{{` so a literal template group in the user's prose can
 * never be read as a prompt variable reference.
 * @param text - the raw prompt text.
 * @returns the same text with every `{{` split by a zero-width space.
 */
export function escapePromptVariables(text) {
  return text.replaceAll('{{', `{${ZERO_WIDTH_SPACE}{`)
}

/**
 * Read at most `maxBytes` bytes of a file without loading the rest into memory.
 * @param file - absolute path of the file.
 * @param maxBytes - the byte budget.
 * @returns the leading bytes, decoded as UTF-8.
 */
function readCapped(file, maxBytes) {
  const handle = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes)
    const read = readSync(handle, buffer, 0, maxBytes, 0)
    // A budget that lands mid-character decodes to U+FFFD; drop that artifact
    // rather than shipping a replacement character to the model.
    return buffer.subarray(0, read).toString('utf8').replace(/\uFFFD$/, '')
  } finally {
    closeSync(handle)
  }
}

/**
 * A cached reader for one file. A read never throws: an unreadable file
 * degrades to "absent" and reports the problem through `warn` once.
 * @param file - absolute path to read.
 * @param maxBytes - UTF-8 byte cap.
 * @param warn - reports one read failure.
 * @returns `read()` → `{ path, exists, content, bytes, truncated }`.
 */
function createFileReader(file, maxBytes, warn) {
  let cache
  let warned = false

  const read = () => {
    let stats
    try {
      stats = statSync(file)
    } catch (error) {
      if (error?.code !== 'ENOENT' && !warned) {
        warned = true
        warn(`cannot stat ${file}`, error)
      }
      cache = undefined
      return { path: file, exists: false, content: '', bytes: 0, truncated: false }
    }

    const size = stats.size
    const truncated = size > maxBytes
    if (cache !== undefined && cache.mtimeMs === stats.mtimeMs && cache.size === size) {
      return { path: file, exists: true, content: cache.content, bytes: size, truncated }
    }

    try {
      const content = readCapped(file, maxBytes)
      cache = { mtimeMs: stats.mtimeMs, size, content }
      warned = false
      return { path: file, exists: true, content, bytes: size, truncated }
    } catch (error) {
      if (!warned) {
        warned = true
        warn(`cannot read ${file}`, error)
      }
      cache = undefined
      return { path: file, exists: false, content: '', bytes: 0, truncated: false }
    }
  }

  return { read }
}

/**
 * Create the reader/writer this plugin's host half uses.
 * @param options - normalized options from `normalizeConfig`.
 * @param logger - optional Cordis logger; failures are reported through it.
 * @returns the prompt handle: `read`, `readInstructions`, `effectiveText`, `write`.
 */
export function createGlobalPrompt(options, logger) {
  const warn = (message, error) => {
    try {
      logger?.warn?.(`dsh-global-system-prompt: ${message}; degrading to the row's text`, error)
    } catch {
      // Logging is best-effort; the plugin must keep working without a logger.
    }
  }

  const promptReader = createFileReader(options.file, options.maxBytes, warn)
  const instructionsReader = options.instructionsFile === ''
    ? undefined
    : createFileReader(options.instructionsFile, options.maxBytes, warn)

  /**
   * The file-location footer. The runtime context the harness injects names the
   * user-global instruction file as a bare "AGENTS.md" with no path, which sends
   * the model looking for it across the home directory; this footer hands over
   * the exact paths instead.
   * @returns the footer text, or a configured replacement note.
   */
  const pathsNote = () => {
    if (options.pathsNote.trim().length > 0) return options.pathsNote
    const lines = [
      'Harness file locations (exact paths — read or edit these directly instead of searching for them):',
      `- global prompt (injected by the dsh-global-system-prompt plugin): ${options.file}`,
    ]
    if (instructionsReader !== undefined) {
      const instructions = instructionsReader.read()
      lines.push(
        '- user-global instructions (the "AGENTS.md" the runtime context mentions): '
        + `${options.instructionsFile}${instructions.exists ? '' : ' (not created yet)'}`,
      )
    }
    return lines.join('\n')
  }

  /**
   * The prompt body alone: the file's content, or the row's `text` while the
   * file is missing, with a blank value collapsed to `''` (the "inject nothing"
   * case). No instructions copy, no file-location footer, and — unlike the
   * system-prompt section's payload — no `{{` escaping: `AGENTS.md` is read
   * verbatim by tools that know nothing about prompt interpolation.
   * @returns the raw prompt text, `''` when there is none.
   */
  const bodyText = () => {
    const prompt = promptReader.read()
    const text = prompt.exists ? prompt.content : (options.text ?? '')
    return text.trim().length > 0 ? text : ''
  }

  /**
   * Assemble the block: optional instructions copy, the global prompt, then the
   * file-location footer.
   * @returns the unescaped block.
   */
  const compose = () => {
    const parts = []
    if (options.includeInstructions && instructionsReader !== undefined) {
      const instructions = instructionsReader.read()
      if (instructions.exists && instructions.content.trim().length > 0) {
        parts.push(`Global instructions (from ${options.instructionsFile}):\n\n${instructions.content}`)
      }
    }
    const text = bodyText()
    if (text.length > 0) parts.push(text)
    if (options.announcePaths) parts.push(pathsNote())
    return parts.join('\n\n')
  }

  /**
   * The exact text the system-prompt section contributes right now.
   *
   * The prompt file wins whenever it exists — an empty file therefore means
   * "inject no prompt text", which is how a user silences their own text without
   * touching the composition. Only a missing (or unreadable) file falls back to
   * the row's `text`. The file-location footer is independent of that text: it
   * exists so the model can find the files at all.
   * @returns the payload for this assembly, `''` when the row is disabled.
   */
  const effectiveText = () => {
    if (!options.enabled) return ''
    const block = compose()
    if (block.trim().length === 0) return ''
    return options.escapeBraces ? escapePromptVariables(block) : block
  }

  /**
   * Replace the prompt file, creating its directory when needed. The write is
   * staged next to the target and renamed into place so a reader never observes
   * a half-written prompt.
   * @param content - the new file content.
   * @returns the UTF-8 byte length written.
   */
  const write = (content) => {
    if (typeof content !== 'string') {
      throw new TypeError(`dsh-global-system-prompt: prompt content must be a string; got ${typeof content}`)
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    mkdirSync(dirname(options.file), { recursive: true })
    const staged = join(dirname(options.file), `.${Date.now().toString(36)}.global-prompt.tmp`)
    try {
      writeFileSync(staged, content, 'utf8')
      renameSync(staged, options.file)
    } catch (error) {
      rmSync(staged, { force: true })
      throw error
    }
    return bytes
  }

  return {
    file: options.file,
    instructionsFile: options.instructionsFile,
    read: promptReader.read,
    readInstructions: () => instructionsReader?.read()
      ?? { path: '', exists: false, content: '', bytes: 0, truncated: false },
    bodyText,
    effectiveText,
    write,
  }
}
