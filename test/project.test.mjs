import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { createGlobalPrompt } from '../lib/prompt.js'
import {
  BLOCK_BEGIN,
  BLOCK_END,
  MAX_AGENTS_BYTES,
  createProjectAgentsSync,
  findProjectRoot,
  removeManagedBlock,
  renderProjectBlock,
  upsertManagedBlock,
} from '../lib/project.js'

let root
let caseRoot

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-global-system-prompt-project-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  caseRoot = mkdtempSync(join(root, 'case-'))
})

/** A directory chain plus, optionally, a `.git` marker at its top. */
function makeProject(name, { git = true } = {}) {
  const project = join(caseRoot, name)
  const nested = join(project, 'packages', 'app')
  mkdirSync(nested, { recursive: true })
  if (git) mkdirSync(join(project, '.git'), { recursive: true })
  return { project, nested }
}

/**
 * A sync handle over a throwaway prompt file. The user-global instruction file
 * is kept inside the case directory so the "never write there" guard has a
 * target of its own.
 * @param config - row configuration overrides.
 * @param logger - optional logger double.
 * @returns `{ options, prompt, sync, instructionsFile, promptFile }`.
 */
function makeSync(config = {}, logger) {
  const promptFile = join(caseRoot, config.promptName ?? 'global-prompt.md')
  const instructionsFile = join(caseRoot, 'home', 'AGENTS.md')
  const options = normalizeConfig({ file: promptFile, instructionsFile, ...config }, {})
  const prompt = createGlobalPrompt(options, undefined)
  return {
    options,
    prompt,
    sync: createProjectAgentsSync(prompt, options, logger),
    instructionsFile,
    promptFile,
  }
}

describe('findProjectRoot', () => {
  it('walks up to the nearest marker', () => {
    const { project, nested } = makeProject('walk-up')
    assert.equal(findProjectRoot(nested, ['.git']), project)
    assert.equal(findProjectRoot(project, ['.git']), project)
  })

  it('accepts a marker file, as a linked worktree has', () => {
    const { project, nested } = makeProject('marker-file', { git: false })
    writeFileSync(join(project, '.git'), 'gitdir: elsewhere\n', 'utf8')
    assert.equal(findProjectRoot(nested, ['.git']), project)
  })

  it('honors a custom marker list', () => {
    const { project, nested } = makeProject('custom-marker', { git: false })
    mkdirSync(join(project, '.hg'))
    assert.equal(findProjectRoot(nested, ['.hg']), project)
  })

  it('falls back to the cwd, or declines entirely', () => {
    const { nested } = makeProject('no-marker', { git: false })
    const markers = ['definitely-not-a-marker']
    assert.equal(findProjectRoot(nested, markers, { fallback: 'cwd' }), nested)
    assert.equal(findProjectRoot(nested, markers, { fallback: 'skip' }), undefined)
  })

  it('declines an unusable cwd', () => {
    assert.equal(findProjectRoot('', ['.git']), undefined)
    assert.equal(findProjectRoot(undefined, ['.git']), undefined)
  })
})

describe('renderProjectBlock', () => {
  it('wraps the prompt in markers, a source note, and the preamble', () => {
    const block = renderProjectBlock('  Always answer in Chinese.  ', {
      file: 'C:\\home\\.dsh\\global-prompt.md',
      preamble: 'Global rules — follow these in every task in this project:',
    })
    assert.ok(block.startsWith(BLOCK_BEGIN), block)
    assert.ok(block.endsWith(BLOCK_END), block)
    assert.ok(block.includes('C:\\home\\.dsh\\global-prompt.md'), block)
    assert.ok(block.includes('Global rules — follow these'), block)
    assert.ok(block.includes('\nAlways answer in Chinese.\n'), block)
    assert.equal(block.includes('  Always answer'), false, 'the body is trimmed')
  })

  it('drops the preamble when the row empties it', () => {
    const block = renderProjectBlock('Be terse.', { file: '/p.md', preamble: '' })
    assert.equal(block.includes('Be terse.'), true)
    assert.equal(block.split('\n').filter(line => line === '').length, 2)
  })
})

