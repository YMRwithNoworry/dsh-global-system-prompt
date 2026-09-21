import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { createGlobalPrompt, escapePromptVariables } from '../lib/prompt.js'

let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-global-system-prompt-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * A prompt handle over a throwaway file. The path announcement is off by
 * default here so these cases stay about the prompt text itself; the footer has
 * its own describe block below.
 */
function makePrompt(config = {}) {
  return createGlobalPrompt(normalizeConfig({
    file: join(root, config.name ?? 'prompt.md'),
    announcePaths: false,
    ...config,
  }, { DSH_HOME: root }), undefined)
}

describe('escapePromptVariables', () => {
  it('neutralizes every opening group so no {{ survives', () => {
    const escaped = escapePromptVariables('use {{name}} and {{}} and {{not a var}}')
    assert.equal(escaped.includes('{{'), false)
    assert.match(escaped, /use \{\u200B\{name}}/)
  })

  it('leaves single braces and lone closers alone', () => {
    assert.equal(escapePromptVariables('{ "a": 1 } and }}'), '{ "a": 1 } and }}')
  })
})

describe('createGlobalPrompt', () => {
  it('injects the file content', () => {
    const prompt = makePrompt({ name: 'plain.md' })
    writeFileSync(join(root, 'plain.md'), 'Always answer in Chinese.\n', 'utf8')
    assert.equal(prompt.effectiveText(), 'Always answer in Chinese.\n')
  })

  it('treats an existing but empty file as an explicit silence', () => {
    const prompt = makePrompt({ name: 'empty.md', text: 'fallback text' })
    writeFileSync(join(root, 'empty.md'), '   \n', 'utf8')
    assert.equal(prompt.effectiveText(), '')
  })

  it('falls back to the row text only while the file is missing', () => {
    const prompt = makePrompt({ name: 'missing.md', text: 'fallback text' })
    assert.equal(prompt.effectiveText(), 'fallback text')
    writeFileSync(join(root, 'missing.md'), 'file text', 'utf8')
    assert.equal(prompt.effectiveText(), 'file text')
  })

  it('injects nothing without a file or a fallback', () => {
    assert.equal(makePrompt({ name: 'nothing.md' }).effectiveText(), '')
  })

  it('honours enabled: false without touching the file', () => {
    const prompt = makePrompt({ name: 'off.md', enabled: false })
    writeFileSync(join(root, 'off.md'), 'ignored', 'utf8')
    assert.equal(prompt.effectiveText(), '')
  })

  it('escapes template groups by default and injects verbatim on request', () => {
    const escaped = makePrompt({ name: 'escape.md' })
    writeFileSync(join(root, 'escape.md'), '{"a": "{{value}}"}', 'utf8')
    assert.equal(escaped.effectiveText().includes('{{'), false)

    const verbatim = makePrompt({ name: 'verbatim.md', escapeBraces: false })
    writeFileSync(join(root, 'verbatim.md'), '{"a": "{{value}}"}', 'utf8')
    assert.equal(verbatim.effectiveText(), '{"a": "{{value}}"}')
  })

  it('reports the file state and re-reads after an external edit', () => {
    const prompt = makePrompt({ name: 'live.md' })
    assert.equal(prompt.read().exists, false)
    writeFileSync(join(root, 'live.md'), 'first', 'utf8')
    assert.deepEqual(
      { exists: prompt.read().exists, content: prompt.read().content },
      { exists: true, content: 'first' },
    )
    writeFileSync(join(root, 'live.md'), 'second!', 'utf8')
    assert.equal(prompt.effectiveText(), 'second!')
  })

  it('truncates a file that exceeds maxBytes', () => {
    const prompt = makePrompt({ name: 'big.md', maxBytes: 8 })
    writeFileSync(join(root, 'big.md'), 'x'.repeat(64), 'utf8')
    const state = prompt.read()
    assert.equal(state.truncated, true)
    assert.equal(state.content, 'x'.repeat(8))
    assert.equal(state.bytes, 64)
  })

  it('writes through the panel path, creating missing directories', () => {
    const file = join(root, 'nested', 'deeper', 'written.md')
    const prompt = createGlobalPrompt(normalizeConfig({ file, announcePaths: false }, {}), undefined)
    assert.equal(prompt.read().exists, false)
    const bytes = prompt.write('# 全局提示词\n中文\n')
    assert.equal(bytes, Buffer.byteLength('# 全局提示词\n中文\n', 'utf8'))
    assert.equal(readFileSync(file, 'utf8'), '# 全局提示词\n中文\n')
    assert.equal(prompt.read().content, '# 全局提示词\n中文\n')
    assert.equal(existsSync(`${file}.tmp`), false)
  })

  it('never throws from effectiveText when the target is a directory', () => {
    const prompt = createGlobalPrompt(normalizeConfig({ file: root, announcePaths: false }, {}), { warn() {} })
    assert.equal(prompt.effectiveText(), '')
  })

  it('rejects a non-string write', () => {
    const prompt = makePrompt({ name: 'typed.md' })
    assert.throws(() => prompt.write(42), TypeError)
  })
})

