---
title: 同步可信配置
status: active
hue: 175
desc: 从版本化项目配置读取授权目录、登记验证及预算，缺口明确拒绝。
code:
  - spec-cli/src/sync/settings.ts
---
# 同步可信配置

## raw source

首次启用一次授权源码和测试目录，不要求用户手填每个实现函数或未来验收 ID。缺少可靠环境时不能猜命令、执行宿主 fallback 或虚报可用。

## expanded spec

[[sync-application]] 只读不可变 source 中 `.spec/spexcode.json` 的 sync 对象，schema 为 sync-settings-v1。sourcePaths/testPaths/readPaths 为仓库相对路径集合；source/test 非空，禁止授权 Spec、依赖或私有资料。facts 只装具名业务事实；本机目录与凭据不写此配置。

verifications 非空，每项 definition 精确登记 id、command argv、cwd、timeoutMs，environment 登记 version、冻结 image@sha256、linux/arm64 或 linux/amd64、memoryBytes、cpus、pidsLimit、scratchBytes、logBytes。P2 仅支持 Docker Node --test；配置缺口、不支持命令、重复登记和越界路径明确拒绝。mandatoryTests 登记现存独立测试的 verificationId/testPath/testId，必须在 read 范围、引用已登记命令且不在模型可写目录；未来 AC 由细化生成，不要求启用者预知。

budget 给出 maxAttempts、maxCalls、maxRepairs、timeoutMs。结构由唯一 Ajv schema 验证；环境和 image 可用性在 coordinator/Docker 中产生证据，不把配置合法视作运行通过。实际配置文件摘要用于本机 enable 授权及并发检查。

environment 可选布尔 `scratchExecutable`，省略或 false 时私有 `/tmp` 为 noexec；只有可信版本化配置显式 true 才允许测试在独立 V3 容器的 tmpfs 执行临时脚本或二进制。其他类型明确拒绝。该能力沿同一冻结环境进入 policy/config 摘要及实际 inspect 核对，不能通过 live 或候选配置改写已开始的运行，也不改变宿主或生产候选的隔离约束。

callTimeoutMs 可显式给出有限单次 native 调用上限，必须为正整数且不超过 budget.timeoutMs；缺省由 coordinator 使用 min(120000,总预算)，并始终受原 operation 截止时间限制。应用只从 operation.input 内冻结的配置读取，字节绑定 input/readSet；修改 live 配置只能用于新操作，不能给旧操作重置期限或放宽已开始预算。

nodeIds 可选，登记本次允许的 Spec 意图根节点；真实子树和影响闭包复用当前图，配置摘要同样绑定授权。省略时只从受授权 source/test 路径的真实治理绑定推导注册意图，未治理/越界节点不伪装成已纳入。无实现绑定的新纯raw意图须显式nodeIds，已注册意图子树内的新raw自动纳入。手動直接请求越nodeIds范围明确拒绝；coverage报告纳入/未纳入节点，分模块接入不能宣称全项目同步。

`model` 可选，保存该项目同步新操作的精确模型 ID，不做供应商白名单；非空且不得带首尾空格。配置摘要与原有授权、currentness 门禁共同绑定模型默认值；配置变化仍须明确重新启用，不能改写已准入 operation 或其预算。

budget唯一schema精确接受原四numeric字段或仅含mode=unlimited的对象，拒混合、缺失或无效形状；旧有限对象不补mode、不改摘要。unlimited没有任何四种总cap，callTimeoutMs仍须为有限正整数，缺省120000ms；仅有限预算要求其不超过总timeoutMs。无界总期不取消验证timeout、租约、取消或资源回收。
