import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {parseFile} from 'music-metadata';
import {diagnostic} from './diagnostics';
import type {AssetPackDiagnostic, ImportLimits} from './types';

export interface ExpectedImageMetadata {
  assetPath: string;
  absolutePath: string;
  requireAlpha: boolean;
  declaredWidth?: number;
  declaredHeight?: number;
  jsonPath?: string;
}

export const validateImage = async (
  image: ExpectedImageMetadata,
  limits: ImportLimits,
): Promise<AssetPackDiagnostic[]> => {
  const diagnostics: AssetPackDiagnostic[] = [];
  try {
    const metadata = await sharp(image.absolutePath, {failOn: 'error'}).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height || width < 1 || height < 1) {
      diagnostics.push(diagnostic('IMAGE_DIMENSIONS_INVALID', 'error', '图片没有有效尺寸。', {
        path: image.jsonPath ?? null,
        assetPath: image.assetPath,
      }));
      return diagnostics;
    }
    if (width * height > limits.maxImagePixels) {
      diagnostics.push(diagnostic('IMAGE_TOO_LARGE', 'error', `图片像素数 ${width * height} 超过安全上限 ${limits.maxImagePixels}。`, {
        path: image.jsonPath ?? null,
        assetPath: image.assetPath,
        suggestion: '请在不改变构图的前提下缩小图片尺寸。',
      }));
    }
    if (
      (image.declaredWidth !== undefined && image.declaredWidth !== width) ||
      (image.declaredHeight !== undefined && image.declaredHeight !== height)
    ) {
      diagnostics.push(diagnostic('IMAGE_DIMENSIONS_MISMATCH', 'error', `声明尺寸与实际图片 ${width}×${height} 不一致。`, {
        path: image.jsonPath ?? null,
        assetPath: image.assetPath,
        suggestion: '更新 JSON 尺寸或重新导出匹配的图片。',
      }));
    }
    if (image.requireAlpha && !metadata.hasAlpha) {
      diagnostics.push(diagnostic('IMAGE_ALPHA_REQUIRED', 'error', '该角色/前景资源必须包含 Alpha 透明通道。', {
        path: image.jsonPath ?? null,
        assetPath: image.assetPath,
        suggestion: '请导出带透明背景的 PNG/WebP，不能用白底图冒充透明图。',
      }));
    }
  } catch {
    diagnostics.push(diagnostic('IMAGE_CORRUPT', 'error', '图片损坏或格式不受支持。', {
      path: image.jsonPath ?? null,
      assetPath: image.assetPath,
      suggestion: '请重新导出图片，并在本机图片查看器中确认可打开。',
    }));
  }
  return diagnostics;
};

export const readUtf8Text = async (absolutePath: string): Promise<string> => {
  const bytes = await readFile(absolutePath);
  return bytes.toString('utf8');
};

export interface AudioProbeResult {
  durationSeconds: number | null;
  diagnostics: AssetPackDiagnostic[];
}

export const probeAudio = async (absolutePath: string, assetPath: string): Promise<AudioProbeResult> => {
  try {
    const metadata = await parseFile(absolutePath, {duration: true});
    const duration = metadata.format.duration;
    if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
      return {
        durationSeconds: null,
        diagnostics: [diagnostic('AUDIO_DURATION_MISSING', 'error', '无法读取旁白音频时长。', {
          assetPath,
          suggestion: '请使用包含完整文件头的 WAV、MP3、M4A 或 AAC 文件。',
        })],
      };
    }
    return {durationSeconds: duration, diagnostics: []};
  } catch {
    return {
      durationSeconds: null,
      diagnostics: [diagnostic('AUDIO_CORRUPT', 'error', '旁白音频损坏或格式不受支持。', {
        assetPath,
        suggestion: '请重新导出旁白音频并确认可以本地播放。',
      })],
    };
  }
};
