<div align="center">

<img src="banner.png" alt="SpexCode — Specs govern. Agents build." width="720">

<p>
  <a href="https://www.npmjs.com/package/spexcode"><img alt="npm" src="https://img.shields.io/npm/v/spexcode?logo=npm&logoColor=white&color=cb3837"></a>
  <img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-2f81f7">
  <img alt="Node.js 22 或更高" src="https://img.shields.io/badge/node-%E2%89%A5%2022-3fb950?logo=nodedotjs&logoColor=white">
  <a href="https://spexcode.net"><img alt="文档" src="https://img.shields.io/badge/docs-spexcode.net-8957e5"></a>
</p>

[English](../README.md) · 中文

</div>

SpexCode 是一个基于 git 的 spec 树和 coding agent 会话管理器。

完整的业务流程、操作步骤、状态含义和常见问题，请阅读 [用户使用手册](USER-MANUAL.zh-CN.md)。

天下苦「spec 漂移」久矣。agent 改代码的速度，远快于有人去更新「这段代码是干什么的」那份说明，而 spec 什么时候不再描述系统，没有任何东西会提醒你。在 SpexCode 里，每个 spec 写明自己管辖哪个文件或函数。之后的 commit 改了这段代码却没动 spec，SpexCode 会指出是哪个 spec、哪个 commit。装了钩子以后，改到被锚定的函数的提交会被拦下，直到有人更新 spec，或写明它为什么仍然成立。

session 让每个 agent 在自己的分支和 worktree 里工作，每次改动交回来时，commit 里都写着它碰过哪些 spec。

一个 spec 节点就是 `.spec/` 下的一个 `spec.md`。它的 `code:` 字段写明实现在哪：

```yaml
---
title: Webhook security
code:
  - src/ingest/webhookVerifier.ts#verifyWebhook
---
Only a push signed with the configured SHA-256 secret may change a release stream.
```

绑定就这一行。版本、漂移和历史都在每次读取时从 git 算出来，此外不存任何东西。

## 从你正在用的 agent 开始

装 CLI 之前，可以先在 Claude Code 或 Codex 里试。**atlas** 插件会读整个仓库，写出第一版 spec 树，检查每张图，最后交回一个能直接打开的页面。

```sh
# Claude Code
claude plugin marketplace add shuxueshuxue/spexcode-plugins
claude plugin install atlas@spexcode
# Codex
codex plugin marketplace add shuxueshuxue/spexcode-plugins
codex plugin add atlas@spexcode
```

然后在任意仓库里运行 `/atlas`。

插件第一次引入用的是 `spex init --pure`：只有 git 里的 `.spec/` 纯文件，不装钩子，不改 agent 配置。以后要用 session 层，再用下面的 CLI 加上。

<img src="readme/atlas.zh.png" alt="Tencent/vConsole 的 atlas：「VConsole 核心」节点和它的生命周期图。" width="900">

