#!/usr/bin/env python3
"""Validate and deterministically assemble a Gen Video Tool ZIP."""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import zipfile
from pathlib import Path, PurePosixPath


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("pack_root", type=Path)
    parser.add_argument("output_zip", type=Path)
    return parser.parse_args()


def load_validator(script_dir: Path):
    validator_path = script_dir / "validate_asset_pack.py"
    spec = importlib.util.spec_from_file_location("asset_pack_validator", validator_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load validate_asset_pack.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> None:
    args = parse_args()
    root = args.pack_root.resolve()
    output = args.output_zip.resolve()
    if not root.is_dir():
        raise SystemExit(f"pack root is not a directory: {root}")
    if output == root or root in output.parents:
        raise SystemExit("output ZIP must be outside the pack root")

    validator = load_validator(Path(__file__).resolve().parent)
    report = validator.validate_path(root)
    validator.print_report(report)
    if report.errors:
        raise SystemExit("asset pack validation failed")

    files = sorted(
        (entry for entry in root.rglob("*") if entry.is_file()),
        key=lambda entry: entry.relative_to(root).as_posix(),
    )
    if not files:
        raise SystemExit("asset pack is empty")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    try:
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for file_path in files:
                relative = PurePosixPath(file_path.relative_to(root).as_posix())
                info = zipfile.ZipInfo(str(relative), date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, file_path.read_bytes())
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    print(output)


if __name__ == "__main__":
    main()
