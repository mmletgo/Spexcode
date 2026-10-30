---
title: 冻结三方行为分类与独立审查
status: active
code:
  - spec-cli/src/sync/code-behavior.ts
---
## raw source

外部代码和两边同改应依据真实共同验证基线自动协调；文本重叠不是业务冲突，模型自身错误不能成为新需求或批准。

## expanded spec

[[sync-code-writeback]] 的行为分析复用独立受限native会话及既有budget/checkpoint。完整旧source、已验证delivery/newsource、共同coveredScope和冻结raw/规则/调用/测试字节进入分析，原意与真实外部差量分别保留；未读取上下文或超预算拒绝，不截断断言。构建与审查session/thread独立，输出及完整readSet/policy/composed/input绑定；审查重新检查每个变化和实际影响路径。

分类为refactor、allowed_change、coverage_gap或conflict。重构不授权业务正文漂移；合法变化保外部行为、沿明确原意补齐必要状态边界及验收。过窄测试不能把允许行为反改成旧代码。每项发现含原意、原/新及双方行为、影响路径与ID、实际证据、具体反例和所需裁决，程序形成稳定ID。

原始作者raw/规则差量是已有用户授权，不重复提问；authorChanges由程序从冻结字节求语义差量并进入独审。AC更新proposal仅在合法已审REQ/RULE/TR变化与完整来源链成立时派生，不删验收或改VERIFY。独审proposal先冻结，程序再绑定真实analysisRef形成授权；模型不能自填作者证据或可信批准。

相容重叠必须提供完整整合正文并独审，不丢前次交付或合法外部行为。无治理新增代码自动定位真实上层raw、生成唯一治理叶；目标未知提出具体GAP，不跳过该文件。节点移动保业务ID及旧新路径证据，节点退役仍需逐项用户原意/裁决授权。裁决新操作重读原具体分析和不可变choice，在当前policy/readset下重新独审；未选冲突保持，仅选择采用行为保对应外部行为，保留原意/新规则按明确目标修代码。

交付内容被来源接受时属于三方回声，不能将详细表再次升为用户新授权；仅不同于旧来源与已交付业务含义的真实raw/REQ/RULE/TR作者差量形成authorChanges。裁决范围由不可变request及原独审所选finding程序派生结构化authority；既有ID只取旧图依赖闭包，新图闭包仅接新ID，候选不能靠新连边扩权。新的裁决独审全部findings保持有效，即使ID恰与已选择历史finding相同也阻其依赖。

没有成对已验证基线且精确selection的bytePair/intentPair全部为null时，当前精确绑定request/analysis/finding的authority可用原完整独审实际读取的composed契约图求旧范围。该图必须绑定原inputId及原analysis.composedDigest，并受原冻结readPaths和当前读取授权共同限定；受控正文的原composed可不同于source快照，不能改取source或当前图。历史authority、oldFrozen及verifiedDelivery语义不变，不制造已验证基线；当前新连边仍不能扩大旧ID范围。

公开作者删除：已采纳交付的准确作者基准中旧节点存在、新source真正缺失，独审allowed_change和对应Spec null整合方案成立时，程序从旧图生成全部旧身份逐项退役授权。当前裁决退役还须非keep选择、所选原finding精确含节点及全部旧身份范围；普通局部规则裁决不能删除整节点。无需调用者预注入plan退役权限，不能凭模型任意列表删验收。

受审Spec raw整合保sourceRaw真实来源及原immutable作者patch、deliveryRaw历史交付，resolvedRaw为完整相容整合，expectedRaw仅由真实原choice程序追加说明。proof在同analysis独审hash内；作者afterRaw/changedIds保持真实差量。真实raw-only作者种子只能经具体已独审AC提案、明确派生RULE/TR集合及目标旧来源关系授权；独立B裁决不阻作者A，也不赋未列无关规则改义权限。raw整合先按真实作者基准、source和delivery的Unicode细粒度编辑合成：无冲突部分逐字保留，只有双方真正交叠的不同局部编辑可由独审自动相容重述。裁决本身不豁免该边界；keep恢复被删Spec仅能恢复精确所选历史原raw，随后程序追加choice说明。产品源码排除.spec内治理/插件资源；未治理但已commit产品源码亦必须完整分析及独审治理，不依赖未提交diff才发现。

