#!/usr/bin/env python3
"""Strict zero-dependency validator for a Gen Video Tool v3 source pack."""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import stat
import wave
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Protocol


MAX_FILES = 2_000
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024
MAX_DECODED_PNG_BYTES = 128 * 1024 * 1024
DELIVERY_WIDTH = 1_080
DELIVERY_HEIGHT = 1_920
DELIVERY_FPS = 30
GENERATION_WIDTH = 480
GENERATION_HEIGHT = 832
GENERATION_FPS = 24
GENERATION_FRAMES = 81

CAPABILITIES = {
    "local-f5-tts",
    "local-i2v",
    "local-i2v-start-end",
    "local-video-matting",
    "deterministic-ballistics",
    "remotion-render",
    "ffmpeg",
    "sidecar-srt",
}
MILESTONE_KINDS = {
    "setup",
    "anticipation",
    "approach",
    "plant",
    "contact",
    "release",
    "follow-through",
    "settle",
    "end",
}
BODY_PARTS = {
    "head",
    "torso",
    "hips",
    "left-hand",
    "right-hand",
    "left-foot",
    "right-foot",
    "left-knee",
    "right-knee",
    "left-elbow",
    "right-elbow",
}
CAMERA_OPERATIONS = {
    "locked",
    "push",
    "pull",
    "pan-left",
    "pan-right",
    "pan-up",
    "pan-down",
}
PLACEHOLDER_RE = re.compile(
    r"(?:"
    r"\b(?:todo|tbd|changeme|placeholder)\b|"
    r"(?:^|[/_\s-])replace(?:[/_\s-]|$)|"
    r"replace\s+with|your[-_](?:id|title|text|path)|"
    r"<[^>\r\n]+>|\{\{[^}\r\n]+\}\}|\$\{[^}\r\n]+\}|"
    r"替换为|待填(?:写)?|占位(?:符)?|在此填写"
    r")",
    re.IGNORECASE,
)
LOCALE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
SRT_TIME_RE = re.compile(
    r"^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3}) --> "
    r"(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$"
)
WINDOWS_DEVICE_RE = re.compile(
    r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE
)


@dataclass(frozen=True)
class Problem:
    code: str
    path: str
    message: str


@dataclass
class ValidationReport:
    source: str
    errors: list[Problem] = field(default_factory=list)
    warnings: list[Problem] = field(default_factory=list)

    def error(self, code: str, path: str, message: str) -> None:
        self.errors.append(Problem(code, path, message))

    def warning(self, code: str, path: str, message: str) -> None:
        self.warnings.append(Problem(code, path, message))


@dataclass(frozen=True)
class PngMetadata:
    width: int
    height: int
    has_alpha: bool


@dataclass
class ShotFacts:
    generated: bool = False
    start_end: bool = False
    ballistics: bool = False
    matte: bool = False


class PackReader(Protocol):
    def names(self) -> list[str]: ...
    def read(self, name: str) -> bytes: ...


class DirectoryReader:
    def __init__(self, root: Path, report: ValidationReport):
        self.root = root
        self._names: list[str] = []
        total = 0
        for item in root.rglob("*"):
            relative = item.relative_to(root).as_posix()
            if item.is_symlink():
                report.error("SOURCE_SYMLINK", relative, "Source-pack symlinks are forbidden")
                continue
            if not item.is_file():
                continue
            size = item.stat().st_size
            total += size
            if size > MAX_FILE_BYTES:
                report.error("FILE_TOO_LARGE", relative, "File exceeds the per-file safety limit")
            self._names.append(relative)
        if len(self._names) > MAX_FILES:
            report.error("TOO_MANY_FILES", "pack", "Source pack contains too many files")
        if total > MAX_TOTAL_BYTES:
            report.error("PACK_TOO_LARGE", "pack", "Source pack exceeds the total safety limit")
        self._names.sort()

    def names(self) -> list[str]:
        return self._names

    def read(self, name: str) -> bytes:
        return (self.root / PurePosixPath(name)).read_bytes()


class ZipReader:
    def __init__(self, archive_path: Path, report: ValidationReport):
        self.archive = zipfile.ZipFile(archive_path)
        self._names: list[str] = []
        seen: set[str] = set()
        total = 0
        for info in self.archive.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if not safe_path(name):
                report.error("ZIP_PATH_INVALID", name, "ZIP entry is not a safe POSIX relative path")
                continue
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                report.error("ZIP_SYMLINK", name, "ZIP symlinks are forbidden")
                continue
            if name in seen:
                report.error("ZIP_DUPLICATE", name, "ZIP contains a duplicate path")
                continue
            seen.add(name)
            total += info.file_size
            if info.file_size > MAX_FILE_BYTES:
                report.error("FILE_TOO_LARGE", name, "File exceeds the per-file safety limit")
            self._names.append(name)
        if len(self._names) > MAX_FILES:
            report.error("TOO_MANY_FILES", "ZIP", "ZIP contains too many files")
        if total > MAX_TOTAL_BYTES:
            report.error("PACK_TOO_LARGE", "ZIP", "ZIP exceeds the total safety limit")

    def names(self) -> list[str]:
        return sorted(self._names)

    def read(self, name: str) -> bytes:
        return self.archive.read(name)


def is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def safe_path(value: object) -> bool:
    if not isinstance(value, str) or not value or len(value) > 1_024 or value != value.strip():
        return False
    if value.startswith(("/", "\\")) or "\\" in value or ":" in value:
        return False
    if re.match(r"^[A-Za-z]:", value) or "://" in value:
        return False
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        return False
    parts = value.split("/")
    if any(part in {"", ".", ".."} or part.endswith((".", " ")) for part in parts):
        return False
    return not any(WINDOWS_DEVICE_RE.match(part) for part in parts)


def contains_placeholder(value: str) -> bool:
    return bool(PLACEHOLDER_RE.search(value))


def scan_placeholders(value: object, pointer: str, report: ValidationReport) -> None:
    if isinstance(value, str):
        if contains_placeholder(value):
            report.error("PLACEHOLDER_FORBIDDEN", pointer, "Replace every template sentinel before validation")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            scan_placeholders(item, f"{pointer}/{index}", report)
    elif isinstance(value, dict):
        for key, item in value.items():
            scan_placeholders(item, f"{pointer}/{key}", report)


def strict_object(
    value: object,
    required: set[str],
    optional: set[str],
    pointer: str,
    report: ValidationReport,
) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        report.error("OBJECT_REQUIRED", pointer, "Expected a JSON object")
        return None
    keys = set(value)
    for key in sorted(required - keys):
        report.error("FIELD_MISSING", f"{pointer}/{key}", "Required field is missing")
    for key in sorted(keys - required - optional):
        report.error("FIELD_UNKNOWN", f"{pointer}/{key}", "Unknown field is not allowed by v3")
    return value


def require_text(
    value: object,
    pointer: str,
    report: ValidationReport,
    *,
    maximum: int = 4_000,
) -> str | None:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > maximum:
        report.error("TEXT_INVALID", pointer, f"Expected trimmed non-empty text of at most {maximum} characters")
        return None
    return value


def require_id(value: object, pointer: str, report: ValidationReport) -> str | None:
    text = require_text(value, pointer, report, maximum=128)
    if text is None:
        return None
    if text in {".", ".."} or re.search(r"[\\/\x00-\x1f\x7f]", text):
        report.error("ID_INVALID", pointer, "ID cannot contain path separators, dot segments, or controls")
        return None
    return text


def load_json(reader: PackReader, name: str, report: ValidationReport) -> Any | None:
    try:
        value = json.loads(reader.read(name).decode("utf-8-sig"))
    except Exception as error:
        report.error("JSON_INVALID", name, f"Cannot read strict UTF-8 JSON: {error}")
        return None
    scan_placeholders(value, f"/{name}", report)
    return value


def require_source_file(
    reader: PackReader,
    names: set[str],
    value: object,
    pointer: str,
    report: ValidationReport,
) -> str | None:
    if not safe_path(value):
        report.error("PATH_INVALID", pointer, "Expected a safe POSIX project-relative path")
        return None
    path_text = str(value)
    if path_text.startswith("generated/"):
        report.error("SOURCE_PATH_GENERATED", pointer, "Source assets cannot live under generated/")
        return None
    if path_text not in names:
        report.error("REFERENCE_MISSING", pointer, f"Referenced source file is missing: {path_text}")
        return None
    return path_text


def require_output_path(value: object, pointer: str, report: ValidationReport) -> str | None:
    if not safe_path(value):
        report.error("PATH_INVALID", pointer, "Expected a safe POSIX project-relative output path")
        return None
    path_text = str(value)
    if not path_text.startswith("generated/"):
        report.error("OUTPUT_PATH_INVALID", pointer, "Mutable desktop output must live under generated/")
        return None
    return path_text


def _png_row_sizes(width: int, height: int, bits_per_pixel: int, interlace: int) -> list[int]:
    if interlace == 0:
        return [math.ceil(width * bits_per_pixel / 8)] * height
    starts_x = (0, 4, 0, 2, 0, 1, 0)
    starts_y = (0, 0, 4, 0, 2, 0, 1)
    steps_x = (8, 8, 4, 4, 2, 2, 1)
    steps_y = (8, 8, 8, 4, 4, 2, 2)
    sizes: list[int] = []
    for start_x, start_y, step_x, step_y in zip(starts_x, starts_y, steps_x, steps_y):
        pass_width = 0 if width <= start_x else (width - start_x + step_x - 1) // step_x
        pass_height = 0 if height <= start_y else (height - start_y + step_y - 1) // step_y
        if pass_width:
            sizes.extend([math.ceil(pass_width * bits_per_pixel / 8)] * pass_height)
    return sizes


