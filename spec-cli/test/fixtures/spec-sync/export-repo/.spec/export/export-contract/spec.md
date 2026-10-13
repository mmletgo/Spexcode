---
title: 导出事件服务契约
status: active
contract-schema: sync-v1
code:
  - src/export.js#ExportService
---
# 导出事件服务契约

## raw source

用户可以提交符合筛选条件的数据导出，任务完成后下载结果。此输入是固定业务验收夹具；decision:EXPORT-POLICY 表示测试作者提供的显式业务事实，只适用于夹具。

## expanded spec

适用域：内存任务，事件串行原子提交；START/COMPLETE/FAIL 由可信 worker 驱动，用户事件含当前 actor。真实 worker 超时、崩溃恢复、队列持久化和文件存储不在本服务范围，不能由此夹具推断这些产品能力已验证。下载结果是非空字符串引用，文件缺失不适用。权限只含当前所有者，不含管理员和持久授权。

### REQ

| id | goal | source | constraints | success | depends-on |
| --- | --- | --- | --- | --- | --- |
| REQ-EXPORT-01 | 提交筛选数据导出并下载完成结果 | user:raw | 遵守显式演示政策 | 成功任务可由所有者下载首次发布结果 | - |

### RULE

| id | scope | constraint | basis | authority | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- |
| RULE-EXPORT-01 | 提交及所有用户事件 | 非空actor可提交；CANCEL/RETRY/DOWNLOAD必须是当前所有者，下载时重新检查 | 权限事实 | export-contract | decision:EXPORT-POLICY | REQ-EXPORT-01 |
| RULE-EXPORT-02 | 提交 | key与非空字符串filter必需；同actor/key/filter返回同任务，不同filter拒绝且原任务不变 | 幂等政策 | export-contract | decision:EXPORT-POLICY | REQ-EXPORT-01 |
| RULE-EXPORT-03 | 生命周期 | 仅声明的状态事件处置合法；拒绝不改任务；完成与取消先提交终态者获胜 | 状态竞争政策 | export-contract | decision:EXPORT-POLICY | REQ-EXPORT-01 |
| RULE-EXPORT-04 | worker回调 | START/COMPLETE/FAIL的attempt与当前不同则返回原任务，不改变状态或发布 | 旧尝试隔离 | export-contract | decision:EXPORT-POLICY | RULE-EXPORT-03 |
| RULE-EXPORT-05 | 结果反馈 | 成功需非空result、发布一次；失败需非空reason；重复完成保留首次结果 | 结果和失败事实 | export-contract | decision:EXPORT-POLICY | RULE-EXPORT-03 |
| RULE-EXPORT-06 | 重试 | 仅FAILED可由所有者重试，保持ID，attempt加一并清除失败原因 | 重试政策 | export-contract | decision:EXPORT-POLICY | RULE-EXPORT-01,RULE-EXPORT-03 |

### FLOW

| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FLOW-EXPORT-01 | REQ-EXPORT-01 | 所有者,worker | 提交请求 | 权限和参数有效 | STEP-EXPORT-01,STEP-EXPORT-02,STEP-EXPORT-03,STEP-EXPORT-04 | STATE-EXPORT-SUCCEEDED,STATE-EXPORT-CANCELLED | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| FLOW-EXPORT-02 | REQ-EXPORT-01 | 所有者 | 失败后手动重试 | 任务FAILED且所有者有权限 | STEP-EXPORT-05 | STATE-EXPORT-QUEUED | rule:RULE-EXPORT-06 | RULE-EXPORT-06 |

### STEP

