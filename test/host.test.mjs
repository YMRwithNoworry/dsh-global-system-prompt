import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { SECTION_NAME, apply, inject, name } from '../lib/index.js'

let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-global-system-prompt-host-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * A minimal Cordis context double: records the section registration, the
 * lifecycle listeners, and the optional-service waits instead of starting a real
 * kernel.
 */
function fakeContext() {
  const context = {
    sections: [],
    waits: [],
    logs: [],
    warnings: [],
    listeners: [],
    logger: { info: (line) => context.logs.push(line), warn: (...args) => context.warnings.push(args) },
    systemPrompt: { section: (section) => { context.sections.push(section); return () => {} } },
    inject: (services, callback) => { context.waits.push({ services, callback }) },
    on: (event, listener) => { context.listeners.push({ event, listener }); return () => {} },
  }
  return context
}

describe('apply', () => {
  it('declares itself as a prompt-registry consumer', () => {
    assert.equal(name, 'global-prompt')
    assert.deepEqual(inject, ['systemPrompt'])
    assert.deepEqual(apply.inject, inject)
  })

  it('registers one uniquely named global section whose text is read live', () => {
    const file = join(root, 'host.md')
    const ctx = fakeContext()
    // Focused on the live re-read: the file-location footer has its own case.
    apply(ctx, { file, order: -900, announcePaths: false, instructionsFile: '' })

    assert.equal(ctx.sections.length, 1)
    assert.equal(ctx.sections[0].name, SECTION_NAME)
    assert.notEqual(SECTION_NAME, 'deployment:persona-prefix')
    assert.equal(ctx.sections[0].order, -900)

    writeFileSync(file, 'first', 'utf8')
    assert.equal(ctx.sections[0].text(), 'first')
    writeFileSync(file, 'second!', 'utf8')
    assert.equal(ctx.sections[0].text(), 'second!')
  })

  it('announces the user-global instruction file by absolute path by default', () => {
    const ctx = fakeContext()
    apply(ctx, { file: join(root, 'announce.md'), instructionsFile: join(root, 'AGENTS.md'), text: 'Be terse.' })

    const injected = ctx.sections[0].text()
    assert.match(injected, /Harness file locations/)
    assert.ok(injected.includes(join(root, 'announce.md')), injected)
    assert.ok(injected.includes(join(root, 'AGENTS.md')), injected)
    assert.match(ctx.logs[0], /announcing/)
  })

  it('drops the announcement when the row turns it off', () => {
    const ctx = fakeContext()
    apply(ctx, {
      file: join(root, 'quiet.md'),
      instructionsFile: join(root, 'AGENTS.md'),
      text: 'Be terse.',
      announcePaths: false,
    })
    assert.equal(ctx.sections[0].text(), 'Be terse.')
    assert.match(ctx.logs[0], /path announcement off/)
  })

  it('waits for the web server instead of requiring it', () => {
    const ctx = fakeContext()
    apply(ctx, { file: join(root, 'web.md') })
    assert.deepEqual(ctx.waits.map(({ services }) => services), [['webServer']])

    const effects = []
    const routes = []
    const host = {
      effect: (factory, label) => { effects.push(label); factory(); return () => {} },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
    }
    ctx.waits[0].callback(host)
    assert.deepEqual(effects, ['dsh-global-system-prompt: editor route'])
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/global-prompt')
    assert.equal(routes[0].kind, 'exact')
    assert.equal(typeof routes[0].handler, 'function')
  })

  it('injects nothing when the row is disabled', () => {
    const ctx = fakeContext()
    apply(ctx, { enabled: false, file: join(root, 'disabled.md') })
    assert.equal(ctx.sections.length, 0)
    assert.equal(ctx.waits.length, 1)
    assert.deepEqual(ctx.listeners, [], 'a disabled row also stops mirroring AGENTS.md')
  })

  it('mirrors the prompt into each session project by default', () => {
    const project = join(root, 'mirror-project')
    mkdirSync(join(project, '.git'), { recursive: true })
    const ctx = fakeContext()
    apply(ctx, { file: join(root, 'mirror.md'), instructionsFile: join(root, 'mirror-home', 'AGENTS.md') })
    writeFileSync(join(root, 'mirror.md'), 'Always answer in Chinese.\n', 'utf8')

    assert.deepEqual(ctx.listeners.map(({ event }) => event), ['agent/session-start', 'agent/pre-step'])
    for (const { event, listener } of ctx.listeners) {
      if (event !== 'agent/session-start') continue
      listener({ agent: { session: { header: { cwd: project } } }, source: 'startup' })
    }
    const written = readFileSync(join(project, 'AGENTS.md'), 'utf8')
    assert.match(written, /BEGIN dsh-global-system-prompt/)
    assert.match(written, /Always answer in Chinese\./)
    assert.match(ctx.logs[0], /mirroring into each session project's AGENTS\.md/)
  })

  it('leaves the lifecycle alone when the row turns the mirror off', () => {
    const ctx = fakeContext()
    apply(ctx, { file: join(root, 'no-mirror.md'), syncProjectAgents: false })
    assert.deepEqual(ctx.listeners, [])
    assert.match(ctx.logs[0], /project AGENTS\.md sync off/)
  })

  it('fails the boot on an invalid row config', () => {
    assert.throws(() => apply(fakeContext(), { order: 'nope' }), /dsh-global-system-prompt: config\.order/)
  })

  it('logs the resolved placement without a logger requirement', () => {
    const ctx = fakeContext()
    apply(ctx, { file: join(root, 'logged.md') })
    assert.match(ctx.logs[0], /dsh-global-system-prompt: active/)
    assert.match(ctx.logs[0], /user:global-prompt/)
  })
})