def png_metadata(data: bytes) -> PngMetadata:
    if len(data) < 57 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("missing PNG signature or complete chunk stream")
    position = 8
    chunk_index = 0
    ihdr: tuple[int, int, int, int, int] | None = None
    palette_entries: int | None = None
    has_trns = False
    seen_idat = False
    idat_closed = False
    seen_iend = False
    idat_parts: list[bytes] = []
    recognized_critical = {b"IHDR", b"PLTE", b"IDAT", b"IEND"}
    while position < len(data):
        if position + 12 > len(data):
            raise ValueError("truncated PNG chunk")
        length = int.from_bytes(data[position : position + 4], "big")
        chunk_type = data[position + 4 : position + 8]
        chunk_end = position + 12 + length
        if chunk_end > len(data):
            raise ValueError("PNG chunk length exceeds file")
        payload = data[position + 8 : position + 8 + length]
        expected_crc = int.from_bytes(data[position + 8 + length : chunk_end], "big")
        actual_crc = zlib.crc32(chunk_type)
        actual_crc = zlib.crc32(payload, actual_crc) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise ValueError(f"CRC mismatch in {chunk_type!r}")
        if chunk_index == 0 and chunk_type != b"IHDR":
            raise ValueError("IHDR must be the first PNG chunk")
        if chunk_type and not (chunk_type[0] & 0x20) and chunk_type not in recognized_critical:
            raise ValueError(f"unsupported critical PNG chunk {chunk_type!r}")
        if chunk_type == b"IHDR":
            if ihdr is not None or length != 13:
                raise ValueError("PNG must contain one 13-byte IHDR")
            width = int.from_bytes(payload[0:4], "big")
            height = int.from_bytes(payload[4:8], "big")
            bit_depth = payload[8]
            color_type = payload[9]
            compression = payload[10]
            filter_method = payload[11]
            interlace = payload[12]
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if width <= 0 or height <= 0 or width > 8_192 or height > 8_192:
                raise ValueError("PNG dimensions are outside the supported range")
            if color_type not in valid_depths or bit_depth not in valid_depths[color_type]:
                raise ValueError("invalid PNG color type / bit depth combination")
            if compression != 0 or filter_method != 0 or interlace not in {0, 1}:
                raise ValueError("unsupported PNG compression, filter, or interlace method")
            ihdr = (width, height, bit_depth, color_type, interlace)
        elif chunk_type == b"PLTE":
            if ihdr is None or seen_idat or length == 0 or length % 3 or length > 768:
                raise ValueError("invalid PLTE chunk")
            if ihdr[3] in {0, 4}:
                raise ValueError("PLTE is forbidden for this PNG color type")
            palette_entries = length // 3
        elif chunk_type == b"tRNS":
            if ihdr is None or seen_idat or has_trns:
                raise ValueError("invalid tRNS ordering")
            color_type = ihdr[3]
            if color_type == 0 and length != 2:
                raise ValueError("grayscale tRNS must contain one sample")
            if color_type == 2 and length != 6:
                raise ValueError("truecolour tRNS must contain three samples")
            if color_type == 3 and (palette_entries is None or length > palette_entries):
                raise ValueError("indexed tRNS exceeds the palette")
            if color_type in {4, 6}:
                raise ValueError("tRNS is forbidden when alpha is already present")
            has_trns = True
        elif chunk_type == b"IDAT":
            if ihdr is None or idat_closed:
                raise ValueError("IDAT chunks must be consecutive after IHDR")
            seen_idat = True
            idat_parts.append(payload)
        elif chunk_type == b"IEND":
            if length != 0 or not seen_idat:
                raise ValueError("invalid IEND or missing IDAT")
            seen_iend = True
            position = chunk_end
            if position != len(data):
                raise ValueError("bytes found after terminal IEND")
            break
        elif seen_idat:
            idat_closed = True
        position = chunk_end
        chunk_index += 1
    if ihdr is None or not seen_idat or not seen_iend:
        raise ValueError("PNG requires IHDR, IDAT, and terminal IEND")
    width, height, bit_depth, color_type, interlace = ihdr
    if color_type == 3 and palette_entries is None:
        raise ValueError("indexed PNG requires PLTE")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    row_sizes = _png_row_sizes(width, height, bit_depth * channels, interlace)
    expected_size = sum(size + 1 for size in row_sizes)
    if expected_size > MAX_DECODED_PNG_BYTES:
        raise ValueError("decoded PNG exceeds safety limit")
    decoder = zlib.decompressobj()
    decoded = decoder.decompress(b"".join(idat_parts), expected_size + 1)
    if decoder.unconsumed_tail or len(decoded) > expected_size:
        raise ValueError("PNG expands beyond its declared scanline size")
    decoded += decoder.flush()
    if not decoder.eof or decoder.unused_data or len(decoded) != expected_size:
        raise ValueError("PNG IDAT stream is incomplete or has the wrong size")
    offset = 0
    for row_size in row_sizes:
        if decoded[offset] > 4:
            raise ValueError("PNG contains an invalid scanline filter")
        offset += row_size + 1
    return PngMetadata(width, height, color_type in {4, 6} or has_trns)


def validate_png(
    reader: PackReader,
    asset_path: str,
    pointer: str,
    report: ValidationReport,
    *,
    width: int | None = None,
    height: int | None = None,
    alpha: bool = False,
) -> PngMetadata | None:
    try:
        metadata = png_metadata(reader.read(asset_path))
    except Exception as error:
        report.error("PNG_INVALID", pointer, f"Expected a complete valid PNG ({asset_path}): {error}")
        return None
    if width is not None and height is not None and (metadata.width, metadata.height) != (width, height):
        report.error(
            "IMAGE_DIMENSIONS_MISMATCH",
            pointer,
            f"Expected {width}x{height}, got {metadata.width}x{metadata.height}",
        )
    if alpha and not metadata.has_alpha:
        report.error("IMAGE_ALPHA_REQUIRED", pointer, f"Transparent PNG required: {asset_path}")
    return metadata


def validate_reference_wav(reader: PackReader, asset_path: str, pointer: str, report: ValidationReport) -> None:
    try:
        with wave.open(io.BytesIO(reader.read(asset_path)), "rb") as audio:
            channels = audio.getnchannels()
            sample_width = audio.getsampwidth()
            sample_rate = audio.getframerate()
            frames = audio.getnframes()
            compression = audio.getcomptype()
            duration = frames / sample_rate if sample_rate else 0
            if channels not in {1, 2}:
                raise ValueError("reference WAV must be mono or stereo")
            if sample_width not in {2, 3, 4}:
                raise ValueError("reference WAV must use 16-, 24-, or 32-bit PCM")
            if not 16_000 <= sample_rate <= 96_000:
                raise ValueError("reference WAV sample rate must be 16-96 kHz")
            if compression != "NONE":
                raise ValueError("reference WAV must be uncompressed PCM")
            if not 1 <= duration <= 30:
                raise ValueError("reference WAV must contain 1-30 seconds of speech")
    except Exception as error:
        report.error("REFERENCE_AUDIO_INVALID", pointer, f"F5 reference audio is invalid: {error}")


def validate_point(value: object, pointer: str, report: ValidationReport) -> dict[str, Any] | None:
    point = strict_object(value, {"x", "y"}, set(), pointer, report)
    if point is None:
        return None
    for key in ("x", "y"):
        if not finite_number(point.get(key)) or not 0 <= point[key] <= 1:
            report.error("POINT_INVALID", f"{pointer}/{key}", "Normalized point must be between 0 and 1")
    return point


def validate_editorial_camera(value: object, pointer: str, report: ValidationReport) -> None:
    camera = strict_object(value, {"owner", "operation", "strength"}, set(), pointer, report)
    if camera is None:
        return
    if camera.get("owner") != "editorial-camera" or camera.get("operation") not in CAMERA_OPERATIONS:
        report.error("EDITORIAL_CAMERA_INVALID", pointer, "Camera owner or operation is invalid")
    strength = camera.get("strength")
    if not finite_number(strength) or not 0 <= strength <= 1:
        report.error("EDITORIAL_CAMERA_INVALID", f"{pointer}/strength", "Camera strength must be between 0 and 1")
    elif camera.get("operation") == "locked" and strength != 0:
        report.error("EDITORIAL_CAMERA_INVALID", f"{pointer}/strength", "Locked camera strength must be zero")
    elif camera.get("operation") != "locked" and strength == 0:
        report.error("EDITORIAL_CAMERA_INVALID", f"{pointer}/strength", "Editorial camera move needs positive strength")


