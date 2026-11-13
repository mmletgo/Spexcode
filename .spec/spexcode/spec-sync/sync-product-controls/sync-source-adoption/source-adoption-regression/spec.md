---
title: 原工作树采纳真实 Git 回归
status: active
desc: 用正式结算夹具与真实 Git 验证快进、保留本地修改、拒绝不完整证明及幂等状态投影。
code:
  - spec-cli/src/sync/source-adoption.test.ts
---
# 原工作树采纳真实 Git 回归

## raw source

采纳入口必须以真实 Git 的失败到通过证明，不能只凭 UI 状态或伪造 receipt 宣称已落地。

## expanded spec

验证 [[sync-source-adoption]] 的共享服务入口。夹具通过正式 store、candidate、四层显式受控前置证据和 private delivery 得到真实 settled receipt；该测试只证明 Git 采纳边界，不代替模型生成或 Docker 产品验收。

覆盖干净原树快进成功、正常 canonical hooks 运行、主分支与 feature 分支投影区分、重复幂等；暂存/未暂存/未跟踪修改、分叉、授权和身份变化、同来源发布锁、未结算资源、伪造或缺失验证/plan/receipt 必须拒绝且不改 source/index/HEAD。Git 报错但 ref 已前进时检查真实诊断；不把错误当作自动回滚。持久 operation 保持 workspace_synced，canonical_synced 仅由既有只读状态投影得到。

服务冷启从原收据自动采纳已授权主分支，重复扫描和重新启动都保持一份原 journal、一次普通 post-merge 和零额外 operation 或派发。无标记历史交付、feature、物理暂停、脏树和未结算资源保留私有结果。外部编辑在异步授权读取期间产生时，重新核实原来源并拒绝快进。

preflight 产出计划后切支或改动 HEAD，最终同步写入边界必须快速拒绝，不向其他分支落入交付提交。

已结算后仅向真实 hooks 目录加入非执行 sample，不改变 canonical 可执行 hook digests，仍必须因冻结 footprint.files 的目录清单摘要改变拒绝；拒绝前后业务 source、index 与 HEAD 保持不变。

成功采纳后再加入相同非执行 sample，重复 adopt 仍须按已验证 receipt 与当前 landing 幂等成功；post-merge trace 不增加，证明没有再次 merge。

未采纳正式重验使用真实临时 Git/SQLite 和正常交付 hooks，先复现 workspace_synced 的 retry phase 拒绝，再核新 retryOf 独立记录、原输入/readSet/预算模型保持、父自身 heads 推进、同 request 幂等与旧 operation/attempt/journal/source/index 原值保持。已采纳、dirty/index/HEAD漂移、部分与缺 receipt、活跃资源及第三方 heads 均拒绝。受控四层 fixture 不冒称真实模型或 Docker 通过。
