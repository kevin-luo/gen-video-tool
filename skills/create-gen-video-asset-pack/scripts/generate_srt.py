#!/usr/bin/env python3
"""Generate a strict external UTF-8 SRT draft from v3 narration segments."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from pathlib import Path


PLACEHOLDER_RE = re.compile(
    r"(?:\b(?:todo|tbd|changeme|placeholder)\b|(?:^|[/_\s-])replace(?:[/_\s-]|$)|"
    r"replace\s+with|your[-_](?:id|title|text|path)|<[^>\r\n]+>|"
    r"\{\{[^}\r\n]+\}\}|\$\{[^}\r\n]+\}|替换为|待填(?:写)?|占位(?:符)?|在此填写)",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("segments_json", type=Path)
    parser.add_argument("output_srt", type=Path)
    return parser.parse_args()


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(seconds: float) -> str:
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("SRT times must be finite and non-negative")
    milliseconds = round(seconds * 1_000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{millis:03d}"


def load_segments(path: Path) -> list[dict[str, object]]:
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(document, dict) or set(document) != {"segments"}:
        raise ValueError("narration.segments.json must contain only a segments array")
    raw = document["segments"]
    if not isinstance(raw, list) or not raw:
        raise ValueError("narration segments must be a non-empty array")
    segments: list[dict[str, object]] = []
    required = {"segmentId", "shotId", "text", "startSeconds", "estimatedDurationSeconds"}
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict) or set(item) != required:
            raise ValueError(f"segment {index} must contain exactly {sorted(required)}")
        segments.append(item)
    return segments


def main() -> None:
    args = parse_args()
    segments = load_segments(args.segments_json)
    cursor = 0.0
    blocks: list[str] = []
    for index, segment in enumerate(segments, start=1):
        text = segment["text"]
        if not isinstance(text, str) or not text or text != text.strip():
            raise ValueError(f"segment {index} has invalid text")
        if PLACEHOLDER_RE.search(text):
            raise ValueError(f"segment {index} still contains a placeholder sentinel")
        start_value = segment["startSeconds"]
        duration_value = segment["estimatedDurationSeconds"]
        if not finite_number(start_value) or start_value < 0:
            raise ValueError(f"segment {index} has invalid startSeconds")
        if not finite_number(duration_value) or duration_value <= 0:
            raise ValueError(f"segment {index} has invalid estimatedDurationSeconds")
        start = float(start_value)
        end = start + float(duration_value)
        if start < cursor - 0.001:
            raise ValueError(f"segment {index} overlaps the previous segment")
        blocks.append(f"{index}\n{timestamp(start)} --> {timestamp(end)}\n{text}")
        cursor = end

    args.output_srt.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output_srt.with_name(f".{args.output_srt.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text("\n\n".join(blocks) + "\n", encoding="utf-8", newline="\n")
        temporary.replace(args.output_srt)
    finally:
        if temporary.exists():
            temporary.unlink()
    print(args.output_srt)


if __name__ == "__main__":
    main()
