---
title: 冻结候选与完整范围门禁
status: active
hue: 175
desc: 协调器验证固定文件JSON、CAS和真实完整diff后冻结并导出独立验证副本。
code:
  - spec-cli/src/sync/candidate.ts
---
# 冻结候选与完整范围门禁

## raw source

协调器是唯一文件写方，Agent 只提供固定 schema 数据。旧 attempt 继续写入不能改变候选和验证输入。

## expanded spec

模型响应使用同一文件语义 schema 的严格投影 CANDIDATE_RESPONSE_SCHEMA：所有对象属性 required，常量/枚举给出显式 type；mode 必填且可为 null，表示沿用已有普通文件 mode，新文件默认 100644。内部候选构造仍可省略 mode，null 与省略的最终树语义相同。模型响应先验证严格投影，不能以注入 runner 绕过。该投影遵循 [Structured Outputs 约束](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)，不能将本地 Ajv 接受等同于原生服务接受。

本节点实现 [[sync-coordination]] 与 [[sync-execution]] 的 P2 候选原语。sync-files-v1 JSON 仅接受 path、beforeDigest、beforeMode、content 和可选普通文件 mode；content 为 null 删除。新增/修改只接受有效 UTF-8 普通文件，未变 binary/symlink 不重写。仓库路径拒绝绝对路径、空段、点段、反斜线及任意 .git 元数据段；父文件/symlink、重复路径、越界和 digest/mode CAS 不匹配均拒绝。

以真实生成基线 tree（composed tree 或原 source tree）到冻结 candidate tree 的完整差量检查 allowed write scope，包含新增、删除和 mode-only 修改；不相信模型自报路径。actualDiffBlob 为 ApplyFilePlan[]，不存在文件对应 digest/mode null。manifest 为 version 1 的完整 entries，含 path/mode/Git OID/原字节 SHA256；digest 绑定不可变 tree、基线、来源、manifest、actual diff 与上层可信 ready/受影响 coveredScope。coveredScope 包含原外部输入需验证的路径，不等于实际模型修改路径；actualDiff 必须是该范围子集。外部修改 file 而模型仅新增 test 时，file 仍保留在验证范围。只有实际 V1–V4 Verification 覆盖才能推进 BaselinePair.coveredScope；路径整合/租约不能代替业务 contractIds/flowIds 和 GAP 的完成证据。最终 apply journal 应另算 currentTarget→candidate 的完整差量，不能混同模型差量。

私有 candidate ref 保活对象。验证导出独立空目录，普通文件和目录只读，链接不跟随且必须在导出范围内；不带 .git、node_modules 或宿主凭据（.env、.npmrc、.netrc、.ssh）和 .spex/runtime，业务 src/auth 等模块完整保留。排除文件明确返回清单并保存排除证据，不改变冻结候选摘要或假称排除范围已获运行覆盖。本原语不运行候选命令、不创建普通 session owned worktree、不 commit/merge。

同一宿主元数据边界由 isHostPrivatePath 导出给模型读集合门禁复用；只按明确路径分类，不以 auth 等业务词屏蔽源码。
