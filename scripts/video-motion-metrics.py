#!/usr/bin/env python3
"""Measure simple temporal QA signals for one or more generated videos."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import fmean

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Report motion, freeze, and sharpness signals as JSON.")
    parser.add_argument("videos", nargs="+", type=Path)
    parser.add_argument("--analysis-width", type=int, default=240)
    parser.add_argument("--freeze-diff", type=float, default=0.35)
    return parser.parse_args()


def percentile(values: list[float], value: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float32), value)) if values else 0.0


def measure(path: Path, analysis_width: int, freeze_diff: float) -> dict[str, object]:
    capture = cv2.VideoCapture(str(path.resolve()))
    if not capture.isOpened():
        raise RuntimeError(f"Unable to open video: {path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = analysis_width / max(1, source_width)
    analysis_size = (analysis_width, max(1, round(source_height * scale)))
    frame_count = 0
    previous: np.ndarray | None = None
    previous_flow: np.ndarray | None = None
    adjacent_differences: list[float] = []
    flow_magnitudes: list[float] = []
    flow_jerks: list[float] = []
    sharpness: list[float] = []
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_count += 1
            gray = cv2.cvtColor(cv2.resize(frame, analysis_size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
            sharpness.append(float(cv2.Laplacian(gray, cv2.CV_32F).var()))
            if previous is not None:
                adjacent_differences.append(float(cv2.absdiff(previous, gray).mean()))
                flow = cv2.calcOpticalFlowFarneback(
                    previous,
                    gray,
                    None,
                    0.5,
                    3,
                    15,
                    3,
                    5,
                    1.2,
                    0,
                )
                magnitude = cv2.magnitude(flow[..., 0], flow[..., 1])
                flow_magnitudes.append(float(magnitude.mean()))
                if previous_flow is not None:
                    flow_jerks.append(float(np.linalg.norm(flow - previous_flow, axis=2).mean()))
                previous_flow = flow
            previous = gray
    finally:
        capture.release()
    transitions = max(0, frame_count - 1)
    freeze_count = sum(value < freeze_diff for value in adjacent_differences)
    return {
        "path": str(path.resolve()),
        "width": source_width,
        "height": source_height,
        "fps": round(fps, 4),
        "frames": frame_count,
        "durationSeconds": round(frame_count / fps, 4) if fps > 0 else None,
        "adjacentDifferenceMean": round(fmean(adjacent_differences), 4) if adjacent_differences else 0.0,
        "adjacentDifferenceP95": round(percentile(adjacent_differences, 95), 4),
        "opticalFlowMeanPixels": round(fmean(flow_magnitudes), 4) if flow_magnitudes else 0.0,
        "opticalFlowP95Pixels": round(percentile(flow_magnitudes, 95), 4),
        "temporalJerkMeanPixels": round(fmean(flow_jerks), 4) if flow_jerks else 0.0,
        "freezeTransitions": freeze_count,
        "freezeRatio": round(freeze_count / transitions, 4) if transitions else 0.0,
        "sharpnessMean": round(fmean(sharpness), 4) if sharpness else 0.0,
    }


def main() -> None:
    args = parse_args()
    if args.analysis_width < 64:
        raise ValueError("--analysis-width must be at least 64 pixels.")
    if args.freeze_diff < 0:
        raise ValueError("--freeze-diff must be non-negative.")
    print(json.dumps({
        "schemaVersion": 1,
        "analysisWidth": args.analysis_width,
        "freezeDifferenceThreshold": args.freeze_diff,
        "videos": [measure(path, args.analysis_width, args.freeze_diff) for path in args.videos],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
