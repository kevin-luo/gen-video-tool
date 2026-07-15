import React from 'react';
import {Img} from 'remotion';
import type {Layer, Transform} from '@gen-video-tool/schema';
import type {CompiledMotionPlan, LayerParallaxSample} from '@gen-video-tool/motion-core';
import {eventsForRole} from '@gen-video-tool/motion-core';
import {combineMotionStyles, motionStyleToCss, sampleEvent} from './animation';
import {resolveAssetSource} from './asset-source';

const defaultTransform: Transform = {
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, anchorX: 0.5, anchorY: 0.5,
};

const paperShadow = 'drop-shadow(5px 8px 0 rgba(20,16,12,.20)) drop-shadow(0 15px 10px rgba(20,16,12,.18))';

export const PaperLayer: React.FC<{
  layer: Layer;
  layerIndex: number;
  frame: number;
  plan: CompiledMotionPlan;
  parallax: LayerParallaxSample;
  assetBase: string;
}> = ({layer, layerIndex, frame, plan, parallax, assetBase}) => {
  if (!layer.visible) return null;
  const base = {...defaultTransform, ...layer.transform};
  const recipeEvents = eventsForRole(plan, layer.role);
  const styles = recipeEvents.map((event) => sampleEvent(event, frame, layerIndex));
  const motion = motionStyleToCss(combineMotionStyles(styles));
  const transform = [
    layer.role === 'background' ? '' : 'translate(-50%, -50%)',
    `translate3d(${base.x + parallax.x * 1080}px, ${base.y + parallax.y * 1920}px, 0)`,
    `rotate(${base.rotation}deg)`,
    `scale(${base.scaleX * parallax.scale}, ${base.scaleY * parallax.scale})`,
    motion.motionTransform,
  ].filter(Boolean).join(' ');
  const common: React.CSSProperties = {
    position: 'absolute',
    inset: layer.role === 'background' ? -42 : undefined,
    left: layer.role === 'background' ? undefined : '50%',
    top: layer.role === 'background' ? undefined : '50%',
    width: layer.role === 'background' ? 'calc(100% + 84px)' : 'auto',
    height: layer.role === 'background' ? 'calc(100% + 84px)' : 'auto',
    maxWidth: layer.role === 'background' ? undefined : '96%',
    opacity: base.opacity * motion.opacity,
    transform,
    transformOrigin: `${base.anchorX * 100}% ${base.anchorY * 100}%`,
    clipPath: motion.clipPath,
    filter: motion.filter ?? (layer.role === 'background' ? undefined : paperShadow),
    zIndex: Math.round(layer.depth * 100),
    willChange: 'transform, opacity, clip-path',
  };

  if (layer.assetPath) {
    return (
      <Img
        data-layer-id={layer.id}
        src={resolveAssetSource(assetBase, layer.assetPath)}
        style={{...common, objectFit: layer.role === 'background' ? 'cover' : 'contain'}}
      />
    );
  }

  if (layer.role === 'foreground') {
    return (
      <div
        data-layer-id={layer.id}
        style={{
          ...common,
          inset: 0,
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          background: '#dfd1b3',
          clipPath: motion.clipPath ?? 'polygon(0 0, 56% 0, 49% 18%, 58% 38%, 47% 61%, 55% 81%, 49% 100%, 0 100%)',
          opacity: recipeEvents.some((event) => event.animation === 'foregroundWipe') ? motion.opacity : 0,
          boxShadow: 'inset -18px 0 0 rgba(87,55,36,.12)',
        }}
      />
    );
  }

  return (
    <div data-layer-id={layer.id} style={{...common, color: '#191510', fontSize: 64, fontWeight: 800}}>
      {layer.text}
    </div>
  );
};
