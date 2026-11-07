---
title: 验证主机与候选运输
status: active
hue: 175
desc: 可信服务器选择执行主机，每个run独立绑定真实路径、运输认证与资源清算。
code:
  - spec-cli/src/sync/verification-transport.ts
related:
  - spec-cli/src/sync/verification-transport.test.ts
  - spec-cli/src/sync/verification-transport-build.test.ts
---
# 验证主机与候选运输

## raw source

正式 V3 必须在候选真实可见的隔离主机执行；远端部署只能由可信 server 决定，不能由模型扩大宿主权限。

## expanded spec

本节点给 [[verification-executor]] 一个 per-run 运输接缝，复用原 Docker argv/inspect/reporter 与 [[verification-remote-helper]]；无共享 mutable currentPlan、第二队列或业务阶段。本地保持原行为；新 SSH 请求冻结 alias、canonical privateRoot、实际 root/daemon 身份、run/config 与远端 candidate/runner 路径。旧 v1 保持本地原绑定，不从当前 SSH 配置补字段。

SPEX_VERIFICATION_SSH_ALIAS 与 SPEX_VERIFICATION_SSH_ROOT 成对来自 server 环境；认证沿本机 SSH，alias 作为独立 argv，固定 bootstrap 以外的路径、命令、文件名及候选字节只作 stdin 数据。不得关闭 host key 检查、读取凭据、拼接候选 shell、固定模型/CLI版本或 BaseURL。只需要远端已支持的 Node 内建 API 与 Linux flock。

可信helper原字节以gzip/base64内联进固定bootstrap，远端仅用Node内建zlib解压并导入同一data URI模块；不改helper、stdin请求/上传帧、effect/恢复身份或既有RPC与验证期限。命令压缩不得把项目载荷移入shell。

新SSH RPC超时附带版本化安全诊断：仅固定action/Docker verb、单调时钟预算/耗时/迟到量、准备耗时、事件循环active/idle累计时间、首末输出观察时间、原始输出字节数/换行与流结束状态、child退出/close观察，以及模块URL摘要、helper字节摘要和bootstrap尺寸。输出时刻仅为本机回调观察；未观察到字节不证明远端未输出。换行或child退出不是成功或远端停止证明；不记录原请求、完整argv、路径、环境、stdout/stderr正文或凭据，不改15秒RPC与原上传deadline。

SPEX_VERIFICATION_SSH_DOCKER_ENDPOINT可显式选择同SSH主机的本地Unix socket，缺省unix:///var/run/docker.sock。实际socket类型须通过检查，endpoint随原plan冻结；所有Docker调用显式--host并清除子进程的Docker context/host/TLS切换环境，随后仍核原daemonId。TCP/SSH网络daemon拒绝，不能仅凭Source字符串冒认同一文件系统。上传通道采用本checkpoint冻结deadline，不受普通短RPC的15秒隐形限制。

每个变更前沿原 checkpoint 登记固定 effectId/requestDigest，首次才派发；恢复只查询原 intent/receipt。正常 SSH 断开不终止远端 worker。上传失败且确认已排空可用新的物化序号续传，resource-only 不上传/create/start。执行边界核 fence，资源观察不恢复业务写权。真实 mounts Source 和 inspect 原件不改写。

stdout/stderr 可 lossless gzip运输，压缩前共用原日志预算；客户端核原长度/SHA及有界解压后返回原流。配置和 checkpoint 的 target 不匹配明确 recovery_required。原 terminal、同 daemon、closed 及重建 effect 排空后，删除丢回执可追加精确不存在恢复观察，不伪造原调用成功。
