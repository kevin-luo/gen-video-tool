#!/usr/bin/env python3
"""Download a large public model artifact with durable parallel range parts."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
from typing import Final
from urllib.parse import unquote, urlparse

import requests


MIB: Final = 1024 * 1024
HASH_RE: Final = re.compile(r"^[0-9a-fA-F]{64}$")
PRINT_LOCK = threading.Lock()


class DownloadUrlProvider:
    """Refresh an expiring redirected CDN URL once for all download workers."""

    def __init__(self, source_url: str, resolved_url: str, *, refresh_from_origin: bool = False) -> None:
        self.source_url = source_url
        self._resolved_url = resolved_url
        self._refresh_from_origin = refresh_from_origin
        self._lock = threading.Lock()

    def get(self) -> str:
        with self._lock:
            return self._resolved_url

    def refresh(self, stale_url: str) -> str:
        with self._lock:
            if self._resolved_url != stale_url:
                return self._resolved_url
            if self._refresh_from_origin:
                # Hugging Face signs the exact requested Range on each origin
                # redirect. Reusing an unrestricted Xet URL can return a larger
                # CAS-aligned block whose bytes are unsuitable for segmentation.
                self._resolved_url = self.source_url
                return self._resolved_url
            _, _, refreshed = probe(self.source_url)
            self._resolved_url = refreshed
            return refreshed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Parallel HTTP range downloader that preserves completed parts across retries.",
    )
    parser.add_argument("url", help="Public HTTPS source URL. Redirects are followed per range request.")
    parser.add_argument("output", type=Path, help="Final output file.")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--segment-mib", type=int, default=64)
    parser.add_argument("--retries", type=int, default=50)
    parser.add_argument("--sha256", help="Optional expected SHA-256. Hugging Face LFS metadata is used when available.")
    return parser.parse_args()


def require_https(url: str) -> None:
    if not url.lower().startswith("https://"):
        raise ValueError("Only HTTPS model downloads are accepted.")


def is_hugging_face_url(url: str) -> bool:
    return urlparse(url).hostname in {'huggingface.co', 'www.huggingface.co'}


def hugging_face_coordinates(url: str) -> tuple[str, str, str] | None:
    parsed = urlparse(url)
    if not is_hugging_face_url(url):
        return None
    segments = [unquote(segment) for segment in parsed.path.split('/') if segment]
    try:
        resolve_index = segments.index('resolve')
    except ValueError:
        return None
    if resolve_index < 2 or len(segments) <= resolve_index + 2:
        return None
    return (
        '/'.join(segments[:resolve_index]),
        segments[resolve_index + 1],
        '/'.join(segments[resolve_index + 2:]),
    )


def probe(url: str) -> tuple[int, str | None, str]:
    response = requests.get(
        url,
        headers={"Accept-Encoding": "identity", "Cache-Control": "no-cache"},
        allow_redirects=True,
        stream=True,
        timeout=(30, 120),
    )
    try:
        response.raise_for_status()
        content_range = response.headers.get("Content-Range", "")
        if response.status_code == 206 and "/" in content_range:
            total = int(content_range.rsplit("/", 1)[1])
        elif response.status_code == 200 and response.headers.get("Content-Length"):
            total = int(response.headers["Content-Length"])
        else:
            raise RuntimeError("Server did not report an artifact length or support byte ranges.")
        etag = response.headers.get("ETag", "").strip('"') or None
        return total, etag, response.url
    finally:
        response.close()


def hugging_face_lfs_sha256(url: str) -> str | None:
    coordinates = hugging_face_coordinates(url)
    if coordinates is None:
        return None
    repo_id, revision, filename = coordinates
    api_url = (
        f"https://huggingface.co/api/models/{repo_id}?blobs=true"
        if revision == 'main'
        else f"https://huggingface.co/api/models/{repo_id}/revision/{revision}?blobs=true"
    )
    response = requests.get(api_url, timeout=(30, 120))
    response.raise_for_status()
    for sibling in response.json().get('siblings', []):
        if sibling.get('rfilename') != filename:
            continue
        sha256 = sibling.get('lfs', {}).get('sha256')
        return sha256.lower() if isinstance(sha256, str) and HASH_RE.fullmatch(sha256) else None
    return None


def part_path(parts_root: Path, index: int) -> Path:
    return parts_root / f"{index:06d}.part"


def download_part(
    *,
    url_provider: DownloadUrlProvider,
    destination: Path,
    start: int,
    end: int,
    retries: int,
    completed_before: int,
    total: int,
) -> int:
    expected = end - start + 1
    destination.parent.mkdir(parents=True, exist_ok=True)
    existing = destination.stat().st_size if destination.exists() else 0
    if existing > expected:
        # Some Xet-backed endpoints align responses to a larger storage chunk
        # even when the requested Content-Range starts at the correct byte.
        # The prefix is still valid, so retain it instead of throwing away a
        # completed segment on resume.
        with destination.open("r+b") as output:
            output.truncate(expected)
        existing = expected
    if existing == expected:
        return expected

    attempt = 0
    download_url = url_provider.get()
    while existing < expected:
        request_start = start + existing
        try:
            with requests.get(
                download_url,
                headers={
                    "Range": f"bytes={request_start}-{end}",
                    "Accept-Encoding": "identity",
                },
                allow_redirects=True,
                stream=True,
                timeout=(30, 120),
            ) as response:
                if response.status_code != 206:
                    raise RuntimeError(f"Expected HTTP 206, received {response.status_code}.")
                content_range = response.headers.get("Content-Range", "")
                if not content_range.startswith(f"bytes {request_start}-"):
                    raise RuntimeError(f"Unexpected Content-Range: {content_range!r}.")
                with destination.open("ab") as output:
                    for chunk in response.iter_content(chunk_size=MIB):
                        if not chunk:
                            continue
                        remaining = expected - output.tell()
                        if remaining <= 0:
                            break
                        output.write(chunk[:remaining])
            existing = destination.stat().st_size
            attempt = 0
        except Exception as error:  # noqa: BLE001 - retry boundary must preserve completed bytes.
            existing = destination.stat().st_size if destination.exists() else 0
            attempt += 1
            if attempt > retries:
                raise RuntimeError(
                    f"Range {start}-{end} failed after {retries} retries; {existing}/{expected} bytes preserved.",
                ) from error
            delay = min(30.0, 1.25 ** min(attempt, 15))
            with PRINT_LOCK:
                print(
                    json.dumps({
                        "event": "range-retry",
                        "range": [start, end],
                        "preservedBytes": existing,
                        "attempt": attempt,
                        "delaySeconds": round(delay, 2),
                        "error": str(error),
                    }, ensure_ascii=False),
                    flush=True,
                )
            download_url = url_provider.refresh(download_url)
            time.sleep(delay)

    with PRINT_LOCK:
        downloaded = completed_before + expected
        print(
            json.dumps({
                "event": "range-complete",
                "range": [start, end],
                "downloadedBytesAtLeast": downloaded,
                "totalBytes": total,
                "percentAtLeast": round(downloaded * 100 / total, 2),
            }, ensure_ascii=False),
            flush=True,
        )
    return expected


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(16 * MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_with_hugging_face_hub(
    *,
    url: str,
    output: Path,
    total: int,
    expected_hash: str | None,
) -> bool:
    coordinates = hugging_face_coordinates(url)
    if coordinates is None:
        return False
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        return False
    repo_id, revision, filename = coordinates
    local_root = output.with_name(f".{output.name}.huggingface")
    print(json.dumps({
        "event": "download-start",
        "backend": "huggingface_hub",
        "output": str(output),
        "totalBytes": total,
        "expectedSha256": expected_hash,
    }), flush=True)
    downloaded = Path(hf_hub_download(
        repo_id=repo_id,
        revision=revision,
        filename=filename,
        local_dir=local_root,
    )).resolve()
    if downloaded.stat().st_size != total:
        raise RuntimeError("Hugging Face download has the wrong length.")
    digest = sha256_file(downloaded)
    if expected_hash is not None and digest != expected_hash:
        raise RuntimeError(f"SHA-256 mismatch: expected {expected_hash}, received {digest}.")
    os.replace(downloaded, output)
    shutil.rmtree(local_root)
    print(json.dumps({
        "event": "download-complete",
        "backend": "huggingface_hub",
        "path": str(output),
        "bytes": total,
        "sha256": digest,
    }), flush=True)
    return True


def main() -> None:
    args = parse_args()
    require_https(args.url)
    if args.workers < 1 or args.workers > 16:
        raise ValueError("--workers must be between 1 and 16.")
    if args.segment_mib < 8 or args.segment_mib > 1024:
        raise ValueError("--segment-mib must be between 8 and 1024.")
    if args.retries < 0:
        raise ValueError("--retries must be non-negative.")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    total, _etag, resolved_url = probe(args.url)
    origin_ranged = is_hugging_face_url(args.url)
    download_url = args.url if origin_ranged else resolved_url
    url_provider = DownloadUrlProvider(
        args.url,
        download_url,
        refresh_from_origin=origin_ranged,
    )
    expected_hash = args.sha256.lower() if args.sha256 else hugging_face_lfs_sha256(args.url)
    if expected_hash is not None and not HASH_RE.fullmatch(expected_hash):
        raise ValueError("--sha256 must contain exactly 64 hexadecimal characters.")

    if output.exists() and output.stat().st_size == total:
        digest = sha256_file(output) if expected_hash else None
        if expected_hash is None or digest == expected_hash:
            print(json.dumps({"event": "already-complete", "path": str(output), "bytes": total, "sha256": digest}), flush=True)
            return

    if download_with_hugging_face_hub(
        url=args.url,
        output=output,
        total=total,
        expected_hash=expected_hash,
    ):
        return

    segment_size = args.segment_mib * MIB
    ranges = [
        (index, start, min(total - 1, start + segment_size - 1))
        for index, start in enumerate(range(0, total, segment_size))
    ]
    # The strategy suffix prevents older CAS-aligned parts from being silently
    # reused after switching Hugging Face downloads to origin-signed ranges.
    range_strategy = "origin-v2" if origin_ranged else "resolved-v1"
    parts_root = output.with_name(f"{output.name}.parts-{range_strategy}")
    parts_root.mkdir(parents=True, exist_ok=True)
    manifest_path = parts_root / "manifest.json"
    manifest_path.write_text(json.dumps({
        "source": args.url,
        "totalBytes": total,
        "segmentBytes": segment_size,
        "expectedSha256": expected_hash,
    }, indent=2), encoding="utf-8")

    completed_before = sum(
        min(part_path(parts_root, index).stat().st_size, end - start + 1)
        if part_path(parts_root, index).exists() else 0
        for index, start, end in ranges
    )
    print(json.dumps({
        "event": "download-start",
        "output": str(output),
        "totalBytes": total,
        "segments": len(ranges),
        "workers": args.workers,
        "resumedBytes": completed_before,
        "expectedSha256": expected_hash,
    }), flush=True)

    progress_lock = threading.Lock()
    completed_counter = completed_before

    def worker(item: tuple[int, int, int]) -> int:
        nonlocal completed_counter
        index, start, end = item
        destination = part_path(parts_root, index)
        expected = end - start + 1
        before = min(destination.stat().st_size, expected) if destination.exists() else 0
        result = download_part(
            url_provider=url_provider,
            destination=destination,
            start=start,
            end=end,
            retries=args.retries,
            completed_before=completed_counter,
            total=total,
        )
        with progress_lock:
            completed_counter += max(0, result - before)
            current = completed_counter
        with PRINT_LOCK:
            print(json.dumps({
                "event": "download-progress",
                "completedBytes": current,
                "totalBytes": total,
                "percent": round(current * 100 / total, 2),
            }), flush=True)
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        list(executor.map(worker, ranges))

    assembling = output.with_name(f"{output.name}.assembling")
    with assembling.open("wb") as destination:
        for index, start, end in ranges:
            source_path = part_path(parts_root, index)
            expected = end - start + 1
            if source_path.stat().st_size != expected:
                raise RuntimeError(f"Segment {index} has the wrong length.")
            with source_path.open("rb") as source:
                shutil.copyfileobj(source, destination, length=16 * MIB)
    if assembling.stat().st_size != total:
        raise RuntimeError("Assembled artifact has the wrong length.")
    digest = sha256_file(assembling)
    if expected_hash is not None and digest != expected_hash:
        raise RuntimeError(f"SHA-256 mismatch: expected {expected_hash}, received {digest}.")
    os.replace(assembling, output)
    shutil.rmtree(parts_root)
    print(json.dumps({
        "event": "download-complete",
        "path": str(output),
        "bytes": total,
        "sha256": digest,
    }), flush=True)


if __name__ == "__main__":
    main()