def validate_delivery(value: object, report: ValidationReport) -> tuple[int | None, dict[str, str]]:
    delivery = strict_object(value, {"raster", "timeline", "video", "audio", "subtitles", "bgm"}, set(), "/delivery", report)
    output_paths: dict[str, str] = {}
    duration: int | None = None
    if delivery is None:
        return duration, output_paths
    raster = strict_object(delivery.get("raster"), {"width", "height", "pixelAspectRatio"}, set(), "/delivery/raster", report)
    if raster is not None and (
        raster.get("width") != DELIVERY_WIDTH
        or raster.get("height") != DELIVERY_HEIGHT
        or raster.get("pixelAspectRatio") != 1
    ):
        report.error("DELIVERY_RASTER_INVALID", "/delivery/raster", "Delivery must be exact 1080x1920 square-pixel video")
    timeline = strict_object(delivery.get("timeline"), {"fps", "durationFrames"}, set(), "/delivery/timeline", report)
    if timeline is not None:
        if timeline.get("fps") != DELIVERY_FPS:
            report.error("DELIVERY_FPS_INVALID", "/delivery/timeline/fps", "Delivery must be exactly 30 fps")
        raw_duration = timeline.get("durationFrames")
        if not is_int(raw_duration) or not 1 <= raw_duration <= 36_000:
            report.error("DELIVERY_DURATION_INVALID", "/delivery/timeline/durationFrames", "Delivery durationFrames must be 1..36000")
        else:
            duration = raw_duration
    video = strict_object(delivery.get("video"), {"path", "codec", "pixelFormat"}, set(), "/delivery/video", report)
    if video is not None:
        path = require_output_path(video.get("path"), "/delivery/video/path", report)
        if path:
            output_paths["video"] = path
        if video.get("codec") != "h264" or video.get("pixelFormat") != "yuv420p":
            report.error("DELIVERY_VIDEO_INVALID", "/delivery/video", "Delivery video must be h264/yuv420p")
    audio = strict_object(delivery.get("audio"), {"path", "sourceFormat", "muxCodec", "muxSampleRate"}, set(), "/delivery/audio", report)
    if audio is not None:
        path = require_output_path(audio.get("path"), "/delivery/audio/path", report)
        if path:
            output_paths["audio"] = path
        if (
            audio.get("sourceFormat") != "wav"
            or audio.get("muxCodec") != "aac"
            or audio.get("muxSampleRate") != 48_000
        ):
            report.error("DELIVERY_AUDIO_INVALID", "/delivery/audio", "Source audio must be WAV and mux to AAC/48 kHz")
    subtitles = strict_object(delivery.get("subtitles"), {"path", "format", "burnIn"}, set(), "/delivery/subtitles", report)
    if subtitles is not None:
        path = require_output_path(subtitles.get("path"), "/delivery/subtitles/path", report)
        if path:
            output_paths["subtitles"] = path
        if subtitles.get("format") != "srt" or subtitles.get("burnIn") is not False:
            report.error("DELIVERY_SUBTITLES_INVALID", "/delivery/subtitles", "Subtitles must be external SRT with burnIn false")
    if delivery.get("bgm") is not None:
        report.error("BGM_FORBIDDEN", "/delivery/bgm", "Background music must be null")
    if len(set(output_paths.values())) != len(output_paths):
        report.error("DELIVERY_PATH_COLLISION", "/delivery", "Video, audio, and subtitle output paths must be distinct")
    return duration, output_paths


def validate_delivery_timeline(value: object, pointer: str, report: ValidationReport) -> tuple[int | None, int | None]:
    timeline = strict_object(value, {"startFrame", "durationFrames"}, set(), pointer, report)
    if timeline is None:
        return None, None
    start = timeline.get("startFrame")
    duration = timeline.get("durationFrames")
    if not is_int(start) or not 0 <= start <= 36_000:
        report.error("SHOT_START_INVALID", f"{pointer}/startFrame", "Shot startFrame must be a non-negative integer")
        start = None
    if not is_int(duration) or not 1 <= duration <= 36_000:
        report.error("SHOT_DURATION_INVALID", f"{pointer}/durationFrames", "Shot durationFrames must be positive")
        duration = None
    return start, duration


def validate_layer_transform(value: object, pointer: str, report: ValidationReport) -> None:
    transform = strict_object(
        value,
        {"x", "y", "scaleX", "scaleY", "rotationDegrees", "opacity"},
        set(),
        pointer,
        report,
    )
    if transform is None:
        return
    for key in ("x", "y"):
        if not finite_number(transform.get(key)):
            report.error("TRANSFORM_INVALID", f"{pointer}/{key}", "Transform coordinate must be finite")
    for key in ("scaleX", "scaleY"):
        if not finite_number(transform.get(key)) or not 0 < transform[key] <= 20:
            report.error("TRANSFORM_INVALID", f"{pointer}/{key}", "Scale must be in (0,20]")
    rotation = transform.get("rotationDegrees")
    if not finite_number(rotation) or not -3_600 <= rotation <= 3_600:
        report.error("TRANSFORM_INVALID", f"{pointer}/rotationDegrees", "Rotation is outside the supported range")
    opacity = transform.get("opacity")
    if not finite_number(opacity) or not 0 <= opacity <= 1:
        report.error("TRANSFORM_INVALID", f"{pointer}/opacity", "Opacity must be between 0 and 1")


def validate_layered_shot(
    reader: PackReader,
    names: set[str],
    shot: dict[str, Any],
    pointer: str,
    report: ValidationReport,
) -> None:
    strict_object(shot, {"shotId", "kind", "deliveryTimeline", "layers", "editorialCamera"}, set(), pointer, report)
    layers = shot.get("layers")
    if not isinstance(layers, list) or not layers:
        report.error("LAYERS_INVALID", f"{pointer}/layers", "Layered collage requires at least one layer")
    else:
        ids: set[str] = set()
        for index, raw_layer in enumerate(layers):
            layer_pointer = f"{pointer}/layers/{index}"
            layer = strict_object(
                raw_layer,
                {"id", "assetPath", "role", "zIndex", "transform"},
                {"motionPreset"},
                layer_pointer,
                report,
            )
            if layer is None:
                continue
            layer_id = require_id(layer.get("id"), f"{layer_pointer}/id", report)
            if layer_id in ids:
                report.error("LAYER_ID_DUPLICATE", f"{layer_pointer}/id", "Layer IDs must be unique")
            if layer_id:
                ids.add(layer_id)
            role = layer.get("role")
            if role not in {"background", "midground", "actor", "prop", "foreground", "overlay"}:
                report.error("LAYER_ROLE_INVALID", f"{layer_pointer}/role", "Layer role is invalid")
            z_index = layer.get("zIndex")
            if not is_int(z_index) or not -10_000 <= z_index <= 10_000:
                report.error("LAYER_Z_INVALID", f"{layer_pointer}/zIndex", "zIndex is outside the supported range")
            motion = layer.get("motionPreset")
            if motion is not None and motion not in {"locked", "idle-breathe", "paper-sway", "drift", "pop-in"}:
                report.error("LAYER_MOTION_INVALID", f"{layer_pointer}/motionPreset", "Unknown layer motion preset")
            asset = require_source_file(reader, names, layer.get("assetPath"), f"{layer_pointer}/assetPath", report)
            if asset and (asset.lower().endswith(".png") or role in {"actor", "prop", "foreground", "overlay"}):
                if not asset.lower().endswith(".png"):
                    report.error("PNG_REQUIRED", f"{layer_pointer}/assetPath", "Cutout layers must use PNG")
                else:
                    validate_png(reader, asset, f"{layer_pointer}/assetPath", report, alpha=role in {"actor", "prop", "foreground", "overlay"})
            validate_layer_transform(layer.get("transform"), f"{layer_pointer}/transform", report)
    validate_editorial_camera(shot.get("editorialCamera"), f"{pointer}/editorialCamera", report)