changedPaths从已采纳交付的逐路径作者基准与当前source真实差量，再联合delivery到composed差量形成；旧source完整上下文仍保留，已ff接受的生成Spec/tests不再次当本轮改动。精确selection的path binding为pairId:null时，base/delivery:null表示没有验证配对，不表示HEAD中该路径缺席；两段实际树差量保留既有比较条目（无共同基线时为HEAD），已commit且未改的只读上下文不造新增，真实修改、新增和删除仍须受审，已commit未治理业务源码仍经原newNodes/GAP归属门。无pair路径的旧source同样保留该真实旧来源全文，使删除文件仍在readablePaths内可完整受审；verifiedDelivery继续缺席，不把HEAD冒充共同已验证基线。真实pair中的base/delivery:null仍按对象缺席删除对应比较条目及旧source/verifiedDelivery视图。模型resolutions不得提前写未来治理叶或未改路径，普通合法变化交后续细化/生成；事实复用须source/text逐字相同，affectedIds只用契约图稳定身份，错误明确路径及非法ID便于自动修复。

AC提案的非作者raw来源必须精确引用本次已校验facts；单独的规则标识不是已绑定事实。独审checkedPaths只声明实际冻结读取且位于授权readPaths内的具体文件，元数据清单、目录名和符号链接不能冒充完整读取。独审路径校验失败时仍携带同次完整审查结果供下一轮诊断，保留业务遗漏和反例；该失败不产生分析批准或新授权。

分析与独审输入前置 requiredChangedPaths、unownedSourcePaths/unownedSourcePathCount 和具体 readablePaths；未治理源码子集与后置归属门复用同一判据，首次纳管的已存在/已提交实现及空初始化文件均按原角色纳入，不以 allowed_change 分组或旧文件身份替代真实 newNodes/GAP/conflict。newNodes 只绑定已有上层 raw 的对应职责，不产生新业务政策。readablePaths 从 oldSource/newSource/verifiedDelivery/composedFiles 的完整文本求出并逐路径标明所在快照；目录前缀授权覆盖新未跟踪源码，删除文件仍核旧全文，元数据或链接不是全文。虚拟冻结快照是唯一输入权威，cwd 的旧 HEAD 不替代冻结字节。必读集合保持真实 changedPaths；不得自动补 checkedPaths 冒充模型已读。前置清单及完整原上下文、repairDiagnostics 全部保留，超过2MiB由 [[frozen-context-reader]] 在同一受限执行器无损读取；分析和独审各自核完整原生读取证明。总预算仍约束，缺失或不完整读取拒绝，不截断正文或诊断。

分析和独审共同收到从冻结正文解析的 contractItems.previous/current 完整项，作为既有稳定身份及义务的索引；精确 selection 的资源名不替代契约定义，未通过 P1 结构检查或独审的候选不成为既有义务；已接受 P1 仍由后续冻结复用和生成保护，不成为 raw 或新的作者授权。raw-only 初始化尚无稳定业务 ID 时，按真实 raw、源码及完整测试分析，允许空 affectedIds/ruleIds，无阻塞发现时随后由 P1 建立详细契约并独审；不能虚构既有 ID 或仅因尚未展开提出 GAP，也不能借此跳过完整业务分析、独审、P1、生成或验证门禁。

raw-only 空关联例外由程序从冻结输入判定：没有成对已验证基线，精确 selection 也没有任何非 null bytePair/intentPair，且旧/当前契约图均无稳定业务 ID。该情形真实 conflict/coverage_gap 同样允许空 affectedIds/ruleIds，保原分类、路径、证据、反例及程序生成的 finding 身份进入独审；批准分析不等于批准业务完成，由 [[sync-coordinator]] 显式阻塞尚无契约关联的已审发现。存在任一已验证基线或任一图有稳定 ID 时仍要求非空 affectedIds；未知 ID、非法 ruleId、路径和完整独审门禁保持。

rawlessSpecPaths仅列出本轮changedPaths中的既有Spec节点：作者基准、当前source与composed必须逐字相同；有已验证基线时，verifiedDelivery也必须存在且逐字相同；无基线时delivery角色可以缺席。这些角色均不得含该节点raw，且不得存在当前裁决或生命周期写授权。对这些路径，分析只用facts/changes完整覆盖业务行为并交 [[sync-elaboration]] 初始化，必须保留原Spec字节且不产生任何resolution（包括content:null）；根/上游raw只作为只读上下文，不能填成该叶raw。真实作者/交付正文或raw差异、缺失的基准字节及显式裁决/生命周期授权不进入该列表，继续沿原相容整合、raw保真和逐项删除门禁处理。

