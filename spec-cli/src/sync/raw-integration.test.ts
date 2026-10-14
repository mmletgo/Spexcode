import assert from 'node:assert/strict'
import test from 'node:test'
import { validateRawIntegration } from './raw-integration.js'

test('相同双方原意不能借代码变化或keep裁决取消未改所有者权限', () => {
  const raw = '用户可以提交符合筛选条件的数据导出，任务完成后下载结果。任何下载均须当前所有者权限。'
  assert.deepEqual(validateRawIntegration(raw, raw, raw, raw), [])
  assert.ok(validateRawIntegration(raw, raw, raw, '以后任何人均可下载任何导出结果，无须所有者权限。').length)
})

test('同一raw行的独立A/B编辑必须精确合成，权限C不能被顺便弱化', () => {
  const base = '用户可以提交符合筛选条件的数据导出，任务完成后下载结果。任何下载均须当前所有者权限。'
  const source = base.replace('符合筛选条件', 'filter最多128字符'), delivery = base.replace('下载结果。', '下载结果并显示完成时间。')
  const resolved = source.replace('下载结果。', '下载结果并显示完成时间。')
  assert.deepEqual(validateRawIntegration(base, source, delivery, resolved), [])
  assert.ok(validateRawIntegration(base, source, delivery, resolved.replace('任何下载均须当前所有者权限。', '任何人均可下载任何导出结果，不要求当前所有者。')).length)
  assert.ok(validateRawIntegration(base, source, delivery, source).length)
})

test('真重叠区域允许独审相容重述，区域外共同义务保持原字节', () => {
  const base = '当前所有者下载；筛选范围为ABC；下载后记录审计。'
  const source = base.replace('ABC', '123'), delivery = base.replace('ABC', '456')
  assert.deepEqual(validateRawIntegration(base, source, delivery, base.replace('ABC', '同时满足123和456的相容范围')), [])
  assert.ok(validateRawIntegration(base, source, delivery, '任何人下载；筛选范围为同时满足123和456的相容范围；下载后记录审计。').length)
})

test('两侧多处编辑保留中间共同C，不能用单个前后缀粗区间吞掉它', () => {
  const base = '甲=ABC；仅当前所有者可下载；乙=XYZ。'
  const source = base.replace('ABC', '123').replace('XYZ', '789'), delivery = base.replace('ABC', '456').replace('XYZ', '012')
  assert.deepEqual(validateRawIntegration(base, source, delivery, '甲=123且456；仅当前所有者可下载；乙=789且012。'), [])
  assert.ok(validateRawIntegration(base, source, delivery, '甲=123且456；任何人可下载；乙=789且012。').length)
})

test('Unicode字符、多位置确定编辑及相同编辑精确组合', () => {
  const base = '😀参数A=甲；所有者🔐；参数B=乙；审计🧾。'
  const source = base.replace('甲', '甲乙').replace('审计🧾', '持久审计🧾'), delivery = base.replace('乙；审计', '丙；审计')
  const resolved = source.replace('乙；持久审计', '丙；持久审计')
  assert.deepEqual(validateRawIntegration(base, source, delivery, resolved), [])
  assert.ok(validateRawIntegration(base, source, delivery, resolved.replace('🔐', '🔓')).length)
  const same = base.replace('甲', '128')
  assert.deepEqual(validateRawIntegration(base, same, same, same), [])
  assert.ok(validateRawIntegration(base, same, same, `${same}任何人可下载。`).length)
})

test('基线为空及单侧插入删除都属于确定结果', () => {
  assert.deepEqual(validateRawIntegration('', '新增原意😀', '', '新增原意😀'), [])
  assert.ok(validateRawIntegration('', '新增原意😀', '', '不同原意😀').length)
  assert.deepEqual(validateRawIntegration('甲乙丙', '甲丙', '甲乙丙', '甲丙'), [])
  assert.deepEqual(validateRawIntegration('所有者。', '所有者。审计。', '所有者。时间。', '所有者。审计并显示时间。'), [])
})

test('插入恰好位于另一侧替换边缘仍有确定组合，不误放整段相容重写', () => {
  assert.deepEqual(validateRawIntegration('ABC权限', '前言ABC权限', '123权限', '前言123权限'), [])
  assert.ok(validateRawIntegration('ABC权限', '前言ABC权限', '123权限', '任意正文权限').length)
  assert.deepEqual(validateRawIntegration('权限ABC', '权限ABC审计', '权限123', '权限123审计'), [])
})

test('共同片段不能换序或被只保留部分的重复字节冒充', () => {
  const base = 'A=ABC；共同权限；B=XYZ；共同审计。'
  const source = base.replace('ABC', '123').replace('XYZ', '789'), delivery = base.replace('ABC', '456').replace('XYZ', '012')
  assert.ok(validateRawIntegration(base, source, delivery, 'A=123且456；共同审计；B=789且012；共同权限。').length)
  assert.ok(validateRawIntegration(base, source, delivery, 'A=123且456；B=789且012；共同审计。').length)
})
