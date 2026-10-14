---
title: 三方原意整合的共同字节保护
status: active
desc: 自动合成确定编辑，限制独审相容重述到真实重叠区域，并保留共同未改原意。
code:
  - spec-cli/src/sync/raw-integration.ts
related:
  - spec-cli/src/sync/raw-integration.test.ts
---
# 三方原意整合的共同字节保护

## raw source

正常相容修改自动整合，不重复询问用户；合并原意必须保留双方共同未改的权限和其他业务约定，不能借某处重叠或已有裁决改写整段需求。

## expanded spec

[[sync-elaboration]] 的三方 raw 整合使用原共同基线、真实作者 source、已验证 delivery 和独审 resolution 的精确字节。两侧相同编辑或没有真实交叠的编辑有唯一合成结果，候选必须逐字相同；source 与 delivery 相同时也不能由模型另写原意。

按 Unicode 字符定位多处编辑，分别保留夹在中间和两侧的共同未改字节，不用整段共同前后缀把中间不变义务吞进可改区域。只有两侧不同编辑真正交叠的局部区域可由独审相容整合；其余固定片段及确定编辑仍必须逐字、按原顺序保留。门禁只核字节来源，不把文本重叠当成业务冲突或自动要求人工确认；局部相容重述的语义正确性仍由独立审查负责。

`validateRawIntegration(base, source, delivery, resolved)` 是无副作用纯函数，返回违反固定字节或确定合成结果的错误列表。节点恢复及用户裁决后缀由调用者从真实冻结输入派生，不提供任意整段原意改写豁免。