冻结 plan.sourcePaths 存在时，它是业务源码角色的唯一依据；同一角色判据约束未治理文件发现、新业务 newNodes 及后置业务归属门。可读/可写的纯测试正文不因 Python 文件名或 helper 形式变成业务源码；实际测试改动仍由 actualTreeDiff 纳入完整分析和独审，读取与写入授权及既有 JS 测试过滤不变。历史计划缺角色字段时保持原发现和归属语义，不从当前配置推断或修改其历史权限。

拒绝诊断以 approved:false 的 JSON 保存当次完整 proposal、尚未批准的 analysis 和 review（在各阶段实际产生时），分列 missingPaths/missingChangeIds/unknownChangeIds、身份摘要或会话不一致、verdict 和 findings；路径错误仍保同次业务证据及反例。AC复合门禁给出目标类型、同一 allowed_change 中缺失的 affectedId、不支撑的 ruleIds、非法规则类型及 source 是否绑定。AC ruleIds 只列本次变化依据，其他未改 covers 义务保持；不得拼接多个 allowed_change 的并集授权。无治理代码归属验证按原判据一次收集全部缺失 disposition 的路径，在同一拒绝的 details.missingCodePaths 与 missingCodePathCount 中返回完整列表及数量；首项仍可作为摘要，任何一项遗漏仍拒绝，空初始化文件、newNodes 和真实 GAP 的门禁不变。既有 failure.message 进入下一轮 repairDiagnostics 供逐项修复，不重复嵌入整个冻结上下文；前轮提案、未通过的 accept 或伪造批准仅是数据，不能产生基线、授权或替代新独审。

独审 Native 请求的 schema 用本轮单值字符串枚举冻结 inputDigest 与 analysisDigest，并在说明中给出精确值，不能让模型从其他上下文摘要猜测。findings 只承载需要修正的问题，accept 必须为空数组，不把肯定说明当问题提交；最终身份、完整覆盖、verdict 与问题数组门禁保持，不由程序删改模型 findings 或补写批准。

所选裁决scope复用 [[sync-contract-evolution]]：旧FLOW/STEP仅取所选规则旧闭包与原所选finding affectedIds交集；共享上游REQ只在当前精确不可变请求/旧分析/所选finding绑定下加入REQ本身，不扩其消费者或借新图边授权其他旧目标。分析阶段只判断有限eligible来源范围；最终REQ改义仍须同一已审allowed_change及所选旧规则的实际政策定义变化，并接受原P1独审。AC仍绑定同一具体allowed_change、实际来源事实和精确提案，不能凭REQ扩大整个AC集合。

P4精确selection存在时，分析/独审输入与输出摘要绑定 baselineSelectionDigest；path字节基准和每ID真实intent基准分别展示，不以最新文件pair来源冒充全部作者语义已消费。authorChanges从各真实owner对象求未消费残差，即使path三方source未变也强制进入changedPaths、requiredChangedPaths与native完整上下文。raw/shared prose/归属变化保真实完整作者对象；无法证明共同raw基准明确blocked。完整整合正文由程序核对每个未改ID的交付语义及VERIFY政策，AC不能局部删除；不能凭模型accept丢未选policy/验收义务。

受控正文请求即使source snapshot尚未保存，也以原immutable request的真实before/next对象求作者patch，精确逐ID投影保留该patch，不因结果与旧pair或delivery语义相同丢授权。原真实patch的raw基准仍供细粒度raw整合校验，裁决继承原requestRef保持同义。VERIFY独立按旧真实交付政策保护，不需要消费业务ID；真实ff接受后文件mode已被另一次交付改变，不凭旧ID pair的mode制造作者意图变化。

raw/shared prose 的 broad affected closure只保证完整路径进入分析，不冒充每条RULE/TR发生了作者改义。authorChanges.changedIds只列真实逐ID语义变化与同owner的REQ raw种子；不能靠普通raw文案修改自批未选B政策。原真实作者残差与受控patch并存时，raw整合仍以真正未消费的完整作者基准保此前残差，不能用request.before掩盖它。

