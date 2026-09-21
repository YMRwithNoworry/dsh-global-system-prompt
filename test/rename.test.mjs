import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { ROOT, nameBearingFiles, readPackageName, renamePackage, validatePackageName } from '../dev/rename-package.mjs'

const current = readPackageName()

/** Relative paths use the platform separator; compare them slash-normalized. */
function posix(path) {
  return path.split('\\').join('/')
}

describe('validatePackageName', () => {
  it('accepts npm-legal names, scoped or not', () => {
    assert.equal(validatePackageName('dsh-global-system-prompt'), 'dsh-global-system-prompt')
    assert.equal(validatePackageName('@you/dsh-global-system-prompt'), '@you/dsh-global-system-prompt')
    assert.equal(validatePackageName('  spaced-name  '), 'spaced-name')
    assert.equal(validatePackageName('with.dots_underscores~tildes'), 'with.dots_underscores~tildes')
  })

  it('rejects names npm would refuse', () => {
    const bad = ['', '   ', 'Uppercase', '@scope', '@scope/', 'name with space', '-leading', '.dot', '../escape', 'a'.repeat(215)]
    for (const candidate of bad) {
      assert.throws(() => validatePackageName(candidate), /rename-package:/, `expected ${JSON.stringify(candidate)} to be rejected`)
    }
  })
})

describe('nameBearingFiles', () => {
  it('covers the manifest, the patch layer, the docs, and every module', () => {
    const files = nameBearingFiles().map(file => posix(relative(ROOT, file)))
    for (const required of ['package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'lib/index.js', 'lib/client.js']) {
      assert.ok(files.includes(required), `missing ${required} in ${files.join(', ')}`)
    }
    assert.ok(files.some(file => file.startsWith('dev/')), 'the e2e script imports the package by name')
    assert.ok(files.every(file => !file.includes('node_modules')))
  })
})

/** A miniature package root in the same shape as this one. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rename-'))
  mkdirSync(join(root, 'lib'))
  mkdirSync(join(root, 'examples'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'old-name', files: ['lib'] }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, 'cordis.patch.yml'), "- insert:\n    - id: x\n      name: 'old-name'\n", 'utf8')
  writeFileSync(join(root, 'lib', 'client.js'), 'window.__ModuleLoader__.load({ id: "old-name", factory: () => {} });\n', 'utf8')
  writeFileSync(join(root, 'lib', 'index.js'), "export const name = 'global-prompt'\nexport const SECTION_NAME = 'user:global-prompt'\n", 'utf8')
  writeFileSync(join(root, 'README.md'), 'install: dsh plugin --profile web add old-name\n', 'utf8')
  return root
}

describe('renamePackage', () => {
  it('reports nothing for a token no file carries', () => {
    const root = fixture()
    try {
      assert.deepEqual(renamePackage({ root, from: 'a-name-nothing-carries', to: 'whatever' }), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rewrites every carrier and leaves the Cordis plugin and section names alone', () => {
    const root = fixture()
    try {
      const hits = renamePackage({ root, from: 'old-name', to: '@you/new-name' })
      assert.deepEqual(hits.map(hit => posix(hit.file)).sort(), ['README.md', 'cordis.patch.yml', 'lib/client.js', 'package.json'])
      assert.equal(readPackageName(root), '@you/new-name')
      assert.equal(readFileSync(join(root, 'lib', 'client.js'), 'utf8').includes('id: "@you/new-name"'), true)
      assert.equal(readFileSync(join(root, 'README.md'), 'utf8').includes('add @you/new-name'), true)
      // Identity that must NOT move with the package name.
      const index = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
      assert.match(index, /export const name = 'global-prompt'/)
      assert.match(index, /'user:global-prompt'/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('dry-run reports the same carriers and writes nothing', () => {
    const root = fixture()
    try {
      const hits = renamePackage({ root, from: 'old-name', to: '@you/new-name', dryRun: true })
      assert.ok(hits.length > 0)
      assert.equal(readPackageName(root), 'old-name')
      assert.equal(readFileSync(join(root, 'lib', 'index.js'), 'utf8').includes('old-name'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('this package', () => {
  it('carries its name in the files the rename tool would rewrite', () => {
    const hits = renamePackage({ from: current, to: 'dry-run-only', dryRun: true })
    const files = hits.map(hit => posix(hit.file))
    for (const required of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'README.md', 'README.en.md']) {
      assert.ok(files.includes(required), `${required} should carry ${current}`)
    }
    assert.equal(hits.reduce((sum, hit) => sum + hit.occurrences, 0) > 0, true)
  })
})
