"""
Dynamic QUInt8 ONNX weight quantization tool for @silent-mi models.
"""

import os
import sys


def export_onnx_quantized(input_path: str, output_path: str) -> bool:
    print(f"[+] Starting dynamic QUInt8 ONNX weight quantization...")
    print(f"    - Input model:  {input_path}")
    print(f"    - Output model: {output_path}")

    abs_in = os.path.abspath(input_path)
    abs_out = os.path.abspath(output_path)

    # Invariant: Guard against identical input and output paths
    if abs_in == abs_out:
        print("[-] Error: Input and output paths cannot be identical. Quantization requires a distinct target path.")
        return False

    if not os.path.isfile(abs_in):
        print(f"[-] Input ONNX file not found: {abs_in}")
        return False

    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic
    except ImportError as e:
        print(f"[-] Missing dependency for ONNX quantization: {e}")
        print("    Install optional quantization dependencies via:")
        print("    pip install -e .[quantize]")
        return False

    os.makedirs(os.path.dirname(abs_out) or ".", exist_ok=True)

    try:
        quantize_dynamic(
            model_input=abs_in,
            model_output=abs_out,
            weight_type=QuantType.QUInt8,
        )
        in_size_mb = os.path.getsize(abs_in) / (1024 * 1024)
        out_size_mb = os.path.getsize(abs_out) / (1024 * 1024)
        print(f"[OK] Dynamic QUInt8 quantization complete:")
        print(f"     Original size:   {in_size_mb:.2f} MB")
        print(f"     Quantized size:  {out_size_mb:.2f} MB ({(out_size_mb / in_size_mb) * 100:.1f}%)")
        print(f"     Output path:     {abs_out}")
        return True
    except Exception as e:
        print(f"[-] ONNX Quantization failed: {e}")
        return False