describe('upsertManagedBlock', () => {
  const block = renderProjectBlock('Always answer in Chinese.', { file: '/p.md', preamble: 'Rules:' })

  it('creates a file that holds nothing else', () => {
    const result = upsertManagedBlock('', block)
    assert.equal(result.ok, true)
    assert.equal(result.action, 'created')
    assert.equal(result.content, `${block}\n`)
  })

  it('treats a whitespace-only file as empty', () => {
    const result = upsertManagedBlock('\n\n  \n', block)
    assert.equal(result.action, 'created')
    assert.equal(result.content, `${block}\n`)
  })

  it('appends below existing content and keeps it verbatim', () => {
    const result = upsertManagedBlock('  # Project notes\n\nKeep me.\n\n\n', block)
    assert.equal(result.action, 'appended')
    assert.ok(result.content.startsWith('  # Project notes\n\nKeep me.\n\n'), JSON.stringify(result.content))
    assert.ok(result.content.includes('Keep me.'))
    assert.ok(result.content.endsWith(`${BLOCK_END}\n`))
  })

  it('is idempotent', () => {
    const first = upsertManagedBlock('Keep me.\n', block)
    const second = upsertManagedBlock(first.content, block)
    assert.equal(second.action, 'unchanged')
    assert.equal(second.content, first.content)
  })

  it('replaces the block in place when the prompt changes', () => {
    const first = upsertManagedBlock('Before.\n\nAfter.\n', block)
    const updated = renderProjectBlock('Always answer in Japanese.', { file: '/p.md', preamble: 'Rules:' })
    const second = upsertManagedBlock(first.content, updated)
    assert.equal(second.action, 'replaced')
    assert.equal(second.content.includes('Chinese'), false)
    assert.equal(second.content.includes('Japanese'), true)
    assert.equal(second.content.indexOf('Before.'), 0)
    assert.equal(second.content.includes('After.'), true)
    assert.equal(second.content.match(/BEGIN dsh-global-system-prompt/g).length, 1)
  })

  it('collapses duplicated blocks instead of stacking them', () => {
    const doubled = `${block}\n\nmiddle\n\n${block}\n`
    const result = upsertManagedBlock(doubled, block)
    assert.equal(result.ok, true)
    assert.equal(result.content.match(/BEGIN dsh-global-system-prompt/g).length, 1)
    assert.ok(result.content.includes('middle'), result.content)
  })

  it('preserves CRLF files and writes CRLF markers', () => {
    const result = upsertManagedBlock('line one\r\nline two\r\n', block)
    assert.equal(result.content.includes('\r\n'), true)
    assert.equal(/[^\r]\n/.test(result.content), false, 'no bare LF survives')
    const again = upsertManagedBlock(result.content, block)
    assert.equal(again.action, 'unchanged')
  })

  it('preserves a byte-order mark', () => {
    const result = upsertManagedBlock('\uFEFF# Notes\n', block)
    assert.ok(result.content.startsWith('\uFEFF# Notes\n'), JSON.stringify(result.content))
    assert.equal(result.content.slice(1).includes('\uFEFF'), false)
  })

  it('refuses a file whose markers do not pair up', () => {
    const orphanBegin = upsertManagedBlock(`${block}\n\nno closing marker here\n`.replace(`\n${BLOCK_END}`, ''), block)
    assert.equal(orphanBegin.ok, false)
    assert.equal(orphanBegin.reason, 'unbalanced')
    const orphanEnd = upsertManagedBlock(`text\n\n${BLOCK_END}\n`, block)
    assert.equal(orphanEnd.ok, false)
  })
})

