# dsh-global-system-prompt

English | [中文](README.md)

[![npm version](https://img.shields.io/npm/v/dsh-global-system-prompt)](https://www.npmjs.com/package/dsh-global-system-prompt)
[![license](https://img.shields.io/npm/l/dsh-global-system-prompt)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da)](https://github.com/topics/dsh-plugin)

## Summary

`dsh-global-system-prompt` brings cc-switch's "global prompt" to DeepSeek Harness: one block of text you write yourself, carried by **every conversation**, edited right in the web settings panel, and live from the next turn on.

It works through two channels: the text is registered as its own **system-prompt section** and, **at the same time**, mirrored into the `AGENTS.md` of the project the session runs in. The system-prompt channel means dsh carries it every turn; the `AGENTS.md` channel means other tools (Claude Code, Codex, Cursor, Zed, …) and later sessions carry it too, and that it travels with the repository:

- **It is the system prompt.** The block sits at a configurable position — by default `order: -900`, immediately after the harness identity line and before the deployment persona.
- **Every scope gets it.** Root sessions, preset-mounted agents, and in-process subagents all assemble it. (Out-of-process children — Codex / Claude Code subagent providers — run their own harness with their own prompt and are unaffected.)
- **Presets cannot shadow it.** The section is named `user:global-prompt`, a name this plugin owns; a preset's persona only replaces `deployment:persona-prefix`.
- **Edits apply immediately.** The text provider re-reads the file on every assembly, so a save reaches the next request with no restart.
- **Fixed cost.** Unchanged content keeps the provider prefix cache; a change (or a clear) touches only this block.
- **It tells the model where the global files are.** The block ends with a file-location footer naming both files by **absolute path**. The runtime context the harness injects mentions the user-global instructions only as a bare "AGENTS.md" and gives no path, which sends the model hunting through the home directory; this footer is what stops that.
- **It also mirrors into the project.** At session start a marker-delimited managed block is maintained in the `AGENTS.md` at the project root, carrying exactly the same body as the system-prompt section ([see below](#sync-into-the-projects-agentsmd)). Not a single byte outside the block is touched.

```text
Harness file locations (exact paths — read or edit these directly instead of searching for them):
- global prompt (injected by the dsh-global-system-prompt plugin): C:\Users\me\.dsh\global-prompt.md
- user-global instructions (the "AGENTS.md" the runtime context mentions): C:\Users\me\.dsh\AGENTS.md
```

So neither the model nor you has to guess which "global AGENTS.md" is meant: read or edit those exact paths. Turn it off with `announcePaths: false`, or replace the wording with `pathsNote`.

The two channels switch off separately: `enabled: false` stops the whole row, `syncProjectAgents: false` stops only the project's `AGENTS.md` (the system prompt carries on), and `announcePaths: false` drops only the file-location footer.

## Table of contents

- [Install](#install)
- [Use](#use)
- [Sync into the project's AGENTS.md](#sync-into-the-projects-agentsmd)
- [Configuration](#configuration)
- [Relationship to AGENTS.md / dsh-global-rules](#relationship-to-agentsmd--dsh-global-rules)
- [Implementation](#implementation)
- [Development](#development)

-----

<a id="install"></a>
## Install

From npm (the published path):

```powershell
# the profile that serves the web UI
dsh plugin --profile web add dsh-global-system-prompt

# the TUI profile works too (no web server: injection and project sync only)
dsh plugin --profile dsh-tui add dsh-global-system-prompt
```

Straight from GitHub (to track the repository, or to pin a commit):

```powershell
dsh plugin --profile web add github:YMRwithNoworry/dsh-global-system-prompt

# pin a commit by appending #<commit-sha> to the repo
dsh plugin --profile web add github:YMRwithNoworry/dsh-global-system-prompt#<commit-sha>
```

From a local checkout (development):

```powershell
# copied into the profile: rebuild the install after editing the source
dsh plugin --profile web add file:<checkout-path>

# or linked: edit the source and just restart dsh
dsh plugin --profile web add link:<checkout-path>
```

> The package is named `dsh-global-system-prompt`. An unrelated third-party package called `dsh-global-prompt` also exists on npm — don't mix them up.

`dsh plugin add` records the package as a profile dependency and appends any package declaring `dsh.bundle` to `dsh.profile.bundles`. **Adding a bundle is a startup boundary**, so restart dsh once; prompt edits never need a restart afterwards.

Verify the composed layer without booting:

```powershell
dsh --profile web --dump-config | Select-String -Context 0,8 'global-system-prompt'
```

<a id="use"></a>
## Use

Open Settings → **全局提示词 (Global prompt)**, write the text, save.

- A save applies to the **next request**; the turn already in flight is unchanged.
- The file is `~/.dsh/global-prompt.md` (`$DSH_HOME/global-prompt.md`) by default and can be edited with any editor — the panel's *reload* button re-reads it.
- An **existing but empty file injects nothing**, which is how you silence the prompt temporarily; delete the file and the row's `text` fallback takes over (empty by default).
- The panel shows the path, the section order, and the bytes actually injected; content beyond `maxBytes` (64 KiB by default) is not injected and the panel says so.
- The panel's bottom section has two status lines for the project `AGENTS.md`: which projects this process has synced, the latest action (created / updated / already current / removed / skipped / failed), and a preview of the block written into projects.

<a id="sync-into-the-projects-agentsmd"></a>
## Sync into the project's AGENTS.md

The system prompt reaches dsh only. The same repository is likely opened with other tools, and those read the project's `AGENTS.md`; switch tools, switch terminals, hand the repo to a teammate, and the rules are gone. So the plugin writes the same prompt **also** into the `AGENTS.md` of the project the session runs in: written once, every tool in that project reads it, and it travels with git.

```markdown
<!-- BEGIN dsh-global-system-prompt -->
<!--
  Managed by the dsh-global-system-prompt plugin. The rules below are synced from:
  C:\Users\me\.dsh\global-prompt.md
  Edits inside this block are overwritten on the next sync; delete the block,
  markers included, to stop syncing.
-->

Global rules — follow these in every task in this project:

(the global prompt text goes here)

<!-- END dsh-global-system-prompt -->
```

| Question | Behavior |
|---|---|
| Which file | Walk up from the session working directory to the first directory containing `.git` and treat it as the project root, then write its `AGENTS.md`; if no marker turns up all the way to the drive root, fall back to the session working directory itself (`projectAgentsFallback: 'skip'` changes that to "no marker, no write") |
| File does not exist | Created automatically, missing directories included |
| Content from someone else already there | Kept as it is, with the block appended at the end; not a byte outside the block is touched |
| When it writes | Once at session start (`agent/session-start` — the harness guarantees it fires before the first prompt assembly, so the very first step already sees the file), then re-checked every step (one `stat` while the content is unchanged) |
| Prompt edited | The next re-check swaps in the new text; no restart |
| Block deleted by hand or eaten by a merge conflict | Written back on the next step; to stop for good, delete the block and set `syncProjectAgents: false` |
| Prompt emptied | The block is removed; if that `AGENTS.md` held nothing but this block (i.e. the plugin created it), the file itself is deleted too |
| Cannot write | A file over 1 MiB, half a marker pair (hand-mangled), or a read/write error — each only logs one warning and leaves the file as it was, the system prompt keeps injecting, and the turn is not interrupted |

A few notes:

- **Instructional**: the `Global rules — follow these in every task in this project:` line at the top of the block is controlled by `projectAgentsPreamble`, so it can be written in your own words, e.g. `projectAgentsPreamble: 'Project rules — every task in this repo must follow them:'`; `''` keeps only the body. The body that lands in `AGENTS.md` is the **unescaped** text (`escapeBraces` applies only to the system-prompt channel), so JSON, `{{placeholder}}`, and the like appear in the project file exactly as written.
- **It appears twice**: inside a dsh session the same rules show up twice — once in the system prompt, once as the workspace instructions injected from `AGENTS.md` (`dsh-agent-instructions` reads it at the first assembly, then re-projects it on file changes). This is deliberate: the first is dsh's live channel, the second is the cross-tool channel. To leave no trace in projects, set `syncProjectAgents: false`.
- **It never touches the user's global file**: `$DSH_HOME/AGENTS.md` is the territory of dsh itself and of dsh-global-rules; the plugin only announces its location and never writes it. Should the project root ever resolve to it, the plugin skips it and logs a warning.
- **Writes are atomic**: a staged temp file in the same directory is renamed into place, so a harness reading `AGENTS.md` never sees a half-written file, and multiple dsh processes cannot truncate each other.

<a id="configuration"></a>
## Configuration

```yaml
- id: global-prompt
  config:
    enabled: true
    # file: ~/.dsh/global-prompt.md       # default $DSH_HOME/global-prompt.md
    order: -900
    text: ''
    maxBytes: 65536
    escapeBraces: true
    announcePaths: true
    # instructionsFile: ~/.dsh/AGENTS.md  # default $DSH_HOME/AGENTS.md; '' to omit it
    includeInstructions: false
    pathsNote: ''
    syncProjectAgents: true
    # projectAgentsFileName: AGENTS.md    # the file written at the project root; bare filename only
    # projectRootMarkers: ['.git']        # markers used when walking up to the project root
    # projectAgentsFallback: cwd          # no marker found: cwd writes the session directory itself / skip writes nothing
    # projectAgentsPreamble: 'Global rules — follow these in every task in this project:'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` registers no section and writes no project `AGENTS.md` (the editor route stays up so you can write first) |
| `file` | `$DSH_HOME/global-prompt.md` | Prompt file; a relative path resolves against the process working directory |
| `order` | `-900` | Section position: `-1000` harness identity, `0` deployment persona prefix, `500` plan policy |
| `text` | `''` | Fallback used only while the file does not exist |
| `maxBytes` | `65536` | UTF-8 byte cap for the injected block; longer content is truncated |
| `escapeBraces` | `true` | Neutralize literal `{{` (see below); only the system-prompt channel is affected |
| `announcePaths` | `true` | Append the file-location footer naming both paths, so the model never searches for them |
| `instructionsFile` | `$DSH_HOME/AGENTS.md` | The harness's own user-global instruction file; named in the footer. `''` drops it entirely |
| `includeInstructions` | `false` | Also carry that file's content in this block. Off by default because `dsh-agent-instructions` already injects it as context in every base-backed profile; turn it on for compositions that do not mount that plugin (e.g. a hand-built sdk-minimal) |
| `pathsNote` | `''` | Replace the generated footer with your own text (verbatim, no placeholders) |
| `syncProjectAgents` | `true` | Mirror the prompt into the session project's `AGENTS.md` ([see above](#sync-into-the-projects-agentsmd)). `false` leaves only the system-prompt channel |
| `projectAgentsFileName` | `AGENTS.md` | Name of the project file; a bare filename only (point it at `CLAUDE.md` if you like) |
| `projectRootMarkers` | `['.git']` | Marker names used when walking up to the project root; a file or a directory counts |
| `projectAgentsFallback` | `cwd` | When no marker is found on the way up: `cwd` uses the session working directory itself, `skip` writes nothing |
| `projectAgentsPreamble` | `Global rules — follow these in every task in this project:` | The instruction line at the top of the block, written verbatim; `''` keeps only the body |

Override a field by id in the profile's `~/.dsh/profiles/<name>/cordis.patch.yml` — a patch **replaces the whole `config`**, so restate every field.

```yaml
- id: global-prompt
  config:
    enabled: true
    order: -1100        # before the identity line
    file: ~/.dsh/my-global-prompt.md
    text: ''
    maxBytes: 65536
    escapeBraces: true
    syncProjectAgents: true
    projectAgentsPreamble: 'Project rules — every task in this repo must follow them:'
```

### `escapeBraces`

Prompt sections interpolate `{{name}}` strictly: an unregistered name throws and breaks the turn, and there is no escape syntax. With the default `escapeBraces: true` the plugin inserts a zero-width space inside every `{{` — invisible to the model and the reader — so literal template syntax in your prompt (JSON, `{{placeholder}}`, …) can never be misread as a variable reference. Set it to `false` only when you want the text injected verbatim.

<a id="relationship-to-agentsmd--dsh-global-rules"></a>
## Relationship to AGENTS.md / dsh-global-rules

The built-in `dsh-agent-instructions` already injects `~/.dsh/AGENTS.md` into every conversation — as **durable user-message context**, not as the system prompt — and `dsh-global-rules` is the settings-panel editor for that file. This plugin is the other channel:

| | `~/.dsh/AGENTS.md` (built-in + dsh-global-rules) | This plugin |
|---|---|---|
| Injected as | user message (runtime context) | system-prompt section |
| Position | durable message before the first request | `order: -900`, right after the identity line |
| Takes effect | immediately in new sessions; the live one waits for a re-projection | next step, no restart |
| Compaction | reconciled through message history | re-rendered every step |
| Edited in | 「全局规则」 | 「全局提示词」 |
| Tells the model where the file is | only "AGENTS.md exists", no path | the exact absolute paths (`announcePaths`) |

Both can coexist; the section names differ. Either one alone is also fine.

The project-level `AGENTS.md` is a third channel, and the only cross-tool one: it is the workspace-instruction source for `dsh-agent-instructions` (read from the project root down to the cwd, recognizing both `AGENTS.md` and `CLAUDE.md`), and other AI tools follow the same convention. `syncProjectAgents` writes the prompt into a managed block in that file — so inside dsh the rules appear twice (system prompt + workspace instructions), while other tools pick them up all the same.

> Why the footer exists: the harness's runtime note reads
> `A user-global instruction file exists: AGENTS.md. Do NOT assume their content.` —
> a name with no path. The model then guesses `~/AGENTS.md`, `.agents/AGENTS.md`, the
> workspace root, … `announcePaths` simply puts the two real paths into the system prompt.

<a id="implementation"></a>
## Implementation

```
dsh-global-system-prompt/
├── package.json          # dsh.bundle.patch + dsh.client (web)
├── cordis.patch.yml      # inserts the global-prompt row
├── lib/
│   ├── index.js          # Cordis plugin: prompt section + webServer route + session lifecycle hooks
│   ├── config.js         # config validation, harness-home resolution
│   ├── prompt.js         # cached read, byte cap, `{{` neutralization, atomic write
│   ├── project.js        # project AGENTS.md: root discovery, managed-block upsert, per-step re-check
│   ├── route.js          # GET/POST /global-prompt (same-origin, body cap)
│   └── client.js         # browser __ModuleLoader__ bundle (no build step)
├── dev/
│   └── e2e-installed.mjs # end-to-end check against an installed dsh
├── test/                 # node --test
└── examples/
```

Notable decisions:

- The section is registered as `ctx.systemPrompt.section({ name: 'user:global-prompt', order, text })` with `text` as a function, which is what makes edits live. The name must be unique — `deployment:persona-prefix` is owned by the registry itself and a duplicate registration throws.
- The plugin's top-level `inject` lists only `systemPrompt`; `webServer` is awaited through `ctx.inject(['webServer'], …)` inside `apply`. A declared-but-absent service would leave the whole plugin pending and nothing would ever be injected into a profile without a web server. The session lifecycle (`agent/session-start`, `agent/pre-step`) is delivered as events rather than services, so `ctx.on` wires it directly and no `inject` entry is needed.
- Reading failures degrade to the row's fallback text and one warning; the provider never throws into the assembly. `project.js` behaves the same way — any exception is swallowed into a warning plus a status record.
- The file-location footer (`pathsNote()` in `prompt.js`) `stat`s both files through the same mtime cache, so "exists / not created yet" is live state.
- Project sync timing: `agent/session-start` is the synchronous notification the harness guarantees before the first prompt assembly (`agent.session.header.cwd` is ready by then), so the very first step already sees the written `AGENTS.md`; `agent/pre-step` is a waterfall, and the plugin only re-checks after `await next()`, never altering the `PreStepDecision`. In steady state a re-check costs one `statSync` (it remembers the block it wrote plus the file's mtime/size) and only reads the file when that does not match.
- It writes only between the markers: `upsertManagedBlock` matches markers rather than positions, so it can replace the block anywhere in the file, collapse duplicate blocks into one, and preserve CRLF and BOM; when only half a marker pair is left (a hand-broken file) it **refuses to write** and logs a warning — better out of sync than eating the user's content.
- The panel route validates same-origin POSTs and writes atomically (staged file + rename); its `GET` payload also carries the exact injected text so the panel can preview what the model reads, plus the project sync status and the block text about to be written into a project file.

<a id="development"></a>
## Development

```powershell
cd <checkout-path>
node --test test/          # 111 cases
node --check lib/client.js # client bundle syntax check
```

Reinstall after a source change:

```powershell
dsh plugin --profile web add file:<checkout-path>
# or link it once and just restart dsh after each edit
dsh plugin --profile web add link:<checkout-path>
```

### Renaming the package or publishing to your own scope

The name lives in four load-bearing places (`package.json`, the `cordis.patch.yml` row `name`, the `__ModuleLoader__.load({ id })` in `lib/client.js`, and the log/diagnostic prefix). Missing one is silent, so the rename goes through the bundled tool:

```powershell
node dev/rename-package.mjs                                    # which files carry the current name
node dev/rename-package.mjs @you/dsh-global-system-prompt       # rewrite (add --dry-run to preview)
node --test test/
```

It replaces only the whole package name, never the Cordis plugin name (`global-prompt`) or the section name (`user:global-prompt`) — those are runtime identity, independent of the package.

Publish:

```powershell
npm login      # your own credentials
npm publish    # publishConfig.access is already public (required for scoped packages)
```

`prepublishOnly` runs the test suite first, so a broken package cannot be published.

## Known limitations

- Verified on the dsh 0.1.5 line; a change to section interpolation or the `settings.section` slot contract would need work here.
- One global block per row — there is no cc-switch-style per-provider list. Mount the row twice with different `file`/`order` values, or use the row config directly.
- It injects text; it does not touch permissions, sandboxing, or anything else.
- `syncProjectAgents` **really does modify your working tree**: it creates or modifies `AGENTS.md` in the project (it shows up in `git diff`), and that is the point. Turn it off with `syncProjectAgents: false`, or use `projectAgentsFallback: 'skip'` to keep out of directories that have no `.git`.
- Project sync follows the **session working directory**: different sessions in one process with different projects each write their own; a session whose `cwd` changes (theoretically none do) does not re-pick a project root.
- The panel's project-sync list is **per-process**: it starts empty after a dsh restart, while the blocks in the files are unaffected.
