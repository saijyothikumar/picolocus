// scripts/download-model.mjs
import { existsSync, mkdirSync, createWriteStream, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BASE_URL = 'https://huggingface.co/MongoDB/mdbr-leaf-ir/resolve/main/';
const TARGET_DIR = fileURLToPath(new URL('../sandbox/demo-saas/public/models/mdbr-leaf-ir', import.meta.url));

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'model_q4.onnx',
  'model_q4.onnx_data',
];

mkdirSync(TARGET_DIR, { recursive: true });
mkdirSync(join(TARGET_DIR, 'onnx'), { recursive: true });

console.log('[+] Checking mdbr-leaf-ir model files for production deployment...');

for (const file of FILES) {
  const destPath = join(TARGET_DIR, file);
  if (existsSync(destPath)) {
    console.log(`[OK] Already present: ${file}`);
    continue;
  }
  const url = BASE_URL + file;
  console.log(`[DOWNLOADING] ${url} -> ${destPath}`);
  const tmpPath = `${destPath}.tmp-${Date.now()}`;
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!resp.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${resp.status} ${resp.statusText}`);
    }
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmpPath));
    renameSync(tmpPath, destPath);
    console.log(`[SAVED] ${file}`);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try { rmSync(tmpPath, { force: true }); } catch {}
    }
    throw err;
  }
}

// Mirror model files to onnx/ subfolder locally to save bandwidth
const onnxModel = join(TARGET_DIR, 'onnx', 'model_q4.onnx');
if (!existsSync(onnxModel) && existsSync(join(TARGET_DIR, 'model_q4.onnx'))) {
  copyFileSync(join(TARGET_DIR, 'model_q4.onnx'), onnxModel);
  console.log('[OK] Mirrored model_q4.onnx to onnx/ subfolder');
}
const onnxData = join(TARGET_DIR, 'onnx', 'model_q4.onnx_data');
if (!existsSync(onnxData) && existsSync(join(TARGET_DIR, 'model_q4.onnx_data'))) {
  copyFileSync(join(TARGET_DIR, 'model_q4.onnx_data'), onnxData);
  console.log('[OK] Mirrored model_q4.onnx_data to onnx/ subfolder');
}

console.log('[+] mdbr-leaf-ir model sync complete.');