代码作者残差与Spec作者授权分开：code-only残差不升格user:raw，仍进入requiredChangedPaths与独审。逐真实intent pair的code/test全文按实际path/mode/OID去重进入intentArtifactFiles；旧source字节视图仍保真实byte pair，不拼造跨pair的全局作者文件。完整源码整合逐三方核确定编辑及mode；真实Git重叠行允许独审解决，但其外固定代码行和未选B确定编辑须逐字保留。Unicode重复代码锚点不能误拒真实Git行重叠，也不能用于删除Bpolicy、弱化权限或回退已交付mode。

成组历史请求的真实 Spec、代码与测试差量作为明确作者输入展开；多个真实 before/next 不互相覆盖作者基准。用户明确请求撤销后，可信应用仅从固定成组树实际删除的身份派生既有 user:raw 退役授权；模型不能扩大该集合。当前独审仍检查未选义务、后续编辑及业务冲突；原可信执行命令和独立测试保持门禁，不能借撤销自免验证。

原可信计划已逐项授权同来源节点退役时，分析仍核实际删除、全部旧义务及独审，但不再派生同 ID 的重复退役授权；避免同一次成组用户请求因重复授权被误拒。

行为分析只能派生本次受审变化对应的验收或退役授权，不能产生恢复退役身份的授权。恢复同一历史对象须由正式撤销入口、固定不可变历史请求及原已结算 receipt 逐项证明；普通作者 raw 或模型声明不能替代该来源链。

成组补偿的新 source 已应用删除或移动时，controlledBeforeFiles 独立保留 immutable group.before 的真实完整文本并纳入独审 readablePaths；该当前作者前置不叫 verifiedDelivery。缺少旧交付基线时，旧 authority 仍能从这一真实 preimage 检查节点迁移及原业务 ID，不能因组后文件消失丢掉必读全文或退役义务。

冻结文本视图直接消费 [[sync-input-snapshot]] 同次批量读取中已核对 OID 的完整原字节，不在摘要读取后为每个 blob 再启动 Git。输出路径顺序、全文和摘要保持与逐对象读取一致；readPaths、symlink mode、host-private 和 UTF-8/二进制过滤保持原判据，不截断、不跨调用缓存，也不改变后续作者差量或独审语义。

冻结上下文中的 nonTextFiles 保留授权路径的完整非文本 Git 对象，按 path/mode/OID 去重并列出真实所属快照及 digest、kind、encoding、content；binary 以完整 base64 表示，symlink 仅保存链接 blob 的目标字节（有效 UTF-8 否则 base64），永不跟随宿主目标。精确 selection 的真实pair中base/delivery null同步表示对象缺席，不借当前HEAD伪造已验证旧全文；无pair时仅oldSource保留真实旧来源对象，verifiedDelivery仍缺席。受控 before/source 及 intent artifact 同样按真实对象投影。readablePaths 的 nonTextFiles.快照名只指向这些完整 payload，元数据和链接目标路径本身仍不能冒充目标正文；真实非文本变化、删除和 requiredChangedPaths/changes/checkedPaths 覆盖保持，不通过过滤非文本消除缺口。所有字节先经原 Git OID 核验，readPaths 与 host-private 边界保持；原文本视图只含真实 UTF-8 普通文件。完整字节可读不等于已理解图片或 wheel 业务含义，raw 真实依赖而不可解释的语义仍须具体 GAP，不自动改成 allowed_change 或产生业务批准。

冻结输入显式给出真实 snapshotTree，并保留 composed.tree 身份。相同 Git 树只证明对应路径的对象字节及 mode 相同，不证明语义相容或业务通过。分析不得编造输入/工具未提供的 hash、AST 或执行校验证据，不把手工重抄、转义或反转义片段的推算冒称冻结原对象校验；真正不可解释且原意依赖的语义继续保留具体 GAP，完整独审与后续门禁不变。

行为分析与独立评审使用协调器传入的固定操作 model，历史缺省 sol；不把 model 加入业务语义上下文或改写旧证明，实际结构化请求仍绑定模型，遵循 [[sync-model-selection]]。

