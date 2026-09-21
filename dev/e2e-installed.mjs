/**
 * Opt-in end-to-end check against a **real installed dsh**: it boots the
 * first-party prompt registry, mounts this plugin exactly as the profile does,
 * and asserts what the model would actually receive.
 *
 * Bare imports (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-system-prompt`, …) come
 * from the harness installation, so the script has to run from inside a profile
 * directory — that is where dsh's own module resolution starts:
 *
 *   node --test test/                                     # unit tests, anywhere
 *   copy dev\e2e-installed.mjs %DSH_HOME%\profiles\web\e2e.mjs
 *   cd /d %DSH_HOME%\profiles\web && node e2e.mjs         # end-to-end
 *
 * `dsh-global-system-prompt` itself must be installed in that profile
 * (`dsh plugin --profile <name> add <spec>`) so `dsh-global-system-prompt` resolves to
 * the artifact under test rather than to ./lib.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as globalPrompt from 'dsh-global-system-prompt'

const SECTION = 'user:global-prompt'
const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

const dir = mkdtempSync(join(tmpdir(), 'dsh-global-system-prompt-e2e-'))
const file = join(dir, 'global-prompt.md')
const instructionsFile = join(dir, 'AGENTS.md')
const ctx = new Context()
let steps = 0

/** Assemble, render, and report the section this plugin owns. */
async function rendered(scope) {
  const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return {
    prompt: renderPrompt(assembly),
    section: assembly.sections.find(entry => entry.name === SECTION),
  }
}

