import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  DEFAULT_INSTRUCTIONS_FILE_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_ORDER,
  DEFAULT_PROJECT_AGENTS_FILE_NAME,
  DEFAULT_PROJECT_AGENTS_PREAMBLE,
  DEFAULT_PROJECT_ROOT_MARKERS,
  SECTION_NAME,
  defaultInstructionsFile,
  defaultPromptFile,
  expandHomePath,
  normalizeConfig,
  resolveDshHome,
} from '../lib/config.js'

describe('expandHomePath', () => {
  it('expands ~ and its separators', () => {
    assert.equal(expandHomePath('~'), homedir())
    assert.equal(expandHomePath('~/prompt.md'), join(homedir(), 'prompt.md'))
    assert.equal(expandHomePath('~\\prompt.md'), join(homedir(), 'prompt.md'))
  })

  it('leaves other paths alone', () => {
    assert.equal(expandHomePath('prompts/p.md'), 'prompts/p.md')
    assert.equal(expandHomePath('/abs/p.md'), '/abs/p.md')
  })
})

describe('resolveDshHome', () => {
  it('prefers the explicit override over the environment', () => {
    assert.equal(resolveDshHome('/explicit', { DSH_HOME: '/env' }), resolve('/explicit'))
  })

  it('uses a non-blank DSH_HOME', () => {
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '/env' }), resolve('/env'))
  })

  it('falls back to ~/.dsh for a missing or blank DSH_HOME', () => {
    assert.equal(resolveDshHome(undefined, {}), join(homedir(), '.dsh'))
    assert.equal(resolveDshHome(undefined, { DSH_HOME: '   ' }), join(homedir(), '.dsh'))
  })
})

