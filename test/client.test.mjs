import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The loader keys the browser bundle by package name, so the expected id is read
 * from the manifest rather than hardcoded: renaming the package (see
 * `dev/rename-package.mjs`) must not silently break this contract.
 */
const PACKAGE_NAME = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).name

/**
 * A React stub: enough of the API for the panel component's render.
 * @param seeded - hook states returned in call order (the component's
 * `useState` calls), so a test can describe the "document arrived" render.
 */
function stubReact(seeded = []) {
  let cursor = 0
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => {
      const value = cursor < seeded.length ? seeded[cursor] : (typeof initial === 'function' ? initial() : initial)
      cursor += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (callback) => callback,
  }
}

/**
 * Load the browser bundle the way the web shell does: install the
 * `__ModuleLoader__` sink, import the file, then run its factory.
 *
 * The bundle is an ES module, so it is imported exactly once for the whole
 * test file (a second import would be served from the module cache and would
 * not register again); the factory is re-run per call, which is what the
 * loader does per player anyway.
 */
let registrationPromise

function clientRegistration() {
  registrationPromise ??= (async () => {
    const registrations = []
    globalThis.window = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }
    try {
      await import('../lib/client.js')
    } finally {
      delete globalThis.window
    }
    assert.equal(registrations.length, 1)
    return registrations[0]
  })()
  return registrationPromise
}

async function loadClientBundle(seeded) {
  const registration = await clientRegistration()
  return {
    registration,
    exports: registration.factory((id) => {
      if (id === 'react') return stubReact(seeded)
      throw new Error(`unexpected require(${JSON.stringify(id)})`)
    }),
  }
}