describe('removeManagedBlock', () => {
  const block = renderProjectBlock('Prompt body.', { file: '/p.md', preamble: 'Rules:' })

  it('removes the block and keeps the surrounding content', () => {
    const withBlock = upsertManagedBlock('# Notes\n\nKeep me.\n', block)
    const result = removeManagedBlock(withBlock.content)
    assert.equal(result.removed, true)
    assert.equal(result.content, '# Notes\n\nKeep me.\n')
  })

  it('reports nothing to do when there is no block', () => {
    const result = removeManagedBlock('# Notes\n')
    assert.equal(result.removed, false)
    assert.equal(result.content, '# Notes\n')
  })

  it('empties a block-only file so the caller can delete it', () => {
    const result = removeManagedBlock(`${block}\n`)
    assert.equal(result.removed, true)
    assert.equal(result.content, '')
  })

  it('refuses a file whose markers do not pair up', () => {
    const result = removeManagedBlock(`text\n${BLOCK_END}\n`)
    assert.equal(result.ok, false)
  })
})

describe('createProjectAgentsSync', () => {
  it('mirrors the prompt into the session project root', () => {
    const { nested, project } = makeProject('mirror')
    const { sync, promptFile, options } = makeSync()
    writeFileSync(promptFile, 'Always answer in Chinese.\n', 'utf8')

    const result = sync.syncCwd(nested, 'session-start')
    assert.equal(result.action, 'created')
    assert.equal(result.target, join(project, 'AGENTS.md'))

    const written = readFileSync(join(project, 'AGENTS.md'), 'utf8')
    assert.ok(written.startsWith(BLOCK_BEGIN), written)
    assert.ok(written.includes('Always answer in Chinese.'), written)
    assert.ok(written.includes(options.projectAgentsPreamble), written)
    assert.ok(written.includes(promptFile), written)
    assert.ok(written.endsWith(`${BLOCK_END}\n`), written)
  })

  it('is idempotent, and stays off the file once it matches', () => {
    const { nested, project } = makeProject('idempotent')
    const { sync, promptFile } = makeSync()
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    assert.equal(sync.syncCwd(nested).action, 'created')

    const target = join(project, 'AGENTS.md')
    const first = readFileSync(target, 'utf8')
    // Freeze the mtime: a rewrite would move it, so an unchanged stamp proves
    // the second sync did not touch the file at all.
    const frozen = new Date(Date.now() - 60_000)
    utimesSync(target, frozen, frozen)

    assert.equal(sync.syncCwd(nested).action, 'unchanged')
    assert.equal(readFileSync(target, 'utf8'), first)
    assert.equal(statSync(target).mtimeMs, frozen.getTime())
  })

  it('follows an edited prompt on the next sync', () => {
    const { nested, project } = makeProject('follows-edit')
    const { sync, promptFile } = makeSync()
    writeFileSync(promptFile, 'First version.\n', 'utf8')
    sync.syncCwd(nested)

    writeFileSync(promptFile, 'Second version.\n', 'utf8')
    assert.equal(sync.syncCwd(nested).action, 'updated')
    const written = readFileSync(join(project, 'AGENTS.md'), 'utf8')
    assert.equal(written.includes('First version.'), false)
    assert.equal(written.includes('Second version.'), true)
  })

  it('repairs a block someone deleted or edited by hand', () => {
    const { nested, project } = makeProject('repairs')
    const { sync, promptFile } = makeSync()
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    sync.syncCwd(nested)

    const target = join(project, 'AGENTS.md')
    writeFileSync(target, '# Only the project notes now.\n', 'utf8')
    assert.equal(sync.syncCwd(nested, 'step').action, 'updated')
    const repaired = readFileSync(target, 'utf8')
    assert.ok(repaired.startsWith('# Only the project notes now.'), repaired)
    assert.ok(repaired.includes('Rules.'), repaired)
  })

  it('keeps the project\'s own content when a block is rewritten', () => {
    const { nested, project } = makeProject('preserves')
    const { sync, promptFile } = makeSync()
    const target = join(project, 'AGENTS.md')
    writeFileSync(target, '# House rules\n\nUse tabs.\n', 'utf8')
    writeFileSync(promptFile, 'Global rule.\n', 'utf8')

    assert.equal(sync.syncCwd(nested).action, 'updated')
    const written = readFileSync(target, 'utf8')
    assert.ok(written.startsWith('# House rules\n\nUse tabs.\n'), written)
    assert.ok(written.includes('Global rule.'), written)
  })

  it('removes the block, and the file it created, when the prompt is emptied', () => {
    const { nested, project } = makeProject('emptied')
    const { sync, promptFile } = makeSync()
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    sync.syncCwd(nested)
    const target = join(project, 'AGENTS.md')
    assert.equal(existsSync(target), true)

    writeFileSync(promptFile, '   \n', 'utf8')
    assert.equal(sync.syncCwd(nested).action, 'removed')
    assert.equal(existsSync(target), false)
  })

  it('leaves a project file that has content of its own in place', () => {
    const { nested, project } = makeProject('emptied-but-owned')
    const { sync, promptFile } = makeSync()
    const target = join(project, 'AGENTS.md')
    writeFileSync(target, '# House rules\n\nUse tabs.\n', 'utf8')
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    sync.syncCwd(nested)

    writeFileSync(promptFile, '', 'utf8')
    assert.equal(sync.syncCwd(nested).action, 'updated')
    assert.equal(readFileSync(target, 'utf8'), '# House rules\n\nUse tabs.\n')
  })

  it('honors a custom file name', () => {
    const { nested, project } = makeProject('custom-name')
    const { sync, promptFile } = makeSync({ projectAgentsFileName: 'CLAUDE.md' })
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    assert.equal(sync.syncCwd(nested).target, join(project, 'CLAUDE.md'))
    assert.equal(existsSync(join(project, 'CLAUDE.md')), true)
    assert.equal(existsSync(join(project, 'AGENTS.md')), false)
  })

  it('skips everything while the row or the sync is off', () => {
    const { nested, project } = makeProject('off')
    const off = makeSync({ syncProjectAgents: false })
    writeFileSync(off.promptFile, 'Rules.\n', 'utf8')
    assert.equal(off.sync.syncCwd(nested).cause, 'disabled')
    assert.equal(existsSync(join(project, 'AGENTS.md')), false)

    const disabled = makeSync({ enabled: false })
    writeFileSync(disabled.promptFile, 'Rules.\n', 'utf8')
    assert.equal(disabled.sync.syncCwd(nested).cause, 'disabled')
    assert.equal(existsSync(join(project, 'AGENTS.md')), false)
  })

  it('never writes the user-global instruction file dsh owns', () => {
    const warnings = []
    const { sync, promptFile, instructionsFile } = makeSync(
      { projectRootMarkers: ['definitely-not-a-marker'] },
      { warn: (...args) => warnings.push(args) },
    )
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    const result = sync.syncCwd(join(caseRoot, 'home'))
    assert.equal(result.action, 'skipped')
    assert.equal(result.cause, 'is-instructions-file')
    assert.equal(existsSync(instructionsFile), false)
    assert.equal(warnings.length, 1)
  })

  it('declines a directory with no project marker when asked to', () => {
    const { sync, promptFile } = makeSync({
      projectAgentsFallback: 'skip',
      projectRootMarkers: ['definitely-not-a-marker'],
    })
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    const result = sync.syncCwd(caseRoot)
    assert.equal(result.cause, 'no-project-root')
    assert.equal(existsSync(join(caseRoot, 'AGENTS.md')), false)
  })

  it('leaves a file with unbalanced markers alone and warns', () => {
    const warnings = []
    const { nested, project } = makeProject('unbalanced')
    const { sync, promptFile } = makeSync({}, { warn: (...args) => warnings.push(args) })
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    const target = join(project, 'AGENTS.md')
    const mangled = `# Notes\n\n${BLOCK_END}\n`
    writeFileSync(target, mangled, 'utf8')

    const result = sync.syncCwd(nested)
    assert.equal(result.action, 'skipped')
    assert.equal(result.cause, 'unbalanced')
    assert.equal(readFileSync(target, 'utf8'), mangled)
    // Again: one warning for a permanent condition, not one per step.
    sync.syncCwd(nested, 'step')
    assert.equal(warnings.length, 1)
  })

  it('declines an implausibly large file', () => {
    const warnings = []
    const { nested, project } = makeProject('too-large')
    const { sync, promptFile } = makeSync({}, { warn: (...args) => warnings.push(args) })
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    writeFileSync(join(project, 'AGENTS.md'), 'x'.repeat(MAX_AGENTS_BYTES + 1), 'utf8')
    const result = sync.syncCwd(nested)
    assert.equal(result.cause, 'too-large')
    // The refusal is permanent, so it is reported once rather than per step.
    assert.equal(sync.syncCwd(nested, 'step').cause, 'too-large')
    assert.equal(sync.syncCwd(nested, 'step').cause, 'too-large')
    assert.equal(warnings.length, 1)
    assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8').length, MAX_AGENTS_BYTES + 1)

    // Shrinking the file out from under the refusal gets it synced again.
    writeFileSync(join(project, 'AGENTS.md'), '# Notes\n', 'utf8')
    assert.equal(sync.syncCwd(nested).action, 'updated')
    assert.ok(readFileSync(join(project, 'AGENTS.md'), 'utf8').includes('Rules.'))
  })

  it('reports its targets and recent transitions for the panel', () => {
    const { nested, project } = makeProject('status')
    const { sync, promptFile } = makeSync()
    writeFileSync(promptFile, 'Rules.\n', 'utf8')
    sync.syncCwd(nested)
    writeFileSync(promptFile, 'Rules, v2.\n', 'utf8')
    sync.syncCwd(nested)

    const status = sync.status()
    assert.equal(status.enabled, true)
    assert.equal(status.fileName, 'AGENTS.md')
    assert.deepEqual(status.markers, ['.git'])
    assert.equal(status.fallback, 'cwd')
    assert.deepEqual(status.targets.map(entry => entry.path), [join(project, 'AGENTS.md')])
    assert.equal(status.targets[0].action, 'updated')
    assert.deepEqual(status.history.map(entry => entry.action), ['updated', 'created'])
  })

  it('reports itself as disabled in the status when the row is off', () => {
    const off = makeSync({ syncProjectAgents: false })
    assert.equal(off.sync.status().enabled, false)
  })

  it('resolves the project from an agent session and survives a broken one', () => {
    const { nested, project } = makeProject('agent')
    const { sync, promptFile } = makeSync()
    writeFileSync(promptFile, 'Rules.\n', 'utf8')

    assert.equal(sync.ensure({ session: { header: { cwd: nested } } }, 'session-start').target,
      join(project, 'AGENTS.md'))
    assert.equal(existsSync(join(project, 'AGENTS.md')), true)
    assert.equal(sync.ensure({ session: { header: {} } }), undefined)
    assert.equal(sync.ensure({ session: undefined }), undefined)
    assert.equal(sync.ensure(undefined), undefined)
  })

  it('subscribes to the session lifecycle and syncs the agent cwd', async () => {
    const { nested, project } = makeProject('attach')
    const { sync, promptFile } = makeSync()
    writeFileSync(promptFile, 'Rules.\n', 'utf8')

    const listeners = new Map()
    const ctx = {
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return () => {}
      },
    }
    sync.attach(ctx)
    assert.deepEqual([...listeners.keys()], ['agent/session-start', 'agent/pre-step'])

    const agent = { session: { header: { cwd: nested } } }
    for (const listener of listeners.get('agent/session-start')) listener({ agent, source: 'startup' })
    const target = join(project, 'AGENTS.md')
    assert.equal(existsSync(target), true)
    assert.ok(readFileSync(target, 'utf8').includes('Rules.'))

    // The pre-step hook is a waterfall: it must hand the decision back untouched.
    const decision = { kind: 'accept' }
    for (const listener of listeners.get('agent/pre-step')) {
      assert.equal(await listener({ agent, messages: [], turn: 1, step: 1 }, async () => decision), decision)
    }

    // Nothing may escape into the loop, whatever the payload looks like:
    // `agent/session-start` fires at publication time, where a throw rolls the
    // agent back, and the pre-step listener sits in the turn's waterfall.
    for (const listener of listeners.get('agent/session-start')) {
      assert.doesNotThrow(() => listener(undefined))
      assert.doesNotThrow(() => listener({}))
    }
    for (const listener of listeners.get('agent/pre-step')) {
      assert.equal(await listener(undefined, async () => decision), decision)
      assert.equal(await listener({}, async () => decision), decision)
    }
  })
})
