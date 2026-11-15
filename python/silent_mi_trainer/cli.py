"""
ASCII-safe CLI entry point for silent-mi-trainer.
Subcommands: validate, fit-adapter, export-onnx, print-options.
"""

import argparse
import os
import sys
from typing import List, Optional

from silent_mi_trainer import __version__
from silent_mi_trainer.validator import TrainingValidator
from silent_mi_trainer.adapter import AdapterFitter
from silent_mi_trainer.quantizer import export_onnx_quantized


def print_options_summary() -> None:
    print("================================================================")
    print("  @silent-mi Trainer Options & Architectural Configuration      ")
    print("================================================================")
    print("1. Closed-Form Residual Ridge Regression:")
    print("   Formula: R = (P - Q) - 0.35 * mask_neg * (N - Q)")
    print("   Losses:  ridge (default), triplet")
    print("   Alphas:  0.0 to 4.0 (default: 1.0)")
    print("   Ranks:   1 to 256 (default: 16, typical JSON size: 4-17 KB)")
    print()
    print("2. Quantization & Formats:")
    print("   Quant:   Symmetric Int8 [-128, 127] with float downScale / upScale")
    print("   Storage: adapter.<scope>.json (version 1.0, row-major flat vectors)")
    print("   Security: Cryptographic SHA-256 pinning against baseModelSha256")
    print()
    print("3. Quality & Evaluation Gates (evalGate):")
    print("   - minRecallAt1:         >= 0.85")
    print("   - minMrrAt5Delta:       >= 0.00")
    print("   - maxNegationViolations: strictly 0")
    print()
    print("4. Physical RBAC Constraints:")
    print("   - Public manifest: manifest.public.json (strictly zero restricted controls)")
    print("   - Docs manifest:   manifest.docs.json (strictly zero restricted clauses)")
    print("   - Role manifests:  manifest.<role>.json (isolated role-specific items)")
    print("================================================================")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="silent-mi-train",
        description=f"silent-mi-trainer v{__version__} - CPU adapter training & ONNX model toolkit for @silent-mi",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    subparsers = parser.add_subparsers(dest="subcommand", help="Subcommand to execute")

    # validate
    validate_parser = subparsers.add_parser(
        "validate",
        help="Validate training config schema, non-empty pairs, RBAC isolation, and goldens",
    )
    validate_parser.add_argument(
        "--config",
        "-c",
        default=None,
        help="Path to silent-mi.train.json (defaults to auto-detection)",
    )

    # fit-adapter
    fit_parser = subparsers.add_parser(
        "fit-adapter",
        help="Fit CPU low-rank Int8 residual adapter via Ridge regression and SVD",
    )
    fit_parser.add_argument(
        "--config",
        "-c",
        default=None,
        help="Path to silent-mi.train.json",
    )
    fit_parser.add_argument(
        "--scope",
        "-s",
        default=None,
        help="Target scope to fit (e.g. public, admin; defaults to all)",
    )
    fit_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate training and evaluation without writing output files",
    )

    # export-onnx
    quant_parser = subparsers.add_parser(
        "export-onnx",
        help="Run dynamic QUInt8 ONNX weight quantization on a model",
    )
    quant_parser.add_argument(
        "--input",
        "-i",
        required=True,
        help="Path to input .onnx file",
    )
    quant_parser.add_argument(
        "--output",
        "-o",
        required=True,
        help="Path to output quantized .onnx file",
    )

    # print-options
    subparsers.add_parser(
        "print-options",
        help="Print an ASCII-safe summary of available training options and hyperparameter bounds",
    )

    return parser


def find_default_config() -> str:
    candidates = [
        "sandbox/demo-saas/training/silent-mi.train.json",
        "training/silent-mi.train.json",
        "silent-mi.train.json",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return "training/silent-mi.train.json"


def main(args: Optional[List[str]] = None) -> int:
    parser = build_parser()
    parsed = parser.parse_args(args)

    if not parsed.subcommand:
        parser.print_help()
        return 0

    if parsed.subcommand == "print-options":
        print_options_summary()
        return 0

    if parsed.subcommand == "validate":
        config_path = parsed.config or find_default_config()
        validator = TrainingValidator(config_path)
        success = validator.validate()
        return 0 if success else 1

    if parsed.subcommand == "fit-adapter":
        config_path = parsed.config or find_default_config()
        fitter = AdapterFitter(config_path, scope=parsed.scope, dry_run=parsed.dry_run)
        success = fitter.fit()
        return 0 if success else 1

    if parsed.subcommand == "export-onnx":
        success = export_onnx_quantized(parsed.input, parsed.output)
        return 0 if success else 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
