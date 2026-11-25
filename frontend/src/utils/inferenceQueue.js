// Page-side copy of the worker's serial queue (the worker must inline its own
// because blob workers cannot resolve relative imports). Kept here so the
// ordering can be tested in Node without loading onnxruntime.
export function createSerialQueue() {
  let tail = Promise.resolve()
  return task => {
    const next = tail.then(task, task)
    tail = next.catch(() => {})
    return next
  }
}