def validate_generated_shot(
    reader: PackReader,
    names: set[str],
    shot: dict[str, Any],
    pointer: str,
    duration: int | None,
    report: ValidationReport,
) -> ShotFacts:
    facts = ShotFacts(generated=True)
    strict_object(
        shot,
        {"shotId", "kind", "deliveryTimeline", "generation", "hybridMotion", "occlusion"},
        set(),
        pointer,
        report,
    )
    generation = strict_object(
        shot.get("generation"),
        {"engine", "conditioning", "preset", "raster", "timeline", "conformToDelivery", "candidateSeeds"},
        set(),
        f"{pointer}/generation",
        report,
    )
    conditioning_mode: str | None = None
    if generation is not None:
        if generation.get("engine") != "wangp-local-i2v":
            report.error("GENERATION_ENGINE_INVALID", f"{pointer}/generation/engine", "Use the local WanGP I2V engine")
        raw_conditioning = generation.get("conditioning")
        conditioning_mode = raw_conditioning.get("mode") if isinstance(raw_conditioning, dict) else None
        if conditioning_mode == "start-only":
            conditioning = strict_object(raw_conditioning, {"mode", "startKeyframePath"}, set(), f"{pointer}/generation/conditioning", report)
        elif conditioning_mode == "start-end":
            conditioning = strict_object(raw_conditioning, {"mode", "startKeyframePath", "endKeyframePath"}, set(), f"{pointer}/generation/conditioning", report)
            facts.start_end = True
        else:
            conditioning = strict_object(raw_conditioning, {"mode"}, set(), f"{pointer}/generation/conditioning", report)
            report.error("CONDITIONING_MODE_INVALID", f"{pointer}/generation/conditioning/mode", "Conditioning must be start-only or start-end")
        if conditioning is not None:
            start = require_source_file(reader, names, conditioning.get("startKeyframePath"), f"{pointer}/generation/conditioning/startKeyframePath", report)
            if start:
                validate_png(reader, start, f"{pointer}/generation/conditioning/startKeyframePath", report, width=GENERATION_WIDTH, height=GENERATION_HEIGHT)
            if conditioning_mode == "start-end":
                end = require_source_file(reader, names, conditioning.get("endKeyframePath"), f"{pointer}/generation/conditioning/endKeyframePath", report)
                if end:
                    validate_png(reader, end, f"{pointer}/generation/conditioning/endKeyframePath", report, width=GENERATION_WIDTH, height=GENERATION_HEIGHT)
                if start and end and start == end:
                    report.error("CONDITIONING_ASSET_DUPLICATE", f"{pointer}/generation/conditioning/endKeyframePath", "Start and end keyframes must be distinct assets")
        preset = strict_object(generation.get("preset"), {"id", "quality", "conditioning", "motionStrength"}, set(), f"{pointer}/generation/preset", report)
        if preset is not None:
            require_id(preset.get("id"), f"{pointer}/generation/preset/id", report)
            if preset.get("quality") not in {"preview", "quality"}:
                report.error("GENERATION_QUALITY_INVALID", f"{pointer}/generation/preset/quality", "Quality must be preview or quality")
            if preset.get("conditioning") != conditioning_mode:
                report.error("PRESET_CONDITIONING_MISMATCH", f"{pointer}/generation/preset/conditioning", "Preset conditioning must match the requested input mode")
            strength = preset.get("motionStrength")
            if not finite_number(strength) or not 0 <= strength <= 1:
                report.error("MOTION_STRENGTH_INVALID", f"{pointer}/generation/preset/motionStrength", "Motion strength must be between 0 and 1")
        raster = strict_object(generation.get("raster"), {"width", "height"}, set(), f"{pointer}/generation/raster", report)
        if raster is not None and (raster.get("width"), raster.get("height")) != (GENERATION_WIDTH, GENERATION_HEIGHT):
            report.error("GENERATION_RASTER_INVALID", f"{pointer}/generation/raster", "Current local WanGP profile must be exactly 480x832")
        source_timeline = strict_object(generation.get("timeline"), {"fps", "frameCount"}, set(), f"{pointer}/generation/timeline", report)
        if source_timeline is not None:
            if (source_timeline.get("fps"), source_timeline.get("frameCount")) != (GENERATION_FPS, GENERATION_FRAMES):
                report.error("GENERATION_TIMELINE_INVALID", f"{pointer}/generation/timeline", "Current local WanGP profile must be exactly 24 fps / 81 frames")
            elif duration is not None:
                delivery_seconds = duration / DELIVERY_FPS
                generation_seconds = GENERATION_FRAMES / GENERATION_FPS
                tolerance = max(1 / DELIVERY_FPS, 1 / GENERATION_FPS)
                if abs(delivery_seconds - generation_seconds) > tolerance:
                    report.error("GENERATION_DURATION_MISMATCH", f"{pointer}/generation/timeline", "Generation and delivery must represent the same duration within one source frame")
        conform = strict_object(generation.get("conformToDelivery"), {"spatialFit", "focalPoint", "temporalFit"}, set(), f"{pointer}/generation/conformToDelivery", report)
        if conform is not None:
            if conform.get("spatialFit") != "cover" or conform.get("temporalFit") != "preserve-duration":
                report.error("CONFORM_INVALID", f"{pointer}/generation/conformToDelivery", "Use cover and preserve-duration conformance")
            validate_point(conform.get("focalPoint"), f"{pointer}/generation/conformToDelivery/focalPoint", report)
        seeds = generation.get("candidateSeeds")
        if (
            not isinstance(seeds, list)
            or len(seeds) != 2
            or any(not is_int(seed) or not 0 <= seed <= 2_147_483_647 for seed in seeds)
            or (len(seeds) == 2 and seeds[0] == seeds[1])
        ):
            report.error("CANDIDATE_SEEDS_INVALID", f"{pointer}/generation/candidateSeeds", "Exactly two distinct non-negative 32-bit seeds are required")

    hybrid = strict_object(shot.get("hybridMotion"), {"actor", "world", "deterministicProps", "editorialCamera"}, set(), f"{pointer}/hybridMotion", report)
    actor: dict[str, Any] | None = None
    actor_ids: set[str] = set()
    primary_actor: str | None = None
    excluded_props: list[str] = []
    world: dict[str, Any] | None = None
    milestone_by_id: dict[str, dict[str, Any]] = {}
    contact_constraints: list[dict[str, Any]] = []
    target_id: str | None = None
    generated_object_ids: set[str] = set()
    if hybrid is not None:
        actor = strict_object(
            hybrid.get("actor"),
            {"id", "supportingActorIds", "action", "prompt", "negativePrompt", "generatedCamera", "excludedCausalPropIds"},
            set(),
            f"{pointer}/hybridMotion/actor",
            report,
        )
        if actor is not None:
            primary_actor = require_id(actor.get("id"), f"{pointer}/hybridMotion/actor/id", report)
            if primary_actor:
                actor_ids.add(primary_actor)
            supporting = actor.get("supportingActorIds")
            if not isinstance(supporting, list):
                report.error("SUPPORTING_ACTORS_INVALID", f"{pointer}/hybridMotion/actor/supportingActorIds", "supportingActorIds must be an array")
            else:
                for index, value in enumerate(supporting):
                    actor_id = require_id(value, f"{pointer}/hybridMotion/actor/supportingActorIds/{index}", report)
                    if actor_id in actor_ids:
                        report.error("ACTOR_ID_DUPLICATE", f"{pointer}/hybridMotion/actor/supportingActorIds/{index}", "Primary and supporting actor IDs must be unique")
                    if actor_id:
                        actor_ids.add(actor_id)
            require_text(actor.get("action"), f"{pointer}/hybridMotion/actor/action", report, maximum=500)
            require_text(actor.get("prompt"), f"{pointer}/hybridMotion/actor/prompt", report)
            require_text(actor.get("negativePrompt"), f"{pointer}/hybridMotion/actor/negativePrompt", report)
            if actor.get("generatedCamera") != "locked":
                report.error("GENERATED_CAMERA_INVALID", f"{pointer}/hybridMotion/actor/generatedCamera", "Generated camera must be locked")
            excluded = actor.get("excludedCausalPropIds")
            if not isinstance(excluded, list):
                report.error("EXCLUDED_PROPS_INVALID", f"{pointer}/hybridMotion/actor/excludedCausalPropIds", "excludedCausalPropIds must be an array")
            else:
                for index, value in enumerate(excluded):
                    prop_id = require_id(value, f"{pointer}/hybridMotion/actor/excludedCausalPropIds/{index}", report)
                    if prop_id in excluded_props:
                        report.error("EXCLUDED_PROP_DUPLICATE", f"{pointer}/hybridMotion/actor/excludedCausalPropIds/{index}", "Excluded prop IDs must be unique")
                    if prop_id:
                        excluded_props.append(prop_id)

        world = strict_object(
            hybrid.get("world"),
            {"subjectId", "generatedObjectIds", "supportSurfaceId", "actionAxis", "milestones", "constraints"},
            {"targetId"},
            f"{pointer}/hybridMotion/world",
            report,
        )
        if world is not None:
            subject_id = require_id(world.get("subjectId"), f"{pointer}/hybridMotion/world/subjectId", report)
            target_id = require_id(world.get("targetId"), f"{pointer}/hybridMotion/world/targetId", report) if "targetId" in world else None
            raw_generated_objects = world.get("generatedObjectIds")
            if not isinstance(raw_generated_objects, list):
                report.error("GENERATED_OBJECTS_INVALID", f"{pointer}/hybridMotion/world/generatedObjectIds", "generatedObjectIds must be an array")
            else:
                for index, value in enumerate(raw_generated_objects):
                    object_pointer = f"{pointer}/hybridMotion/world/generatedObjectIds/{index}"
                    object_id = require_id(value, object_pointer, report)
                    if object_id in generated_object_ids:
                        report.error("GENERATED_OBJECT_ID_DUPLICATE", object_pointer, "Generated-world object IDs must be unique")
                    if object_id:
                        generated_object_ids.add(object_id)
            surface_id = require_id(world.get("supportSurfaceId"), f"{pointer}/hybridMotion/world/supportSurfaceId", report)
            if subject_id and primary_actor and subject_id != primary_actor:
                report.error("SUBJECT_MISMATCH", f"{pointer}/hybridMotion/world/subjectId", "World subject must be the primary actor")
            axis = strict_object(world.get("actionAxis"), {"from", "to"}, set(), f"{pointer}/hybridMotion/world/actionAxis", report)
            if axis is not None:
                start_point = validate_point(axis.get("from"), f"{pointer}/hybridMotion/world/actionAxis/from", report)
                end_point = validate_point(axis.get("to"), f"{pointer}/hybridMotion/world/actionAxis/to", report)
                if start_point and end_point and math.hypot(end_point["x"] - start_point["x"], end_point["y"] - start_point["y"]) < 0.01:
                    report.error("ACTION_AXIS_ZERO", f"{pointer}/hybridMotion/world/actionAxis", "Action axis must point from actor toward target")
            milestones = world.get("milestones")
            previous = -1
            if not isinstance(milestones, list) or not milestones:
                report.error("MILESTONES_INVALID", f"{pointer}/hybridMotion/world/milestones", "At least one milestone is required")
            else:
                for index, raw_milestone in enumerate(milestones):
                    milestone_pointer = f"{pointer}/hybridMotion/world/milestones/{index}"
                    milestone = strict_object(raw_milestone, {"id", "kind", "frame"}, set(), milestone_pointer, report)
                    if milestone is None:
                        continue
                    milestone_id = require_id(milestone.get("id"), f"{milestone_pointer}/id", report)
                    kind = milestone.get("kind")
                    frame = milestone.get("frame")
                    if kind not in MILESTONE_KINDS:
                        report.error("MILESTONE_KIND_INVALID", f"{milestone_pointer}/kind", "Unknown milestone kind")
                    if not is_int(frame) or frame < 0 or (duration is not None and frame >= duration):
                        report.error("MILESTONE_FRAME_INVALID", f"{milestone_pointer}/frame", "Milestone must be an in-shot delivery frame")
                    elif frame <= previous:
                        report.error("MILESTONE_ORDER_INVALID", f"{milestone_pointer}/frame", "Milestones must use strictly increasing frames")
                    else:
                        previous = frame
                    if milestone_id in milestone_by_id:
                        report.error("MILESTONE_ID_DUPLICATE", f"{milestone_pointer}/id", "Milestone IDs must be unique")
                    if milestone_id:
                        milestone_by_id[milestone_id] = milestone

            constraints = strict_object(world.get("constraints"), {"facing", "support", "contact"}, set(), f"{pointer}/hybridMotion/world/constraints", report)
            constraint_ids: set[str] = set()

            def remember_constraint(raw_id: object, constraint_pointer: str) -> str | None:
                constraint_id = require_id(raw_id, f"{constraint_pointer}/id", report)
                if constraint_id in constraint_ids:
                    report.error("CONSTRAINT_ID_DUPLICATE", f"{constraint_pointer}/id", "World constraint IDs must be unique")
                if constraint_id:
                    constraint_ids.add(constraint_id)
                return constraint_id

            def validate_interval(from_id: object, through_id: object, interval_pointer: str) -> None:
                start_id = require_id(from_id, f"{interval_pointer}/fromMilestoneId", report)
                end_id = require_id(through_id, f"{interval_pointer}/throughMilestoneId", report)
                start_milestone = milestone_by_id.get(start_id or "")
                end_milestone = milestone_by_id.get(end_id or "")
                if start_id and start_milestone is None:
                    report.error("CONSTRAINT_MILESTONE_MISSING", f"{interval_pointer}/fromMilestoneId", "Constraint start milestone does not exist")
                if end_id and end_milestone is None:
                    report.error("CONSTRAINT_MILESTONE_MISSING", f"{interval_pointer}/throughMilestoneId", "Constraint end milestone does not exist")
                if start_milestone and end_milestone and end_milestone.get("frame", -1) < start_milestone.get("frame", -1):
                    report.error("CONSTRAINT_INTERVAL_REVERSED", interval_pointer, "Constraint interval must run forward in delivery time")

            if constraints is not None:
                facing = constraints.get("facing")
                if not isinstance(facing, list) or not facing:
                    report.error("FACING_CONSTRAINT_REQUIRED", f"{pointer}/hybridMotion/world/constraints/facing", "At least one structured facing constraint is required")
                else:
                    for index, raw_constraint in enumerate(facing):
                        constraint_pointer = f"{pointer}/hybridMotion/world/constraints/facing/{index}"
                        constraint = strict_object(raw_constraint, {"id", "actorId", "towardTargetId", "bodyAxis", "fromMilestoneId", "throughMilestoneId", "maxDeviationDegrees"}, set(), constraint_pointer, report)
                        if constraint is None:
                            continue
                        remember_constraint(constraint.get("id"), constraint_pointer)
                        actor_id = require_id(constraint.get("actorId"), f"{constraint_pointer}/actorId", report)
                        toward = require_id(constraint.get("towardTargetId"), f"{constraint_pointer}/towardTargetId", report)
                        if actor_id and actor_id not in actor_ids:
                            report.error("CONSTRAINT_ACTOR_MISSING", f"{constraint_pointer}/actorId", "Facing actor is not in the generated performance")
                        if toward and toward != target_id:
                            report.error("FACING_TARGET_MISMATCH", f"{constraint_pointer}/towardTargetId", "Facing target must equal world.targetId")
                        if constraint.get("bodyAxis") not in {"head", "torso", "hips", "travel"}:
                            report.error("FACING_AXIS_INVALID", f"{constraint_pointer}/bodyAxis", "Facing body axis is invalid")
                        maximum = constraint.get("maxDeviationDegrees")
                        if not finite_number(maximum) or not 0 < maximum <= 90:
                            report.error("FACING_DEVIATION_INVALID", f"{constraint_pointer}/maxDeviationDegrees", "Facing deviation must be in (0,90]")
                        validate_interval(constraint.get("fromMilestoneId"), constraint.get("throughMilestoneId"), constraint_pointer)
                support = constraints.get("support")
                if not isinstance(support, list) or not support:
                    report.error("SUPPORT_CONSTRAINT_REQUIRED", f"{pointer}/hybridMotion/world/constraints/support", "At least one structured support constraint is required")
                else:
                    for index, raw_constraint in enumerate(support):
                        constraint_pointer = f"{pointer}/hybridMotion/world/constraints/support/{index}"
                        constraint = strict_object(raw_constraint, {"id", "actorId", "bodyPart", "surfaceId", "mode", "fromMilestoneId", "throughMilestoneId", "maxSlipPixels"}, set(), constraint_pointer, report)
                        if constraint is None:
                            continue
                        remember_constraint(constraint.get("id"), constraint_pointer)
                        actor_id = require_id(constraint.get("actorId"), f"{constraint_pointer}/actorId", report)
                        constraint_surface = require_id(constraint.get("surfaceId"), f"{constraint_pointer}/surfaceId", report)
                        if actor_id and actor_id not in actor_ids:
                            report.error("CONSTRAINT_ACTOR_MISSING", f"{constraint_pointer}/actorId", "Support actor is not in the generated performance")
                        if constraint_surface and constraint_surface != surface_id:
                            report.error("SUPPORT_SURFACE_MISMATCH", f"{constraint_pointer}/surfaceId", "Support constraint must use world.supportSurfaceId")
                        if constraint.get("bodyPart") not in BODY_PARTS:
                            report.error("BODY_PART_INVALID", f"{constraint_pointer}/bodyPart", "Unknown body part")
                        if constraint.get("mode") not in {"planted", "supported", "sliding-allowed"}:
                            report.error("SUPPORT_MODE_INVALID", f"{constraint_pointer}/mode", "Unknown support mode")
                        slip = constraint.get("maxSlipPixels")
                        if not finite_number(slip) or not 0 <= slip <= DELIVERY_WIDTH:
                            report.error("SUPPORT_SLIP_INVALID", f"{constraint_pointer}/maxSlipPixels", "Support slip must be 0..1080 delivery pixels")
                        validate_interval(constraint.get("fromMilestoneId"), constraint.get("throughMilestoneId"), constraint_pointer)
                raw_contact = constraints.get("contact")
                if not isinstance(raw_contact, list):
                    report.error("CONTACT_CONSTRAINTS_INVALID", f"{pointer}/hybridMotion/world/constraints/contact", "contact must be an array")
                else:
                    for index, raw_constraint in enumerate(raw_contact):
                        constraint_pointer = f"{pointer}/hybridMotion/world/constraints/contact/{index}"
                        constraint = strict_object(raw_constraint, {"id", "actorId", "bodyPart", "target", "milestoneId", "kind", "toleranceFrames"}, set(), constraint_pointer, report)
                        if constraint is None:
                            continue
                        remember_constraint(constraint.get("id"), constraint_pointer)
                        actor_id = require_id(constraint.get("actorId"), f"{constraint_pointer}/actorId", report)
                        milestone_id = require_id(constraint.get("milestoneId"), f"{constraint_pointer}/milestoneId", report)
                        if actor_id and actor_id not in actor_ids:
                            report.error("CONSTRAINT_ACTOR_MISSING", f"{constraint_pointer}/actorId", "Contact actor is not in the generated performance")
                        if constraint.get("bodyPart") not in BODY_PARTS:
                            report.error("BODY_PART_INVALID", f"{constraint_pointer}/bodyPart", "Unknown body part")
                        if constraint.get("kind") not in {"strike", "touch", "grasp", "release"}:
                            report.error("CONTACT_KIND_INVALID", f"{constraint_pointer}/kind", "Unknown contact kind")
                        tolerance = constraint.get("toleranceFrames")
                        if not is_int(tolerance) or not 0 <= tolerance <= 3:
                            report.error("CONTACT_TOLERANCE_INVALID", f"{constraint_pointer}/toleranceFrames", "Contact tolerance must be 0..3 delivery frames")
                        milestone = milestone_by_id.get(milestone_id or "")
                        if milestone_id and milestone is None:
                            report.error("CONTACT_MILESTONE_MISSING", f"{constraint_pointer}/milestoneId", "Contact milestone does not exist")
                        elif milestone is not None:
                            expected_kind = "release" if constraint.get("kind") == "release" else "contact"
                            if milestone.get("kind") != expected_kind:
                                report.error("CONTACT_MILESTONE_KIND", f"{constraint_pointer}/kind", "Contact kind must match a contact/release milestone")
                        target_pointer = f"{constraint_pointer}/target"
                        raw_target = constraint.get("target")
                        target_owner = raw_target.get("owner") if isinstance(raw_target, dict) else None
                        if target_owner == "deterministic-interaction":
                            target = strict_object(raw_target, {"owner", "propId"}, set(), target_pointer, report)
                            if target is not None:
                                require_id(target.get("propId"), f"{target_pointer}/propId", report)
                        elif target_owner == "generated-world":
                            target = strict_object(raw_target, {"owner", "objectId"}, set(), target_pointer, report)
                            if target is not None:
                                object_id = require_id(target.get("objectId"), f"{target_pointer}/objectId", report)
                                if object_id and object_id != target_id and object_id not in generated_object_ids:
                                    report.error(
                                        "CONTACT_WORLD_OBJECT_MISSING",
                                        f"{target_pointer}/objectId",
                                        "Generated-world contact must use world.targetId or a declared generatedObjectId",
                                    )
                        else:
                            strict_object(raw_target, {"owner"}, set(), target_pointer, report)
                            report.error(
                                "CONTACT_TARGET_OWNER_INVALID",
                                f"{target_pointer}/owner",
                                "Contact target owner must be deterministic-interaction or generated-world",
                            )
                        contact_constraints.append(constraint)

        props = hybrid.get("deterministicProps")
        prop_ids: set[str] = set()
        prop_trigger_by_id: dict[str, str] = {}
        if not isinstance(props, list):
            report.error("DETERMINISTIC_PROPS_INVALID", f"{pointer}/hybridMotion/deterministicProps", "deterministicProps must be an array")
        else:
            for index, raw_prop in enumerate(props):
                prop_pointer = f"{pointer}/hybridMotion/deterministicProps/{index}"
                prop = strict_object(raw_prop, {"propId", "assetPath", "renderSize", "trigger", "transform", "motion"}, set(), prop_pointer, report)
                if prop is None:
                    continue
                prop_id = require_id(prop.get("propId"), f"{prop_pointer}/propId", report)
                if prop_id in prop_ids:
                    report.error("PROP_ID_DUPLICATE", f"{prop_pointer}/propId", "Deterministic prop IDs must be unique")
                if prop_id:
                    prop_ids.add(prop_id)
                    facts.ballistics = True
                asset = require_source_file(reader, names, prop.get("assetPath"), f"{prop_pointer}/assetPath", report)
                render_size = strict_object(prop.get("renderSize"), {"width", "height"}, set(), f"{prop_pointer}/renderSize", report)
                render_width: int | None = None
                render_height: int | None = None
                if render_size is not None:
                    width = render_size.get("width")
                    height = render_size.get("height")
                    if not finite_number(width) or not 0 < width <= DELIVERY_WIDTH:
                        report.error("PROP_RENDER_SIZE_INVALID", f"{prop_pointer}/renderSize/width", "Prop render width must be in (0,1080]")
                    elif float(width).is_integer():
                        render_width = int(width)
                    if not finite_number(height) or not 0 < height <= DELIVERY_HEIGHT:
                        report.error("PROP_RENDER_SIZE_INVALID", f"{prop_pointer}/renderSize/height", "Prop render height must be in (0,1920]")
                    elif float(height).is_integer():
                        render_height = int(height)
                if asset:
                    if not asset.lower().endswith(".png"):
                        report.error("PNG_REQUIRED", f"{prop_pointer}/assetPath", "Deterministic prop must be a transparent PNG")
                    else:
                        validate_png(reader, asset, f"{prop_pointer}/assetPath", report, width=render_width, height=render_height, alpha=True)
                trigger = strict_object(prop.get("trigger"), {"milestoneId", "kind"}, set(), f"{prop_pointer}/trigger", report)
                trigger_milestone_id: str | None = None
                if trigger is not None:
                    trigger_milestone_id = require_id(trigger.get("milestoneId"), f"{prop_pointer}/trigger/milestoneId", report)
                    if trigger.get("kind") not in {"contact", "release"}:
                        report.error("PROP_TRIGGER_KIND_INVALID", f"{prop_pointer}/trigger/kind", "Prop trigger must be contact or release")
                    milestone = milestone_by_id.get(trigger_milestone_id or "")
                    if milestone is None:
                        report.error("PROP_TRIGGER_MISSING", f"{prop_pointer}/trigger/milestoneId", "Prop trigger milestone does not exist")
                    elif milestone.get("kind") != trigger.get("kind"):
                        report.error("PROP_TRIGGER_MISMATCH", f"{prop_pointer}/trigger/kind", "Prop trigger kind must match its milestone")
                    if prop_id and trigger_milestone_id:
                        prop_trigger_by_id[prop_id] = trigger_milestone_id
                transform = strict_object(prop.get("transform"), {"x", "y", "scaleX", "scaleY", "rotationDegrees"}, set(), f"{prop_pointer}/transform", report)
                if transform is not None:
                    for key, maximum in (("x", DELIVERY_WIDTH), ("y", DELIVERY_HEIGHT)):
                        if not finite_number(transform.get(key)) or not 0 <= transform[key] <= maximum:
                            report.error("PROP_TRANSFORM_INVALID", f"{prop_pointer}/transform/{key}", f"Prop centre must be inside 0..{maximum} delivery pixels")
                    for key in ("scaleX", "scaleY"):
                        if not finite_number(transform.get(key)) or not 0 < transform[key] <= 20:
                            report.error("PROP_TRANSFORM_INVALID", f"{prop_pointer}/transform/{key}", "Prop scale must be in (0,20]")
                    rotation = transform.get("rotationDegrees")
                    if not finite_number(rotation) or not -3_600 <= rotation <= 3_600:
                        report.error("PROP_TRANSFORM_INVALID", f"{prop_pointer}/transform/rotationDegrees", "Prop rotation is outside the supported range")
                motion = strict_object(prop.get("motion"), {"kind", "contactFrame", "flightFrames", "targetX", "targetY", "targetScale", "curveX", "spinDegrees"}, set(), f"{prop_pointer}/motion", report)
                if motion is not None:
                    if motion.get("kind") != "ballistic":
                        report.error("PROP_MOTION_INVALID", f"{prop_pointer}/motion/kind", "Only deterministic ballistic motion is supported")
                    contact_frame = motion.get("contactFrame")
                    flight_frames = motion.get("flightFrames")
                    if not is_int(contact_frame) or contact_frame < 0:
                        report.error("PROP_CONTACT_FRAME_INVALID", f"{prop_pointer}/motion/contactFrame", "contactFrame must be non-negative")
                    if not is_int(flight_frames) or not 1 <= flight_frames <= 2_400:
                        report.error("PROP_FLIGHT_INVALID", f"{prop_pointer}/motion/flightFrames", "flightFrames must be 1..2400")
                    if is_int(contact_frame) and is_int(flight_frames) and duration is not None and contact_frame + flight_frames > duration - 1:
                        report.error("PROP_FLIGHT_OUTSIDE_SHOT", f"{prop_pointer}/motion/flightFrames", "Ballistic flight must finish inside the delivery shot")
                    if trigger is not None:
                        milestone = milestone_by_id.get(str(trigger.get("milestoneId")))
                        if milestone is not None and milestone.get("frame") != contact_frame:
                            report.error("PROP_TRIGGER_FRAME_MISMATCH", f"{prop_pointer}/motion/contactFrame", "contactFrame must equal the trigger milestone frame")
                    for key, maximum in (("targetX", DELIVERY_WIDTH), ("targetY", DELIVERY_HEIGHT)):
                        if not finite_number(motion.get(key)) or not 0 <= motion[key] <= maximum:
                            report.error("PROP_TARGET_INVALID", f"{prop_pointer}/motion/{key}", f"Target must be inside 0..{maximum} delivery pixels")
                    target_scale = motion.get("targetScale")
                    if not finite_number(target_scale) or not 0 < target_scale <= 20:
                        report.error("PROP_TARGET_INVALID", f"{prop_pointer}/motion/targetScale", "Target scale must be in (0,20]")
                    curve = motion.get("curveX")
                    if not finite_number(curve) or not -4_000 <= curve <= 4_000:
                        report.error("PROP_CURVE_INVALID", f"{prop_pointer}/motion/curveX", "curveX is outside the supported range")
                    spin = motion.get("spinDegrees")
                    if not finite_number(spin) or not -14_400 <= spin <= 14_400:
                        report.error("PROP_SPIN_INVALID", f"{prop_pointer}/motion/spinDegrees", "spinDegrees is outside the supported range")
        if set(excluded_props) != prop_ids:
            report.error("PROP_EXCLUSION_MISMATCH", f"{pointer}/hybridMotion/actor/excludedCausalPropIds", "Generated plate must exclude exactly the deterministic causal props")
        for index, constraint in enumerate(contact_constraints):
            contact_pointer = f"{pointer}/hybridMotion/world/constraints/contact/{index}"
            target = constraint.get("target")
            if not isinstance(target, dict) or target.get("owner") != "deterministic-interaction":
                continue
            prop_id = target.get("propId")
            if prop_id not in prop_ids:
                report.error("CONTACT_PROP_MISSING", f"{contact_pointer}/target/propId", "Deterministic contact must reference an owned deterministic prop")
            elif constraint.get("milestoneId") != prop_trigger_by_id.get(prop_id):
                report.error("CONTACT_TRIGGER_MISMATCH", f"{contact_pointer}/milestoneId", "Structured contact and deterministic prop must use the same milestone")
        for prop_id in prop_ids:
            owners = [
                constraint
                for constraint in contact_constraints
                if isinstance(constraint.get("target"), dict)
                and constraint["target"].get("owner") == "deterministic-interaction"
                and constraint["target"].get("propId") == prop_id
            ]
            if len(owners) != 1:
                report.error(
                    "CONTACT_OWNER_COUNT_INVALID",
                    f"{pointer}/hybridMotion/world/constraints/contact",
                    f"Deterministic prop needs exactly one owned, trigger-matched contact constraint: {prop_id}",
                )
        validate_editorial_camera(hybrid.get("editorialCamera"), f"{pointer}/hybridMotion/editorialCamera", report)

    occlusion_raw = shot.get("occlusion")
    occlusion_mode = occlusion_raw.get("mode") if isinstance(occlusion_raw, dict) else None
    if occlusion_mode == "none":
        occlusion = strict_object(occlusion_raw, {"mode", "requirement"}, set(), f"{pointer}/occlusion", report)
        if occlusion is not None and occlusion.get("requirement") != "none":
            report.error("OCCLUSION_INVALID", f"{pointer}/occlusion/requirement", "No-matte mode requires requirement none")
    elif occlusion_mode == "local-matte":
        facts.matte = True
        occlusion = strict_object(
            occlusion_raw,
            {"mode", "requirement", "subjectId", "engine", "outputDirectory", "outputFormat", "featherPixels"},
            {"foregroundAssetPath"},
            f"{pointer}/occlusion",
            report,
        )
        if occlusion is not None:
            if occlusion.get("requirement") not in {"optional", "required"}:
                report.error("OCCLUSION_REQUIREMENT_INVALID", f"{pointer}/occlusion/requirement", "Matte requirement must be optional or required")
            subject_id = require_id(occlusion.get("subjectId"), f"{pointer}/occlusion/subjectId", report)
            if subject_id and subject_id != primary_actor:
                report.error("MATTE_SUBJECT_MISMATCH", f"{pointer}/occlusion/subjectId", "Matte subject must be the primary generated actor")
            if occlusion.get("engine") != "local-video-matting" or occlusion.get("outputFormat") != "webm-alpha":
                report.error("OCCLUSION_ENGINE_INVALID", f"{pointer}/occlusion", "Local matte must use local-video-matting/webm-alpha")
            require_output_path(occlusion.get("outputDirectory"), f"{pointer}/occlusion/outputDirectory", report)
            feather = occlusion.get("featherPixels")
            if not is_int(feather) or not 0 <= feather <= 64:
                report.error("OCCLUSION_FEATHER_INVALID", f"{pointer}/occlusion/featherPixels", "featherPixels must be 0..64")
            if "foregroundAssetPath" in occlusion:
                foreground = require_source_file(reader, names, occlusion.get("foregroundAssetPath"), f"{pointer}/occlusion/foregroundAssetPath", report)
                if foreground:
                    if not foreground.lower().endswith(".png"):
                        report.error("PNG_REQUIRED", f"{pointer}/occlusion/foregroundAssetPath", "Foreground occluder must be a transparent PNG")
                    else:
                        validate_png(reader, foreground, f"{pointer}/occlusion/foregroundAssetPath", report, alpha=True)
    else:
        strict_object(occlusion_raw, {"mode"}, set(), f"{pointer}/occlusion", report)
        report.error("OCCLUSION_MODE_INVALID", f"{pointer}/occlusion/mode", "Occlusion mode must be none or local-matte")
    return facts


