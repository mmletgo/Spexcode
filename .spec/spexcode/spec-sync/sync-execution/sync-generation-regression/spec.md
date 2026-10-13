---
title: 冻结生成与独立审查回归验证
status: active
hue: 175
desc: 用真实 Git 快照和注入会话证明冻结绑定、门禁、独立审查与取消行为。
code:
  - spec-cli/src/sync/generation.test.ts
---
# 冻结生成与独立审查回归验证

## raw source

生成与独立审查必须验证真实候选字节和拒绝路径，不能靠 builder 或 Agent 的成功声明通过。

## expanded spec

测试创建独立临时 Git 仓库并真实 capture/freeze 候选；注入 runner 只替代 native 模型调用，不替代 schema/CAS/scope/manifest/候选对象校验。覆盖完整候选与未改源码/测试 assertions、不同 session/thread、稳定 requestKey、dispatch 登记顺序、warning不阻断、强制硬门禁失败不review、生成 schema/CAS/越界拒绝，以及错 inputId/digest、不完整/不存在/重复 checkedIds、accept带发现、复用会话拒绝。

组合输入基线与完整 UTF-8 文本从实际 Git 对象核对；准备后磁盘变化及调用者 Map/array/policy 修改不能改变已冻结生成/审查。取消与unsupported保留真实原因，不增加派发或偷偷重试。检查用户文件/index/HEAD 保持原样，真实候选仅冻结为对象 refs；本测试不证明 Docker V3 或完整 P2 产品交付。

针对命令：根目录 `npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/generation.test.ts`；`npx eslint spec-cli/src/sync/generation*.ts`；`npm run typecheck`。独立依赖安装后先正常 build 提供 workspace 类型。
