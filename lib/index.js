/**
 * `dsh-global-system-prompt` — a cc-switch-style global prompt for DeepSeek Harness.
 *
 * The bundle patch (`cordis.patch.yml`) mounts one row. That row:
 *
 * 1. registers a single, uniquely named system-prompt section
 *    (`user:global-prompt`) whose text provider re-reads the prompt file on
 *    every assembly, so the block is part of **every** conversation and turns
 *    in every scope — root sessions, preset-mounted agents, and in-process
 *    subagents alike — and an edit lands on the next step without a restart;
 * 2. names the harness's user-global files by **absolute path** inside that
 *    block. The runtime context the harness injects mentions the user-global
 *    instructions only as a bare "AGENTS.md", which sends the model hunting
 *    through the home directory for it; the footer removes the search;
 * 3. mirrors the same text into the session project's own `AGENTS.md` as a
 *    **managed block**, so the rules also reach every other tool that reads that
 *    file and outlive the dsh session itself — see `project.js`;
 * 4. serves the read/write route the web settings panel uses, when the profile
 *    has a web server at all.
 *
 * Why a section instead of `personaPrefix`: the deployment persona slot is
 * owned by the prompt registry itself (`deployment:persona-prefix`), and agent
 * presets shadow that name with their own persona. A unique name is additive
 * everywhere and cannot be shadowed by a preset.
 *
 * @module dsh-global-system-prompt
 */

import {
  DEFAULT_INSTRUCTIONS_FILE_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_ORDER,
  DEFAULT_PROJECT_AGENTS_FILE_NAME,
  DEFAULT_PROJECT_AGENTS_PREAMBLE,
  DEFAULT_PROJECT_ROOT_MARKERS,
  MAX_EDITOR_BODY_BYTES,
  SECTION_NAME,
  defaultInstructionsFile,
  defaultPromptFile,
  normalizeConfig,
  resolveDshHome,
} from './config.js'
import { createGlobalPrompt, escapePromptVariables } from './prompt.js'
import {
  BLOCK_BEGIN,
  BLOCK_END,
  BLOCK_ID,
  MAX_AGENTS_BYTES,
  createProjectAgentsSync,
  findProjectRoot,
  removeManagedBlock,
  renderProjectBlock,
  upsertManagedBlock,
} from './project.js'
import { ROUTE_PATH, createEditorHandler, sameOrigin } from './route.js'

export {
  BLOCK_BEGIN,
  BLOCK_END,
  BLOCK_ID,
  DEFAULT_INSTRUCTIONS_FILE_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_ORDER,
  DEFAULT_PROJECT_AGENTS_FILE_NAME,
  DEFAULT_PROJECT_AGENTS_PREAMBLE,
  DEFAULT_PROJECT_ROOT_MARKERS,
  MAX_AGENTS_BYTES,
  MAX_EDITOR_BODY_BYTES,
  ROUTE_PATH,
  SECTION_NAME,
  createEditorHandler,
  createGlobalPrompt,
  createProjectAgentsSync,
  defaultInstructionsFile,
  defaultPromptFile,
  escapePromptVariables,
  findProjectRoot,
  normalizeConfig,
  removeManagedBlock,
  renderProjectBlock,
  resolveDshHome,
  sameOrigin,
  upsertManagedBlock,
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'global-prompt'

/**
 * The prompt registry must exist before the section can be registered. The web
 * route is optional, so it is waited for through `ctx.inject` inside `apply`
 * rather than declared here — a declared-but-absent service would leave the
 * whole plugin pending and the prompt would never be injected.
 */
export const inject = ['systemPrompt']

/**
 * Apply the global prompt.
 * @param ctx - the plugin context (`systemPrompt` is injected).
 * @param config - the composition entry's config.
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const prompt = createGlobalPrompt(options, ctx.logger)
  const projectSync = createProjectAgentsSync(prompt, options, ctx.logger)

  if (options.enabled) {
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: options.order,
      // Evaluated once per assembly: file edits apply from the next step on.
      text: () => prompt.effectiveText(),
    })
  }

  // Lifecycle listeners are not services, so they need no `inject`: attaching
  // them here leaves a profile without an agent loop (config dumps, tooling)
  // working exactly as before.
  if (options.enabled && options.syncProjectAgents) projectSync.attach(ctx)

  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: createEditorHandler(prompt, options, projectSync),
    }), 'dsh-global-system-prompt: editor route')
  })

  try {
    const state = prompt.read()
    const instructions = prompt.readInstructions()
    ctx.logger.info(
      `dsh-global-system-prompt: ${options.enabled ? 'active' : 'disabled'} — ${options.file}`
      + ` (${state.exists ? `${state.bytes} B` : 'not created yet'}),`
      + ` section "${SECTION_NAME}" at order ${options.order}`
      + (options.announcePaths
        ? `, announcing ${instructions.path || '(no instruction file)'}`
          + ` (${instructions.exists ? `${instructions.bytes} B` : 'not created yet'})`
        : ', path announcement off')
      + (options.enabled && options.syncProjectAgents
        ? `, mirroring into each session project's ${options.projectAgentsFileName}`
          + ` (root markers: ${options.projectRootMarkers.join(', ') || 'none'}`
          + `, fallback: ${options.projectAgentsFallback})`
        : ', project AGENTS.md sync off'),
    )
  } catch {
    // Logging is best-effort; the plugin works without a logger.
  }
}

// The harness's module loader unwraps a `default` export before reading plugin
// metadata; this package exports no default, and the mirror on the function
// keeps the injection declaration attached either way.
apply.inject = inject
