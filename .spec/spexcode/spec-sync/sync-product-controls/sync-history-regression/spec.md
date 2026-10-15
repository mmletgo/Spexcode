---
title: 成组补偿与版本回退应用回归
status: active
desc: 正式应用入口用真实Git与Docker验证成组新提交、重叠冲突、暂停与writer fencing。
code:
  - spec-cli/src/sync/application-history.test.ts
---
# 成组补偿与版本回退应用回归

## raw source

AC-SYNC-24 的成组撤销和版本回退必须由可运行入口证明，不能只靠 helper 或文档。

## expanded spec

真实 Git receipt 是显式受控前置，不把该种子手工登记的四层结果当作产品语义验证。正式 [[sync-application]] revert 入口随后以独立 fake harness 控制模型输出，完整经过原有行为分析、细化、生成、V1–V4、真实 Docker 验收与严格 hooks 的新 Git 提交。验证 Spec、代码、测试成组，祖先历史、同文件后续非重叠与无关编辑、原 source/index 保留；重放及运输 alias 不重置预算、不重复交付。真实重叠进入业务冲突并保留证据，不覆盖人类编辑或产生补偿提交。

stopWriter 验证物理暂停先持久化，当前观察/执行者停止，receipt 与 journal 不删除，新服务仍受暂停约束。v10 升级先 online backup，未来 schema 拒同步写入，既有会话仍可读取。原生 Agent 的完整实际补偿验收由上层产品交付证据承担，本回归不伪称执行了真实模型。

通过 SPEX_VERIFICATION_EVIDENCE_DIR 外放 SQLite 一致备份、实际 Git 对象与操作/尝试/journal，便于审阅新提交和未覆盖边界。

真实跨目录 rename 回归先以明确受控迁移交付为前置，再从正式 revert 入口恢复历史精确 Spec 路径，检查当前 leaf 授权原本不含该路径、补偿只增加该文件、源/测试目录权限保持、实际交付节点及全部业务 ID 连续。
