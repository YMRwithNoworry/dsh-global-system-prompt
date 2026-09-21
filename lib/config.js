/**
 * Configuration normalization for `dsh-global-system-prompt`.
 *
 * Every field arrives from the composition row (`cordis.patch.yml`), so it is
 * validated and normalized here before any file or prompt work happens: a typo
 * fails the boot loudly instead of silently dropping the global prompt.
 *
 * @module dsh-global-system-prompt/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Directory name of the default harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Environment variable that overrides the default harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** File name of the user prompt inside the harness home. */
export const DEFAULT_PROMPT_FILE_NAME = 'global-prompt.md'

/** File name of the user-global instruction set inside the harness home. */
export const DEFAULT_INSTRUCTIONS_FILE_NAME = 'AGENTS.md'

/** File name of the project-level instruction set this plugin keeps in sync. */
export const DEFAULT_PROJECT_AGENTS_FILE_NAME = 'AGENTS.md'

/**
 * Names that mark a project root while walking up from a session cwd. `.git`
 * matches the harness's own discovery, so the mirrored block lands in the file
 * dsh already reads as workspace instructions.
 */
export const DEFAULT_PROJECT_ROOT_MARKERS = ['.git']

/**
 * The model-facing line that opens the mirrored block. Everything else in the
 * block is generated bookkeeping; this is the sentence that makes the block read
 * as an instruction rather than as documentation.
 */
export const DEFAULT_PROJECT_AGENTS_PREAMBLE = 'Global rules — follow these in every task in this project:'

/** Prompt section this plugin owns; a unique name no first-party row registers. */
export const SECTION_NAME = 'user:global-prompt'

/**
 * Section order of the injected block. `-1000` is the harness identity line and
 * `0` the deployment persona prefix, so `-900` reads as a preamble directly
 * after the identity, before the persona.
 */
export const DEFAULT_ORDER = -900

/** UTF-8 byte cap applied to the injected block. */
export const DEFAULT_MAX_BYTES = 65536

/** Upper bound the editor route accepts for one save request body. */
export const MAX_EDITOR_BODY_BYTES = 256 * 1024

/**
 * Expand the supported tilde prefixes against the operating-system home.
 * @param path - a configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the harness home with the same precedence the harness itself uses:
 * an explicit override, then a non-blank `$DSH_HOME`, then `~/.dsh`.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping the override is read from.
 * @returns the absolute harness home path.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.[DSH_HOME_ENV]
  const selected = configured ?? (typeof fromEnv === 'string' && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), DSH_HOME_DIR_NAME))
  return resolve(expandHomePath(selected))
}

/**
 * Resolve the default prompt file: `<harness home>/global-prompt.md`.
 * @param dshHome - explicit harness-home override.
 * @param env - environment mapping the override is read from.
 * @returns the absolute path of the default prompt file.
 */
export function defaultPromptFile(dshHome, env = process.env) {
  return join(resolveDshHome(dshHome, env), DEFAULT_PROMPT_FILE_NAME)
}

/**
 * Resolve the default user-global instruction file: `<harness home>/AGENTS.md`.
 * This is the file the harness's own instruction loader reads, and the one the
 * runtime context mentions by bare name — hence the plugin announcing it.
 * @param dshHome - explicit harness-home override.
 * @param env - environment mapping the override is read from.
 * @returns the absolute path of the default instruction file.
 */
export function defaultInstructionsFile(dshHome, env = process.env) {
  return join(resolveDshHome(dshHome, env), DEFAULT_INSTRUCTIONS_FILE_NAME)
}

/** One normalized option value with its expected JavaScript type. */
const VALIDATORS = {
  enabled: 'boolean',
  order: 'number',
  text: 'string',
  maxBytes: 'number',
  escapeBraces: 'boolean',
  announcePaths: 'boolean',
  includeInstructions: 'boolean',
  pathsNote: 'string',
  syncProjectAgents: 'boolean',
  projectAgentsFileName: 'string',
  projectAgentsPreamble: 'string',
  projectAgentsFallback: 'string',
  projectRootMarkers: 'string[]',
}

/** Values `projectAgentsFallback` may take. */
const PROJECT_AGENTS_FALLBACKS = ['cwd', 'skip']

/**
 * Fail with the plugin's own prefix so a bad row config names its owner.
 * @param message - the diagnostic.
 * @returns never — the function always throws.
 */
function fail(message) {
  throw new Error(`dsh-global-system-prompt: ${message}`)
}

