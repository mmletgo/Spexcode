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

callTimeoutMs 可显式给出有限单次 native 调用上限，必须为正整数且不超过 budget.timeoutMs；缺省由 coordinator 使用 min(120000,总预算)，并始终受原 operation 截止时间限制。应用只从 operation.input 内冻结的配置读取，字节绑定 input/readSet；修改 live 配置只能用于新操作，不能给旧操作重置期限或放宽已开始预算。
