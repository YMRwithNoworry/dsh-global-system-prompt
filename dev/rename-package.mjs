/**
 * Rename this plugin package everywhere its name is part of its identity.
 *
 * A dsh bundle's package name appears in four load-bearing places, and a
 * mismatch is silent in three of them — the host row resolves by the specifier,
 * the browser bundle is dropped unless `__ModuleLoader__.load({ id })` equals
 * the package name, and diagnostics lie if the prefix is stale. This script
 * rewrites all of them (plus the docs and test expectations) in one pass.
 *
 * Usage:
 *
 *   node dev/rename-package.mjs                     # show the current name and every file that carries it
 *   node dev/rename-package.mjs @you/plugin-name     # rewrite in place
 *   node dev/rename-package.mjs @you/plugin-name --dry-run
 *
 * It does NOT touch the directory name, git history, or anything outside this
 * package root.
 *
 * @module dsh-global-system-prompt/dev/rename-package
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package root (this file lives in `<root>/dev/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories scanned for name occurrences, relative to the root. */
const SCANNED_DIRECTORIES = ['lib', 'test', 'dev', 'examples']

/** Files scanned for name occurrences, relative to the root. */
const SCANNED_FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']

/** Exact npm package-name grammar, as published by name-validator. */
const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/**
 * Validate one candidate package name.
 * @param name - the candidate.
 * @returns the trimmed name.
 * @throws when the name cannot be published to npm.
 */
export function validatePackageName(name) {
  const candidate = typeof name === 'string' ? name.trim() : ''
  if (candidate.length === 0) throw new Error('rename-package: a new package name is required')
  if (candidate.length > 214) throw new Error('rename-package: npm names are limited to 214 characters')
  const [first, second] = candidate.split('/')
  const bare = second ?? first
  if (!PACKAGE_NAME.test(candidate) || /^[._-]/.test(bare)) {
    throw new Error(`rename-package: ${JSON.stringify(candidate)} is not a valid npm package name `
      + '(lowercase letters, digits, and -._~, not starting with - . or _, optionally behind one @scope/)')
  }
  return candidate
}

/**
 * Read the package's current name.
 * @param root - the package root.
 * @returns the `name` field.
 */
export function readPackageName(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
}

/**
 * List every file that may carry the name: the manifest, the patch, the docs,
 * and every module under the scanned directories.
 * @param root - the package root.
 * @returns absolute paths, sorted for a stable report.
 */
export function nameBearingFiles(root = ROOT) {
  const files = SCANNED_FILES.map(file => join(root, file)).filter(existsSync)
  for (const directory of SCANNED_DIRECTORIES) {
    const absolute = join(root, directory)
    if (!existsSync(absolute)) continue
    for (const entry of readdirSync(absolute)) {
      if (/\.(?:js|mjs|cjs|md|yml|yaml)$/.test(entry)) files.push(join(absolute, entry))
    }
  }
  return files.sort()
}

/**
 * Rewrite every occurrence of `from` into `to` across the name-bearing files.
 *
 * The replaced token is the full package name, never the Cordis plugin name or
 * the prompt-section name, so a rename cannot break `name`/`inject`/`apply` or
 * the section identity.
 * @param options - `root`, `from`, `to`, and `dryRun`.
 * @returns one `{ file, occurrences }` row per file that changed.
 */
export function renamePackage({ root = ROOT, from, to, dryRun = false }) {
  const hits = []
  for (const file of nameBearingFiles(root)) {
    const before = readFileSync(file, 'utf8')
    const occurrences = before.split(from).length - 1
    if (occurrences === 0) continue
    if (!dryRun) writeFileSync(file, before.replaceAll(from, to), 'utf8')
    hits.push({ file: relative(root, file), occurrences })
  }
  return hits
}

/** Run the CLI. */
function main(argv) {
  const dryRun = argv.includes('--dry-run')
  const [requested] = argv.filter(argument => argument !== '--dry-run')
  const current = readPackageName()

  if (requested === undefined) {
    const files = nameBearingFiles()
    const carrying = files.filter(file => readFileSync(file, 'utf8').includes(current))
    console.log(`current name: ${current}`)
    console.log(`carried by ${carrying.length} file(s):`)
    for (const file of carrying) console.log(`  ${relative(ROOT, file)}`)
    console.log('\nusage: node dev/rename-package.mjs <new-name> [--dry-run]')
    return
  }

  const next = validatePackageName(requested)
  if (next === current) {
    console.log(`rename-package: already named ${current}; nothing to do`)
    return
  }
  const hits = renamePackage({ from: current, to: next, dryRun })
  if (hits.length === 0) {
    console.error(`rename-package: ${current} appears in no scanned file — refusing to pretend this worked`)
    process.exitCode = 1
    return
  }
  const total = hits.reduce((sum, hit) => sum + hit.occurrences, 0)
  console.log(`${dryRun ? 'would rename' : 'renamed'} ${current} -> ${next} (${total} occurrence(s))`)
  for (const hit of hits) console.log(`  ${hit.file}: ${hit.occurrences}`)
  if (dryRun) return
  console.log('\nnext steps:')
  console.log(`  1. node --test test/`)
  console.log(`  2. dsh plugin --profile <name> remove ${current}`)
  console.log(`  3. dsh plugin --profile <name> add file:${ROOT}`)
  console.log('  4. restart dsh, then check 设置 -> 全局提示词')
}

/* v8 ignore next 3 -- only runs as a program, never when imported by a test */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
