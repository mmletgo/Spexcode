import test from 'node:test'
import assert from 'node:assert/strict'
import { HARNESS_IDENTITIES } from '@spexcode/spec-core'
import { RUNTIME_HARNESSES } from './harness.js'

test('full harness adapters project the one identity registry', () => {
  assert.deepEqual(
    RUNTIME_HARNESSES.map(({ id, sessionEnvVar }) => ({ id, sessionEnvVar })),
    HARNESS_IDENTITIES,
  )
})
