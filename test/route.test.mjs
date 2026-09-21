import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { createGlobalPrompt } from '../lib/prompt.js'
import { ROUTE_PATH, createEditorHandler } from '../lib/route.js'

let root
let prompt
let options

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-global-system-prompt-route-'))
  options = normalizeConfig({
    file: join(root, 'prompt.md'),
    instructionsFile: join(root, 'AGENTS.md'),
    text: 'fallback',
  }, {})
  prompt = createGlobalPrompt(options, undefined)
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A response double recording the status, headers, and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
  }
}

/** A request double: a Readable body plus the headers the handler inspects. */
function fakeRequest(method, { headers = {}, body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  request.method = method
  request.headers = headers
  return request
}

const SAME_ORIGIN = { origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }

describe('editor route', () => {
  it('owns a dedicated path', () => {
    assert.equal(ROUTE_PATH, '/global-prompt')
  })

  it('reports the file, the effective payload, and the row placement', async () => {
    writeFileSync(join(root, 'prompt.md'), 'hello', 'utf8')
    const response = fakeResponse()
    await createEditorHandler(prompt, options)(fakeRequest('GET'), response)
    assert.equal(response.status, 200)
    assert.equal(response.headers['cache-control'], 'no-store')
    const payload = JSON.parse(response.body)
    assert.equal(payload.exists, true)
    assert.equal(payload.content, 'hello')
    assert.equal(payload.bytes, 5)
    assert.equal(payload.enabled, true)
    assert.equal(payload.path, join(root, 'prompt.md'))
    assert.equal(payload.fallbackBytes, 'fallback'.length)
    // The announcement is on by default, so the payload carries the footer and
    // the panel can preview exactly what the model reads.
    assert.match(payload.injected, /^hello\n\nHarness file locations/)
    assert.ok(payload.injected.includes(join(root, 'AGENTS.md')), payload.injected)
    assert.equal(payload.injectedBytes, Buffer.byteLength(payload.injected, 'utf8'))
    assert.equal(payload.instructionsPath, join(root, 'AGENTS.md'))
    assert.equal(payload.instructionsExists, false)
    assert.equal(payload.announcePaths, true)
    assert.equal(payload.includeInstructions, false)
  })

  it('replaces the file on a same-origin POST', async () => {
    const response = fakeResponse()
    const raw = '{"a": "{{x}}"}'
    await createEditorHandler(prompt, options)(
      fakeRequest('POST', { headers: SAME_ORIGIN, body: JSON.stringify({ content: raw }) }),
      response,
    )
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.content, raw)
    // The file keeps the raw text; the injected payload is escaped.
    assert.equal(payload.injected.includes('{{'), false)
    assert.ok(payload.injected.startsWith('{"a": "{'), payload.injected)
    assert.equal(payload.injectedBytes, Buffer.byteLength(payload.injected, 'utf8'))
    assert.equal(prompt.effectiveText().includes('{{'), false)
  })

  it('refuses a cross-site or origin-less write', async () => {
    for (const headers of [
      { origin: 'http://evil.example', host: '127.0.0.1:3000' },
      { origin: '::not a url::', host: '127.0.0.1:3000' },
      { host: '127.0.0.1:3000' },
      {},
    ]) {
      const response = fakeResponse()
      await createEditorHandler(prompt, options)(
        fakeRequest('POST', { headers, body: JSON.stringify({ content: 'nope' }) }),
        response,
      )
      assert.equal(response.status, 403)
    }
    assert.equal(prompt.read().content, '{"a": "{{x}}"}')
  })

  it('rejects a body without string content', async () => {
    const response = fakeResponse()
    await createEditorHandler(prompt, options)(
      fakeRequest('POST', { headers: SAME_ORIGIN, body: JSON.stringify({ content: 1 }) }),
      response,
    )
    assert.equal(response.status, 400)
    assert.match(JSON.parse(response.body).error, /content must be a string/)
  })

  it('answers other methods with 405', async () => {
    const response = fakeResponse()
    await createEditorHandler(prompt, options)(fakeRequest('DELETE'), response)
    assert.equal(response.status, 405)
    assert.equal(response.headers.allow, 'GET, POST')
  })

  it('reports the project-AGENTS.md sync and the block it mirrors', async () => {
    writeFileSync(join(root, 'prompt.md'), 'Always answer in Chinese.', 'utf8')
    const recorded = []
    const sync = {
      status: () => ({
        enabled: true,
        fileName: 'AGENTS.md',
        markers: ['.git'],
        fallback: 'cwd',
        targets: [{ path: 'C:\\work\\repo\\AGENTS.md', action: 'created', at: 1 }],
        history: [],
      }),
      syncCwd: (cwd) => recorded.push(cwd),
    }

    const response = fakeResponse()
    await createEditorHandler(prompt, options, sync)(fakeRequest('GET'), response)
    const payload = JSON.parse(response.body)
    assert.equal(payload.projectAgents.enabled, true)
    assert.equal(payload.projectAgents.targets[0].path, 'C:\\work\\repo\\AGENTS.md')
    assert.match(payload.projectAgentsBlock, /^<!-- BEGIN dsh-global-system-prompt -->/)
    assert.ok(payload.projectAgentsBlock.includes('Always answer in Chinese.'))
    assert.equal(recorded.length, 0, 'a panel read never writes into a project')

    // A row that turns the mirror off reports no block to show.
    const off = normalizeConfig({
      file: join(root, 'prompt.md'),
      instructionsFile: join(root, 'AGENTS.md'),
      syncProjectAgents: false,
    }, {})
    const offResponse = fakeResponse()
    await createEditorHandler(prompt, off)(fakeRequest('GET'), offResponse)
    assert.equal(JSON.parse(offResponse.body).projectAgentsBlock, '')
  })
})
