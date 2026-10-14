---
title: 无仓库副作用的契约公开入口
status: active
hue: 175
desc: 汇总契约纯核心及围栏感知的正文读取能力，导入时不初始化仓库或执行器。
code:
  - packages/spec-core/src/contracts/index.ts
---
# 无仓库副作用的契约公开入口

## raw source

业务细化和其他调用方需要共用契约能力，即使运行目录没有 Git 仓库，也能安全导入和处理已提供的文本。

## expanded spec

公开入口为 `@spexcode/spec-core/contracts`，语法权威属于 [[sync-contract-schema]]。入口导出契约类型、固定列定义、解析、引用图、验证、覆盖与影响、内容摘要，以及共用的 `parseFrontmatter` 和围栏感知 `parseParts`。具体职责由相应技术叶治理，不在入口复制业务实现。

入口依赖不得引入文件读取、Git、仓库根初始化或执行调度。导入并解析调用方源文本在无 Git 仓库目录中可用；真实文件由调用方提供。没有运行命令、代码生成、交付写权限或完成证据接口。

公开dependencyClosure供外部代码行为发现复用同一GAP依赖阻塞算法；它不传染FLOW归属或纯导航阻塞，也不添加图状态或运行副作用。

入口公开既有解析器的 contractTableCells，调用方读冻结表头、引用单元格与转义文本时复用同一语法，不另造分列器；该工具只处理传入字符串，无仓库或运行副作用。
