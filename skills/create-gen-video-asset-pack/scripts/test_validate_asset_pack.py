from __future__ import annotations

import importlib.util
import copy
import json
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
import zlib
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
REPO_ROOT = SKILL_ROOT.parents[1]
SPEC = importlib.util.spec_from_file_location("asset_pack_validator_test_target", SCRIPT_DIR / "validate_asset_pack.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load validate_asset_pack.py")
VALIDATOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VALIDATOR
SPEC.loader.exec_module(VALIDATOR)


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(kind)
    crc = zlib.crc32(payload, crc) & 0xFFFFFFFF
    return len(payload).to_bytes(4, "big") + kind + payload + crc.to_bytes(4, "big")


def write_rgba_png(path: Path, width: int, height: int) -> None:
    row = b"\x00" + bytes((196, 142, 72, 255)) * width
    raw = row * height
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(raw, level=9))
        + png_chunk(b"IEND", b"")
    )


def write_reference_wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = 16_000
    frames = bytearray()
    for index in range(sample_rate * 2):
        sample = int(4_000 * math.sin(2 * math.pi * 220 * index / sample_rate))
        frames.extend(struct.pack("<h", sample))
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(bytes(frames))


class AssetPackValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "pack"
        shutil.copytree(SKILL_ROOT / "assets" / "template", self.root)
        production_path = self.root / "production.json"
        production = json.loads(production_path.read_text(encoding="utf-8"))
        production["projectId"] = "football-demo"
        production["metadata"]["title"] = "一脚球为什么不能先飞"
        production["narration"]["referenceText"] = "这是用于本地声音克隆的准确参考句子。"
        spoken = "支撑脚先落稳，球碰到右脚以后才往球门飞。"
        production["narration"]["segments"][0]["text"] = spoken
        shot = production["shots"][0]
        actor = shot["hybridMotion"]["actor"]
        actor.update(
            {
                "id": "kicker",
                "action": "one right-foot strike with a planted left foot",
                "prompt": "Locked camera. The kicker faces the goal, plants the left foot, strikes once, and follows through.",
                "excludedCausalPropIds": ["ball"],
            }
        )
        world = shot["hybridMotion"]["world"]
        world.update({"subjectId": "kicker", "targetId": "goal", "supportSurfaceId": "pitch"})
        facing = world["constraints"]["facing"][0]
        facing.update({"id": "face-goal", "actorId": "kicker", "towardTargetId": "goal"})
        support = world["constraints"]["support"][0]
        support.update({"id": "left-foot-plant", "actorId": "kicker", "surfaceId": "pitch"})
        contact = world["constraints"]["contact"][0]
        contact.update(
            {
                "id": "right-foot-ball",
                "actorId": "kicker",
                "target": {"owner": "deterministic-interaction", "propId": "ball"},
            }
        )
        prop = shot["hybridMotion"]["deterministicProps"][0]
        prop.update({"propId": "ball", "assetPath": "assets/shots/shot-01/ball.png"})
        production_path.write_text(json.dumps(production, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        segment_document = {
            "segments": [
                {
                    "segmentId": "voice-shot-01",
                    "shotId": "shot-01",
                    "text": spoken,
                    "startSeconds": 0,
                    "estimatedDurationSeconds": 3.35,
                }
            ]
        }
        (self.root / "narration.segments.json").write_text(
            json.dumps(segment_document, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        (self.root / "narration.txt").write_text(spoken + "\n", encoding="utf-8", newline="\n")
        (self.root / "subtitles.srt").write_text(
            f"1\n00:00:00,000 --> 00:00:03,350\n{spoken}\n",
            encoding="utf-8",
            newline="\n",
        )
        write_rgba_png(self.root / "assets" / "shots" / "shot-01" / "performance-start.png", 480, 832)
        write_rgba_png(self.root / "assets" / "shots" / "shot-01" / "ball.png", 96, 96)
        write_reference_wav(self.root / "assets" / "voices" / "narrator.wav")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def production(self) -> dict[str, object]:
        return json.loads((self.root / "production.json").read_text(encoding="utf-8"))

    def write_production(self, value: dict[str, object]) -> None:
        (self.root / "production.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

    def error_codes(self) -> set[str]:
        return {problem.code for problem in VALIDATOR.validate_path(self.root).errors}

    def test_valid_greenfield_v3_pack_passes(self) -> None:
        report = VALIDATOR.validate_path(self.root)
        self.assertEqual([], report.errors)

    def test_ihdr_only_png_is_rejected(self) -> None:
        valid = (self.root / "assets" / "shots" / "shot-01" / "performance-start.png").read_bytes()
        (self.root / "assets" / "shots" / "shot-01" / "performance-start.png").write_bytes(valid[:33])
        self.assertIn("PNG_INVALID", self.error_codes())

    def test_placeholder_sentinel_is_rejected(self) -> None:
        production = self.production()
        production["metadata"]["title"] = "TODO"
        self.write_production(production)
        self.assertIn("PLACEHOLDER_FORBIDDEN", self.error_codes())

    def test_legacy_manifest_is_rejected(self) -> None:
        (self.root / "manifest.json").write_text("{}\n", encoding="utf-8")
        self.assertIn("LEGACY_CONTRACT_FORBIDDEN", self.error_codes())

    def test_generation_geometry_is_not_delivery_geometry(self) -> None:
        production = self.production()
        production["shots"][0]["generation"]["raster"]["width"] = 1080
        self.write_production(production)
        self.assertIn("GENERATION_RASTER_INVALID", self.error_codes())

    def test_structured_facing_mismatch_is_rejected(self) -> None:
        production = self.production()
        production["shots"][0]["hybridMotion"]["world"]["constraints"]["facing"][0]["towardTargetId"] = "behind-player"
        self.write_production(production)
        self.assertIn("FACING_TARGET_MISMATCH", self.error_codes())

    def test_generated_world_contact_accepts_target_and_declared_object(self) -> None:
        production = self.production()
        world = production["shots"][0]["hybridMotion"]["world"]
        contacts = world["constraints"]["contact"]
        contacts.append(
            {
                "id": "left-hand-goal-touch",
                "actorId": "kicker",
                "bodyPart": "left-hand",
                "target": {"owner": "generated-world", "objectId": "goal"},
                "milestoneId": "contact",
                "kind": "touch",
                "toleranceFrames": 1,
            }
        )
        self.write_production(production)
        self.assertEqual([], VALIDATOR.validate_path(self.root).errors)

        world["generatedObjectIds"] = ["goal-net"]
        contacts[-1]["target"]["objectId"] = "goal-net"
        self.write_production(production)
        self.assertEqual([], VALIDATOR.validate_path(self.root).errors)

    def test_generated_world_contact_rejects_undeclared_object(self) -> None:
        production = self.production()
        world = production["shots"][0]["hybridMotion"]["world"]
        world["constraints"]["contact"].append(
            {
                "id": "left-hand-phantom-touch",
                "actorId": "kicker",
                "bodyPart": "left-hand",
                "target": {"owner": "generated-world", "objectId": "phantom"},
                "milestoneId": "contact",
                "kind": "touch",
                "toleranceFrames": 1,
            }
        )
        self.write_production(production)
        self.assertIn("CONTACT_WORLD_OBJECT_MISSING", self.error_codes())

    def test_generated_world_object_ids_must_be_unique(self) -> None:
        production = self.production()
        production["shots"][0]["hybridMotion"]["world"]["generatedObjectIds"] = ["net", "net"]
        self.write_production(production)
        self.assertIn("GENERATED_OBJECT_ID_DUPLICATE", self.error_codes())

    def test_deterministic_contact_requires_one_owner_and_matching_trigger(self) -> None:
        production = self.production()
        contacts = production["shots"][0]["hybridMotion"]["world"]["constraints"]["contact"]
        duplicate = copy.deepcopy(contacts[0])
        duplicate["id"] = "second-ball-owner"
        contacts.append(duplicate)
        self.write_production(production)
        self.assertIn("CONTACT_OWNER_COUNT_INVALID", self.error_codes())

        contacts.pop()
        contacts[0]["milestoneId"] = "follow"
        self.write_production(production)
        self.assertIn("CONTACT_TRIGGER_MISMATCH", self.error_codes())

    def test_srt_text_mismatch_is_rejected(self) -> None:
        (self.root / "subtitles.srt").write_text(
            "1\n00:00:00,000 --> 00:00:03,350\n这是另一句话。\n",
            encoding="utf-8",
            newline="\n",
        )
        self.assertIn("SRT_TEXT_MISMATCH", self.error_codes())

    def test_required_matte_requires_capability(self) -> None:
        production = self.production()
        production["shots"][0]["occlusion"] = {
            "mode": "local-matte",
            "requirement": "required",
            "subjectId": "kicker",
            "engine": "local-video-matting",
            "outputDirectory": "generated/mattes/shot-01",
            "outputFormat": "webm-alpha",
            "featherPixels": 2,
        }
        self.write_production(production)
        self.assertIn("CAPABILITY_MISSING", self.error_codes())

    def test_generate_srt_script_writes_strict_external_cue(self) -> None:
        output = Path(self.temporary.name) / "regenerated.srt"
        subprocess.run(
            [
                sys.executable,
                str(SCRIPT_DIR / "generate_srt.py"),
                str(self.root / "narration.segments.json"),
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("00:00:00,000 --> 00:00:03,350", output.read_text(encoding="utf-8"))

    def test_assemble_script_creates_a_revalidated_zip(self) -> None:
        output = Path(self.temporary.name) / "pack.zip"
        subprocess.run(
            [
                sys.executable,
                str(SCRIPT_DIR / "assemble_asset_pack.py"),
                str(self.root),
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = VALIDATOR.validate_path(output)
        self.assertEqual([], report.errors)

    def test_python_validator_does_not_accept_known_zod_rejections(self) -> None:
        tsx = REPO_ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
        schema_module = REPO_ROOT / "packages" / "video-generation" / "src" / "production" / "production-plan.ts"
        if not tsx.exists() or not schema_module.exists():
            self.skipTest("repository tsx runtime is unavailable")
        checker = Path(self.temporary.name) / "zod-check.ts"
        checker.write_text(
            """
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
async function main() {
  const candidate = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const module = await import(pathToFileURL(process.argv[3]).href);
  try { module.parseProductionPlan(candidate); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
main().catch((error) => { console.error(error); process.exit(1); });
""".strip()
            + "\n",
            encoding="utf-8",
        )
        def zod_accepts(candidate: dict[str, object]) -> bool:
            candidate_path = Path(self.temporary.name) / "candidate.json"
            candidate_path.write_text(json.dumps(candidate, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run(
                [str(tsx), str(checker), str(candidate_path), str(schema_module)],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
            )
            self.zod_error = result.stderr
            return result.returncode == 0

        original = self.production()
        self.assertTrue(
            zod_accepts(original),
            f"canonical valid pack must pass the authoritative Zod parser: {getattr(self, 'zod_error', '')}",
        )
        cases: list[tuple[str, dict[str, object]]] = []
        extra = copy.deepcopy(original)
        extra["legacy"] = True
        cases.append(("unknown top-level field", extra))
        bad_locale = copy.deepcopy(original)
        bad_locale["metadata"]["locale"] = "not a locale!"
        cases.append(("invalid locale", bad_locale))
        missing_preset_mode = copy.deepcopy(original)
        del missing_preset_mode["shots"][0]["generation"]["preset"]["conditioning"]
        cases.append(("missing preset conditioning", missing_preset_mode))
        missing_support = copy.deepcopy(original)
        missing_support["shots"][0]["hybridMotion"]["world"]["constraints"]["support"] = []
        cases.append(("missing structured support", missing_support))
        legacy_audio = copy.deepcopy(original)
        legacy_audio["delivery"]["audio"] = {
            "path": "generated/audio/narration.wav",
            "codec": "aac",
            "sampleRate": 48000,
        }
        cases.append(("legacy audio shape", legacy_audio))
        flat_contact = copy.deepcopy(original)
        contact = flat_contact["shots"][0]["hybridMotion"]["world"]["constraints"]["contact"][0]
        contact["propId"] = contact.pop("target")["propId"]
        cases.append(("legacy flat contact target", flat_contact))
        undeclared_world_object = copy.deepcopy(original)
        undeclared_world_object["shots"][0]["hybridMotion"]["world"]["constraints"]["contact"].append(
            {
                "id": "touch-phantom",
                "actorId": "kicker",
                "bodyPart": "left-hand",
                "target": {"owner": "generated-world", "objectId": "phantom"},
                "milestoneId": "contact",
                "kind": "touch",
                "toleranceFrames": 1,
            }
        )
        cases.append(("undeclared generated-world contact target", undeclared_world_object))
        for label, candidate in cases:
            with self.subTest(label=label):
                self.write_production(candidate)
                python_accepts = not VALIDATOR.validate_path(self.root).errors
                self.assertFalse(zod_accepts(candidate), f"authoritative Zod unexpectedly accepted {label}")
                self.assertFalse(python_accepts, f"Python validator accepted a plan Zod rejects: {label}")


class PaperCollageAssetPackValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "paper-pack"
        shutil.copytree(SKILL_ROOT / "assets" / "paper-template", self.root)
        production_path = self.root / "production.json"
        production = json.loads(production_path.read_text(encoding="utf-8"))
        production["projectId"] = "paper-collage-demo"
        production["metadata"]["title"] = "纸片组装验证"
        production["narration"]["referenceText"] = "这是用于本地声音克隆的准确参考句子。"
        spoken = "纸片先搭好场景，小猫再从画外滑进来。"
        production["narration"]["segments"][0]["text"] = spoken
        production_path.write_text(
            json.dumps(production, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        (self.root / "narration.segments.json").write_text(
            json.dumps(
                {
                    "segments": [
                        {
                            "segmentId": "voice-shot-01",
                            "shotId": "shot-01",
                            "text": spoken,
                            "startSeconds": 0,
                            "estimatedDurationSeconds": 5,
                        }
                    ]
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        (self.root / "narration.txt").write_text(spoken + "\n", encoding="utf-8", newline="\n")
        (self.root / "subtitles.srt").write_text(
            f"1\n00:00:00,000 --> 00:00:05,000\n{spoken}\n",
            encoding="utf-8",
            newline="\n",
        )
        for name in (
            "background.png",
            "structure.png",
            "actor-complete.png",
            "prop.png",
            "foreground.png",
            "accent.png",
        ):
            write_rgba_png(self.root / "assets" / "shots" / "shot-01" / name, 320, 480)
        write_reference_wav(self.root / "assets" / "voices" / "narrator.wav")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def production(self) -> dict[str, object]:
        return json.loads((self.root / "production.json").read_text(encoding="utf-8"))

    def write_production(self, value: dict[str, object]) -> None:
        (self.root / "production.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )

    def error_codes(self) -> set[str]:
        return {problem.code for problem in VALIDATOR.validate_path(self.root).errors}

    def test_default_paper_template_passes_after_replacing_placeholders(self) -> None:
        report = VALIDATOR.validate_path(self.root)
        self.assertEqual([], report.errors)

    def test_default_paper_template_matches_authoritative_zod_schema(self) -> None:
        tsx = REPO_ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
        schema_module = REPO_ROOT / "packages" / "video-generation" / "src" / "production" / "production-plan.ts"
        if not tsx.exists() or not schema_module.exists():
            self.skipTest("repository tsx runtime is unavailable")
        checker = Path(self.temporary.name) / "paper-zod-check.ts"
        checker.write_text(
            """
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
async function main() {
  const candidate = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const module = await import(pathToFileURL(process.argv[3]).href);
  module.parseProductionPlan(candidate);
}
main().catch((error) => { console.error(error); process.exit(1); });
""".strip()
            + "\n",
            encoding="utf-8",
        )
        result = subprocess.run(
            [str(tsx), str(checker), str(self.root / "production.json"), str(schema_module)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(0, result.returncode, result.stderr)

    def test_all_finite_rigid_paper_follow_through_kinds_are_accepted(self) -> None:
        original = self.production()
        for kind in (
            "bob",
            "sway",
            "gesture-left",
            "gesture-right",
            "exit-left",
            "exit-right",
        ):
            with self.subTest(kind=kind):
                production = copy.deepcopy(original)
                cue = production["shots"][0]["layers"][2]["assembly"]["followThrough"]
                cue["kind"] = kind
                if kind.startswith("exit-"):
                    cue["distance"] = 1_200
                    cue["rotationDegrees"] = 10
                self.write_production(production)
                self.assertEqual([], VALIDATOR.validate_path(self.root).errors)

    def test_follow_through_uses_a_strict_field_and_range_contract(self) -> None:
        original = self.production()
        cases = (
            ("kind", "idle-breathe", "PAPER_FOLLOW_THROUGH_KIND_INVALID"),
            ("kind", ["sway"], "PAPER_FOLLOW_THROUGH_KIND_INVALID"),
            ("delayFrames", -1, "PAPER_FOLLOW_THROUGH_DELAY_INVALID"),
            ("durationFrames", 7, "PAPER_FOLLOW_THROUGH_DURATION_INVALID"),
            ("distance", 121, "PAPER_FOLLOW_THROUGH_DISTANCE_INVALID"),
            ("rotationDegrees", 9, "PAPER_FOLLOW_THROUGH_ROTATION_INVALID"),
            ("cadenceFps", 5, "PAPER_FOLLOW_THROUGH_CADENCE_INVALID"),
        )
        for field, value, expected_code in cases:
            with self.subTest(field=field, value=value):
                production = copy.deepcopy(original)
                cue = production["shots"][0]["layers"][2]["assembly"]["followThrough"]
                cue[field] = value
                self.write_production(production)
                self.assertIn(expected_code, self.error_codes())

        production = copy.deepcopy(original)
        cue = production["shots"][0]["layers"][2]["assembly"]["followThrough"]
        cue["repeat"] = True
        self.write_production(production)
        self.assertIn("FIELD_UNKNOWN", self.error_codes())

    def test_follow_through_must_leave_six_exact_final_hold_frames(self) -> None:
        production = self.production()
        cue = production["shots"][0]["layers"][2]["assembly"]["followThrough"]
        cue["delayFrames"] = 49
        self.write_production(production)

        codes = self.error_codes()
        self.assertIn("PAPER_FOLLOW_THROUGH_HOLD_REQUIRED", codes)
        self.assertIn("PAPER_SETTLE_HOLD_REQUIRED", codes)

    def test_unknown_assembly_kind_is_rejected(self) -> None:
        production = self.production()
        production["shots"][0]["layers"][1]["assembly"]["kind"] = "morph"
        self.write_production(production)
        self.assertIn("PAPER_ASSEMBLY_KIND_INVALID", self.error_codes())

    def test_background_assembly_and_timeline_overrun_are_rejected(self) -> None:
        production = self.production()
        production["shots"][0]["layers"][0]["assembly"] = {
            "kind": "pop",
            "startFrame": 0,
            "durationFrames": 12,
            "distance": 120,
            "rotationDegrees": 2,
            "steps": 6,
        }
        production["shots"][0]["layers"][1]["assembly"]["startFrame"] = 140
        production["shots"][0]["layers"][1]["assembly"]["durationFrames"] = 20
        self.write_production(production)
        codes = self.error_codes()
        self.assertIn("PAPER_BACKGROUND_ASSEMBLY_FORBIDDEN", codes)
        self.assertIn("PAPER_ASSEMBLY_OUTSIDE_SHOT", codes)

    def test_looping_motion_cannot_resume_after_assembly(self) -> None:
        production = self.production()
        production["shots"][0]["layers"][1]["motionPreset"] = "paper-sway"
        self.write_production(production)
        self.assertIn("PAPER_ASSEMBLY_MOTION_CONFLICT", self.error_codes())

    def test_non_uniform_paper_scale_is_rejected_as_distortion(self) -> None:
        production = self.production()
        production["shots"][0]["layers"][2]["transform"]["scaleY"] = 1.2
        self.write_production(production)
        self.assertIn("PAPER_UNIFORM_SCALE_REQUIRED", self.error_codes())

    def test_partial_or_simultaneous_paper_assembly_is_rejected(self) -> None:
        production = self.production()
        del production["shots"][0]["layers"][2]["assembly"]
        for layer in production["shots"][0]["layers"][1:]:
            if "assembly" in layer:
                layer["assembly"]["startFrame"] = 12
        self.write_production(production)
        codes = self.error_codes()
        self.assertIn("PAPER_GROUP_ASSEMBLY_REQUIRED", codes)
        self.assertIn("PAPER_ASSEMBLY_STAGGER_REQUIRED", codes)

    def test_zero_assembly_static_collage_is_rejected(self) -> None:
        production = self.production()
        for layer in production["shots"][0]["layers"]:
            layer.pop("assembly", None)
        self.write_production(production)
        codes = self.error_codes()
        self.assertIn("PAPER_GROUP_ASSEMBLY_REQUIRED", codes)
        self.assertIn("PAPER_ASSEMBLY_STAGGER_REQUIRED", codes)

    def test_repository_cat_noodle_example_is_a_clean_source_pack(self) -> None:
        example = REPO_ROOT / "examples" / "cat-noodle-collage-v1"
        report = VALIDATOR.validate_path(example)
        self.assertEqual([], report.errors)


if __name__ == "__main__":
    unittest.main()
