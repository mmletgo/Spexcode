---
title: 导出生成真实库级预验
status: active
desc: 调用生产细化、生成、冻结及 Docker 接缝，保存白名单证据。
code:
  - spec-cli/test/p2-export-preflight.ts
---
# 导出生成真实库级预验

## raw source

尽早从真实自然语言输入验证细化与实现生成风险，保留实际模型输出和 Docker 验收证据；不能把库级预验称为完整 P2 交付成功。

## expanded spec

driver 将白名单 UTF-8 夹具复制到独立真实 Git 仓库，capture 原文件、index 与身份；所有业务输入来自冻结对象。明确记录 fixture snapshot 与独立后端 native root、开始时固定的 backend base commit。现有只读 structured runtime 属于后端项目，所以 native 桥仅替换固定执行 root/base，prompt 仍包含真实冻结 fixture；不宣称 fixture 自身 CLI/HTTP 产品入口运行。全部调用固定 gpt-6.1-sol/high，builder 与独立 review 使用生产原生会话，不 fake runner 或降低 unsupported 安全政策。

复用 elaborate、readFrozenContracts、runGeneration、checkGenerationContractIntent、freezeCandidate、planAcceptanceRuns 和 Docker executor；原 raw/REQ/AC/VERIFY 不得弱化，所有细化 AC 是必需验证集，加可信 oracle IDs。模型只可写详细叶 Spec、实现和新增 generated tests；实际完整 diff 门禁保护 oracle/facts/package。完整白名单文本进入生成，graph/完整派生图不序列化。冻结后只读导出无 Git/共享 node_modules，用固定官方 Node digest、linux/arm64、明确 cwd 和资源预算执行；unsupported 保留原因且不平台重试或宿主 fallback。

在创建输入与任何 native 派发前，直接引用生产 ELABORATION_SCHEMA 的 VERIFY.id 与 AC.command 子 schema 校验可信登记 ID，固定登记为 VERIFY-EXPORT-01。不能把夹具自己不合法的技术 ID 与硬 schema 冲突归为用户业务 GAP；修正此类输入必须形成新的事实、冻结摘要及独立审查证据，不修改旧模型输出冒充合格。

细化 facts 仅包含完整业务/API政策，files 仅传冻结业务 Spec 文本；AGENTS、package 脚本和 oracle 作者指令不作为业务输入。可信验证定义通过独立 verifications 字段传入，输出程序核对。生成阶段仍提供完整冻结 UTF-8 文件和 oracle 断言；driver 固定生成技术说明的 SHA 进入 GenerationInput.policy，并明确附在 code_generate/code_review 的只读桥请求中作为技术政策，artifact 同时记录该 SHA，不移入业务 facts。不允许实现阶段新增 REQ/RULE/AC 将作者职责变为业务承诺；真实模型输出始终原样保存。

每个新冻结输入最多2次细化修复、6次细化调用、每次900秒、细化总3600秒；生成/独立审查使用各900秒的两次生产调用，Docker固定30秒。不无限重启相同输入，unsupported无平台重试。此前失败证据保留，新事实/执行根base/key/digest独立记录。

输入、输出、派发、原生身份、候选 manifest/actual diff、Docker 政策/检查点/结果保存指定用户可视化目录的 p2-export-preflight 独立 run 子目录；不复制认证、runtime 或 home。结束复核源 snapshot/index 未改；不 apply、commit 候选、发布 refs 到用户分支、结算 receipt 或标 synced。仅 library-preflight:passed 可代表这一限定预验，最终完整 P2 仍需真实产品协调与交付入口验收。

运行：`npx tsx spec-cli/test/p2-export-preflight.ts <用户可视化目录>/p2-export-preflight`；针对类型：`npm run typecheck`；lint：`npx eslint spec-cli/test/p2-export-preflight*.ts spec-cli/test/fixtures/spec-sync/export-implementation-repo/trusted-oracle/*.mjs`。