| id | flow | action | input | output | rules | next | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-EXPORT-01 | FLOW-EXPORT-01 | 校验并创建或找到任务 | actor,key,filter | QUEUED或既有任务；错误退出 | RULE-EXPORT-01,RULE-EXPORT-02 | STEP-EXPORT-02 | derived:FLOW-EXPORT-01 | RULE-EXPORT-01,RULE-EXPORT-02 |
| STEP-EXPORT-02 | FLOW-EXPORT-01 | 开始当前attempt | id,attempt | RUNNING或旧回调原任务 | RULE-EXPORT-03,RULE-EXPORT-04 | STEP-EXPORT-03 | derived:FLOW-EXPORT-01 | RULE-EXPORT-03,RULE-EXPORT-04 |
| STEP-EXPORT-03 | FLOW-EXPORT-01 | 完成、失败或取消 | result,reason,actor | 状态与反馈；失败或取消结束当前执行 | RULE-EXPORT-03,RULE-EXPORT-05 | STEP-EXPORT-04,TR-EXPORT-RUNNING-FAIL,TR-EXPORT-RUNNING-CANCEL | derived:FLOW-EXPORT-01 | RULE-EXPORT-03,RULE-EXPORT-05 |
| STEP-EXPORT-04 | FLOW-EXPORT-01 | 下载结果 | actor,id | 结果或明确拒绝 | RULE-EXPORT-01,RULE-EXPORT-03 | END | derived:FLOW-EXPORT-01 | RULE-EXPORT-01,RULE-EXPORT-03 |
| STEP-EXPORT-05 | FLOW-EXPORT-02 | 失败后重试 | actor,id | QUEUED与新attempt；不满足条件明确拒绝 | RULE-EXPORT-01,RULE-EXPORT-06 | STEP-EXPORT-02,TR-EXPORT-FAILED-RETRY | derived:FLOW-EXPORT-02 | RULE-EXPORT-01,RULE-EXPORT-06 |

### STATE

| id | object | meaning | initial | terminal | feedback | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| STATE-EXPORT-QUEUED | export-job | 等待执行 | true | false | 等待执行 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| STATE-EXPORT-RUNNING | export-job | 当前attempt执行中 | false | false | 当前attempt执行中 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| STATE-EXPORT-SUCCEEDED | export-job | 已发布结果 | false | true | 已发布结果 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| STATE-EXPORT-FAILED | export-job | 失败，可重试 | false | false | 失败，可重试 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| STATE-EXPORT-CANCELLED | export-job | 取消，禁止发布 | false | true | 取消，禁止发布 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |

### EVENT

| id | object | origin | trigger | input | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- |
| EVENT-EXPORT-START | export-job | worker | START | attempt,result,reason | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| EVENT-EXPORT-COMPLETE | export-job | worker | COMPLETE | attempt,result,reason | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| EVENT-EXPORT-FAIL | export-job | worker | FAIL | attempt,result,reason | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| EVENT-EXPORT-CANCEL | export-job | 所有者 | CANCEL | actor | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| EVENT-EXPORT-RETRY | export-job | 所有者 | RETRY | actor | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| EVENT-EXPORT-DOWNLOAD | export-job | 所有者 | DOWNLOAD | actor | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |

### TR

