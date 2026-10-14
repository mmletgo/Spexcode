---
title: scoped-read-urls
status: active
hue: 195
desc: 读取 URL 以同一 targetTree 贯穿正文、历史、附件及源码。
code:
  - spec-dashboard/src/data.js#specUrl
  - spec-dashboard/src/data.js#readScopeUrl
  - spec-dashboard/src/data.js#fetchNodeFiles
  - spec-dashboard/src/data.js#fetchNodeFileSlice
  - spec-dashboard/src/data.js#fetchSourceSlice
  - spec-dashboard/src/data.js#fetchDirEntries
related:
  - spec-dashboard/src/data.test.mjs
---
# scoped-read-urls

读取 URL 以同一 targetTree 贯穿正文、历史、附件及源码。

复用现有 specUrl、分页读取和项目 API 前缀，targetTree 作为 query 追加，既有 name/path/offset/limit 等选择器必须保留。缺省仍读取后台 root；非法或失效树的失败直接抛出，不二次请求 canonical。