/**
 * Resolve one configured path: expand a tilde, then anchor a relative value to
 * the process working directory.
 * @param path - the configured path.
 * @returns the absolute path.
 */
function resolveConfiguredPath(path) {
  const expanded = expandHomePath(path.trim())
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded)
}

/**
 * Normalize one composition row's configuration into the concrete options the
 * reader, the prompt section, and the editor route consume.
 * @param config - the composition entry's `config` object.
 * @param env - environment mapping used for the harness-home fallback.
 * @returns normalized options: `enabled`, `file`, `order`, `text`, `maxBytes`,
 * `escapeBraces`, `announcePaths`, `instructionsFile`, `includeInstructions`,
 * `pathsNote`, `syncProjectAgents`, `projectAgentsFileName`, `projectRootMarkers`,
 * `projectAgentsFallback`, `projectAgentsPreamble`.
 */
export function normalizeConfig(config = {}, env = process.env) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    fail(`config must be an object; got ${JSON.stringify(config)}`)
  }
  for (const [key, type] of Object.entries(VALIDATORS)) {
    const value = config[key]
    if (value === undefined) continue
    if (type === 'string[]') {
      if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
        fail(`config.${key} must be an array of strings; got ${JSON.stringify(value)}`)
      }
      continue
    }
    if (typeof value !== type) {
      fail(`config.${key} must be a ${type}; got ${JSON.stringify(config[key])}`)
    }
  }

  const file = config.file ?? defaultPromptFile(config.dshHome, env)
  if (typeof file !== 'string' || file.trim().length === 0) {
    fail(`config.file must be a non-empty string; got ${JSON.stringify(config.file)}`)
  }

  const instructionsFile = config.instructionsFile ?? defaultInstructionsFile(config.dshHome, env)
  if (typeof instructionsFile !== 'string') {
    fail(`config.instructionsFile must be a string; got ${JSON.stringify(config.instructionsFile)}`)
  }

  const order = config.order ?? DEFAULT_ORDER
  if (!Number.isFinite(order)) fail(`config.order must be a finite number; got ${JSON.stringify(config.order)}`)

  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    fail(`config.maxBytes must be a positive integer; got ${JSON.stringify(config.maxBytes)}`)
  }

  const projectAgentsFileName = config.projectAgentsFileName ?? DEFAULT_PROJECT_AGENTS_FILE_NAME
  if (projectAgentsFileName.trim().length === 0 || /[\\/]/.test(projectAgentsFileName)) {
    fail(`config.projectAgentsFileName must be a bare file name; got ${JSON.stringify(config.projectAgentsFileName)}`)
  }

  const projectRootMarkers = config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS]
  for (const marker of projectRootMarkers) {
    if (marker.trim().length === 0 || /[\\/]/.test(marker)) {
      fail(`config.projectRootMarkers entries must be bare names; got ${JSON.stringify(marker)}`)
    }
  }

  const projectAgentsFallback = config.projectAgentsFallback ?? 'cwd'
  if (!PROJECT_AGENTS_FALLBACKS.includes(projectAgentsFallback)) {
    fail(`config.projectAgentsFallback must be one of ${PROJECT_AGENTS_FALLBACKS.join(' | ')}`
      + `; got ${JSON.stringify(config.projectAgentsFallback)}`)
  }

  return {
    enabled: config.enabled ?? true,
    file: resolveConfiguredPath(file),
    order,
    text: config.text ?? '',
    maxBytes,
    escapeBraces: config.escapeBraces ?? true,
    // Set false for a bare block with no file-location footer.
    announcePaths: config.announcePaths ?? true,
    // An empty value disables both the footer line and content inclusion.
    instructionsFile: instructionsFile.trim().length === 0 ? '' : resolveConfiguredPath(instructionsFile),
    includeInstructions: config.includeInstructions ?? false,
    pathsNote: config.pathsNote ?? '',
    // Mirror the prompt into each session project's AGENTS.md as a managed block.
    syncProjectAgents: config.syncProjectAgents ?? true,
    projectAgentsFileName: projectAgentsFileName.trim(),
    projectRootMarkers: [...projectRootMarkers],
    // 'cwd' mirrors into a marker-less directory anyway; 'skip' keeps this
    // plugin out of anything that is not a recognizable project.
    projectAgentsFallback,
    projectAgentsPreamble: config.projectAgentsPreamble ?? DEFAULT_PROJECT_AGENTS_PREAMBLE,
  }
}
