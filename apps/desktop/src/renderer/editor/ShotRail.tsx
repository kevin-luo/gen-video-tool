import {ChevronDown, ChevronUp, Grid2X2, GripVertical, List, Search} from 'lucide-react';
import type {ShotModel} from '../domain/editor';
import {IconButton} from '../components/IconButton';
import {ProjectCover} from '../components/ProjectCover';

interface ShotRailProps {
  shots: ShotModel[];
  selectedShotId: string;
  onSelect: (shotId: string) => void;
  onReorder: (shotId: string, delta: -1 | 1) => void;
}

export function ShotRail({shots, selectedShotId, onSelect, onReorder}: ShotRailProps) {
  return (
    <aside className="shot-rail" aria-label="镜头列表">
      <header className="pane-header">
        <div><strong>镜头列表</strong><span>({shots.length})</span></div>
        <div className="pane-header__tools">
          <IconButton compact label="网格视图"><Grid2X2 size={15} /></IconButton>
          <IconButton compact label="列表视图" className="is-active"><List size={15} /></IconButton>
          <IconButton compact label="搜索镜头"><Search size={15} /></IconButton>
        </div>
      </header>
      <ol className="shot-list">
        {shots.map((shot, arrayIndex) => {
          const selected = shot.id === selectedShotId;
          return (
            <li key={shot.id} className={`shot-item ${selected ? 'is-selected' : ''}`}>
              {selected ? <span className="torn-registration" aria-hidden="true" /> : null}
              <button
                type="button"
                className="shot-item__main"
                onClick={() => onSelect(shot.id)}
                onKeyDown={(event) => {
                  if (event.altKey && event.key === 'ArrowUp') onReorder(shot.id, -1);
                  if (event.altKey && event.key === 'ArrowDown') onReorder(shot.id, 1);
                }}
                aria-pressed={selected}
              >
                <span className="shot-item__index">{String(shot.index).padStart(2, '0')}</span>
                <ProjectCover variant="football" compact label={shot.year} />
                <span className="shot-item__copy">
                  <strong><span className="shot-item__year">{shot.year}</span>{shot.title}</strong>
                  <small>{shot.duration.toFixed(1)}s</small>
                  <small>{shot.note}</small>
                </span>
              </button>
              <div className="shot-item__reorder">
                <GripVertical size={14} aria-hidden="true" />
                <IconButton compact label={`上移镜头 ${shot.index}`} disabled={arrayIndex === 0} onClick={() => onReorder(shot.id, -1)}><ChevronUp size={13} /></IconButton>
                <IconButton compact label={`下移镜头 ${shot.index}`} disabled={arrayIndex === shots.length - 1} onClick={() => onReorder(shot.id, 1)}><ChevronDown size={13} /></IconButton>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
