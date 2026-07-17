import {Film, Image, Sparkles} from 'lucide-react';
import {resolveAssetSource} from '@gen-video-tool/remotion-engine';
import type {ShotModel} from '../domain/editor';

interface ShotRailProps {
  shots: ShotModel[];
  selectedShotId: string;
  assetBase: string;
  onSelect: (shotId: string) => void;
}

const statusLabel = (shot: ShotModel): string => {
  if (shot.kind === 'layered-collage') return '确定性合成';
  if (shot.state.status === 'awaiting-review') return '等待审片';
  if (shot.state.status === 'selected' || shot.state.status === 'complete') return '已选片';
  if (shot.state.status === 'generating') return '生成中';
  if (shot.state.status === 'failed' || shot.state.status === 'interrupted') return '需要处理';
  return '待生成';
};

export function ShotRail({shots, selectedShotId, assetBase, onSelect}: ShotRailProps) {
  return (
    <aside className="shot-rail" aria-label="镜头列表">
      <header className="pane-header">
        <div><strong>镜头列表</strong><span>({shots.length})</span></div>
        <Film size={16} aria-hidden="true" />
      </header>
      <ol className="shot-list">
        {shots.map((shot) => {
          const selected = shot.id === selectedShotId;
          return (
            <li key={shot.id} className={`shot-item ${selected ? 'is-selected' : ''}`}>
              {selected ? <span className="torn-registration" aria-hidden="true" /> : null}
              <button type="button" className="shot-item__main" onClick={() => onSelect(shot.id)} aria-pressed={selected}>
                <span className="shot-item__index">{String(shot.index).padStart(2, '0')}</span>
                <span className="shot-keyframe-thumb">
                  <img src={resolveAssetSource(assetBase, shot.previewAssetPath)} alt="" />
                  {shot.kind === 'generated-performance' ? <Sparkles size={12} /> : <Image size={12} />}
                </span>
                <span className="shot-item__copy">
                  <strong>{shot.id}</strong>
                  <small>{shot.durationSeconds.toFixed(1)} 秒 · {statusLabel(shot)}</small>
                  <small>{shot.title}</small>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