def validate_narration(
    reader: PackReader,
    names: set[str],
    value: object,
    shot_ids: set[str],
    delivery_audio_path: str | None,
    report: ValidationReport,
) -> list[dict[str, Any]]:
    narration = strict_object(
        value,
        {"engine", "language", "referenceAudioPath", "referenceText", "speed", "segments", "mergedAudioPath"},
        set(),
        "/narration",
        report,
    )
    if narration is None:
        return []
    if narration.get("engine") != "f5-tts-local":
        report.error("NARRATION_ENGINE_INVALID", "/narration/engine", "Narration must use local F5-TTS")
    require_text(narration.get("language"), "/narration/language", report, maximum=32)
    reference = require_source_file(reader, names, narration.get("referenceAudioPath"), "/narration/referenceAudioPath", report)
    if reference:
        if not reference.lower().endswith(".wav"):
            report.error("REFERENCE_AUDIO_INVALID", "/narration/referenceAudioPath", "F5 reference audio must be a WAV")
        else:
            validate_reference_wav(reader, reference, "/narration/referenceAudioPath", report)
    require_text(narration.get("referenceText"), "/narration/referenceText", report)
    speed = narration.get("speed")
    if not finite_number(speed) or not 0.5 <= speed <= 2:
        report.error("TTS_SPEED_INVALID", "/narration/speed", "F5 speed must be between 0.5 and 2")
    merged = require_output_path(narration.get("mergedAudioPath"), "/narration/mergedAudioPath", report)
    if merged and delivery_audio_path and merged != delivery_audio_path:
        report.error("NARRATION_AUDIO_PATH_MISMATCH", "/narration/mergedAudioPath", "mergedAudioPath must equal delivery.audio.path")
    segments = narration.get("segments")
    valid_segments: list[dict[str, Any]] = []
    ids: set[str] = set()
    outputs: set[str] = set()
    if not isinstance(segments, list) or not segments:
        report.error("NARRATION_SEGMENTS_INVALID", "/narration/segments", "At least one narration segment is required")
        return valid_segments
    for index, raw_segment in enumerate(segments):
        pointer = f"/narration/segments/{index}"
        segment = strict_object(raw_segment, {"segmentId", "shotId", "text", "outputPath"}, set(), pointer, report)
        if segment is None:
            continue
        segment_id = require_id(segment.get("segmentId"), f"{pointer}/segmentId", report)
        shot_id = require_id(segment.get("shotId"), f"{pointer}/shotId", report)
        require_text(segment.get("text"), f"{pointer}/text", report)
        output = require_output_path(segment.get("outputPath"), f"{pointer}/outputPath", report)
        if segment_id in ids:
            report.error("NARRATION_SEGMENT_ID_DUPLICATE", f"{pointer}/segmentId", "Narration segment IDs must be unique")
        if segment_id:
            ids.add(segment_id)
        if shot_id and shot_id not in shot_ids:
            report.error("NARRATION_SHOT_MISSING", f"{pointer}/shotId", "Narration segment references an unknown shot")
        if output in outputs or (output and output == merged):
            report.error("NARRATION_OUTPUT_COLLISION", f"{pointer}/outputPath", "Segment and merged narration outputs must be unique")
        if output:
            outputs.add(output)
        valid_segments.append(segment)
    return valid_segments


