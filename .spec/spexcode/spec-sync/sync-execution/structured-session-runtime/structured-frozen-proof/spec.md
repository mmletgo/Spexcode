---
title: 结构化原生证明派发
status: active
code:
  - spec-cli/src/structured-frozen-proof.ts
---
# 结构化原生证明派发

## raw source

结构化会话和持久资源重放应校验对应原生provider的真实证明，不能混用证明或改变旧记录算法。

## expanded spec

版本4沿 [[zcode-frozen-proof]] 核对完整见证与输出，拒绝附带Codex读取额度；其它版本原样委托 [[frozen-context-reader]]。单向薄派发避免原始覆盖算法与provider证明模块互相导入，不新增执行队列或变换历史字节。
