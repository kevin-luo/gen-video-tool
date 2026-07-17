import {AudioWaveform, Camera, Clapperboard, Route} from 'lucide-react';
import type {ProjectModel, ShotModel} from '../domain/editor';

interface TimelineProps {
  project: ProjectModel;
  shots: ShotModel[];
  selectedShotId: string;
  duration: number;
  playhead: number;
  onSeek: (time: number) => void;
  onSelectShot: (id: string) => void;
}

const cameraLabel = (shot: ShotModel): string => shot.camera.operation === 'locked'
  ? '锁定'
  : `${shot.camera.operation} ${Math.round(shot.camera.strength * 100)}%`;

const productionLabel = (shot: ShotModel): string => {
  if (shot.kind === 'layered-collage') return 'Remotion 分层';
  if (shot.state.status === 'selected' || shot.state.status === 'complete') return 'WanGP 已选片';
  if (shot.state.status === 'awaiting-review') return 'WanGP 待审片';
  if (shot.state.status === 'generating') return 'WanGP 生成中';
  return 'WanGP 待生成';
};

const logicLabel = (shot: ShotModel): string => shot.plan.kind === 'generated-performance'
  ? `${shot.plan.hybridMotion.world.milestones.length} 个里程碑`
  : `${shot.plan.layers.length} 个图层`;

export function Timeline({project, shots, selectedShotId, duration, playhead, onSeek, onSelectShot}: TimelineProps) {
  const percentage = duration ? (playhead / duration) * 100 : 0;
  const marks = Array.from({length: Math.ceil(duration) + 1}, (_, index) => index);
  const narrationReady = project.state.narration.status === 'complete';

  return (
    <section className="timeline" aria-label="v3 交付时间线">
      <div className="timeline__summary"><strong>总时长：{duration.toFixed(2)} 秒</strong><span>{project.plan.delivery.timeline.fps} fps · {project.plan.delivery.timeline.durationFrames} 帧</span></div>
      <div className="timeline__body">
        <div className="timeline__labels">
          <div className="timeline-label timeline-label--story">镜头</div>
          <div className="timeline-label"><Clapperboard size={13} />画面来源</div>
          <div className="timeline-label"><Camera size={13} />后期运镜</div>
          <div className="timeline-label"><Route size={13} />世界逻辑</div>
          <div className="timeline-label"><AudioWaveform size={13} />本地旁白</div>
        </div>
        <div
          className="timeline__tracks"
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
          }}
        >
          <div className="time-ruler">{marks.map((mark) => <span key={mark} style={{left: `${duration ? (mark / duration) * 100 : 0}%`}}>{mark}s</span>)}</div>
          <div className="timeline-row timeline-row--story">
            {shots.map((shot) => (
              <button
                key={shot.id}
                type="button"
                className={`story-clip ${shot.id === selectedShotId ? 'is-selected' : ''}`}
                style={{width: `${(shot.durationSeconds / duration) * 100}%`}}
                onClick={(event) => { event.stopPropagation(); onSelectShot(shot.id); }}
              >
                <span>{String(shot.index).padStart(2, '0')}</span><strong>{shot.id}</strong>
              </button>
            ))}
          </div>
          <div className="timeline-row">{shots.map((shot) => <span key={shot.id} className="event-clip event-clip--entrance" style={{width: `${(shot.durationSeconds / duration) * 100}%`}}>{productionLabel(shot)}</span>)}</div>
          <div className="timeline-row">{shots.map((shot) => <span key={shot.id} className="event-clip event-clip--camera" style={{width: `${(shot.durationSeconds / duration) * 100}%`}}>{cameraLabel(shot)}</span>)}</div>
          <div className="timeline-row">{shots.map((shot) => <span key={shot.id} className="event-clip event-clip--emphasis" style={{width: `${(shot.durationSeconds / duration) * 100}%`}}>{logicLabel(shot)}</span>)}</div>
          <div className="timeline-row timeline-row--audio"><span className={`narration-track ${narrationReady ? 'is-ready' : ''}`}>{narrationReady ? 'F5-TTS WAV 已就绪 · 字幕仅导出 SRT' : '等待镜头选片后合成本地旁白'}</span></div>
          <div className="playhead" style={{left: `${percentage}%`}} aria-hidden="true"><i /></div>
        </div>
      </div>
    </section>
  );
}