发送给 Native 分析/独审前的最后 JSON 使用 `textEncoding: "sha256-body-entry-v2"` 与 `bodyIndex`。六个文本视图保留路径顺序、各对象角色与来源；intentArtifactFiles/authorByteProjections保留path/mode/oid/digest，只把text改为bodyRef；nonTextFiles同样只把content改为bodyRef，原kind/encoding与全部元数据不变。bodyRef是原content字符串的SHA-256；每个唯一optional content用一个UTF8 entry（json-string-v1）；所有角色升级结束后，required content按bodyRef排序合成一个json-object-v1对象entry，值直接使用完整字符串的JSON编码，避免逐小文件Native往返。所有U+FEFF写为JSON转义，避免任一对齐分段开头被旧reader去掉；读取全文后JSON解析一次，required再按bodyRef取值还原原字符串，保留BOM、中文、CRLF及完整base64。bodyIndex自述entryId、kind、encoding、运输字节sha256/byteLength、原字符串contentByteLength和required（required locator共用完整对象entry的运输身份）；原Git对象digest继续绑定实际原字节。同一正文任一角色必读即必读，去重不丢来源、路径或mode。正文不嵌入必读元数据，另附纯JSON frozenEntries，由prepareFrozenPrompt在真实attempt/policy与派发摘要前冻结；持久计划只保留最终ref。required来自changedPaths的全部实际版本（含删除前）、全部冻结业务规格全文及frontmatter code/related实际引用（raw-only也适用，复用既有精确路径、目录、glob、#symbol语法）、AC.test、mandatoryTests、code事实来源、当前作者before/after、controlled与intent artifacts。无关未改且未引用的文本、二进制或链接本体均可optional，仍完整存在同一私有清单、授权与inputDigest中，链接不跟随宿主。inputDigest绑定完整逻辑元数据、全部正文SHA和角色；不递归提取任意元数据字符串。分析实际引用的facts/changes/newNodes/resolutions路径必须在分析精确turn完整覆盖；独审除了自己的checkedPaths，还须独立覆盖所批准分析的全部这些引用路径，不能借分析证明。缺证明、部分覆盖、目录或只有bodyRef均不算全文；证明只来自可信runner。其余ownership、checkedPaths、序列化前业务对象及后续完整独审、生成与验收门禁不变。旧已持久请求和证明原样恢复，不就地改写旧wire或响应。

当 `composed.authorProjectionBlob` 直接指向 `canonical-author-projection-v1`，或指向 `selected-author-projection-v1` 且沿其 `priorProjection` 引用链解析到该版本时，冻结上下文额外提供受 `plan.readPaths` 限定且排除 host-private 路径的 `authorByteProjections`，保留每项 snapshotId/path 与原 before/after mode/OID/digest，并读取Git对象中的完整 UTF-8 正文。两端正文使用同一 body table。各文本视图保留其实际来源/派生树字节；compositionEvidence 的 source 可来自 author-clean 投影，需按 `authorByteProjections` 核对对应 snapshotId/path 的投影前后对象，不把此角色差异当数据损坏或新业务政策。非 canonical 语义投影元数据保持原样。


v2 分区执行携带显式 partition.id/changedPaths；分析及独审仅对本区真实差量负责，不把其它未治理文件重新并入普通事件。原 v1 没有该字段时保留历史发现语义。plan.commitTrigger.before 可在没有共同验证基线时提供真实旧来源，verifiedDelivery 仍为空，不冒充已验证交付。前态必须同物理来源且完整snapshot验证通过。分区 native 输入按本区读取闭包投影来源、正文索引、语义残差、裁决及路径元数据；程序仍用原完整不可变对象核授权。聚合仅保独立原件引用与唯一变更并集，不伪造一次全局模型独审。


无验证基线的v2提交前态可证明真实作者删除：作者差量对照真实oldSource，不把不存在的delivery当作已经消费了删除。冻结verifiedDelivery角色仍为空，不能冒称验证交付；退役逐项授权和独审继续要求真实before→source删除、原义务ID及null resolution。


分区裁决仍向生成和独审保留原previousComposed不可变引用及previousReadPaths元数据，证明原完整独审契约图的真实身份与范围；只投影previous.analysis的本区事实及变更，不能丢失原组合身份。原范围元数据不是本区未提供正文的已读证明，也不扩充本区写权限或伪造verifiedDelivery角色。
