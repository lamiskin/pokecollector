#!/usr/bin/env node
// Fetches the card-corner detector assets used by the browser probe.
//
// Model: cornelius-2.12.onnx from Hugging Face HanClinto/cornelius,
// revision 9280009f5a66f75f952820d9dadb894909b759b7, 4,407,545 bytes,
// sha256 650da3cc3e9ac778c6951de631f824ec1e63bdabf3aaa39a35d7435af625612e.
// Licence: AGPL-3.0, matching this application's licence.
//
// The model and the onnxruntime-web dist files are not committed: they are
// large, reproducible, and the model is downloaded from its canonical source.
// frontend/public/detector/ is gitignored; this script runs before dev/build.
//
// Runtime: onnxruntime-web 1.24.3. Two builds are vendored so the app can
// compare them on the same device: the asyncify bundle (ort.webgpu.min.mjs with
// the asyncify wasm pair) and the plain simd bundle (ort.wasm.min.mjs with the
// threaded simd wasm pair). The legacy ort.all.min.mjs (JSEP) bundle returns
// all-zero outputs on Android Chrome, so it is deliberately not copied.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR_SOURCE = join(FRONTEND_ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const DETECTOR_DIR = join(FRONTEND_ROOT, 'public', 'detector')
const VENDOR_DIR = join(DETECTOR_DIR, 'vendor')

const MODEL_URL = 'https://huggingface.co/HanClinto/cornelius/resolve/9280009f5a66f75f952820d9dadb894909b759b7/cornelius-2.12.onnx'
const MODEL_NAME = 'cornelius-2.12.onnx'
const MODEL_SIZE = 4_407_545
const MODEL_SHA256 = '650da3cc3e9ac778c6951de631f824ec1e63bdabf3aaa39a35d7435af625612e'

const VENDOR_FILES = [
  'ort.webgpu.min.mjs',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  // Plain (non-asyncify) simd build, selectable at runtime for comparison.
  'ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]

const sha256 = data => createHash('sha256').update(data).digest('hex')

async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

async function copyVendorFiles() {
  try {
    await stat(VENDOR_SOURCE)
  } catch {
    throw new Error('onnxruntime-web is not installed; run npm install first.')
  }
  await mkdir(VENDOR_DIR, { recursive: true })
  for (const name of VENDOR_FILES) {
    const source = join(VENDOR_SOURCE, name)
    const destination = join(VENDOR_DIR, name)
    const [sourceSize, destinationSize] = await Promise.all([
      fileSize(source),
      fileSize(destination),
    ])
    if (sourceSize === null) {
      throw new Error(`onnxruntime-web dist is missing ${name}; run npm install first.`)
    }
    if (sourceSize === destinationSize) {
      console.log(`vendor: ${name} already present (${sourceSize} bytes)`)
      continue
    }
    await copyFile(source, destination)
    console.log(`vendor: copied ${name} (${sourceSize} bytes)`)
  }
}

async function verifyModel(path) {
  const data = await readFile(path)
  return data.length === MODEL_SIZE && sha256(data) === MODEL_SHA256
}

async function ensureModel() {
  const destination = join(DETECTOR_DIR, MODEL_NAME)
  if (await verifyModel(destination).catch(() => false)) {
    console.log(`model: ${MODEL_NAME} already present and verified`)
    return
  }
  await rm(destination, { force: true })
  console.log(`model: downloading ${MODEL_NAME}`)
  const response = await fetch(MODEL_URL)
  if (!response.ok) {
    throw new Error(`model download failed: HTTP ${response.status} ${response.statusText}`)
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length !== MODEL_SIZE || sha256(data) !== MODEL_SHA256) {
    await rm(destination, { force: true })
    throw new Error(
      `model verification failed (got ${data.length} bytes, sha256 ${sha256(data)}); `
      + 'deleted the download. Check the network or the pinned revision.',
    )
  }
  await writeFile(destination, data)
  console.log(`model: wrote ${MODEL_NAME} (${MODEL_SIZE} bytes, sha256 verified)`)
}

try {
  await mkdir(DETECTOR_DIR, { recursive: true })
  await copyVendorFiles()
  await ensureModel()
  console.log('detector assets ready')
} catch (error) {
  console.error(`fetch-detector-assets: ${error.message}`)
  process.exitCode = 1
}