def validate_production(reader: PackReader, names: set[str], report: ValidationReport) -> dict[str, Any] | None:
    value = load_json(reader, "production.json", report)
    plan = strict_object(
        value,
        {"schemaVersion", "projectId", "metadata", "networkPolicy", "requiredCapabilities", "delivery", "narration", "shots"},
        set(),
        "",
        report,
    )
    if plan is None:
        return None
    if plan.get("schemaVersion") != 3:
        report.error("PRODUCTION_VERSION", "/schemaVersion", "Only schemaVersion 3 is accepted")
    require_id(plan.get("projectId"), "/projectId", report)
    metadata = strict_object(plan.get("metadata"), {"title", "locale"}, set(), "/metadata", report)
    if metadata is not None:
        require_text(metadata.get("title"), "/metadata/title", report, maximum=200)
        locale = metadata.get("locale")
        if not isinstance(locale, str) or not LOCALE_RE.fullmatch(locale):
            report.error("LOCALE_INVALID", "/metadata/locale", "Locale must be a portable BCP-47 tag such as zh-CN")
    if plan.get("networkPolicy") != "offline-only":
        report.error("NETWORK_POLICY_INVALID", "/networkPolicy", "Only offline-only production is accepted")
    capabilities = plan.get("requiredCapabilities")
    capability_set: set[str] = set()
    if not isinstance(capabilities, list) or not capabilities:
        report.error("CAPABILITIES_INVALID", "/requiredCapabilities", "At least one capability is required")
    else:
        for index, capability in enumerate(capabilities):
            if not isinstance(capability, str) or capability not in CAPABILITIES:
                report.error("CAPABILITY_UNKNOWN", f"/requiredCapabilities/{index}", f"Unknown capability: {capability!r}")
            elif capability in capability_set:
                report.error("CAPABILITY_DUPLICATE", f"/requiredCapabilities/{index}", f"Duplicate capability: {capability}")
            else:
                capability_set.add(capability)
    delivery_duration, output_paths = validate_delivery(plan.get("delivery"), report)
    raw_shots = plan.get("shots")
    shot_ids: set[str] = set()
    expected_start = 0
    facts = ShotFacts()
    if not isinstance(raw_shots, list) or not raw_shots:
        report.error("PRODUCTION_SHOTS_INVALID", "/shots", "At least one production shot is required")
    else:
        for index, raw_shot in enumerate(raw_shots):
            pointer = f"/shots/{index}"
            if not isinstance(raw_shot, dict):
                report.error("SHOT_INVALID", pointer, "Shot must be a JSON object")
                continue
            shot_id = require_id(raw_shot.get("shotId"), f"{pointer}/shotId", report)
            if shot_id in shot_ids:
                report.error("SHOT_ID_DUPLICATE", f"{pointer}/shotId", "Shot IDs must be unique")
            if shot_id:
                shot_ids.add(shot_id)
            start, duration = validate_delivery_timeline(raw_shot.get("deliveryTimeline"), f"{pointer}/deliveryTimeline", report)
            if start is not None and start != expected_start:
                report.error("SHOT_TIMELINE_GAP", f"{pointer}/deliveryTimeline/startFrame", "Shots must be contiguous without gaps or overlaps")
            if start is not None and duration is not None:
                expected_start = start + duration
            kind = raw_shot.get("kind")
            if kind == "layered-collage":
                validate_layered_shot(reader, names, raw_shot, pointer, report)
            elif kind == "generated-performance":
                shot_facts = validate_generated_shot(reader, names, raw_shot, pointer, duration, report)
                facts.generated = facts.generated or shot_facts.generated
                facts.start_end = facts.start_end or shot_facts.start_end
                facts.ballistics = facts.ballistics or shot_facts.ballistics
                facts.matte = facts.matte or shot_facts.matte
            else:
                strict_object(raw_shot, {"shotId", "kind", "deliveryTimeline"}, set(), pointer, report)
                report.error("SHOT_KIND_INVALID", f"{pointer}/kind", "Shot kind must be layered-collage or generated-performance")
    if delivery_duration is not None and expected_start != delivery_duration:
        report.error("DELIVERY_TIMELINE_MISMATCH", "/delivery/timeline/durationFrames", "Delivery duration must equal the contiguous shot timeline")
    validate_narration(
        reader,
        names,
        plan.get("narration"),
        shot_ids,
        output_paths.get("audio"),
        report,
    )
    required = {"local-f5-tts", "remotion-render", "ffmpeg", "sidecar-srt"}
    if facts.generated:
        required.add("local-i2v")
    if facts.start_end:
        required.add("local-i2v-start-end")
    if facts.ballistics:
        required.add("deterministic-ballistics")
    if facts.matte:
        required.add("local-video-matting")
    for capability in sorted(required - capability_set):
        report.error("CAPABILITY_MISSING", "/requiredCapabilities", f"Missing required capability: {capability}")
    return plan


