# dsh-global-system-prompt

[English](README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-global-system-prompt)](https://www.npmjs.com/package/dsh-global-system-prompt)
[![license](https://img.shields.io/npm/l/dsh-global-system-prompt)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0969da)](https://github.com/topics/dsh-plugin)

## 概述

`dsh-global-system-prompt` 给 DeepSeek Harness 补上 cc-switch 那个「全局提示词」：一段你自己写的文字，**每一次对话都会带上**，在 Web 设置面板里直接编辑，保存后下一轮对话即生效。

它的做法有两条通道：把这段文字注册成系统提示词里的一个独立段落（section），**同时**写进当前会话所在项目的 `AGENTS.md`。系统提示词那条保证 dsh 每一轮都带上；`AGENTS.md` 那条保证别的工具（Claude Code、Codex、Cursor、Zed……）和以后的会话也带上，并且跟着仓库走：

- **进的是系统提示词**，位置固定可调，默认紧跟在 harness 身份行之后、persona 之前（order `-900`）。
- **对所有会话生效**：根会话、preset 挂载的 agent、进程内 subagent 都会带上（外部 CLI 子代理如 Codex/Claude Code 有自己的提示词，不受影响）。
- **不会被 preset 遮蔽**：段落名 `user:global-prompt` 是插件独占的，agent preset 的 persona 只会覆盖 `deployment:persona-prefix`，覆盖不到它。
- **改完即生效**：每个 step 重新渲染时都会重新读文件，所以保存后下一次请求就带上新内容，不用重启 dsh。
- **消耗固定**：内容不变就不会污染 prompt 前缀缓存；内容变了（或清空）只改变这一段。
- **告诉模型全局文件在哪**：注入内容末尾会自动附一段文件位置说明，写出下面两个文件的**绝对路径**。dsh 自己注入的运行时上下文只把用户全局指令说成一句「AGENTS.md」（不给路径），模型为此经常满硬盘找；这段说明就是治这个的。
- **同时写进项目**：每个会话开始时，它所在项目根目录的 `AGENTS.md` 会被维护一段带标记的区块，正文与系统提示词那段完全一致（[见下](#同步到项目-agentsmd)）。区块之外的内容插件的字节都不动。

```text
Harness file locations (exact paths — read or edit these directly instead of searching for them):
- global prompt (injected by the dsh-global-system-prompt plugin): C:\Users\me\.dsh\global-prompt.md
- user-global instructions (the "AGENTS.md" the runtime context mentions): C:\Users\me\.dsh\AGENTS.md
```

于是模型（以及你自己）不用再猜「全局 AGENTS.md 到底是哪个」：要读要改，直接照这个路径操作即可。想关掉就 `announcePaths: false`；想换文案就 `pathsNote`。

两条通道可以各关各的：`enabled: false` 整行停用，`syncProjectAgents: false` 只停项目 `AGENTS.md`（系统提示词照旧）、`announcePaths: false` 只去掉文件位置说明。

## 目录

- [安装](#安装)
- [使用](#使用)
- [同步到项目 AGENTS.md](#同步到项目-agentsmd)
- [配置](#配置)
- [与 AGENTS.md / dsh-global-rules 的关系](#与-agentsmd--dsh-global-rules-的关系)
- [实现](#实现)
- [开发](#开发)

-----

<a id="安装"></a>
## 安装

从 npm 装（正式方式）：

```powershell
# Web 面板用的 profile
dsh plugin --profile web add dsh-global-system-prompt

# TUI profile 也可以装（没有 Web 服务器，只有注入与项目同步生效）
dsh plugin --profile dsh-tui add dsh-global-system-prompt
```

从 GitHub 装（想直接跟仓库走，或者钉住某个提交）：

```powershell
dsh plugin --profile web add github:YMRwithNoworry/dsh-global-system-prompt

# 钉住提交：仓库名后面接 #<commit-sha>
dsh plugin --profile web add github:YMRwithNoworry/dsh-global-system-prompt#<commit-sha>
```

从本地 checkout 装（开发/自用）：

```powershell
# 复制一份进 profile：改完源码要重装一次
dsh plugin --profile web add file:<本仓库路径>

# 或者软链一份：改完源码直接重启 dsh
dsh plugin --profile web add link:<本仓库路径>
```

> 包名是 `dsh-global-system-prompt`。npm 上另有一个别人的 `dsh-global-prompt`（同名不同包，与本包无关），别装错了。

`dsh plugin add` 会把包加进 profile 的 `dependencies`，并把声明了 `dsh.bundle` 的包追加到 `dsh.profile.bundles`。**新增 bundle 是启动边界**，装完要重启一次 dsh；之后改提示词内容就完全不用重启了。

装完可以先不启动、只验证层是否合入：

```powershell
dsh --profile web --dump-config | Select-String -Context 0,8 'global-system-prompt'
```

应该能看到一行 `# == dsh-global-system-prompt` 以及插入的行：

```yaml
- id: global-prompt
  name: dsh-global-system-prompt
  config:
    enabled: true
    order: -900
    ...
```

<a id="使用"></a>
## 使用

打开 设置 → **全局提示词**，在文本框里写内容，保存。

- 保存后**下一次请求（下一轮对话）生效**，当前已经发出的那一轮不变。
- 文件默认是 `~/.dsh/global-prompt.md`（即 `$DSH_HOME/global-prompt.md`），也可以直接用任何编辑器改它——面板上的「重新读取」按钮会重新拉取。
- **文件存在但内容为空 = 不注入提示词正文**（文件位置说明仍会附加，见 `announcePaths`），这也是临时静音的办法；删掉文件则回到配置里的 `text` 兜底（默认为空）。
- 面板会显示提示词文件路径、**用户全局指令文件**路径与状态、段落位置 order、实际注入字节数，还有一个「实际注入预览」可以展开看模型读到的原文；文件超过 `maxBytes`（默认 64 KiB）时超出部分不会注入。
- 面板底部还有两行关于项目 `AGENTS.md` 的状态：本进程同步过哪些项目、最近一次动作（已创建 / 已更新 / 已是最新 / 已移除 / 已跳过 / 失败），以及「写入项目的区块」预览。

<a id="同步到项目-agentsmd"></a>
## 同步到项目 AGENTS.md

系统提示词只影响 dsh。同一个仓库你还可能用别的工具打开，它们读的是项目里的 `AGENTS.md`；换个工具、换个终端、交给同事，规则就没了。所以插件把同一段提示词**同时**写进当前会话所在项目的 `AGENTS.md`：写一次，项目里所有工具都读得到，还跟着 git 走。

```markdown
<!-- BEGIN dsh-global-system-prompt -->
<!--
  Managed by the dsh-global-system-prompt plugin. The rules below are synced from:
  C:\Users\me\.dsh\global-prompt.md
  Edits inside this block are overwritten on the next sync; delete the block,
  markers included, to stop syncing.
-->

Global rules — follow these in every task in this project:

（这里是全局提示词的原文）

<!-- END dsh-global-system-prompt -->
```

| 问题 | 行为 |
|---|---|
| 写哪个文件 | 从会话工作目录向上找到第一个带 `.git` 的目录当项目根，写它的 `AGENTS.md`；一路到盘符根都没有标记，就退回到会话工作目录本身（`projectAgentsFallback: 'skip'` 可改成"找不到就不写"） |
| 文件不存在 | 自动创建（连同缺失的目录） |
| 已经有别人的内容 | 原样保留，区块追加在末尾；区块之外的内容插件一个字节都不动 |
| 什么时候写 | 会话开始写一次（`agent/session-start`——harness 保证它在首次组装提示词之前，所以第一个 step 就读得到），之后每个 step 复查一次（内容没变时只花一次 `stat`） |
| 提示词改了 | 下一次复查时换成新内容，不用重启 |
| 区块被手删 / 被合并冲突吃掉 | 下一步写回；想彻底停就删掉区块后把 `syncProjectAgents` 设为 `false` |
| 提示词被清空 | 区块被摘掉；如果那个 `AGENTS.md` 除了这个区块什么都没有（也就是它是插件建的），文件本身也会删掉 |
| 写不了 | 文件超过 1 MiB、标记只剩一半（被手改坏）、读写报错——都只记一条 warning 并保持文件原样，系统提示词照常注入，回合不会中断 |

几点说明：

- **指令性**：区块开头那行 `Global rules — follow these in every task in this project:` 由 `projectAgentsPreamble` 控制，用你自己的话写也行，比如 `projectAgentsPreamble: '全局规则，本项目所有任务都必须遵守：'`；设成 `''` 则只留正文。写进 `AGENTS.md` 的正文是**未转义**的原文（`escapeBraces` 只作用于系统提示词段落那条通道），所以 JSON、`{{placeholder}}` 这类内容在项目文件里长什么样就是什么样。
- **会有两份**：在 dsh 会话里同一段规则会出现两次——一次在系统提示词，一次是 `AGENTS.md` 作为工作区指令注入的上下文（`dsh-agent-instructions` 在首次组装时读它，之后按文件变更重投影）。这是刻意的：前者是 dsh 的实时通道，后者是跨工具通道。不想在项目里留痕就 `syncProjectAgents: false`。
- **不碰用户的全局文件**：`$DSH_HOME/AGENTS.md` 是 dsh 自己和 dsh-global-rules 的地盘，插件只声明它的位置、绝不写它；万一项目根正好解析到它，插件会跳过并记一条 warning。
- **写入是原子的**：先写同目录的临时文件再 rename，harness 正在读 `AGENTS.md` 时不会读到半截内容；有多个 dsh 进程时也不会互相截断。

<a id="配置"></a>
## 配置

配置写在行里。默认值如下（也就是本包的 `cordis.patch.yml`）：

```yaml
- id: global-prompt
  config:
    enabled: true
    # file: ~/.dsh/global-prompt.md       # 默认 $DSH_HOME/global-prompt.md；支持 ~ / ~/ / ~\
    order: -900
    text: ''
    maxBytes: 65536
    escapeBraces: true
    announcePaths: true
    # instructionsFile: ~/.dsh/AGENTS.md  # 默认 $DSH_HOME/AGENTS.md；'' 表示不提
    includeInstructions: false
    pathsNote: ''
    syncProjectAgents: true
    # projectAgentsFileName: AGENTS.md    # 写进项目根的这个文件；只能是文件名
    # projectRootMarkers: ['.git']        # 向上找项目根用的标记
    # projectAgentsFallback: cwd          # 找不到标记：cwd 写会话目录本身 / skip 不写
    # projectAgentsPreamble: 'Global rules — follow these in every task in this project:'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时不注册段落、也不写项目 `AGENTS.md`（面板路由仍在，方便你先写好内容再打开） |
| `file` | `$DSH_HOME/global-prompt.md` | 提示词文件；相对路径按进程工作目录解析 |
| `order` | `-900` | 段落位置。`-1000` 是 harness 身份行，`0` 是部署 persona 前缀，`500` 是 plan 策略；越小越靠前 |
| `text` | `''` | 仅当文件**不存在**时使用的兜底文本 |
| `maxBytes` | `65536` | 注入内容的 UTF-8 字节上限，超出部分截断（面板会提示） |
| `escapeBraces` | `true` | 中和文本里的 `{{`（见下）；只影响系统提示词那条通道 |
| `announcePaths` | `true` | 在末尾附加「文件位置说明」，写出下面两个文件的绝对路径（模型不必再找） |
| `instructionsFile` | `$DSH_HOME/AGENTS.md` | dsh 自己的用户全局指令文件；用于位置说明。设为 `''` 则完全不提它 |
| `includeInstructions` | `false` | 把该文件的内容也并进这一段。默认关闭，因为 base 系 profile 里 `dsh-agent-instructions` 已经它会作为上下文注入；只有在没有挂那个插件的组装（比如自建 sdk-minimal）里才需要打开 |
| `pathsNote` | `''` | 自定义位置说明文案（原样使用、不支持占位符）。留空则用生成的英文说明 |
| `syncProjectAgents` | `true` | 把提示词同步进会话项目的 `AGENTS.md`（[见上](#同步到项目-agentsmd)）。`false` 只保留系统提示词那条通道 |
| `projectAgentsFileName` | `AGENTS.md` | 项目文件的名字，只能是裸文件名（想写 `CLAUDE.md` 就改这里） |
| `projectRootMarkers` | `['.git']` | 向上找项目根时的标记名；标记文件或目录都算 |
| `projectAgentsFallback` | `cwd` | 一路没找到标记时：`cwd` 用会话工作目录本身，`skip` 干脆不写 |
| `projectAgentsPreamble` | `Global rules — follow these in every task in this project:` | 区块开头那行给模型看的指令，原样写入；`''` 只留正文 |

想覆盖某项时，在 profile 的 `~/.dsh/profiles/<name>/cordis.patch.yml` 里按 id 改——**patch 会整体替换该行的 `config`，所以要写全**：

```yaml
- id: global-prompt
  config:
    enabled: true
    order: -1100        # 放到身份行之前
    file: ~/.dsh/my-global-prompt.md
    text: ''
    maxBytes: 65536
    escapeBraces: true
    syncProjectAgents: true
    projectAgentsPreamble: '全局规则，本项目所有任务都必须遵守：'
```

### 关于 `escapeBraces`（重要）

系统提示词段落会把 `{{name}}` 当作**变量插值**，遇到未注册的变量名会抛错并中断这一轮，而且没有转义语法。所以如果你会在全局提示词里写 JSON、模板、`{{placeholder}}` 这类内容，保持 `escapeBraces: true`（默认）：插件会把每个 `{{` 中间插入一个零宽空格（模型看不到，人眼也看不到），插值就不会命中。确实需要原样注入时才设为 `false`。

<a id="与-agentsmd--dsh-global-rules-的关系"></a>
## 与 AGENTS.md / dsh-global-rules 的关系

dsh 内置的 `dsh-agent-instructions` 已经把 `~/.dsh/AGENTS.md` 注入到每个会话——但那是**用户消息形式的上下文**（durable context），不是系统提示词；`dsh-global-rules` 正是那个文件的可视化编辑器。本插件是**另一条通道**：

| | `~/.dsh/AGENTS.md`（内置 + dsh-global-rules） | 本插件 |
|---|---|---|
| 注入形式 | 用户消息（runtime context） | 系统提示词段落 |
| 位置 | 首批请求前的 durable 消息 | order `-900`，紧跟身份行 |
| 生效时机 | 新会话立即；当前会话要等文件操作后的重投影 | 下一个 step（不用重启，也不用等文件操作） |
| 与压缩/历史 | 参与消息历史的协调 | 每步重新渲染，不受历史压缩影响 |
| 编辑界面 | 「全局规则」 | 「全局提示词」 |
| 告诉模型文件在哪 | 只说「存在 AGENTS.md」，不给路径 | 直接写出绝对路径（`announcePaths`） |

两者可以并存互不冲突（段落名不同）。只用其中一个也完全可以。

而项目里的 `AGENTS.md` 是第三条通道，也是唯一跨工具的那条：它是 `dsh-agent-instructions` 的工作区指令来源（从项目根一路读到 cwd，`AGENTS.md` / `CLAUDE.md` 都认），别的 AI 工具也按同一套约定读它。本插件的 `syncProjectAgents` 把提示词写进这个文件的一个托管区块里——于是在 dsh 里这段规则会出现两次（系统提示词 + 工作区指令），在别的工具里也照样生效。

> 为什么需要「告诉模型文件在哪」：dsh 注入的那句运行时提示是
> `A user-global instruction file exists: AGENTS.md. Do NOT assume their content.`——
> 名字有了、路径没给。模型于是会去猜 `~/AGENTS.md`、`.agents/AGENTS.md`、工作区根……
> 找不到就乱读一通。本插件的 `announcePaths` 把那两个真实路径直接摆进系统提示词。

<a id="实现"></a>
## 实现

```
dsh-global-system-prompt/
├── package.json          # dsh.bundle.patch + dsh.client(web)
├── cordis.patch.yml      # 插入 global-prompt 行
├── lib/
│   ├── index.js          # Cordis 插件：注册 system prompt 段落 + 挂 webServer 路由 + 接会话生命周期
│   ├── config.js         # 配置校验/归一化，harness home 解析
│   ├── prompt.js         # 文件读取（mtime 缓存、限额截断）、`{{` 中和、原子写入
│   ├── project.js        # 项目 AGENTS.md：找项目根、托管区块增删改、每步复查
│   ├── route.js          # GET/POST /global-prompt（同源校验、体积上限）
│   └── client.js         # 浏览器侧 __ModuleLoader__ bundle（无构建步骤）
├── dev/
│   └── e2e-installed.mjs # 对着已安装的 dsh 跑端到端校验
├── test/                 # node --test
└── examples/
```

要点：

- **段落注册**：`ctx.systemPrompt.section({ name: 'user:global-prompt', order, text })`，`text` 是函数，每次 assemble 时求值——这是「改完即生效」的实现方式。段落名必须唯一：`deployment:persona-prefix` 由提示词注册表自己占用，重名会直接抛错。
- **可选依赖**：插件顶层只声明 `inject = ['systemPrompt']`；`webServer` 用 `ctx.inject(['webServer'], …)` 等——如果声明在顶层，没有 Web 服务器的 profile 会让整个插件停在 pending，提示词就永远不注入了。会话生命周期（`agent/session-start`、`agent/pre-step`）是事件不是服务，`ctx.on` 直接接，不需要 inject。
- **失败不炸回合**：读文件失败只记一条 warning 并退回落兜底文本，绝不从 `text()` 抛错；`project.js` 同理，任何异常都吞成 warning + 一条状态记录。
- **文件位置说明**：`prompt.js` 的 `pathsNote()` 生成那段 footer，两个文件各读一次 `stat`（同样带 mtime 缓存），所以「已存在 / 尚未创建」是实时状态。
- **项目同步的时机**：`agent/session-start` 是 harness 保证在首次组装提示词之前发出的同步通知（`agent.session.header.cwd` 此时已就绪），所以第一个 step 就能读到写好的 `AGENTS.md`；`agent/pre-step` 是 waterfall，插件 `await next()` 之后才复查，绝不改动 `PreStepDecision`。稳态下每次复查只做一次 `statSync`（记住「我写的区块 + 文件当时的 mtime/size」），不匹配才读文件。
- **只在标记之间动手**：`upsertManagedBlock` 认标记不认位置，能在文件任意位置替换、把重复区块收敛成一个、保留 CRLF 与 BOM；标记只剩一半（被手改坏）时**拒绝写入**并 warning，宁可不同步也不吃用户的内容。
- **面板路由**：`GET /global-prompt` 返回文件内容、两个文件的路径与状态、**本回合实际注入的原文**、以及项目同步状态与要写入的区块原文（面板据此预览），`POST` 校验同源后原子写入（临时文件 + rename）。

<a id="开发"></a>
## 开发

```powershell
cd <本仓库路径>
node --test test/          # 111 个用例
node --check lib/client.js # client bundle 语法检查（未构建，手写 __ModuleLoader__ 工厂）
```

改完源码后重新装一次即可让 profile 用上新代码：

```powershell
dsh plugin --profile web add file:<本仓库路径>
```

或者用 `link:` 装一份链接，改完直接重启 dsh：

```powershell
dsh plugin --profile web add link:<本仓库路径>
```

### 改包名 / 发到自己的 scope

包名散落在四个有加载语义的地方（`package.json`、`cordis.patch.yml` 的行 `name`、`lib/client.js` 的 `__ModuleLoader__.load({ id })`、日志与报错前缀），漏改其中任何一个都不会立刻报错但会静默失效。用带改名工具一次改完：

```powershell
node dev/rename-package.mjs                                  # 看当前名字都被哪些文件携带
node dev/rename-package.mjs @你的用户名/dsh-global-system-prompt  # 改（先 --dry-run 预览）
node --test test/                                            # 改完自测
```

工具只替换「完整包名」这个 token，不会动 Cordis 插件名（`global-prompt`）和段落名（`user:global-prompt`）——这两者是运行时身份，与包名无关。

发布：

```powershell
npm login                  # 需要你自己的 npm 凭证
npm publish                # publishConfig.access 已设为 public（scoped 包必须）
```

`prepublishOnly` 会先跑一遍测试，测不过发不出去。

## 已知限制

- 只在 dsh 0.1.5 系列验证过；段落插值规则、`settings.section` 槽位契约、`agent/session-start` / `agent/pre-step` 的载荷若在未来版本变化，需要跟着改。
- 面板是**全局一段**，没有 cc-switch 那种「按 provider 分别配置」的多档位；需要多份就装多份（改 `file` 与 `order`）或直接用行配置切。
- 注入的是提示词文本，不做权限/沙箱方面的任何事。
- `syncProjectAgents` 会**真的改你的工作区**：会在项目里新建/修改 `AGENTS.md`（git diff 里会看到它），这是它的目的。不想要就 `syncProjectAgents: false`，或在 `projectAgentsFallback: 'skip'` 下让没有 `.git` 的目录被跳过。
- 项目同步以**会话工作目录**为准：一个进程里不同会话开着不同项目，就各写各的；`cwd` 变化的会话（理论上没有）不会重挑项目根。
- 面板上的项目同步状态是**进程内的**：重启 dsh 后列表从空开始，文件里的区块不受影响。
