import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { createGlobalPrompt } from '../lib/prompt.js'
import { createEditorHandler } from '../lib/route.js'

const root = mkdtempSync(join(tmpdir(), 'gsp-desktop-'))
const options = normalizeConfig({ file: join(root, 'prompt.md'), instructionsFile: join(root, 'AGENTS.md') }, {})
const prompt = createGlobalPrompt(options, undefined)
const server = createServer(createEditorHandler(prompt, options))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + String(server.address().port)

const post = (headers, content) => fetch(base + '/global-prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ content }),
})

// 1. the desktop shell's relay: no Origin at all
let response = await post({}, 'from-desktop-relay')
console.log('relay (no Origin)          ->', response.status, JSON.stringify(readFileSync(join(root, 'prompt.md'), 'utf8')))
// 2. the desktop page talking to the host origin directly
response = await post({ origin: 'dsh-app://app' }, 'from-dsh-app-page')
console.log('Origin: dsh-app://app      ->', response.status, JSON.stringify(readFileSync(join(root, 'prompt.md'), 'utf8')))
// 3. a cross-site page is still refused
response = await post({ origin: 'https://evil.example' }, 'from-evil')
console.log('Origin: https://evil.example ->', response.status, JSON.stringify(readFileSync(join(root, 'prompt.md'), 'utf8')))
// 4. same-origin browser save still works
response = await post({ origin: base }, 'from-web-panel')
console.log('Origin: ' + base + ' ->', response.status, JSON.stringify(readFileSync(join(root, 'prompt.md'), 'utf8')))
// 5. GET (what the panel loads on open) still works
response = await fetch(base + '/global-prompt')
console.log('GET                        ->', response.status, (await response.json()).content)

server.close()
rmSync(root, { recursive: true, force: true })
