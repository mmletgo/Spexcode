---
title: LLM Manager 原生执行入口
status: active
code:
  - spec-cli/src/llm-manager-host.ts
related:
  - spec-cli/llm-manager/requirements.txt
  - spec-cli/llm-manager/native-runtime.mjs
  - spec-cli/src/sync/model-settings.test.ts
---

# LLM Manager 原生执行入口

同一份已安装的 LLM Manager 提供供应商选路和执行。SpexCode 通过版本化入口加载 Manager 执行包，将已冻结的请求和工作目录交给相应能力。在本机控制面登记原进程并验证其停止、原生结果、工作树及 Git 证据。管理入口的错误使用固定分类，不携带配置或凭据。

启用组选路的宿主使用该 Python 安装所带执行包。没有配置组选路时，同一 Manager 源提交构建的原生执行包由 SpexCode 发行版携带，供显式 CLI 和独立安装使用。供应商协议源码在 Manager 维护。

托管 Codex 大审查从已安装执行包加载持久 App Server 原生适配器，按 Manager 公开能力验证实际可执行文件。该适配器负责原生配置、模型目录、动态工具协商、精确轮次与历史形态、可见输出、精确中断及归档原件验证。宿主负责 Git 候选、冻结业务字节、原 generation 和停止权限。捕获完整原生归档后，同原请求可关闭本机服务再复核；回读严格匹配原载体和已接受的历史摘要。
