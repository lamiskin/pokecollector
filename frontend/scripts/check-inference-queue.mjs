// Two queued inference tasks must never overlap. This mirrors the worker's
// inlined createSerialQueue; the worker cannot import this file from a blob.
import assert from 'node:assert/strict'
import { createSerialQueue } from '../src/utils/inferenceQueue.js'

const enqueue = createSerialQueue()
const events = []
const task = name => async () => {
  events.push(`${name}:start`)
  await new Promise(resolve => setTimeout(resolve, 15))
  events.push(`${name}:end`)
  return name
}

const [first, second] = await Promise.all([
  enqueue(task('first')),
  enqueue(task('second')),
])
assert.equal(first, 'first')
assert.equal(second, 'second')
assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])

// A rejection must not break the chain for the next task.
const queue = createSerialQueue()
const failing = queue(async () => { throw new Error('boom') })
await assert.rejects(failing)
const after = await queue(async () => 'after')
assert.equal(after, 'after')

console.log('inference queue sanity check passed')