try {
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment persona.' })
  const fiber = await ctx.plugin(globalPrompt, { file, instructionsFile, order: -900 })

  writeFileSync(file, 'Always answer in Chinese.', 'utf8')
  const first = await rendered()
  assert.equal(first.section?.name, SECTION)
  assert.equal(globalPrompt.DEFAULT_ORDER, -900)
  assert.ok(first.section?.text.startsWith('Always answer in Chinese.'))
  assert.ok(first.prompt.startsWith(`${IDENTITY}\n\nAlways answer in Chinese.`), first.prompt)
  assert.ok(first.prompt.includes('Deployment persona.'))
  console.log(`ok ${++steps}: the block lands right after the identity line at order -900`)

  // The adaptation: the runtime context names the user-global instructions only
  // as a bare "AGENTS.md", so the block hands the model the exact paths.
  assert.match(first.section.text, /Harness file locations/)
  assert.ok(first.section.text.includes(file), first.section.text)
  assert.ok(first.section.text.includes(instructionsFile), first.section.text)
  assert.match(first.section.text, /AGENTS\.md.*\(not created yet\)/)
  writeFileSync(instructionsFile, 'Never push without asking.\n', 'utf8')
  const announced = await rendered()
  assert.equal(announced.section.text.includes('(not created yet)'), false)
  assert.ok(announced.section.text.includes(instructionsFile), announced.section.text)
  console.log(`ok ${++steps}: the file-location footer names the prompt file and the user-global AGENTS.md`)

  // A preset/agent scope must still receive the block: its persona shadows
  // `deployment:persona-prefix`, never this section's unique name.
  const scope = createScope(ctx, { agent: 'e2e-preset' })
  const scoped = await rendered(scope)
  assert.ok(scoped.prompt.includes('Always answer in Chinese.'), scoped.prompt)
  console.log(`ok ${++steps}: a scoped (preset/agent) assembly still carries the block`)

  // Literal template syntax must not break the turn.
  writeFileSync(file, 'Config example: {"a": "{{value}}"}', 'utf8')
  const templated = await rendered()
  assert.equal(templated.prompt.includes('{{'), false, 'escaped output must not contain a variable group')
  assert.ok(templated.prompt.includes('value'))
  console.log(`ok ${++steps}: literal {{...}} is neutralized instead of throwing`)

  // An edit applies to the next assembly without a restart.
  writeFileSync(file, 'Second revision.', 'utf8')
  assert.ok((await rendered()).prompt.includes('Second revision.'))
  console.log(`ok ${++steps}: an edit applies on the next assembly, no restart`)

  // An existing but empty file is an explicit silence for the prompt text; the
  // file-location footer is independent of it and stays.
  writeFileSync(file, '', 'utf8')
  const silenced = await rendered()
  assert.equal(silenced.prompt.includes('Second revision.'), false)
  assert.match(silenced.section?.text ?? '', /Harness file locations/)
  console.log(`ok ${++steps}: an empty file silences the prompt text while the footer stays`)

  // Disposal removes the section from the assembly again.
  await fiber.dispose()
  assert.equal((await rendered()).section, undefined)
  console.log(`ok ${++steps}: disposing the fiber unregisters the section`)

  // Optional: carry the instruction file's own content, for profiles that do not
  // mount the harness instruction loader. Mounted alone, since the section name
  // is unique per scope.
  const including = await ctx.plugin(globalPrompt, {
    file,
    instructionsFile,
    includeInstructions: true,
    order: -890,
  })
  const withInstructions = (await rendered()).section?.text ?? ''
  assert.match(withInstructions, /Global instructions \(from /)
  assert.ok(withInstructions.includes('Never push without asking.'), withInstructions)
  await including.dispose()
  console.log(`ok ${++steps}: includeInstructions: true carries the AGENTS.md content into the block`)

  // The project mirror: a live session's cwd selects the project root, and
  // `agent/session-start` is emitted before the session's first assembly, so the
  // file the harness reads as workspace instructions already carries the rules.
  const project = join(dir, 'project')
  const nested = join(project, 'packages', 'app')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  writeFileSync(file, 'Always answer in Chinese.', 'utf8')
  writeFileSync(join(project, 'AGENTS.md'), '# House rules\n\nUse tabs.\n', 'utf8')

  const mirroring = await ctx.plugin(globalPrompt, { file, instructionsFile, order: -880 })
  const agent = { session: { header: { cwd: nested } } }
  ctx.emit('agent/session-start', { agent, source: 'startup' })
  const mirrored = readFileSync(join(project, 'AGENTS.md'), 'utf8')
  assert.match(mirrored, /^# House rules/)
  assert.match(mirrored, /<!-- BEGIN dsh-global-system-prompt -->/)
  assert.ok(mirrored.includes('Always answer in Chinese.'), mirrored)
  assert.ok(mirrored.includes(file), mirrored)
  assert.match(mirrored, /<!-- END dsh-global-system-prompt -->\n$/)
  console.log(`ok ${++steps}: agent/session-start mirrors the prompt into the project AGENTS.md`)

  // The per-step re-check is a waterfall listener: it must hand the decision
  // back untouched, and it must repair a block someone removed by hand.
  const decision = { kind: 'accept', messages: [] }
  const returned = await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => decision,
  )
  assert.equal(returned, decision)
  writeFileSync(join(project, 'AGENTS.md'), '# House rules\n\nUse tabs.\n', 'utf8')
  await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
    async () => decision,
  )
  assert.match(readFileSync(join(project, 'AGENTS.md'), 'utf8'), /BEGIN dsh-global-system-prompt/)
  console.log(`ok ${++steps}: the pre-step re-check restores a deleted block and passes the decision through`)

  // An emptied prompt takes its block out of a project file that has content of
  // its own, and leaves that content exactly as it was.
  writeFileSync(file, '', 'utf8')
  ctx.emit('agent/session-start', { agent, source: 'resume' })
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), '# House rules\n\nUse tabs.\n')
  console.log(`ok ${++steps}: an emptied prompt takes only its own block out of a project file`)

  // A file the plugin created holds nothing but the block, so it goes away too.
  const bare = join(dir, 'bare-project')
  mkdirSync(join(bare, '.git'), { recursive: true })
  const bareAgent = { session: { header: { cwd: bare } } }
  writeFileSync(file, 'Always answer in Chinese.', 'utf8')
  ctx.emit('agent/session-start', { agent: bareAgent, source: 'startup' })
  assert.equal(existsSync(join(bare, 'AGENTS.md')), true)
  writeFileSync(file, '', 'utf8')
  ctx.emit('agent/session-start', { agent: bareAgent, source: 'resume' })
  assert.equal(existsSync(join(bare, 'AGENTS.md')), false)
  console.log(`ok ${++steps}: an emptied prompt removes a file the plugin itself created`)
  await mirroring.dispose()

  console.log('dsh-global-system-prompt: end-to-end check passed')
} finally {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}
