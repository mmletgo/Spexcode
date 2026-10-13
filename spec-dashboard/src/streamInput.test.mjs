import test from 'node:test'
import assert from 'node:assert/strict'
import { subscribeBoardLive } from './data.js'

test('the existing stream invalidates file reads on full input and reconnect ready, never session frames or ping', () => {
  const previous = globalThis.EventSource
  const listeners = new Map()
  let connections = 0
  globalThis.EventSource = class {
    constructor() { connections += 1 }
    addEventListener(name, callback) { listeners.set(name, callback) }
    close() {}
  }
  let inputs = 0
  const stop = subscribeBoardLive({ onBoard: () => {}, onInput: () => { inputs += 1 } })
  try {
    listeners.get('ready')({ data: 'x' })
    assert.equal(inputs, 1)
    listeners.get('ping')({ data: 'x' })
    assert.equal(inputs, 1)
    listeners.get('graph-full')({ data: JSON.stringify({ to: 'session-frame', graph: { nodes: [], sessions: [] } }) })
    assert.equal(inputs, 1, 'a board/session projection is not a file-input signal')
    listeners.get('graph-input')({ data: 'x' })
    assert.equal(inputs, 2)
    listeners.get('ready')({ data: 'x' })
    assert.equal(inputs, 3, 'same graph position after reconnect still invalidates readings')
    assert.equal(connections, 1, 'readings share the existing stream')
  } finally {
    stop()
    if (previous === undefined) delete globalThis.EventSource
    else globalThis.EventSource = previous
  }
})