| id | object | from | event | condition | to | disposition | reason | effects | rules | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TR-EXPORT-QUEUED-START | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-START | 当前attempt | STATE-EXPORT-RUNNING | transition | 合法事件 | 不发布新结果 | RULE-EXPORT-03 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| TR-EXPORT-QUEUED-COMPLETE | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-COMPLETE | 当前attempt | STATE-EXPORT-QUEUED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-QUEUED-FAIL | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-FAIL | 当前attempt | STATE-EXPORT-QUEUED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-QUEUED-CANCEL | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-CANCEL | 当前所有者 | STATE-EXPORT-CANCELLED | transition | 合法事件 | 禁止结果发布 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-QUEUED-RETRY | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-RETRY | 当前所有者 | STATE-EXPORT-QUEUED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 |
| TR-EXPORT-QUEUED-DOWNLOAD | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-DOWNLOAD | 当前所有者 | STATE-EXPORT-QUEUED | reject | not-ready | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-RUNNING-START | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-START | 当前attempt | STATE-EXPORT-RUNNING | idempotent | 合法事件 | 不发布新结果 | RULE-EXPORT-03 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| TR-EXPORT-RUNNING-COMPLETE | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-COMPLETE | 当前attempt且result非空 | STATE-EXPORT-SUCCEEDED | transition | 合法事件 | 发布一次结果 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-RUNNING-FAIL | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-FAIL | 当前attempt且reason非空 | STATE-EXPORT-FAILED | transition | 合法事件 | 保留失败原因 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-RUNNING-CANCEL | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-CANCEL | 当前所有者 | STATE-EXPORT-CANCELLED | transition | 合法事件 | 禁止结果发布 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-RUNNING-RETRY | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-RETRY | 当前所有者 | STATE-EXPORT-RUNNING | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 |
| TR-EXPORT-RUNNING-DOWNLOAD | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-DOWNLOAD | 当前所有者 | STATE-EXPORT-RUNNING | reject | not-ready | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-SUCCEEDED-START | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-START | 当前attempt | STATE-EXPORT-SUCCEEDED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| TR-EXPORT-SUCCEEDED-COMPLETE | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-COMPLETE | 当前attempt | STATE-EXPORT-SUCCEEDED | idempotent | 已确定终态不改写 | 不发布新结果 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-SUCCEEDED-FAIL | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-FAIL | 当前attempt | STATE-EXPORT-SUCCEEDED | idempotent | 已确定终态不改写 | 不发布新结果 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-SUCCEEDED-CANCEL | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-CANCEL | 当前所有者 | STATE-EXPORT-SUCCEEDED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-SUCCEEDED-RETRY | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-RETRY | 当前所有者 | STATE-EXPORT-SUCCEEDED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 |
| TR-EXPORT-SUCCEEDED-DOWNLOAD | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-DOWNLOAD | 当前所有者 | STATE-EXPORT-SUCCEEDED | idempotent | 已确定终态不改写 | 返回已发布结果 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-FAILED-START | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-START | 当前attempt | STATE-EXPORT-FAILED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| TR-EXPORT-FAILED-COMPLETE | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-COMPLETE | 当前attempt | STATE-EXPORT-FAILED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-FAILED-FAIL | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-FAIL | 当前attempt | STATE-EXPORT-FAILED | idempotent | 已确定终态不改写 | 不发布新结果 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-FAILED-CANCEL | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-CANCEL | 当前所有者 | STATE-EXPORT-FAILED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-FAILED-RETRY | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-RETRY | 当前所有者 | STATE-EXPORT-QUEUED | transition | 合法事件 | attempt加一并清除原因 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 |
| TR-EXPORT-FAILED-DOWNLOAD | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-DOWNLOAD | 当前所有者 | STATE-EXPORT-FAILED | reject | not-ready | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-CANCELLED-START | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-START | 当前attempt | STATE-EXPORT-CANCELLED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03 | rule:RULE-EXPORT-03 | RULE-EXPORT-03 |
| TR-EXPORT-CANCELLED-COMPLETE | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-COMPLETE | 当前attempt | STATE-EXPORT-CANCELLED | idempotent | 已确定终态不改写 | 不发布新结果 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-CANCELLED-FAIL | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-FAIL | 当前attempt | STATE-EXPORT-CANCELLED | idempotent | 已确定终态不改写 | 不发布新结果 | RULE-EXPORT-03,RULE-EXPORT-05 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-05 |
| TR-EXPORT-CANCELLED-CANCEL | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-CANCEL | 当前所有者 | STATE-EXPORT-CANCELLED | idempotent | 已确定终态不改写 | 不发布新结果 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-CANCELLED-RETRY | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-RETRY | 当前所有者 | STATE-EXPORT-CANCELLED | reject | invalid-state | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01,RULE-EXPORT-06 |
| TR-EXPORT-CANCELLED-DOWNLOAD | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-DOWNLOAD | 当前所有者 | STATE-EXPORT-CANCELLED | reject | not-ready | 拒绝且任务不变 | RULE-EXPORT-03,RULE-EXPORT-01 | rule:RULE-EXPORT-03 | RULE-EXPORT-03,RULE-EXPORT-01 |
| TR-EXPORT-STALE-QUEUED-START | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-START | attempt不匹配 | STATE-EXPORT-QUEUED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-QUEUED-COMPLETE | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-COMPLETE | attempt不匹配 | STATE-EXPORT-QUEUED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-QUEUED-FAIL | export-job | STATE-EXPORT-QUEUED | EVENT-EXPORT-FAIL | attempt不匹配 | STATE-EXPORT-QUEUED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-RUNNING-START | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-START | attempt不匹配 | STATE-EXPORT-RUNNING | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-RUNNING-COMPLETE | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-COMPLETE | attempt不匹配 | STATE-EXPORT-RUNNING | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-RUNNING-FAIL | export-job | STATE-EXPORT-RUNNING | EVENT-EXPORT-FAIL | attempt不匹配 | STATE-EXPORT-RUNNING | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-SUCCEEDED-START | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-START | attempt不匹配 | STATE-EXPORT-SUCCEEDED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-SUCCEEDED-COMPLETE | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-COMPLETE | attempt不匹配 | STATE-EXPORT-SUCCEEDED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-SUCCEEDED-FAIL | export-job | STATE-EXPORT-SUCCEEDED | EVENT-EXPORT-FAIL | attempt不匹配 | STATE-EXPORT-SUCCEEDED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-FAILED-START | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-START | attempt不匹配 | STATE-EXPORT-FAILED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-FAILED-COMPLETE | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-COMPLETE | attempt不匹配 | STATE-EXPORT-FAILED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-FAILED-FAIL | export-job | STATE-EXPORT-FAILED | EVENT-EXPORT-FAIL | attempt不匹配 | STATE-EXPORT-FAILED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-CANCELLED-START | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-START | attempt不匹配 | STATE-EXPORT-CANCELLED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-CANCELLED-COMPLETE | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-COMPLETE | attempt不匹配 | STATE-EXPORT-CANCELLED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |
| TR-EXPORT-STALE-CANCELLED-FAIL | export-job | STATE-EXPORT-CANCELLED | EVENT-EXPORT-FAIL | attempt不匹配 | STATE-EXPORT-CANCELLED | idempotent | 旧attempt失效 | 返回原任务，不发布 | RULE-EXPORT-04 | rule:RULE-EXPORT-04 | RULE-EXPORT-04 |

