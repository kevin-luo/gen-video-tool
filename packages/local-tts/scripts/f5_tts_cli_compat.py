#!/usr/bin/env python3
"""Run F5-TTS without requiring TorchCodec for ordinary local WAV input.

This wrapper is opt-in.  It replaces only torchaudio.load with SoundFile, then
executes the installed F5-TTS CLI module in the same local Python environment.
"""

from __future__ import annotations

import runpy

import numpy as np
import soundfile as sf
import torch
import torchaudio


def _soundfile_load(path: str, *args: object, **kwargs: object) -> tuple[torch.Tensor, int]:
    del args, kwargs
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    channels_first = np.ascontiguousarray(audio.T)
    return torch.from_numpy(channels_first), int(sample_rate)


torchaudio.load = _soundfile_load  # type: ignore[assignment]
runpy.run_module("f5_tts.infer.infer_cli", run_name="__main__")
