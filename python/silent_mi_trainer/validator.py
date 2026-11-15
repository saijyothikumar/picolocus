"""
Pure Python standard-library validator for @silent-mi training configurations and manifests.
Zero external runtime dependencies.
"""

import json
import os
import re
import sys
from typing import Any, Dict, List, Set, Tuple


class TrainingValidator:
    def __init__(self, config_path: str):
        self.config_path = os.path.abspath(config_path)
        self.base_dir = os.path.dirname(self.config_path)
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def validate(self) -> bool:
        print(f"[+] Validating training workspace configuration: {self.config_path}")

        if not os.path.isfile(self.config_path):
            self.errors.append(f"Config file not found: {self.config_path}")
            self._report()
            return False

        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
        except Exception as e:
            self.errors.append(f"Malformed JSON in config file: {e}")
            self._report()
            return False

        # 1. Schema & Options Validation
        self._validate_schema(config)

        # 2. Pairs Validation
        pairs_dir = self._resolve_path(config.get("pairsDir", self.base_dir))
        self._validate_pairs(pairs_dir)

        # 3. RBAC Isolation Gate
        manifests_dir = self._resolve_path(config.get("manifestsDir", "public"))
        self._validate_rbac_isolation(manifests_dir, pairs_dir)

        # 4. Goldens Validation & Contradictory Duplicate Check
        goldens_file = self._resolve_path(config.get("goldensFile", os.path.join(self.base_dir, "goldens.jsonl")))
        self._validate_goldens(goldens_file)

        return self._report()

    def _resolve_path(self, path: str) -> str:
        if os.path.isabs(path):
            return path
        # Try relative to config dir first, then relative to cwd
        p1 = os.path.join(self.base_dir, path)
        if os.path.exists(p1):
            return p1
        return os.path.abspath(path)

    def _validate_schema(self, config: Dict[str, Any]) -> None:
        print("[+] Checking configuration schema and hyperparameter bounds...")
        required_keys = ["version", "manifestsDir", "outputDir", "evalGate"]
        for key in required_keys:
            if key not in config:
                self.errors.append(f"Missing required config key: '{key}'")

        if config.get("version") != "1.0":
            self.errors.append(f"Unsupported config version: '{config.get('version')}', expected '1.0'")

        rank = config.get("rank", 16)
        if not isinstance(rank, int) or rank < 1 or rank > 256:
            self.errors.append(f"Invalid rank: {rank}, must be integer in [1, 256]")

        alpha = config.get("alpha", 1.0)
        if not isinstance(alpha, (int, float)) or alpha < 0 or alpha > 4.0:
            self.errors.append(f"Invalid alpha: {alpha}, must be float in [0.0, 4.0]")

        loss = config.get("loss", "ridge")
        if loss not in ("ridge", "triplet"):
            self.errors.append(f"Invalid loss: '{loss}', must be 'ridge' or 'triplet'")

        eval_gate = config.get("evalGate")
        if not isinstance(eval_gate, dict):
            self.errors.append("Config 'evalGate' must be an object")
        else:
            min_recall = eval_gate.get("minRecallAt1")
            if min_recall is None or not (0.0 <= float(min_recall) <= 1.0):
                self.errors.append(f"evalGate.minRecallAt1 must be float in [0.0, 1.0], got {min_recall}")

            max_neg = eval_gate.get("maxNegationViolations")
            if max_neg is None or int(max_neg) != 0:
                self.errors.append(f"evalGate.maxNegationViolations must be strictly 0, got {max_neg}")

    def _validate_pairs(self, pairs_dir: str) -> None:
        print(f"[+] Checking training pairs in: {pairs_dir}")
        if not os.path.isdir(pairs_dir):
            self.errors.append(f"Pairs directory not found: {pairs_dir}")
            return

        pair_files = [f for f in os.listdir(pairs_dir) if f.startswith("train_pairs.") and f.endsWith(".jsonl")] if hasattr(str, "endsWith") else [f for f in os.listdir(pairs_dir) if f.startswith("train_pairs.") and f.endswith(".jsonl")]
        if not pair_files:
            self.errors.append(f"No train_pairs.*.jsonl files found in {pairs_dir}")
            return

        total_pairs = 0
        for pf in pair_files:
            file_path = os.path.join(pairs_dir, pf)
            file_pairs = 0
            with open(file_path, "r", encoding="utf-8") as f:
                for line_idx, line in enumerate(f, start=1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                        query = record.get("query")
                        pos_id = record.get("positiveId")
                        if not query or not isinstance(query, str) or not query.strip():
                            self.errors.append(f"{pf}:{line_idx} missing non-empty 'query'")
                        if not pos_id or not isinstance(pos_id, str) or not pos_id.strip():
                            self.errors.append(f"{pf}:{line_idx} missing non-empty 'positiveId'")
                        file_pairs += 1
                    except json.JSONDecodeError:
                        self.errors.append(f"{pf}:{line_idx} invalid JSON line")
            total_pairs += file_pairs
            print(f"    - {pf}: {file_pairs} valid pairs")

        if total_pairs == 0:
            self.errors.append(f"Zero valid training pairs found across all {pairs_dir}/train_pairs.*.jsonl files")

    def _validate_rbac_isolation(self, manifests_dir: str, pairs_dir: str) -> None:
        print(f"[+] Verifying physical RBAC isolation across manifests in: {manifests_dir}")
        if not os.path.isdir(manifests_dir):
            self.errors.append(f"Manifests directory not found: {manifests_dir}")
            return

        manifest_files = [f for f in os.listdir(manifests_dir) if f.startswith("manifest.") and f.endswith(".json")]
        if not manifest_files:
            self.errors.append(f"No manifest.*.json files found in {manifests_dir}")
            return

        public_ids: Set[str] = set()
        docs_ids: Set[str] = set()
        restricted_ids: Set[str] = set()
        restricted_roles: Set[str] = set()

        for mf in manifest_files:
            file_path = os.path.join(manifests_dir, mf)
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    manifest_data = json.load(f)
            except Exception as e:
                self.errors.append(f"Could not load manifest {mf}: {e}")
                continue

            scope = mf.replace("manifest.", "").replace(".json", "")
            items = manifest_data.get("items", [])

            if scope == "public":
                for item in items:
                    item_id = item.get("id")
                    if item_id:
                        public_ids.add(item_id)
                    # Check for explicit restricted role or hide policy
                    roles = item.get("roles", [])
                    if roles and any(r.lower() not in ("public", "all", "*") for r in roles):
                        self.errors.append(
                            f"RBAC Leak: Item '{item_id}' in manifest.public.json specifies restricted roles {roles}"
                        )
                    if item.get("tierPolicy") == "hide":
                        self.errors.append(
                            f"RBAC Leak: Item '{item_id}' in manifest.public.json has tierPolicy 'hide'"
                        )
            elif scope == "docs":
                for item in items:
                    item_id = item.get("id")
                    if item_id:
                        docs_ids.add(item_id)
                    roles = item.get("roles", [])
                    if roles and any(r.lower() not in ("public", "all", "*") for r in roles):
                        self.errors.append(
                            f"RBAC Leak: Clause '{item_id}' in manifest.docs.json specifies restricted roles {roles}"
                        )
                    if item.get("tierPolicy") == "hide":
                        self.errors.append(
                            f"RBAC Leak: Clause '{item_id}' in manifest.docs.json has tierPolicy 'hide'"
                        )
            else:
                # Role-specific restricted manifest
                restricted_roles.add(scope)
                for item in items:
                    item_id = item.get("id")
                    if item_id:
                        restricted_ids.add(item_id)

        # Cross-check: strictly restricted items must NOT exist in public or docs manifests
        strictly_restricted = restricted_ids - public_ids - docs_ids
        for r_id in strictly_restricted:
            if r_id in public_ids:
                self.errors.append(f"Physical RBAC Leak: Restricted item '{r_id}' leaked into manifest.public.json")
            if r_id in docs_ids:
                self.errors.append(f"Physical RBAC Leak: Restricted item '{r_id}' leaked into manifest.docs.json")

        # Also check train_pairs.public.jsonl and train_pairs.docs.jsonl
        for public_pair_file in ["train_pairs.public.jsonl", "train_pairs.docs.jsonl"]:
            pair_path = os.path.join(pairs_dir, public_pair_file)
            if os.path.isfile(pair_path):
                with open(pair_path, "r", encoding="utf-8") as f:
                    for line_idx, line in enumerate(f, start=1):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            record = json.loads(line)
                            p_id = record.get("positiveId")
                            n_id = record.get("negativeId")
                            if p_id and p_id in strictly_restricted:
                                self.errors.append(
                                    f"Physical RBAC Leak: Restricted ID '{p_id}' found in {public_pair_file}:{line_idx} (positiveId)"
                                )
                            if n_id and n_id in strictly_restricted:
                                self.errors.append(
                                    f"Physical RBAC Leak: Restricted ID '{n_id}' found in {public_pair_file}:{line_idx} (negativeId)"
                                )
                        except json.JSONDecodeError:
                            pass

    def _validate_goldens(self, goldens_file: str) -> None:
        print(f"[+] Checking goldens for contradictory duplicate queries in: {goldens_file}")
        if not os.path.isfile(goldens_file):
            self.errors.append(f"Goldens file not found: {goldens_file}")
            return

        queries_map: Dict[str, List[Dict[str, Any]]] = {}
        total_goldens = 0

        with open(goldens_file, "r", encoding="utf-8") as f:
            for line_idx, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    query = record.get("query")
                    if not query or not isinstance(query, str):
                        self.errors.append(f"goldens.jsonl:{line_idx} missing 'query'")
                        continue
                    norm_q = " ".join(query.strip().lower().split())
                    queries_map.setdefault(norm_q, []).append({
                        "line": line_idx,
                        "raw_query": query,
                        "expectedId": record.get("expectedId"),
                        "forbiddenId": record.get("forbiddenId"),
                        "expectedCategory": record.get("expectedCategory"),
                        "userContext": record.get("userContext"),
                    })
                    total_goldens += 1
                except json.JSONDecodeError:
                    self.errors.append(f"goldens.jsonl:{line_idx} invalid JSON line")

        # Check for contradictory duplicates
        for norm_q, entries in queries_map.items():
            if len(entries) > 1:
                # Compare expected targets across identical queries
                expected_ids = set()
                categories = set()
                for e in entries:
                    exp_id = e.get("expectedId")
                    cat = e.get("expectedCategory")
                    if exp_id is not None:
                        expected_ids.add(exp_id)
                    if cat is not None:
                        categories.add(cat)

                # Contradiction: same query has multiple different positive target IDs
                # without distinguishing role context
                if len(expected_ids) > 1:
                    contexts = [json.dumps(e.get("userContext") or {}) for e in entries]
                    if len(set(contexts)) == 1:
                        # Exactly identical userContext but conflicting expectedId
                        lines_str = ", ".join(str(e["line"]) for e in entries)
                        self.errors.append(
                            f"Contradictory duplicate golden query '{norm_q}' on lines [{lines_str}] "
                            f"with conflicting targets: {list(expected_ids)}"
                        )

        print(f"    - Validated {total_goldens} golden queries ({len(queries_map)} unique)")

    def _report(self) -> bool:
        if self.warnings:
            for w in self.warnings:
                print(f"[WARN] {w}")

        if self.errors:
            print(f"[-] Validation failed with {len(self.errors)} error(s):")
            for e in self.errors:
                print(f"    [FAIL] {e}")
            return False

        print("[OK] Training workspace and manifest validation passed with 0 errors.")
        return True