用户事件无权限按RULE-EXPORT-01拒绝，状态和结果不变；RUNNING的空result/空reason按RULE-EXPORT-05拒绝且保持RUNNING，AC-EXPORT-02/03覆盖边界。

### AC

| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-EXPORT-01 | REQ-EXPORT-01,RULE-EXPORT-02 | 无任务 | 同键重试及改参数 | 同ID，冲突不改原任务 | tests/export.test.mjs#AC-EXPORT-01 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| AC-EXPORT-02 | RULE-EXPORT-01,RULE-EXPORT-02,RULE-EXPORT-05 | 未就绪任务 | 非法输入或空结果回调 | 明确拒绝，状态不变 | tests/export.test.mjs#AC-EXPORT-02 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| AC-EXPORT-03 | RULE-EXPORT-01 | 成功任务 | 其他actor下载、取消、重试 | 全部拒绝，原结果可由所有者下载 | tests/export.test.mjs#AC-EXPORT-03 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| AC-EXPORT-04 | TR-EXPORT-QUEUED-START,TR-EXPORT-QUEUED-COMPLETE,TR-EXPORT-QUEUED-FAIL,TR-EXPORT-QUEUED-CANCEL,TR-EXPORT-QUEUED-RETRY,TR-EXPORT-QUEUED-DOWNLOAD,TR-EXPORT-RUNNING-START,TR-EXPORT-RUNNING-COMPLETE,TR-EXPORT-RUNNING-FAIL,TR-EXPORT-RUNNING-CANCEL,TR-EXPORT-RUNNING-RETRY,TR-EXPORT-RUNNING-DOWNLOAD,TR-EXPORT-SUCCEEDED-START,TR-EXPORT-SUCCEEDED-COMPLETE,TR-EXPORT-SUCCEEDED-FAIL,TR-EXPORT-SUCCEEDED-CANCEL,TR-EXPORT-SUCCEEDED-RETRY,TR-EXPORT-SUCCEEDED-DOWNLOAD,TR-EXPORT-FAILED-START,TR-EXPORT-FAILED-COMPLETE,TR-EXPORT-FAILED-FAIL,TR-EXPORT-FAILED-CANCEL,TR-EXPORT-FAILED-RETRY,TR-EXPORT-FAILED-DOWNLOAD,TR-EXPORT-CANCELLED-START,TR-EXPORT-CANCELLED-COMPLETE,TR-EXPORT-CANCELLED-FAIL,TR-EXPORT-CANCELLED-CANCEL,TR-EXPORT-CANCELLED-RETRY,TR-EXPORT-CANCELLED-DOWNLOAD | 每个可达状态 | 分别提交六个当前事件 | 30项状态和拒绝均符合契约 | tests/export.test.mjs#AC-EXPORT-04 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| AC-EXPORT-05 | TR-EXPORT-STALE-QUEUED-START,TR-EXPORT-STALE-QUEUED-COMPLETE,TR-EXPORT-STALE-QUEUED-FAIL,TR-EXPORT-STALE-RUNNING-START,TR-EXPORT-STALE-RUNNING-COMPLETE,TR-EXPORT-STALE-RUNNING-FAIL,TR-EXPORT-STALE-SUCCEEDED-START,TR-EXPORT-STALE-SUCCEEDED-COMPLETE,TR-EXPORT-STALE-SUCCEEDED-FAIL,TR-EXPORT-STALE-FAILED-START,TR-EXPORT-STALE-FAILED-COMPLETE,TR-EXPORT-STALE-FAILED-FAIL,TR-EXPORT-STALE-CANCELLED-START,TR-EXPORT-STALE-CANCELLED-COMPLETE,TR-EXPORT-STALE-CANCELLED-FAIL | 每个可达状态 | 旧attempt回调 | 15项状态不变，不发布 | tests/export.test.mjs#AC-EXPORT-05 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| AC-EXPORT-06 | RULE-EXPORT-03,TR-EXPORT-RUNNING-COMPLETE,TR-EXPORT-RUNNING-CANCEL,TR-EXPORT-CANCELLED-COMPLETE | RUNNING | 两种完成与取消顺序 | 先提交终态获胜 | tests/export.test.mjs#AC-EXPORT-06 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| AC-EXPORT-07 | RULE-EXPORT-05,TR-EXPORT-SUCCEEDED-COMPLETE | SUCCEEDED | 重复完成 | 保留首次结果且只发布一次 | tests/export.test.mjs#AC-EXPORT-07 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
| AC-EXPORT-08 | RULE-EXPORT-06,TR-EXPORT-FAILED-RETRY | FAILED | 重试后旧成功，再新attempt成功 | ID保持、attempt增加，旧结果无效 | tests/export.test.mjs#AC-EXPORT-08 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |

### VERIFY

| id | command | cwd | timeout-ms |
| --- | --- | --- | --- |
| VERIFY-EXPORT-01 | ["node","--test","tests/export.test.mjs"] | . | 10000 |

当前固定业务事实没有未决GAP。没有实际测试输出时不能伪造通过证据；完整产品P0–P5的验证独立建立。
