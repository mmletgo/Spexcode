---
title: LLM Manager 原生执行入口
status: active
code:
  - spec-cli/src/llm-manager-host.ts
related:
  - spec-cli/llm-manager/requirements.txt
---

# LLM Manager 原生执行入口

同一份已安装的 LLM Manager 提供供应商选路和执行。SpexCode 通过版本化入口加载 Manager 执行包，将已冻结的请求和工作目录交给相应能力。在本机控制面登记原进程并验证其停止、原生结果、工作树及 Git 证据。管理入口的错误使用固定分类，不携带配置或凭据。
