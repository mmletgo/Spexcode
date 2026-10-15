---
title: 同步操作的真实文件差异
status: active
code:
  - spec-cli/src/sync/diff-read.ts
related:
  - spec-cli/src/sync/diff-read.test.ts
---
# 同步操作的真实文件差异

用户按文件审阅同一操作的代码、测试和 Spec 差异。候选差异比较组合输入与冻结候选，交付差异比较操作的交付基线与冻结候选；未取得 settled receipt 时只能表示候选交付内容，不能表示已经落地。

request 差异比较原始输入 immutableTree 与受控用户请求的完整 requestTree；正文编辑仅返回其实际 Spec 路径，sync.history 成组补偿只允许唯一历史验证器核实的 changes[].path。该精确路径列表包含新增、删除及 rename 旧新两边，界面逐项按 path 请求，不用节点或目录猜测扩权；不要求已产生候选。它展示准确新增和删除内容，始终不作为交付证明。来源后续编辑、删除或移动不影响按固定对象阅读历史请求，也不会因读取历史而修改来源。

读取先校验候选摘要与真实 Git tree，且文件必须属于相应完整实际差量。只接收仓库相对路径，不接受调用者提供 Git 对象、引用或命令；禁止宿主认证/运行路径。使用 literal pathspec 并禁用 external diff、textconv 和 rename 推断。结果完整返回固定对象身份与 patch，超过 2 MiB 明确拒绝，不能截断后显示为完整证据。读取不修改任何工作树、index 或引用。

是否已交付只能由同候选的 settled journal receipt 证明。后续源文件编辑不改变历史候选差异；来源、当前输入是否陈旧仍由应用详情独立展示。需求归属 [[sync-product-controls]]。


裁决若继承原controlled正文或sync.history请求，request差异读取originalRequestBlob完整tree，保原用户提交差量且不冒充采用行为后的生成结果；无原请求差量的裁决明确404，使用固定选择证据审阅，不抛body解析500或伪造空diff。历史请求始终复用readHistoryRequest核真实Git三方、固定输入及完整changes，不信任任意填写的路径或tree；范围外及宿主私有路径仍404，不读取请求路径对应的live文件。
