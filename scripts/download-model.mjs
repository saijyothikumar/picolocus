// scripts/download-model.mjs
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BASE_URL = 'https://huggingface.co/MongoDB/mdbr-leaf-ir/resolve/main/';
const TARGET_DIR = join(process.cwd(), 'sandbox', 'demo-saas', 'public', 'models', 'mdbr-leaf-ir');

const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  'model_q4.onnx',
  'model_q4.onnx_data',
  'onnx/model_q4.onnx',
  'onnx/model_q4.onnx_data',
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
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${resp.status} ${resp.statusText}`);
  }
  await pipeline(Readable.fromWeb(resp.body), createWriteStream(destPath));
  console.log(`[SAVED] ${file}`);
}
console.log('[+] mdbr-leaf-ir model sync complete.');
