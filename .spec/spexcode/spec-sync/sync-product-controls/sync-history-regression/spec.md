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

真实重叠撤销用例先回到原operation冻结的来源分支，正式重新启用并核对完整身份后才修改代码；原业务冲突、无补偿提交、保留人类编辑与index断言保持，不以放宽来源或分区门槛取得通过。

真实 Git receipt 是显式受控前置，不把该种子手工登记的四层结果当作产品语义验证。正式 [[sync-application]] revert 入口随后以独立 fake harness 控制模型输出，完整经过原有行为分析、细化、生成、V1–V4、真实 Docker 验收与严格 hooks 的新 Git 提交。验证 Spec、代码、测试成组，祖先历史、同文件后续非重叠与无关编辑、原 source/index 保留；重放及运输 alias 不重置预算、不重复交付。真实重叠进入业务冲突并保留证据，不覆盖人类编辑或产生补偿提交。

stopWriter 验证物理暂停先持久化，当前观察/执行者停止，receipt 与 journal 不删除，新服务仍受暂停约束。v10 升级先 online backup，未来 schema 拒同步写入，既有会话仍可读取。原生 Agent 的完整实际补偿验收由上层产品交付证据承担，本回归不伪称执行了真实模型。

通过 SPEX_VERIFICATION_EVIDENCE_DIR 外放 SQLite 一致备份、实际 Git 对象与操作/尝试/journal，便于审阅新提交和未覆盖边界。

真实跨目录 rename 回归先以明确受控迁移交付为前置，再从正式 revert 入口恢复历史精确 Spec 路径，检查当前 leaf 授权原本不含该路径、补偿只增加该文件、源/测试目录权限保持、实际交付节点及全部业务 ID 连续。

恢复同一历史退役对象的回归保留原 receipt、退役账本、旧节点与业务 ID，验证完整 Spec、代码、验收及映射成组恢复；不得通过移除历史退役记录或放开新业务复用 ID 获得通过。

历史child种子在交付前由现有完整冻结契约检查断言零error，涵盖无状态FLOW/STEP/RULE及真实代码测试绑定。原node tombstone与REQ/FLOW/STEP/RULE/AC均进入真实已结算head；精确恢复后再运行普通源码编辑，检查旧退休pair不改且较新node/业务ID head保持可推进。错误receipt/operation、错误ID/路径及仅伪source均不授恢复权。

完整恢复回归包含child自身VERIFY及种子前明确可信固定命令登记；正式恢复后直接读取node/VERIFY和业务head，必须绑定新receipt，再验证普通后继修改。

明确 fixture 建立真实 Git 已结算 receipt 并采纳到原来源后，正式 commit-only 观察沿既有 baseline 消除回声：重复扫描无新 operation、无派发和模型调用；该种子不充当真实模型或 Docker 验收。writer-fencing 的旧 reader 拒绝断言跟随当前实际迁移代数，不固定过时的未来版本号。

receipt 消费边界回归复用明确受控四层种子及真实 Git journal：C0 作者 code 输入形成仅写 Spec 的已结算交付，公开 adopt 正式采纳 D；在线观察或停机采纳后启动补偿均对 D 零派发并保存 baseline 消费证据。重建应用实例后 C1 仅提交代码，origin 必须为 code，before 精确等于 D，paths 不包含生成 Spec。先复现旧 before 跨过 D 导致 combined，再证明修复；暂停期间新的 Spec/code 提交保持未消费，恢复时累计两者并沿真实前态。种子不是实际模型或 Docker 语义验收，测试禁止模型调用。

混合旧新资源heads回归以两次真实settled receipt建立：初始化后分别仅改变sync.model或可信Docker验证image/platform并正式重新启用，局部新交付保留旧源码bytehead，再经公开adopt实际写回。先复现旧context使操作2变3的echo，再证明首次物理pause只读扫描无failure/派发，resume及重复扫描不重开。原receipt和外部操作不伪结算。frontier到parent含未消费code/业务Spec/只读docs的混合输入首次仍准入，重复后其完整真实输入与状态保留。外部同tree后继不被冒认为receipt，之后纯代码提交仍为code。四层种子明确受控，只证明消费机制与真实Git边界，不冒称模型或Docker通过。