/** Depth-first walk of the stub element tree. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

describe('client bundle', () => {
  it('registers itself under the package name the loader expects', async () => {
    const { registration } = await loadClientBundle()
    assert.equal(registration.id, PACKAGE_NAME)
    assert.equal(typeof registration.factory, 'function')
  })

  it('declares the slots service and exports the plugin shape', async () => {
    const { exports: plugin } = await loadClientBundle()
    assert.equal(plugin.name, 'global-prompt')
    assert.deepEqual(plugin.inject, ['slots'])
    assert.equal(typeof plugin.apply, 'function')
  })

  it('registers the settings section once the slot exists', async () => {
    const { exports: plugin } = await loadClientBundle()
    const waits = []
    plugin.apply({
      slots: {
        inject: (name, callback) => { waits.push({ name, callback }) },
        register: (options, component) => { waits.push({ options, component }) },
      },
    })
    assert.deepEqual(waits.map(({ name }) => name), ['settings.section'])

    waits[0].callback()
    const [{ options, component }] = waits.slice(1)
    assert.equal(options.name, 'settings.section')
    assert.equal(options.id, 'global-prompt')
    assert.equal(options.order, 40)
    assert.equal(options.label(), '全局提示词')
    assert.equal(typeof component, 'function')
  })

  /**
   * Register the section and return a function that renders the panel the way
   * React would: the slot stores an element factory, so the first call produces
   * `<GlobalPromptSection />` and the second invokes that function component.
   */
  async function panel(seeded) {
    const { exports: plugin } = await loadClientBundle(seeded)
    const registered = []
    plugin.apply({
      slots: {
        inject: (_name, callback) => { callback() },
        register: (options, component) => { registered.push({ options, component }) },
      },
    })
    return () => {
      const element = registered[0].component()
      return typeof element.type === 'function' ? element.type(element.props ?? {}) : element
    }
  }

  /** Every primitive tag and its text content in one render. */
  function inspect(tree) {
    const tags = []
    const text = []
    walk(tree, (node) => {
      if (typeof node.type !== 'string') return
      tags.push(node.type)
      const label = (node.children ?? []).filter((child) => typeof child === 'string').join('')
      if (label.length > 0) text.push(label)
    })
    return { tags, text }
  }

  it('renders the loading state before the file arrives', async () => {
    const render = await panel()
    const { tags, text } = inspect(render())
    assert.ok(tags.includes('p'))
    assert.ok(text.includes('加载中…'), text.join(' / '))
    assert.equal(tags.includes('textarea'), false)
  })

  it('renders the editor with the file, its path, and both actions once loaded', async () => {
    const content = '# 全局提示词\n始终用中文回答。'
    const meta = {
      path: 'C:/Users/me/.dsh/global-prompt.md',
      order: -900,
      enabled: true,
      exists: true,
      truncated: false,
      injectedBytes: Buffer.byteLength(content, 'utf8'),
      fallbackBytes: 0,
    }
    const render = await panel([content, content, meta, true, false, { kind: 'idle', text: '' }])
    const tree = render()
    const { tags, text } = inspect(tree)

    assert.ok(tags.includes('textarea'), `expected a textarea, got ${tags.join(', ')}`)
    const textarea = []
    walk(tree, (node) => { if (node.type === 'textarea') textarea.push(node.props) })
    assert.equal(textarea[0].value, content)
    assert.ok(text.some((line) => line.includes(meta.path)), text.join(' / '))
    assert.ok(text.includes('保存'), text.join(' / '))
    assert.ok(text.includes('重新读取'), text.join(' / '))
    // Not dirty yet, so no unsaved badge and the save button is disabled.
    assert.equal(text.includes('有未保存的修改'), false)
  })

  it('names the user-global instruction file and previews the injected text', async () => {
    const content = 'Be terse.'
    const injected = `${content}\n\nHarness file locations (exact paths — read or edit these directly instead of searching for them):\n`
      + '- global prompt (injected by the dsh-global-system-prompt plugin): C:/Users/me/.dsh/global-prompt.md\n'
      + '- user-global instructions (the "AGENTS.md" the runtime context mentions): C:/Users/me/.dsh/AGENTS.md'
    const meta = {
      path: 'C:/Users/me/.dsh/global-prompt.md',
      order: -900,
      enabled: true,
      exists: true,
      truncated: false,
      injected,
      injectedBytes: Buffer.byteLength(injected, 'utf8'),
      fallbackBytes: 0,
      announcePaths: true,
      includeInstructions: false,
      instructionsPath: 'C:/Users/me/.dsh/AGENTS.md',
      instructionsExists: true,
      instructionsBytes: 4200,
    }
    const render = await panel([content, content, meta, true, false, { kind: 'idle', text: '' }])
    const { tags, text } = inspect(render())

    assert.ok(text.some((line) => line.includes('全局指令文件') && line.includes(meta.instructionsPath)), text.join(' / '))
    assert.ok(text.some((line) => line.includes('已存在') && line.includes('4.1 kB')), text.join(' / '))
    // The panel tells the user why the path is injected…
    assert.ok(text.some((line) => line.includes('模型不用再去猜')), text.join(' / '))
    // …and shows the exact text the model receives.
    assert.ok(tags.includes('details'), tags.join(', '))
    assert.ok(tags.includes('pre'), tags.join(', '))
    assert.ok(text.some((line) => line === injected), text.join(' / '))
  })

  it('reports the project AGENTS.md sync and previews the mirrored block', async () => {
    const content = 'Be terse.'
    const block = `<!-- 管理区块 -->\n${content}`
    const meta = {
      path: 'C:/Users/me/.dsh/global-prompt.md',
      order: -900,
      enabled: true,
      exists: true,
      truncated: false,
      injected: content,
      injectedBytes: Buffer.byteLength(content, 'utf8'),
      fallbackBytes: 0,
      projectAgents: {
        enabled: true,
        fileName: 'AGENTS.md',
        markers: ['.git'],
        fallback: 'cwd',
        targets: [{ path: 'D:\\code\\repo\\AGENTS.md', action: 'created', at: 1 }],
        history: [],
      },
      projectAgentsBlock: block,
    }
    const render = await panel([content, content, meta, true, false, { kind: 'idle', text: '' }])
    const { text } = inspect(render())

    assert.ok(
      text.some((line) => line.includes('项目 AGENTS.md') && line.includes('D:\\code\\repo\\AGENTS.md') && line.includes('已创建')),
      text.join(' / '),
    )
    assert.ok(text.some((line) => line.includes('向上找 .git')), text.join(' / '))
    assert.ok(text.some((line) => line === block), text.join(' / '))
  })

  it('stays quiet about the project sync when the row turns it off', async () => {
    const meta = {
      path: 'C:/Users/me/.dsh/global-prompt.md',
      order: -900,
      enabled: true,
      exists: true,
      truncated: false,
      injected: 'Be terse.',
      injectedBytes: 9,
      fallbackBytes: 0,
      projectAgents: { enabled: false, fileName: 'AGENTS.md', markers: ['.git'], fallback: 'cwd', targets: [], history: [] },
      projectAgentsBlock: '',
    }
    const render = await panel(['Be terse.', 'Be terse.', meta, true, false, { kind: 'idle', text: '' }])
    const { text } = inspect(render())
    assert.equal(text.some((line) => line.includes('项目 AGENTS.md')), false, text.join(' / '))
  })
})
