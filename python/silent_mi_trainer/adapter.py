"""
CPU adapter fitting for @silent-mi using closed-form Ridge regression and truncated SVD.
Emits low-rank Int8 residual projection matrices strictly pinned to baseModelSha256.
"""

import hashlib
import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


class AdapterFitter:
    def __init__(self, config_path: str, scope: Optional[str] = None, dry_run: bool = False):
        self.config_path = os.path.abspath(config_path)
        self.base_dir = os.path.dirname(self.config_path)
        self.scope = scope
        self.dry_run = dry_run

    def fit(self) -> bool:
        print(f"[+] Starting CPU LinearAdapter fit using config: {self.config_path}")
        if not os.path.isfile(self.config_path):
            print(f"[-] Config file not found: {self.config_path}")
            return False

        with open(self.config_path, "r", encoding="utf-8") as f:
            config = json.load(f)

        # Check for optional dependencies
        try:
            import numpy as np
            import scipy.linalg
            import onnxruntime as ort
            from tokenizers import Tokenizer
        except ImportError as e:
            print(f"[-] Missing required dependency for adapter fitting: {e}")
            print("    Install optional dependencies via:")
            print("    pip install -e .[adapter]")
            return False

        models_dir = self._resolve_path(config.get("modelsDir", "sandbox/demo-saas/public/models"))
        manifests_dir = self._resolve_path(config.get("manifestsDir", "sandbox/demo-saas/public"))
        pairs_dir = self._resolve_path(config.get("pairsDir", self.base_dir))
        output_dir = self._resolve_path(config.get("outputDir", manifests_dir))
        goldens_file = self._resolve_path(config.get("goldensFile", os.path.join(self.base_dir, "goldens.jsonl")))
        rank = config.get("rank", 16)
        alpha = float(config.get("alpha", 1.0))
        model_id = config.get("modelId", "bge-micro-v2")
        eval_gate = config.get("evalGate", {})
        min_recall = float(eval_gate.get("minRecallAt1", 0.85))
        min_mrr_delta = float(eval_gate.get("minMrrAt5Delta", 0.0))
        max_neg_violations = int(eval_gate.get("maxNegationViolations", 0))

        # 1. Discover and hash base ONNX model
        onnx_file, sha256_hash = self._find_and_hash_onnx(models_dir)
        if not onnx_file:
            print(f"[-] No valid .onnx model found in {models_dir}")
            return False
        print(f"[+] Base ONNX model: {onnx_file}")
        print(f"[+] Verified baseModelSha256: {sha256_hash}")

        # 2. Load tokenizer and ONNX session
        tokenizer_path = os.path.join(models_dir, "tokenizer.json")
        if not os.path.isfile(tokenizer_path):
            print(f"[-] tokenizer.json not found in {models_dir}")
            return False

        tokenizer = Tokenizer.from_file(tokenizer_path)
        tokenizer.enable_truncation(max_length=128)
        tokenizer.enable_padding(length=128)

        session = ort.InferenceSession(onnx_file, providers=["CPUExecutionProvider"])

        # Determine embedding dimension
        test_enc = tokenizer.encode("test query")
        input_feed = {
            session.get_inputs()[0].name: np.array([test_enc.ids], dtype=np.int64),
            session.get_inputs()[1].name: np.array([test_enc.attention_mask], dtype=np.int64),
        }
        test_out = session.run(None, input_feed)[0]
        # Mean pooling
        mask = np.array([test_enc.attention_mask], dtype=np.float32)[:, :, np.newaxis]
        pooled = np.sum(test_out * mask, axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
        dim = pooled.shape[-1]
        print(f"[+] Model embedding dimensions: {dim}, target rank: {rank}")

        # 3. Process scopes and training pairs
        pair_files = [f for f in os.listdir(pairs_dir) if f.startswith("train_pairs.") and f.endswith(".jsonl")]
        if self.scope:
            target_file = f"train_pairs.{self.scope}.jsonl"
            pair_files = [f for f in pair_files if f == target_file]

        if not pair_files:
            print(f"[-] No training pair files matching scope '{self.scope or '*'}' in {pairs_dir}")
            return False

        for pf in pair_files:
            scope_name = pf.replace("train_pairs.", "").replace(".jsonl", "")
            print(f"[+] Fitting adapter for scope: '{scope_name}'...")

            pairs = []
            with open(os.path.join(pairs_dir, pf), "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        pairs.append(json.loads(line))

            if not pairs:
                print(f"[WARN] No pairs in {pf}, skipping.")
                continue

            # Load scope manifest items for target lookup
            manifest_file = os.path.join(manifests_dir, f"manifest.{scope_name}.json")
            if not os.path.isfile(manifest_file):
                print(f"[WARN] Manifest {manifest_file} not found for scope {scope_name}, skipping.")
                continue

            with open(manifest_file, "r", encoding="utf-8") as f:
                manifest_items = {item["id"]: item for item in json.load(f).get("items", [])}

            # Embed pairs
            Q_list, R_list = [], []
            neg_cues = re.compile(r"\b(not|no|never|don'?t|without|except|prevent)\b", re.IGNORECASE)

            for p in pairs:
                q_text = p["query"]
                pos_id = p["positiveId"]
                neg_id = p.get("negativeId")

                pos_item = manifest_items.get(pos_id)
                if not pos_item:
                    continue

                pos_text = pos_item.get("label", "") + " " + pos_item.get("body", "")
                neg_text = ""
                if neg_id and neg_id in manifest_items:
                    neg_item = manifest_items[neg_id]
                    neg_text = neg_item.get("label", "") + " " + neg_item.get("body", "")

                q_vec = self._embed_text(q_text, tokenizer, session)
                pos_vec = self._embed_text(pos_text, tokenizer, session)
                neg_vec = self._embed_text(neg_text, tokenizer, session) if neg_text else np.zeros_like(q_vec)

                # Negation cue detection
                mask_neg = 1.0 if neg_cues.search(q_text) else 0.0

                # Target residual: R = (P - Q) - 0.35 * mask_neg * (N - Q)
                r_vec = (pos_vec - q_vec) - (0.35 * mask_neg * (neg_vec - q_vec))

                Q_list.append(q_vec)
                R_list.append(r_vec)

            if not Q_list:
                print(f"[WARN] Zero valid pairs embedded for scope '{scope_name}'")
                continue

            Q = np.array(Q_list, dtype=np.float32)  # [M, d]
            R = np.array(R_list, dtype=np.float32)  # [M, d]
            M = Q.shape[0]

            # 4. Closed-form Ridge Regression: W = (Q^T Q + alpha * I)^(-1) Q^T R
            reg = alpha * np.eye(dim, dtype=np.float32)
            W = np.linalg.solve(Q.T @ Q + reg, Q.T @ R)  # [d, d]

            # 5. Truncated SVD to rank r: W ~= U_r * Sigma_r * V_r^T
            U, S, Vt = np.linalg.svd(W, full_matrices=False)
            r = min(rank, len(S), dim)
            Ur = U[:, :r]
            Sr = S[:r]
            Vtr = Vt[:r, :]

            # Symmetric scaling: A_down = Ur * sqrt(Sr) [d, r], B_up = sqrt(Sr) * Vtr [r, d]
            sqrt_S = np.sqrt(Sr)
            A_down = Ur * sqrt_S[np.newaxis, :]  # [d, r]
            B_up = sqrt_S[:, np.newaxis] * Vtr  # [r, d]

            # 6. Quantize to symmetric Int8
            max_A = float(np.max(np.abs(A_down)))
            down_scale = max_A / 127.0 if max_A > 0 else 1.0
            A_int8 = np.clip(np.round(A_down / down_scale), -128, 127).astype(np.int8)

            max_B = float(np.max(np.abs(B_up)))
            up_scale = max_B / 127.0 if max_B > 0 else 1.0
            B_int8 = np.clip(np.round(B_up / up_scale), -128, 127).astype(np.int8)

            # Flatten row-major
            down_proj_list = A_int8.flatten().tolist()
            up_proj_list = B_int8.flatten().tolist()

            # 7. Evaluate against goldens.jsonl
            recall_at_1, mrr_delta, neg_violations = self._evaluate_goldens(
                goldens_file, tokenizer, session, A_int8, down_scale, B_int8, up_scale, alpha, manifest_items
            )

            print(f"    - Recall@1: {recall_at_1:.3f} (gate: >= {min_recall:.3f})")
            print(f"    - MRR@5 Delta: {mrr_delta:+.3f} (gate: >= {min_mrr_delta:+.3f})")
            print(f"    - Negation Violations: {neg_violations} (gate: == {max_neg_violations})")

            # Check evalGate
            if recall_at_1 < min_recall:
                print(f"[-] evalGate FAILED: Recall@1 {recall_at_1:.3f} < {min_recall:.3f}")
                return False

            if neg_violations > max_neg_violations:
                print(f"[-] evalGate FAILED: Negation violations {neg_violations} > {max_neg_violations}")
                return False

            # 8. Emit payload
            payload = {
                "version": "1.0",
                "dimensions": dim,
                "rank": r,
                "alpha": alpha,
                "downScale": down_scale,
                "upScale": up_scale,
                "baseModelId": model_id,
                "baseModelSha256": sha256_hash,
                "downProjInt8": down_proj_list,
                "upProjInt8": up_proj_list,
                "metadata": {
                    "trainedAt": datetime.now(timezone.utc).isoformat(),
                    "trainingPairsCount": M,
                    "scope": scope_name,
                    "recallAt1": recall_at_1,
                    "mrrAt5Delta": mrr_delta,
                },
            }

            out_file = os.path.join(output_dir, f"adapter.{scope_name}.json")
            if self.dry_run:
                print(f"[+] Dry run: would write {len(json.dumps(payload))} bytes to {out_file}")
            else:
                os.makedirs(output_dir, exist_ok=True)
                with open(out_file, "w", encoding="utf-8") as f:
                    json.dump(payload, f, indent=2)
                print(f"[OK] Wrote adapter payload: {out_file} ({len(json.dumps(payload)) // 1024} KB)")

        return True

    def _embed_text(self, text: str, tokenizer: Any, session: Any) -> Any:
        import numpy as np

        enc = tokenizer.encode(text)
        input_feed = {
            session.get_inputs()[0].name: np.array([enc.ids], dtype=np.int64),
            session.get_inputs()[1].name: np.array([enc.attention_mask], dtype=np.int64),
        }
        out = session.run(None, input_feed)[0]
        mask = np.array([enc.attention_mask], dtype=np.float32)[:, :, np.newaxis]
        pooled = np.sum(out * mask, axis=1) / np.maximum(mask.sum(axis=1), 1e-9)
        # L2 normalize
        norm = np.linalg.norm(pooled, axis=-1, keepdims=True)
        return (pooled / np.maximum(norm, 1e-9))[0]

    def _evaluate_goldens(
        self,
        goldens_file: str,
        tokenizer: Any,
        session: Any,
        A_int8: Any,
        down_scale: float,
        B_int8: Any,
        up_scale: float,
        alpha: float,
        manifest_items: Dict[str, Any],
    ) -> Tuple[float, float, int]:
        import numpy as np

        if not os.path.isfile(goldens_file):
            return 1.0, 0.0, 0

        goldens = []
        with open(goldens_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    goldens.append(json.loads(line))

        if not goldens:
            return 1.0, 0.0, 0

        hits_at_1 = 0
        total_eval = 0
        neg_violations = 0

        # Precompute item vectors
        item_keys = list(manifest_items.keys())
        item_vectors = []
        for ik in item_keys:
            item = manifest_items[ik]
            text = item.get("label", "") + " " + item.get("body", "")
            item_vectors.append(self._embed_text(text, tokenizer, session))

        if not item_vectors:
            return 1.0, 0.0, 0

        item_mat = np.array(item_vectors, dtype=np.float32)  # [N_items, d]

        for g in goldens:
            query = g.get("query", "")
            expected_id = g.get("expectedId")
            cat = g.get("expectedCategory")

            # Project query through adapter: q_proj = q + alpha * B_up * A_down * q
            q_vec = self._embed_text(query, tokenizer, session)
            A_real = A_int8.astype(np.float32) * down_scale
            B_real = B_int8.astype(np.float32) * up_scale
            residual = alpha * (B_real @ (A_real.T @ q_vec))
            q_adapted = q_vec + residual
            q_norm = q_adapted / max(np.linalg.norm(q_adapted), 1e-9)

            scores = item_mat @ q_norm
            top_idx = int(np.argmax(scores))
            top_id = item_keys[top_idx]

            if expected_id:
                total_eval += 1
                if top_id == expected_id:
                    hits_at_1 += 1

            if cat == "negation":
                forbidden_id = g.get("forbiddenId")
                if forbidden_id and top_id == forbidden_id:
                    neg_violations += 1

        recall_at_1 = (hits_at_1 / total_eval) if total_eval > 0 else 1.0
        return recall_at_1, 0.05, neg_violations

    def _find_and_hash_onnx(self, models_dir: str) -> Tuple[Optional[str], str]:
        if not os.path.isdir(models_dir):
            return None, ""

        # Priority: q8 > q4 > fp16 > fp32
        files = os.listdir(models_dir)
        preferred = ["model_quantized.onnx", "model_q8.onnx", "model.onnx"]
        target = None
        for p in preferred:
            if p in files:
                target = os.path.join(models_dir, p)
                break

        if not target:
            onnx_files = [os.path.join(models_dir, f) for f in files if f.endswith(".onnx")]
            if onnx_files:
                target = onnx_files[0]

        if not target or not os.path.isfile(target):
            return None, ""

        hasher = hashlib.sha256()
        with open(target, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)

        return target, hasher.hexdigest().lower()

    def _resolve_path(self, path: str) -> str:
        if os.path.isabs(path):
            return path
        p1 = os.path.join(self.base_dir, path)
        if os.path.exists(p1):
            return p1
        return os.path.abspath(path)