def srt_timestamp_ms(match: re.Match[str], offset: int) -> int:
    hours = int(match.group(1 + offset))
    minutes = int(match.group(2 + offset))
    seconds = int(match.group(3 + offset))
    millis = int(match.group(4 + offset))
    return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + millis


def parse_srt(text: str, report: ValidationReport) -> list[tuple[int, int, str]]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized or "\x00" in normalized:
        report.error("SRT_INVALID", "subtitles.srt", "SRT must be non-empty UTF-8 text without NUL bytes")
        return []
    blocks = re.split(r"\n{2,}", normalized)
    cues: list[tuple[int, int, str]] = []
    previous_end = -1
    for block_index, block in enumerate(blocks, start=1):
        lines = block.split("\n")
        pointer = f"subtitles.srt#cue-{block_index}"
        if len(lines) < 3 or lines[0] != str(block_index):
            report.error("SRT_SEQUENCE_INVALID", pointer, "Cue numbers must be consecutive and begin at 1")
            continue
        match = SRT_TIME_RE.fullmatch(lines[1])
        if match is None:
            report.error("SRT_TIMESTAMP_INVALID", pointer, "Use HH:MM:SS,mmm --> HH:MM:SS,mmm with valid minute/second ranges")
            continue
        start = srt_timestamp_ms(match, 0)
        end = srt_timestamp_ms(match, 4)
        cue_text = "\n".join(lines[2:]).strip()
        if not cue_text:
            report.error("SRT_TEXT_EMPTY", pointer, "Cue text cannot be empty")
        if contains_placeholder(cue_text):
            report.error("PLACEHOLDER_FORBIDDEN", pointer, "Replace every template sentinel before validation")
        if end <= start:
            report.error("SRT_RANGE_INVALID", pointer, "Cue end must be later than its start")
        if start < previous_end:
            report.error("SRT_OVERLAP", pointer, "SRT cues must not overlap")
        previous_end = max(previous_end, end)
        cues.append((start, end, cue_text))
    return cues


