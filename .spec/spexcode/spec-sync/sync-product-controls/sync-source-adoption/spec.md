---
title: 已验证交付采纳到原工作树
status: active
desc: 在同来源发布锁内核实完整结算证据和当前授权，只向干净原工作树正常快进实际交付提交。
code:
  - spec-cli/src/sync/source-adoption.ts
---
# 已验证交付采纳到原工作树

## raw source

用户从 Dashboard 或 CLI 将已验证完整交付采纳到原输入工作树。只接受真实已结算提交，保留本地修改和正常 Git hooks，不因按钮点击写入虚假的主分支完成状态。

## expanded spec

[[sync-application]] 的详情资格与实际采纳使用同一后端判据。只接受完整 workspace_synced/awaiting_landing/canonical_synced 操作：没有未决范围、全部实际交付覆盖操作范围、当前尝试及全部 journal 已 settled，同来源没有未结算原生资源或交付日志，物理写入未暂停。未完成态先给出明确拒因，再读取固定 runtime 和完整证据。

复核 [[sync-private-delivery]] 已持久的 input、candidate、四层 pass 验证、apply plan、文件步骤、receipt、commit intent 与真实 Git tree/parent/effect 绑定，不重造证据。receipt.actualCommit 必须真实存在；交付快照的 HEAD、工作树、index 和 manifest 等于已验证完整候选。unchanged intent 仅复用原 parent；普通提交必须匹配原 parent 和 effect。固定 runtime、canonical hooks 及执行配置须可静态证明。

settledReceipt及既有scope覆盖谓词可由[[sync-application]]复用为纯只读已采纳证明，全部验证规则保持；该消费读取不调用写入用prepareSourceAdoption，不借物理run、空闲资源或改控制取得权限。正式adopt/fast-forward的全部写入前置与hooks流程保持。

尚未采纳且需要写入时，当前 hook binding 的完整 footprintPolicy 必须与交付时冻结值一致：版本、私有目录物理身份、执行配置摘要及 files 中所有目录清单/模式/内容摘要均逐项比较。canonical filter payload、元数据或 hooks 目录清单变化不能仅凭可执行 hook 字节相同获得写入资格；版本或文件绑定不一致明确返回 sync_adoption_hooks_changed。

原来源的仓库、commonDir、gitDir、物理工作树和分支须仍与操作一致；当前本机启用记录、版本化配置摘要及节点授权仍有效。working/index/untracked 任一非忽略内容改变即明确拒绝；当前 HEAD 必须是 receipt commit 的祖先。已采纳且当前闭包仍一致时幂等返回现状，不重复执行 Git。相关后续提交或分叉不自动三方合并、reset、rebase 或覆盖。

完整 receipt 和只读 landing 已证明 sourceSynced 时，经过上述授权、结算证据和干净原树检查后直接幂等返回，不再要求写入用 hooks/footprint 与交付前冻结值相等；合法 post-merge 刷新不会把已采纳读取变成写入失败。

所有前置检查保持业务 source、index、HEAD 与分支只读；沿应用既有快照读取可保存内容寻址对象和私有保活 metadata。真正写入前取得协调器既有 artifacts/.publication-locks 的同 source file-mutex，在锁内重读操作、snapshot、授权、证据及 hook binding，再执行普通 git merge --ff-only --no-autostash。清除内部发布模式、注入与 lint/defer bypass 环境；不禁用 hooks，不增加另一套 hook 协议。锁只协调正式服务写者，不能替用户锁住外部编辑器。

临近 merge 的同步边界再次核实 symbolic-ref HEAD 与实际 HEAD 仍为计划中的原分支/提交；preflight 后切支或推进 HEAD 明确拒绝。执行后的身份与分支仍需核实。这些复核不承诺阻绝任意外部进程同时操作 Git，最终仍以正常 hooks 和实际状态投影为准。

Git 非零退出不等于没有副作用；错误包含实际 HEAD 是否前进，保留现场并要求重新读取状态，不承诺自动撤销。Git 完整成功后仍通过 [[sync-landing-status]] 读取实际 sourceSynced/canonicalSynced；没有新造的 journal、receipt 或持久完成阶段。主分支仍有脏改动时拒绝采纳不妨碍原私有交付成果查询。
