"""
Unit tests for silent_mi_trainer standard library validator and CLI.
Runs with standard library unittest (zero external test dependencies).
"""

import json
import os
import shutil
import tempfile
import unittest

from silent_mi_trainer.validator import TrainingValidator
from silent_mi_trainer.quantizer import export_onnx_quantized
from silent_mi_trainer.cli import main


class TestTrainingValidator(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.manifests_dir = os.path.join(self.test_dir, "manifests")
        self.training_dir = os.path.join(self.test_dir, "training")
        os.makedirs(self.manifests_dir, exist_ok=True)
        os.makedirs(self.training_dir, exist_ok=True)

        # Create valid manifests
        public_manifest = {
            "version": "1.0",
            "scope": "public",
            "items": [
                {"id": "ctrl-profile", "label": "Edit Profile", "type": "control"},
                {"id": "ctrl-theme", "label": "Dark Mode Toggle", "type": "control"},
            ],
        }
        with open(os.path.join(self.manifests_dir, "manifest.public.json"), "w", encoding="utf-8") as f:
            json.dump(public_manifest, f)

        admin_manifest = {
            "version": "1.0",
            "scope": "admin",
            "items": [
                {"id": "ctrl-delete-ws", "label": "Delete Workspace", "type": "control", "roles": ["admin"]},
            ],
        }
        with open(os.path.join(self.manifests_dir, "manifest.admin.json"), "w", encoding="utf-8") as f:
            json.dump(admin_manifest, f)

        # Create valid training pairs
        with open(os.path.join(self.training_dir, "train_pairs.public.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"query": "edit profile", "positiveId": "ctrl-profile"}) + "\n")
            f.write(json.dumps({"query": "dark mode", "positiveId": "ctrl-theme"}) + "\n")

        with open(os.path.join(self.training_dir, "train_pairs.admin.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"query": "delete workspace", "positiveId": "ctrl-delete-ws"}) + "\n")

        # Create valid goldens
        with open(os.path.join(self.training_dir, "goldens.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"query": "edit profile", "expectedId": "ctrl-profile", "expectedCategory": "positive"}) + "\n")
            f.write(json.dumps({"query": "do not delete workspace", "forbiddenId": "ctrl-delete-ws", "expectedCategory": "negation"}) + "\n")

        # Valid config
        self.valid_config = {
            "$schema": "./silent-mi.train.schema.json",
            "version": "1.0",
            "modelId": "bge-micro-v2",
            "modelsDir": self.test_dir,
            "manifestsDir": self.manifests_dir,
            "pairsDir": self.training_dir,
            "goldensFile": os.path.join(self.training_dir, "goldens.jsonl"),
            "outputDir": self.manifests_dir,
            "rank": 16,
            "alpha": 1.0,
            "loss": "ridge",
            "evalGate": {
                "minRecallAt1": 0.85,
                "minMrrAt5Delta": 0.0,
                "maxNegationViolations": 0,
            },
        }
        self.config_file = os.path.join(self.training_dir, "silent-mi.train.json")
        with open(self.config_file, "w", encoding="utf-8") as f:
            json.dump(self.valid_config, f)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_valid_configuration_passes(self):
        validator = TrainingValidator(self.config_file)
        self.assertTrue(validator.validate())
        self.assertEqual(len(validator.errors), 0)

    def test_invalid_schema_bounds_fails(self):
        bad_config = dict(self.valid_config)
        bad_config["rank"] = 512  # out of bound > 256
        bad_config["alpha"] = -1.0  # out of bound < 0
        bad_config["evalGate"] = {"minRecallAt1": 1.5, "maxNegationViolations": 2}
        bad_file = os.path.join(self.training_dir, "bad.train.json")
        with open(bad_file, "w", encoding="utf-8") as f:
            json.dump(bad_config, f)

        validator = TrainingValidator(bad_file)
        self.assertFalse(validator.validate())
        self.assertGreaterEqual(len(validator.errors), 3)

    def test_physical_rbac_leak_fails(self):
        # Leak admin item into manifest.public.json
        leaked_public = {
            "version": "1.0",
            "scope": "public",
            "items": [
                {"id": "ctrl-profile", "label": "Edit Profile"},
                {"id": "ctrl-secret", "label": "Secret Key", "roles": ["admin"]},
            ],
        }
        with open(os.path.join(self.manifests_dir, "manifest.public.json"), "w", encoding="utf-8") as f:
            json.dump(leaked_public, f)

        validator = TrainingValidator(self.config_file)
        self.assertFalse(validator.validate())
        self.assertTrue(any("RBAC Leak" in e for e in validator.errors))

    def test_contradictory_duplicate_goldens_fails(self):
        # Write contradictory goldens (identical query, conflicting expected IDs)
        with open(os.path.join(self.training_dir, "goldens.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"query": "search query", "expectedId": "target-a"}) + "\n")
            f.write(json.dumps({"query": "search query", "expectedId": "target-b"}) + "\n")

        validator = TrainingValidator(self.config_file)
        self.assertFalse(validator.validate())
        self.assertTrue(any("Contradictory duplicate golden query" in e for e in validator.errors))

    def test_export_onnx_guards_identical_paths(self):
        test_file = os.path.join(self.test_dir, "model.onnx")
        with open(test_file, "w") as f:
            f.write("mock onnx")
        result = export_onnx_quantized(test_file, test_file)
        self.assertFalse(result)


if __name__ == "__main__":
    unittest.main()
