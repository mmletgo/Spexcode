import assert from 'node:assert/strict'
import test from 'node:test'
import { relationClaimsPath } from './anchors.js'

test('globstar目录可匹配零层或多层目录，普通星号不跨目录', () => {
  const claim = 'src/helpers/**/*.js'
  assert.equal(relationClaimsPath(claim, 'src/helpers/format.js'), true)
  assert.equal(relationClaimsPath(claim, 'src/helpers/nested/format.js'), true)
  assert.equal(relationClaimsPath(claim, 'src/helpers/nested/deeper/format.js'), true)
  assert.equal(relationClaimsPath(claim, 'src/helpers/format.ts'), false)
  assert.equal(relationClaimsPath('src/helpers', 'src/helpers/format.js'), true)
  assert.equal(relationClaimsPath('src/helpers/format.js', 'src/helpers/format.js'), true)
  assert.equal(relationClaimsPath('src/*.js', 'src/format.js'), true)
  assert.equal(relationClaimsPath('src/*.js', 'src/nested/format.js'), false)
  assert.equal(relationClaimsPath('src/**', 'src/format.js'), true)
  assert.equal(relationClaimsPath('src/**', 'src/nested/format.js'), true)
})
