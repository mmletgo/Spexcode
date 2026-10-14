---
title: 同步应用影响计划
status: active
hue: 175
desc: 复用冻结契约图与旧节点治理，构造可信读写闭包。
code:
  - spec-cli/src/sync/planning.ts
---
# 同步应用影响计划

## raw source

已有功能或高层自然语言节点都复用治理及契约影响；授权目录内可创建实现和测试，不能要求用户逐函数写计划或漏掉共享权威节点。

## expanded spec

[[sync-application]] 从 source snapshot 读取 Spec，复用 loadSpecs、readFrozenContracts 和 contractImpact，不维护第二份业务图。初始上下文仅读 Spec，不把整仓未授权文件或凭据转成字符串。目标包含意图节点、其子节点、图影响节点和共享代码治理闭包；related 不计治理。受影响 code/test 必须在 [[sync-application-settings]] 的授权或独立保护测试登记，否则显示未授权路径。

readPaths 纳入冻结 Spec、版本化配置、授权源码/测试目录、额外 readPaths、影响代码/测试及保护测试；writePaths 只含目标 Spec 精确路径和 source/test 授权目录。目录授权允许新自然语言需求创建实现，不授权任意磁盘或模型创造新 raw 意图。plan 传递 facts、精确 verification 和 mandatoryTests 给 coordinator；全部 source/composed 差量仍经过完整 read/write 检查，不能偷偷交付未验证的其它 dirty 修改。V4 重新构造当前 plan，不能沿用旧影响自证。
