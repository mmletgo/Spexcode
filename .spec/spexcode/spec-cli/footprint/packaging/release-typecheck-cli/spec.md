---
title: CLI 源码类型检查范围
status: active
hue: 175
desc: TypeScript源码与真实JavaScript运行时在同一模块图中检查，不用声明文件遮蔽待发布模块。
code:
  - spec-cli/tsconfig.json
---
# CLI 源码类型检查范围

## raw source

源码检查通过后，正常构建及发布也必须提供真正可导入的运行时，不能只有类型声明。

## expanded spec

CLI检查保持strict/noEmit，使用allowJs与NodeNext构建的运行时文件范围一致。独立.mjs模块的公开接口由精确JSDoc提供类型，不放同名.d.mts造成编译器只选声明而漏发运行时。类型检查不替代正常构建、发布清单与真实import；验证运输产物见[[verification-transport]]。
