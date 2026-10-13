# Spec 同步验收夹具

`export-repo/` 是可直接复制到临时 Git 仓库的最小 UTF-8 输入，业务契约唯一来源为 `.spec/export/export-contract/spec.md`，代码治理由该叶节点 `code:` 绑定。无外部依赖，不安装 hooks。

- `variants/` 保存针对基线的统一补丁，先复制基线，再在副本 `git apply`；不在基线内维护第二份业务规则。
- 基线验证：`cd export-repo && node --test tests/export.test.mjs`。
- `missing-branch.patch` 删除 CANCELLED×COMPLETE 的处置，应被契约覆盖检查拒绝；代码测试仍绿不能代替契约完整。
- `missing-policy.patch` 提出重试政策 GAP，仅阻塞重试依赖，供细化与缺口投影验收。
- `conflicting-download.patch` 去掉下载时的权限检查，应使 `AC-EXPORT-03` 失败并由反写分类识别为显式规则冲突。
- 夹具仅定义内存服务的同步事件提交，不包含真实 worker、文件持久化或队列恢复；这些不适用事实明确写在契约中，不把缺失恢复政策伪装为完整产品。
- 测试标题稳定 ID 与 AC.test 保持一致；新增场景优先扩展最小夹具和断言，禁止只镜像实现。
- `verification-repo/` 是 V3 容器隔离夹具：普通子进程、只读候选/root、未挂载宿主敏感路径、无外网、stdout 伪报告；`hang.test.mjs` 用于真实超时和取消。必须经 Docker 执行器运行才能证明隔离，宿主 `node --test` 不能替代。
