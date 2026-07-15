import React from 'react';
import type {ShotDocument} from '@gen-video-tool/schema';

const fitTitleSize = (text: string, width: number, maxLines: number) => {
  const charactersPerLine = Math.max(6, Math.floor((width * 0.82) / 72));
  const estimatedLines = Math.ceil(text.length / charactersPerLine);
  return Math.max(44, Math.min(98, 92 * Math.min(1, maxLines / Math.max(1, estimatedLines))));
};

export const TitleLayer: React.FC<{shot: ShotDocument; width: number; height: number}> = ({shot, width, height}) => {
  if (!shot.title) return null;
  const {title} = shot;
  const safe = title.safeArea;
  const size = fitTitleSize(title.text, width, title.maxLines);
  return (
    <div
      data-editorial-title
      style={{
        position: 'absolute',
        left: width * safe,
        right: width * safe,
        top: height * Math.max(safe, 0.055),
        zIndex: 140,
        display: 'flex',
        justifyContent: 'flex-start',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          maxWidth: '86%',
          padding: title.paperBackground ? '18px 28px 16px' : 0,
          color: '#19140e',
          background: title.paperBackground ? '#eadcba' : 'transparent',
          fontFamily: '"Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif',
          fontSize: size,
          fontWeight: 900,
          lineHeight: 1.04,
          letterSpacing: '-0.04em',
          textWrap: 'balance',
          transform: `rotate(${title.rotation}deg)`,
          border: title.paperBackground ? '2px solid rgba(45,33,20,.18)' : undefined,
          boxShadow: title.paperBackground ? '7px 10px 0 rgba(45,29,16,.22)' : undefined,
          WebkitTextStroke: title.paperBackground ? undefined : '2px #f4e8c9',
          paintOrder: 'stroke fill',
        }}
      >
        {title.text}
      </div>
    </div>
  );
};