def normalize_spoken_text(value: str) -> str:
    return "".join(value.split())


def validate_sidecars(reader: PackReader, plan: dict[str, Any] | None, report: ValidationReport) -> None:
    try:
        narration_text = reader.read("narration.txt").decode("utf-8-sig").strip()
        segments_value = json.loads(reader.read("narration.segments.json").decode("utf-8-sig"))
        srt_text = reader.read("subtitles.srt").decode("utf-8-sig")
    except Exception as error:
        report.error("NARRATION_SIDECAR_INVALID", "narration", f"Cannot read strict UTF-8 narration sidecars: {error}")
        return
    if not narration_text:
        report.error("NARRATION_TEXT_EMPTY", "narration.txt", "Narration text cannot be empty")
    if contains_placeholder(narration_text):
        report.error("PLACEHOLDER_FORBIDDEN", "narration.txt", "Replace every template sentinel before validation")
    segment_document = strict_object(segments_value, {"segments"}, set(), "narration.segments.json", report)
    raw_segments = segment_document.get("segments") if segment_document else None
    external_segments: list[dict[str, Any]] = []
    previous_end = 0.0
    if not isinstance(raw_segments, list) or not raw_segments:
        report.error("NARRATION_SIDECAR_INVALID", "narration.segments.json", "segments must be a non-empty array")
    else:
        for index, raw_segment in enumerate(raw_segments):
            pointer = f"narration.segments.json/segments/{index}"
            segment = strict_object(
                raw_segment,
                {"segmentId", "shotId", "text", "startSeconds", "estimatedDurationSeconds"},
                set(),
                pointer,
                report,
            )
            if segment is None:
                continue
            require_id(segment.get("segmentId"), f"{pointer}/segmentId", report)
            require_id(segment.get("shotId"), f"{pointer}/shotId", report)
            require_text(segment.get("text"), f"{pointer}/text", report)
            scan_placeholders(segment, pointer, report)
            start = segment.get("startSeconds")
            duration = segment.get("estimatedDurationSeconds")
            if not finite_number(start) or start < 0:
                report.error("NARRATION_TIMING_INVALID", f"{pointer}/startSeconds", "startSeconds must be finite and non-negative")
            if not finite_number(duration) or duration <= 0:
                report.error("NARRATION_TIMING_INVALID", f"{pointer}/estimatedDurationSeconds", "estimatedDurationSeconds must be positive")
            if finite_number(start) and start < previous_end - 0.001:
                report.error("NARRATION_TIMING_OVERLAP", pointer, "Narration segment estimates must not overlap")
            if finite_number(start) and finite_number(duration):
                previous_end = start + duration
            external_segments.append(segment)
    if external_segments:
        combined = "".join(str(segment.get("text", "")) for segment in external_segments)
        if normalize_spoken_text(narration_text) != normalize_spoken_text(combined):
            report.error("NARRATION_TEXT_MISMATCH", "narration.txt", "Narration text must concatenate from sidecar segments")
    if plan is not None:
        narration_plan = plan.get("narration", {})
        plan_segments = narration_plan.get("segments", []) if isinstance(narration_plan, dict) else []
        expected = [
            (item.get("segmentId"), item.get("shotId"), item.get("text"))
            for item in plan_segments
            if isinstance(item, dict)
        ]
        actual = [
            (item.get("segmentId"), item.get("shotId"), item.get("text"))
            for item in external_segments
        ]
        if actual != expected:
            report.error("NARRATION_PLAN_MISMATCH", "narration.segments.json", "Sidecar segment IDs, shot IDs, and text must exactly match production.json")
        delivery = plan.get("delivery", {})
        timeline = delivery.get("timeline", {}) if isinstance(delivery, dict) else {}
        total_seconds = timeline.get("durationFrames", 0) / DELIVERY_FPS if finite_number(timeline.get("durationFrames")) else 0
        if previous_end > total_seconds + 1 / DELIVERY_FPS:
            report.error("NARRATION_EXCEEDS_DELIVERY", "narration.segments.json", "Estimated narration extends beyond delivery by more than one frame")
    cues = parse_srt(srt_text, report)
    if len(cues) != len(external_segments):
        report.error("SRT_CUE_COUNT_MISMATCH", "subtitles.srt", "SRT must contain exactly one cue per narration segment")
    for index, (cue, segment) in enumerate(zip(cues, external_segments)):
        start_ms, end_ms, cue_text = cue
        pointer = f"subtitles.srt#cue-{index + 1}"
        if normalize_spoken_text(cue_text) != normalize_spoken_text(str(segment.get("text", ""))):
            report.error("SRT_TEXT_MISMATCH", pointer, "Cue text must exactly match its narration segment")
        start = segment.get("startSeconds")
        duration = segment.get("estimatedDurationSeconds")
        if finite_number(start) and finite_number(duration):
            expected_start = round(start * 1_000)
            expected_end = round((start + duration) * 1_000)
            if abs(start_ms - expected_start) > 1 or abs(end_ms - expected_end) > 1:
                report.error("SRT_TIMING_MISMATCH", pointer, "Cue timing must match narration.segments.json to the millisecond")


def validate_path(source: Path | str) -> ValidationReport:
    path_value = Path(source).resolve()
    report = ValidationReport(str(path_value))
    try:
        if path_value.is_dir():
            reader: PackReader = DirectoryReader(path_value, report)
        elif path_value.is_file() and path_value.suffix.lower() == ".zip":
            reader = ZipReader(path_value, report)
        else:
            report.error("SOURCE_INVALID", str(path_value), "Expected an asset-pack directory or ZIP")
            return report
    except Exception as error:
        report.error("SOURCE_INVALID", str(path_value), f"Cannot open asset pack: {error}")
        return report
    names_list = reader.names()
    names = set(names_list)
    if len(names) != len(names_list):
        report.error("PATH_DUPLICATE", "pack", "Asset paths must be unique")
    for name in names:
        if not safe_path(name):
            report.error("PATH_INVALID", name, "Every asset path must be safe and POSIX relative")
        if name.startswith("generated/"):
            report.error("GENERATED_ARTIFACT_FORBIDDEN", name, "Source packs must not contain generated outputs or mutable state")
        if name == "manifest.json" or re.fullmatch(r"shots/[^/]+/shot\.json", name):
            report.error("LEGACY_CONTRACT_FORBIDDEN", name, "v3 has no manifest.json or per-shot v2 JSON")
        if contains_placeholder(name):
            report.error("PLACEHOLDER_FORBIDDEN", name, "Replace placeholder file and directory names")
    required = {"production.json", "narration.txt", "narration.segments.json", "subtitles.srt"}
    for missing in sorted(required - names):
        report.error("ROOT_FILE_MISSING", missing, f"Required v3 root file is missing: {missing}")
    if not required.issubset(names):
        return report
    plan = validate_production(reader, names, report)
    validate_sidecars(reader, plan, report)
    return report


def print_report(report: ValidationReport) -> None:
    for problem in report.errors:
        print(f"ERROR {problem.code} {problem.path}: {problem.message}")
    for problem in report.warnings:
        print(f"WARN  {problem.code} {problem.path}: {problem.message}")
    print(f"Validated {report.source}: {len(report.errors)} error(s), {len(report.warnings)} warning(s)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    report = validate_path(args.source)
    print_report(report)
    raise SystemExit(1 if report.errors else 0)


if __name__ == "__main__":
    main()