更多这样画出来的仓库：[flatcode.spexcode.net](https://flatcode.spexcode.net/)。图由 [archify](https://github.com/tt-a1i/archify)（MIT）渲染。

## 可计算的 spec 漂移

spec 的每个版本就是一次碰过它 `spec.md` 的 commit，窗口从最新一版开始；之后每个 commit，SpexCode 用 Git 给出的改动行，去和被锚定单元在那个 commit 时的行区间求交。

<img src="readme/term-spec-lint.svg" alt="spex spec lint 报出 src/ingest/webhookVerifier.ts#verifyWebhook 自 spec webhook-security v3 以来的 anchor-drift。" width="900">

有交集就是 `anchor-drift`：这是错误，装了钩子时提交会被拦下。同一文件其它位置的改动只是 drift 提醒。

<img src="readme/drift-history.zh.svg" alt="spec webhook-security v3 之后，commit cbe53ee 改了 webhookVerifier.ts 第 6 行，落在 verifyWebhook（第 5–13 行）内，重叠即 anchor-drift。" width="900">

全部从 Git 算出，不存任何漂移数据。两种解法：spec 跟着代码改，新版本就会关闭窗口；或者用 `Spec-OK` trailer / `spex spec ack` 写明契约仍然成立。

```sh
spex spec lint
```

装了钩子以后，命中锚点的新 commit 会被拒绝。要么把 spec 和代码一起改，要么写明为什么这次只改实现、契约仍然成立：

```sh
git commit --trailer "Spec-OK: webhook-security"
```

已经提交的改动用：

```sh
spex spec ack webhook-security --reason "契约仍然成立，这次重构没有改变它"
```


## 在图形界面里用

<img src="readme/product.png" alt="SpexCode dashboard：桌面端的 review session，手机端的 webhook-security spec。" width="900">

## 在终端里用

<img src="readme/term-session-ls.svg" alt="Harbor 演示项目上的 spex session ls：处于 review、asking、parked 的 session，各自带着 spec 节点、id、父 session 和 prompt。" width="900">

dashboard 能做的事，CLI 都有对应的命令；`spex help` 会列出全部。

## Git 还是笔记本？直观的 spec 管理

spec 是 git 里的 Markdown 文件，dashboard 把它们当成可以直接操作的文档来读。

<table>
<tr>
<td width="50%"><img src="readme/spec-change.gif" alt="在 webhook-security spec 上点「1 pending change」，打开一个运行中的 session 对它所做修改的逐词红线对比。"></td>
<td width="50%"><img src="readme/spec-send.gif" alt="选中 webhook-security spec 里的一句话，右键，附上一条消息发给某个 session。"></td>
</tr>
<tr>
<td>运行中的 session 对这份 spec 的修改，以红线对比呈现。</td>
<td>选中一段话，发给某个 session。</td>
</tr>
</table>

## 快速开始

需要 **Node ≥ 22** 和 **git**。

```sh
npm i -g spexcode
cd your-repo
spex init --harness claude,codex,opencode,pi,zcode,claude-headless,opencode-headless,pi-headless,codex-headless
```

示例列出了全部内建 harness，留下你用的就行（任意一个 id 或逗号分隔的子集）。`spex init` 会种下 spec 树、安装钩子，并把工作流说明写进你的 agent 本来就会读的文件。已有配置不会被覆盖；`spex uninstall` 会移除 SpexCode 加的东西。

<details>
<summary><strong>只引入一部分</strong></summary>

| 命令 | 结果 |
| :--- | :--- |
| `spex init --pure` | 只有根 spec 和项目配置，不装钩子。 |
| `spex init --harness none` | spec 工作流和钩子，不改 agent 配置。 |
| `spex init --harness …` | spec 工作流，外加给所选 agent 的说明。 |

加 `--title "你的项目名"` 给根 spec 和 dashboard 命名。

</details>

<details>
<summary><strong>运行隔离的 session</strong></summary>

session 管理需要 **tmux**；Windows 上请用 **WSL2**。

```sh
spex session new "[[webhook-security]] verify signatures behind a reverse proxy"
spex session ls
spex session review <session-id>
spex session merge <session-id>
```

worker 只提议，什么时候发起受闸门保护的合并由你决定。

</details>

<details>
<summary><strong>打开 dashboard</strong></summary>

```sh
npm i -g @spexcode/spec-dashboard
spex serve
spex dashboard
```

每个项目一个后端，一台机器一个 dashboard 服务所有项目。spec、session 和终端视图都有可分享的 URL。

</details>

## 三层

<img src="readme/layers.zh.svg" alt="三层：L0 是 git 里的 spec–code 图，L1 是建在其上的隔离 worktree 里的 agent session，L2 是读取 L1 的 dashboard。" width="900">

[上手指南](https://spexcode.net/getting-started/) · [和 agent 一起工作](https://spexcode.net/working-with-agents/) · [参与贡献](CONTRIBUTING.md)

首发于 [LINUX DO](https://linux.do)。以 [MIT](../LICENSE) 许可发布。
