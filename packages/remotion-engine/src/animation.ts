import type {CSSProperties} from 'react';
import type {CompiledMotionEvent} from '@gen-video-tool/motion-core';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (value: number) => 1 - Math.pow(1 - clamp01(value), 3);
const easeInOut = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export type MotionStyle = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  clipPath?: string;
  filter?: string;
};

const neutral = (): MotionStyle => ({x: 0, y: 0, scale: 1, rotation: 0, opacity: 1});

export const sampleEvent = (event: CompiledMotionEvent, frame: number, ordinal = 0): MotionStyle => {
  const staggeredStart = event.kind === 'entrance' ? event.startFrame + ordinal * 2 : event.startFrame;
  const raw = (frame - staggeredStart) / Math.max(1, event.durationFrames);
  const progress = clamp01(raw);
  const active = frame >= staggeredStart && frame <= staggeredStart + event.durationFrames;
  const before = frame < staggeredStart;
  const style = neutral();

  if (event.kind === 'entrance' && before) style.opacity = 0;
  if (event.kind === 'entrance' && !active && !before) return style;

  switch (event.animation) {
    case 'paperSlap': {
      const t = easeOut(progress);
      style.scale = 0.72 + t * 0.28;
      style.rotation = (ordinal % 2 === 0 ? -1 : 1) * (6 * (1 - t));
      style.opacity = t;
      style.y = 46 * (1 - t);
      return style;
    }
    case 'paperUnfold': {
      const t = easeInOut(progress);
      style.opacity = t;
      style.clipPath = `inset(${(1 - t) * 50}% 0 ${(1 - t) * 50}% 0)`;
      style.scale = 0.98 + t * 0.02;
      return style;
    }
    case 'paperTearReveal': {
      const t = easeOut(progress);
      style.opacity = t;
      style.clipPath = `polygon(0 0, ${Math.min(100, t * 118)}% 0, ${Math.min(100, t * 108)}% 31%, ${Math.min(100, t * 116)}% 64%, ${Math.min(100, t * 110)}% 100%, 0 100%)`;
      return style;
    }
    case 'newspaperSlide': {
      const t = easeOut(progress);
      style.x = (ordinal % 2 === 0 ? -1 : 1) * 120 * (1 - t);
      style.rotation = (ordinal % 2 === 0 ? -1 : 1) * 2.4 * (1 - t);
      style.opacity = t;
      return style;
    }
    case 'photoStack': {
      const t = easeOut(progress);
      style.x = (ordinal % 2 === 0 ? -42 : 42) * (1 - t);
      style.y = -56 * (1 - t);
      style.scale = 0.86 + t * 0.14;
      style.rotation = (ordinal % 2 === 0 ? -5 : 5) * (1 - t);
      style.opacity = t;
      return style;
    }
    case 'tapeAttach': {
      const t = easeOut(progress);
      style.y = -22 * (1 - t);
      style.rotation = -3 * (1 - t);
      style.opacity = t;
      return style;
    }
    case 'propRoll': {
      const t = easeOut(progress);
      style.x = -90 * (1 - t);
      style.rotation = -180 * (1 - t);
      style.opacity = t;
      return style;
    }
    case 'propPop': {
      const t = easeOut(progress);
      style.scale = 0.25 + t * 0.75;
      style.opacity = t;
      return style;
    }
    case 'foregroundWipe': {
      if (event.kind === 'emphasis') {
        if (!active) return {...style, opacity: 0};
        const cover = progress <= 0.5 ? easeInOut(progress * 2) : easeInOut((1 - progress) * 2);
        style.clipPath = `inset(0 ${(1 - cover) * 100}% 0 0)`;
        style.opacity = 1;
        return style;
      }
      const t = easeInOut(progress);
      style.clipPath = `inset(0 ${(1 - t) * 100}% 0 0)`;
      style.opacity = before ? 0 : 1;
      return style;
    }
    case 'impactShake': {
      if (!active) return style;
      const falloff = 1 - progress;
      style.x = Math.sin((frame - event.startFrame) * Math.PI * 1.7) * 15 * falloff;
      style.y = Math.cos((frame - event.startFrame) * Math.PI * 1.3) * 8 * falloff;
      style.rotation = Math.sin((frame - event.startFrame) * Math.PI) * 1.2 * falloff;
      return style;
    }
    case 'halftonePulse': {
      if (!active) return style;
      const pulse = Math.sin(progress * Math.PI);
      style.scale = 1 + pulse * 0.035;
      style.filter = `contrast(${1 + pulse * 0.22}) saturate(${1 - pulse * 0.12})`;
      return style;
    }
    case 'shadowSettle': {
      if (!active) return style;
      const t = easeOut(progress);
      style.y = -7 * (1 - t);
      style.filter = `drop-shadow(${Math.round(3 + t * 5)}px ${Math.round(6 + t * 7)}px ${Math.round(1 + t * 5)}px rgba(20,16,12,.26))`;
      return style;
    }
    case 'misregistrationFlash': {
      if (!active) return style;
      const pulse = Math.sin(progress * Math.PI);
      style.filter = `drop-shadow(${pulse * 7}px 0 #c62f28) drop-shadow(${-pulse * 7}px 0 #1b5f8b)`;
      return style;
    }
    case 'microDrift': {
      if (!active) return style;
      style.x = Math.sin(progress * Math.PI * 2) * 2;
      style.y = Math.cos(progress * Math.PI * 2) * 1.5;
      style.rotation = Math.sin(progress * Math.PI * 2) * 0.15;
      return style;
    }
    default:
      return style;
  }
};

export const combineMotionStyles = (styles: readonly MotionStyle[]): MotionStyle =>
  styles.reduce<MotionStyle>((result, style) => ({
    x: result.x + style.x,
    y: result.y + style.y,
    scale: result.scale * style.scale,
    rotation: result.rotation + style.rotation,
    opacity: result.opacity * style.opacity,
    ...(style.clipPath ? {clipPath: style.clipPath} : result.clipPath ? {clipPath: result.clipPath} : {}),
    ...(style.filter ? {filter: style.filter} : result.filter ? {filter: result.filter} : {}),
  }), neutral());

export const motionStyleToCss = (style: MotionStyle): {
  opacity: number;
  clipPath?: CSSProperties['clipPath'];
  filter?: CSSProperties['filter'];
  motionTransform: string;
} => ({
  opacity: style.opacity,
  ...(style.clipPath ? {clipPath: style.clipPath} : {}),
  ...(style.filter ? {filter: style.filter} : {}),
  motionTransform: `translate3d(${style.x}px, ${style.y}px, 0) rotate(${style.rotation}deg) scale(${style.scale})`,
});
