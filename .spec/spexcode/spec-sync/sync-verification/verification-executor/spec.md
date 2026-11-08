---
title: Docker 候选行为验证执行器
status: active
hue: 175
desc: 在独立只读候选副本执行真实 Node 验收，以持久检查点恢复容器生命周期。
code:
  - spec-cli/src/sync/verification-executor.ts
related:
  - spec-cli/src/sync/verification-executor.test.ts
  - spec-cli/src/sync/verification-executor.docker.test.ts
---
# Docker 候选行为验证执行器

## raw source

真正运行当前冻结候选的验收，候选不能获得源树、共享 Git、宿主凭据或交付树写权；执行证据与输入、候选、政策和实际环境绑定。未终止的容器或未结算证据不能显示通过或释放执行容量。

## expanded spec

新远端 V3 复用唯一执行器及原 resource 四阶段，通过 [[verification-transport]] 将完整候选与 reporter 真正送到可信 server 选择的 SSH Linux Docker 主机。v2 checkpoint 在任何远端写入前持久原 target/daemon、实际远端 paths、run/input/candidate/policy/config 绑定；上传后原阶段追加实际模式、字节、链接及 runnerDigest 认证，成功持久后才 create/start。inspect 原件直接核真实远端 Source，不改写为本机路径。旧 v1 保持本地原绑定和历史缺席。

旧v1本地planned取消且容器不存在时，没有远端closed/effect排空证明，保持unknown/recovery_required且不得新create；不借NoSuch追加未执行成功证明。

上传/create/start 边界重新检查原业务 fence；失效只结算资源。planned 尚无容器时，可在原 target 的 closed 排空及精确不存在证明后保存 not-created terminal，再清理 staging 后 removed，不造 container evidence。终态原件先持久，随后 exact rm 与临时 candidate/runner 清算均已确认才 removed；控制历史、锁及 closed 保留不代表活跃 staging。

SSH 断开不证明 worker 或 Docker CLI 停止。[[verification-remote-helper]] 按单 run 内核锁及固定 effect intent/receipt 排空；已提交 create/start 无完成证明保持 recovery_required，不以 NoSuch 自免。closed 在锁内持久后无 remote intent 的请求可证明未执行，迟到请求拒绝。原 terminal 已持久、同 target/daemon、closed 有效且全部可重建 effect 排空后，rm/cleanup 的丢回执可由 exact ID/path 不存在追加恢复观察；不改写旧调用结果、不盲重放。

本叶节点实现 [[sync-verification]] 的 V3 执行边界；不单独证明 V1/V2/V4、候选交付或完整 P2 已完成。政策由上层可信校验器提供，固定镜像摘要、Linux 平台、Node 测试 argv、必需稳定测试 ID 与 CPU/内存/PID/时间/日志/scratch 预算。候选无法删减执行集合或改命令免检。

仅新发生的SSH RPC超时将[[verification-transport]]的安全诊断原样附在VerificationResult，planned前仍unsupported且无资源，已有checkpoint仍recovery_required并保留原资源。诊断不伪造容器证据、receipt、停止或清算证明；上层沿原结果证据接缝保存。普通错误与旧结果的字段缺席保持。

实际工作目录严格采用受信 VERIFY 的仓库相对 cwd，并在容器 inspect 中复核；不能把子目录命令偷偷放到根目录执行。稳定 testID 来自 AC 的具体测试绑定，可以与 AC 的业务 ID 不同；必须在真实报告中唯一通过。

只支持 Docker Linux `linux/arm64` 与 `linux/amd64`；macOS 宿主经 Docker 执行 Linux 行为，未声明原生 macOS 验收能力。Docker 不存在、平台不符、镜像未预置或政策不受支持时明确 unsupported，不回退宿主执行。镜像准备属于可信环境准备，不在宿主执行候选生命周期脚本。

完整 export 先复制至当前用户独占的私有目录，以内容和执行权限摘要核对冻结输入。export 不含 `.git`、宿主 `node_modules` 或特殊文件。普通仓库内部的相对软链接保留链接语义，目标及完整解析结果必须留在 export 内且不指向排除内容；绝对、越界、悬空或循环链接拒绝。链接文本参与摘要，不把链接静默改成另一份普通文件。请求政策与恢复检查点在首次异步等待前复制，外部调用者后续改写不改变本轮绑定。仅挂载只读副本与可信只读 reporter；scratch 使用有大小限制的私有 tmpfs，产物不能污染冻结输入。容器以 1000:1000、只读 root、无网络、cap-drop ALL、no-new-privileges、init、独立 IPC/cgroup namespace、禁止 restart/healthcheck 及完整资源预算启动。创建后 inspect 实际 ID、label、镜像、命令、环境、安全配置和 mounts，不接受额外挂载或 anonymous volume。

私有 `/tmp` tmpfs 缺省及 `scratchExecutable: false` 保持 noexec；只有可信冻结政策显式给出布尔 true 时允许在该 tmpfs 执行测试创建的脚本或二进制，仍保持 nosuid、nodev 和大小预算。create 参数与 inspect 期待值从同一规则推导；实际挂载不符拒绝启动或接管。该能力只影响独立 V3 容器的私有 scratch，不授予宿主访问或修改生产候选的隔离政策。

程序在 create 前持久 planned（runId、唯一名字、完整 labels、configDigest、候选/工具副本、绝对截止时间），create 后核对实际容器并持久 created，再 start。恢复读取上层提供的检查点；planned 在 create 回执丢失窗口通过唯一名字查找，再严格核对全部身份和配置，不重复创建或按名字盲认。created 以 exact ID 接管，终态以后先持久真实 inspect、exitCode、受限日志与结果，才删除 exact ID；删除回执丢失按已持久终态恢复。没有 `--rm`。scratch 执行能力与其余政策一同参与 policy/config 摘要，恢复不能更换。持久失败、daemon 断连、CLI 超时或身份不符保持 recovery_required，保留资源供上层恢复，不静默释放容量。

取消/超时对 exact ID stop，必要时 kill，再 inspect 实际非运行终态；CLI 退出不是容器终止证明。终态 inspect、容器 exitCode、必要稳定 testID 的唯一 passed 结果和完整 reporter 结束事件都存在才通过；missing、重复、failed、skipped/todo、结果截断或 exit0 无报告都失败。可信只读 Node reporter 输出 `node-test-events-v1`；候选测试 stdout/stderr 被编码为数据，不能冒充测试事件。日志超过预算输出截断标记并停止发出后续报告。

测试 ID 与源码和 AC 的受保护绑定由上层政策核对，本执行器不把测试声明或模型总结当作业务覆盖证明。上层通过 `onCheckpoint` 存储 evidence blob；执行器没有第二数据库/队列。私有副本和检查点在外部 scratch 中保留，由上层按已结算证据的保留政策回收。

针对性验证见 `spec-cli/src/sync/AGENTS.md`。故障注入覆盖回执、持久失败、身份拒绝、断连和伪报告；真实 Docker 覆盖子进程、只读写拒绝、源树/凭据/socket 不可见、无网络、超时、取消及创建窗口恢复。scratch 场景在同一冻结镜像中直接 spawn tmpfs 内 755 脚本，分别确认缺省 EACCES 和显式 true 成功。