describe('normalizeConfig', () => {
  it('defaults to the harness home prompt file and the preamble order', () => {
    const options = normalizeConfig({}, { DSH_HOME: '/home/user/.dsh' })
    assert.equal(options.enabled, true)
    assert.equal(options.file, join(resolve('/home/user/.dsh'), 'global-prompt.md'))
    assert.equal(options.order, DEFAULT_ORDER)
    assert.equal(options.text, '')
    assert.equal(options.maxBytes, DEFAULT_MAX_BYTES)
    assert.equal(options.escapeBraces, true)
    assert.equal(SECTION_NAME, 'user:global-prompt')
  })

  it('defaults to mirroring the prompt into each project AGENTS.md', () => {
    const options = normalizeConfig({}, { DSH_HOME: '/home/user/.dsh' })
    assert.equal(options.syncProjectAgents, true)
    assert.equal(options.projectAgentsFileName, DEFAULT_PROJECT_AGENTS_FILE_NAME)
    assert.deepEqual(options.projectRootMarkers, DEFAULT_PROJECT_ROOT_MARKERS)
    assert.equal(options.projectAgentsFallback, 'cwd')
    assert.equal(options.projectAgentsPreamble, DEFAULT_PROJECT_AGENTS_PREAMBLE)
  })

  it('announces the harness user-global instruction file by default', () => {
    const options = normalizeConfig({}, { DSH_HOME: '/home/user/.dsh' })
    assert.equal(options.announcePaths, true)
    assert.equal(options.instructionsFile, join(resolve('/home/user/.dsh'), 'AGENTS.md'))
    assert.equal(options.includeInstructions, false)
    assert.equal(options.pathsNote, '')
  })

  it('accepts every documented field', () => {
    const options = normalizeConfig({
      enabled: false,
      file: 'prompts/global.md',
      order: 120,
      text: 'fallback',
      maxBytes: 128,
      escapeBraces: false,
      announcePaths: false,
      instructionsFile: 'rules/AGENTS.md',
      includeInstructions: true,
      pathsNote: 'see the docs',
    }, {})
    assert.equal(options.enabled, false)
    assert.equal(options.file, resolve(process.cwd(), 'prompts/global.md'))
    assert.equal(options.order, 120)
    assert.equal(options.text, 'fallback')
    assert.equal(options.maxBytes, 128)
    assert.equal(options.escapeBraces, false)
    assert.equal(options.announcePaths, false)
    assert.equal(options.instructionsFile, resolve(process.cwd(), 'rules/AGENTS.md'))
    assert.equal(options.includeInstructions, true)
    assert.equal(options.pathsNote, 'see the docs')
  })

  it('expands a tilde file and honours dshHome', () => {
    assert.equal(normalizeConfig({ file: '~/p.md' }, {}).file, join(homedir(), 'p.md'))
    assert.equal(normalizeConfig({ dshHome: 'C:/custom' }, {}).file, join(resolve('C:/custom'), 'global-prompt.md'))
    assert.equal(
      normalizeConfig({ dshHome: 'C:/custom' }, {}).instructionsFile,
      join(resolve('C:/custom'), DEFAULT_INSTRUCTIONS_FILE_NAME),
    )
    assert.equal(normalizeConfig({ instructionsFile: '~/AGENTS.md' }, {}).instructionsFile, join(homedir(), 'AGENTS.md'))
  })

  it('treats an empty instructionsFile as "do not mention it"', () => {
    assert.equal(normalizeConfig({ instructionsFile: '  ' }, {}).instructionsFile, '')
  })

  it('rejects a wrong type on every field', () => {
    const cases = [
      { enabled: 'yes' },
      { order: '900' },
      { text: 1 },
      { maxBytes: '10' },
      { escapeBraces: 1 },
      { announcePaths: 'yes' },
      { instructionsFile: 1 },
      { includeInstructions: 'yes' },
      { pathsNote: 1 },
      { syncProjectAgents: 'yes' },
      { projectAgentsFileName: 1 },
      { projectAgentsPreamble: 1 },
      { projectAgentsFallback: 1 },
      { projectRootMarkers: '.git' },
      { projectRootMarkers: ['ok', 2] },
    ]
    for (const config of cases) {
      assert.throws(() => normalizeConfig(config, {}), /dsh-global-system-prompt: config\./)
    }
  })

  it('rejects an unusable file, order, or budget', () => {
    assert.throws(() => normalizeConfig({ file: '   ' }, {}), /config\.file must be a non-empty string/)
    assert.throws(() => normalizeConfig({ order: Number.NaN }, {}), /config\.order must be a finite number/)
    assert.throws(() => normalizeConfig({ maxBytes: 0 }, {}), /config\.maxBytes must be a positive integer/)
    assert.throws(() => normalizeConfig({ maxBytes: 1.5 }, {}), /config\.maxBytes must be a positive integer/)
  })

  it('rejects a non-object config', () => {
    assert.throws(() => normalizeConfig([1, 2], {}), /config must be an object/)
    assert.throws(() => normalizeConfig(null, {}), /config must be an object/)
  })

  it('rejects a project file name or marker that is not a bare name', () => {
    assert.throws(
      () => normalizeConfig({ projectAgentsFileName: '   ' }, {}),
      /config\.projectAgentsFileName must be a bare file name/,
    )
    assert.throws(
      () => normalizeConfig({ projectAgentsFileName: 'docs/AGENTS.md' }, {}),
      /config\.projectAgentsFileName must be a bare file name/,
    )
    assert.throws(
      () => normalizeConfig({ projectRootMarkers: [''] }, {}),
      /config\.projectRootMarkers entries must be bare names/,
    )
    assert.throws(
      () => normalizeConfig({ projectRootMarkers: ['.git/HEAD'] }, {}),
      /config\.projectRootMarkers entries must be bare names/,
    )
  })

  it('rejects an unknown project-root fallback', () => {
    assert.throws(
      () => normalizeConfig({ projectAgentsFallback: 'home' }, {}),
      /config\.projectAgentsFallback must be one of cwd \| skip/,
    )
  })

  it('accepts every project-mirror field', () => {
    const options = normalizeConfig({
      syncProjectAgents: false,
      projectAgentsFileName: 'CLAUDE.md',
      projectRootMarkers: ['.git', '.hg'],
      projectAgentsFallback: 'skip',
      projectAgentsPreamble: '全局规则，必须遵守：',
    }, {})
    assert.equal(options.syncProjectAgents, false)
    assert.equal(options.projectAgentsFileName, 'CLAUDE.md')
    assert.deepEqual(options.projectRootMarkers, ['.git', '.hg'])
    assert.equal(options.projectAgentsFallback, 'skip')
    assert.equal(options.projectAgentsPreamble, '全局规则，必须遵守：')
  })
})

describe('defaultPromptFile', () => {
  it('joins the resolved home with the default name', () => {
    assert.equal(defaultPromptFile(undefined, { DSH_HOME: '/env' }), join(resolve('/env'), 'global-prompt.md'))
  })
})

describe('defaultInstructionsFile', () => {
  it('points at the file the harness instruction loader reads', () => {
    assert.equal(defaultInstructionsFile(undefined, { DSH_HOME: '/env' }), join(resolve('/env'), 'AGENTS.md'))
  })
})
