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

模型读集合回归覆盖：实际冻结树里的 .env 不进入生成或审查、完整manifest仍绑定该不变条目；读取真实 src/auth 业务源码不被名称误屏蔽；省略未改 AC 断言文件或修改未读取既有文件时硬拒绝，不能以精简上下文缩减验证。

oracle 定向回归核 mandatory tuple、固定 verification definition 与完整旧断言进入同一生成/独审输入；调用者后改 testId/command 不改变冻结内容和摘要。未绑定当前真实裁决的 reserved missing_fact/needs_input finding 必须 review_invalid，不自免检。

contract-omission marker回归拒绝错路径、未知existingID与affectedIds未关联；普通contract引用仍返回repair而不获得重细化权。真实候选、独立identity与原schema门禁全部保留。

可信发布 freeze 回调回归证明：响应返回后才调用，闭包外真实继承进入实际候选且原模型提示不变；闭包内 readonly 字节和不存在路径被回调修改均拒绝，模型修改 readonly oracle 仍越界拒绝。

真实Git冻结的单份测试全文超过2MiB时，生成和独立审查仍逐字收到全部断言及首尾内容，候选保该全文不变且会话保持独立。本文件的runner为受控接缝；原生超大读取与实际覆盖证明由 [[frozen-context-reader]] 单独验收，不能把提示到达当模型已读。