describe('file-location announcement', () => {
  const promptFile = join(root, 'announced.md')
  const instructionsFile = join(root, 'AGENTS.md')

  /** A handle with the announcement on (the shipped default). */
  function announcing(config = {}) {
    return createGlobalPrompt(normalizeConfig({ file: promptFile, instructionsFile, ...config }, { DSH_HOME: root }), undefined)
  }

  it('is on by default and names both files by absolute path', () => {
    // A path no other case in this block writes to, so both files are absent.
    const fresh = join(root, 'fresh')
    const injected = createGlobalPrompt(normalizeConfig({
      file: join(fresh, 'p.md'),
      instructionsFile: join(fresh, 'AGENTS.md'),
    }, { DSH_HOME: root }), undefined).effectiveText()
    assert.match(injected, /Harness file locations/)
    assert.ok(injected.includes(join(fresh, 'p.md')), injected)
    assert.ok(injected.includes(join(fresh, 'AGENTS.md')), injected)
    assert.match(injected, /AGENTS\.md.*\(not created yet\)/)
  })

  it('drops the "not created yet" marker once the instruction file exists', () => {
    writeFileSync(instructionsFile, '# rules\n', 'utf8')
    assert.equal(announcing().effectiveText().includes('(not created yet)'), false)
  })

  it('keeps the prompt text and puts the footer after it', () => {
    writeFileSync(promptFile, 'Be terse.', 'utf8')
    const injected = announcing().effectiveText()
    assert.ok(injected.startsWith('Be terse.\n\nHarness file locations'), injected)
  })

  it('announces the paths even with no prompt text at all', () => {
    const injected = announcing({ file: join(root, 'no-text.md'), text: '' }).effectiveText()
    assert.match(injected, /Harness file locations/)
  })

  it('drops the instruction line when instructionsFile is empty', () => {
    const injected = announcing({ instructionsFile: '' }).effectiveText()
    assert.match(injected, /global prompt \(injected by the dsh-global-system-prompt plugin\)/)
    assert.equal(injected.includes('user-global instructions'), false)
  })

  it('injects nothing when the announcement is off and no text exists', () => {
    const prompt = announcing({ file: join(root, 'nothing-at-all.md'), announcePaths: false, instructionsFile: '', text: '' })
    assert.equal(prompt.effectiveText(), '')
  })

  it('uses a configured pathsNote verbatim, escaping it like any other text', () => {
    const injected = announcing({ pathsNote: 'files: {{a}} and {{b}}' }).effectiveText()
    assert.equal(injected.includes('Harness file locations'), false)
    assert.equal(injected.includes('{{'), false)
    assert.ok(injected.includes('files: '), injected)
  })

  it('includes the instruction file content when asked', () => {
    writeFileSync(instructionsFile, 'Never push without asking.\n', 'utf8')
    const injected = announcing({ includeInstructions: true }).effectiveText()
    assert.match(injected, /Global instructions \(from .*AGENTS\.md\):/)
    assert.ok(injected.includes('Never push without asking.'), injected)
    assert.ok(injected.indexOf('Never push without asking.') < injected.indexOf('Harness file locations'), injected)
  })

  it('re-reads the instruction file through the same cache', () => {
    const prompt = announcing({ includeInstructions: true })
    writeFileSync(instructionsFile, 'first revision', 'utf8')
    assert.ok(prompt.effectiveText().includes('first revision'))
    writeFileSync(instructionsFile, 'second revision', 'utf8')
    assert.ok(prompt.effectiveText().includes('second revision'))
  })

  it('reports the instruction file through readInstructions', () => {
    writeFileSync(instructionsFile, 'abc', 'utf8')
    const state = announcing().readInstructions()
    assert.equal(state.path, instructionsFile)
    assert.equal(state.exists, true)
    assert.equal(state.bytes, 3)
    assert.equal(state.content, 'abc')
    assert.deepEqual(announcing({ instructionsFile: '' }).readInstructions(), {
      path: '',
      exists: false,
      content: '',
      bytes: 0,
      truncated: false,
    })
  })
})
