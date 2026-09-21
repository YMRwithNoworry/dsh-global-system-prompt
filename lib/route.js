/**
 * The settings-panel editor route: read and write the global-prompt file over
 * HTTP so the browser half can edit it without filesystem access.
 *
 * A profile without a web server simply never mounts this route; the host
 * plugin's prompt section works either way.
 *
 * @module dsh-global-system-prompt/route
 */

import { MAX_EDITOR_BODY_BYTES } from './config.js'
import { renderProjectBlock } from './project.js'

/** Path this plugin owns on the profile's web server. */
export const ROUTE_PATH = '/global-prompt'

/**
 * Write one JSON response and close the request.
 * @param response - the platform response object.
 * @param status - the HTTP status code.
 * @param payload - the JSON-serializable body.
 */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Whether the request's `Origin` matches its `Host`. A browser always sends
 * both, so a mismatch (or a missing pair) is a cross-site write attempt.
 * @param request - the platform request object.
 * @returns true when the two agree.
 */
export function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Read and parse a JSON request body, capped before it is buffered.
 * @param request - the platform request object.
 * @returns the parsed body.
 */
export async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_EDITOR_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Build the route handler the web server mounts.
 *
 * `GET` reports the file, the payload the model would receive right now, the
 * row's placement, and the project-`AGENTS.md` sync state so the panel can
 * describe what it is editing; `POST` replaces the file.
 * @param prompt - the prompt handle from `createGlobalPrompt`.
 * @param options - normalized options from `normalizeConfig`.
 * @param sync - optional project-`AGENTS.md` sync handle, reported as `projectAgents`.
 * @returns an async (request, response) handler.
 */
export function createEditorHandler(prompt, options, sync) {
  const describe = () => {
    const state = prompt.read()
    const instructions = prompt.readInstructions()
    const injected = prompt.effectiveText()
    const body = options.enabled && options.syncProjectAgents ? prompt.bodyText() : ''
    return {
      path: options.file,
      exists: state.exists,
      content: state.content,
      bytes: state.bytes,
      truncated: state.truncated,
      maxBytes: options.maxBytes,
      // The exact text the section contributes — footer included, so the panel
      // can show what the model actually reads.
      injected,
      injectedBytes: Buffer.byteLength(injected, 'utf8'),
      enabled: options.enabled,
      order: options.order,
      fallbackBytes: Buffer.byteLength(options.text ?? '', 'utf8'),
      announcePaths: options.announcePaths,
      includeInstructions: options.includeInstructions,
      instructionsPath: options.instructionsFile,
      instructionsExists: instructions.exists,
      instructionsBytes: instructions.bytes,
      projectAgents: sync?.status?.(),
      // The block as it lands in a project file: lets the panel show the
      // mirrored text without a round trip through the filesystem.
      projectAgentsBlock: body.trim().length > 0
        ? renderProjectBlock(body, { file: options.file, preamble: options.projectAgentsPreamble })
        : '',
    }
  }

  return async (request, response) => {
    if (request.method === 'GET') {
      try {
        sendJson(response, 200, describe())
      } catch (error) {
        sendJson(response, 500, { error: String(error?.message ?? error) })
      }
      return
    }

    if (request.method === 'POST') {
      if (!sameOrigin(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      try {
        const body = await readJsonBody(request)
        const content = typeof body === 'object' && body !== null ? body.content : undefined
        if (typeof content !== 'string') {
          sendJson(response, 400, { error: 'content must be a string' })
          return
        }
        prompt.write(content)
        sendJson(response, 200, { ok: true, ...describe() })
      } catch (error) {
        sendJson(response, 500, { error: String(error?.message ?? error) })
      }
      return
    }

    response.writeHead(405, { allow: 'GET, POST' })
    response.end()
  }
}
