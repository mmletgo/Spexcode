---
title: 无浏览器同步服务回归
status: active
hue: 175
desc: 真正后端与CLI验证同物理控制、停止重启和无Dashboard输入补偿。
code:
  - spec-cli/src/sync/service.test.ts
---
# 无浏览器同步服务回归

## raw source

CLI、HTTP和后台观察共用真实服务，无Dashboard保存、暂停及停机恢复不能只是客户端mock。

## expanded spec

AC-SYNC-SERVICE-01 启动真实index后端和CLI子进程，使用临时Git与canonical SQLite。HTTP物理pause、CLI enable/status，真实文件保存仍更新latest snapshot而零派发；正常SIGTERM退出后CLI离线明确非零，外部Git提交后重启无浏览器补偿。物理暂停跨服务进程保留，监听online由新真实进程投影；verify用同应用真实建queued操作但0call，recover只原资源清理不派新模型。该场景有意保持物理暂停，不能算实际模型、Docker或最终交付证据；生成交付由协调器与上层真实产品验收覆盖。

实际HTTP拒绝撤销route/body身份不一致和空请求键；CLI撤销尚未采纳交付明确非零。CLI停止写入后物理暂停、完整操作历史和0call仍保留，返回恢复列表不冒充完整历史或已释放全部资源。

同一暂停场景由真实 CLI/HTTP verify --model 创建固定 terra 操作，run 同键省略选择保留模型，同键改模型明确幂等冲突；0call保持，不把持久接入当作真实Native模型执行证明。模型合同属于 [[sync-model-selection]]。

已存在或备份固定运行描述先核精确期望模型，再允许admission。未受理请求留下的原描述若与后续选择不符，明确早拒，不新建operation/receipt/FIFO且不静默重建；匹配原描述的合法显式retry或新请求仍沿既有入口。
