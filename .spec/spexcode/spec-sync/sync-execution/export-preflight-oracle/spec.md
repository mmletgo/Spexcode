---
title: 导出生成基准的可信验收
status: active
desc: 夹具作者政策的独立公共接口断言，禁止模型修改。
code:
  - spec-cli/test/fixtures/spec-sync/export-implementation-repo/trusted-oracle/export.oracle.test.mjs
---
# 导出生成基准的可信验收

## raw source

从自然语言生成导出服务后，独立验收必须检查实际数据结果和权限、幂等、快照、尝试身份及竞争顺序，不能信任模型自报成功或空结果。

## expanded spec

`export-implementation-repo` 初始只含自然语言原意、完整作者事实、固定公共 API、package 和独立 oracle，无状态/流程契约表及业务实现。政策属于夹具作者，不是持续同步产品默认。服务限纯内存、可信只记录且无同步重入/异常的 enqueue；不证明 HTTP、真实 worker、持久化或部署恢复。

oracle 只通过 createExportService 的公共方法观察任务与真实行数组，不实现服务。验证精确 trim 后类别筛选、数据读取时点与复制隔离、actor+key 幂等、全部状态 owner 权限、回调当前/旧/未来/缺失 attempt、QUEUED 拒绝提前完成、RUNNING 重复 start、失败错误保留、同 ID 重试原快照、终态不翻转以及完成/失败/取消两两竞争次序。稳定 ORACLE-* 标题作为可信运行必需集合；oracle、facts、package、上层 raw 与指令都在模型写范围之外。生成器另生成自己的业务断言，不复制 oracle。
