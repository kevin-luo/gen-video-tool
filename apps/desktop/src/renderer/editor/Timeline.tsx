import {AudioWaveform, Camera, ChevronsRight, LogIn, Sparkles} from 'lucide-react';
import type {ShotModel} from '../domain/editor';

interface TimelineProps {
  shots: ShotModel[];
  selectedShotId: string;
  duration: number;
  playhead: number;
  onSeek: (time: number) => void;
  onSelectShot: (id: string) => void;
}

const tracks = [
  {id: 'entrance', label: '入场', icon: LogIn},
  {id: 'emphasis', label: '强调', icon: Sparkles},
  {id: 'camera', label: '运镜', icon: Camera},
  {id: 'transition', label: '转场', icon: ChevronsRight},
] as const;

export function Timeline({shots, selectedShotId, duration, playhead, onSeek, onSelectShot}: TimelineProps) {
  const percentage = duration ? (playhead / duration) * 100 : 0;
  const timeMarks = Array.from({length: Math.ceil(duration / 5) + 1}, (_, index) => index * 5);

  return (
    <section className="timeline" aria-label="故事节拍时间线">
      <div className="timeline__summary"><strong>总时长：{duration.toFixed(1)}s</strong><span>30 fps</span></div>
      <div className="timeline__body">
        <div className="timeline__labels">
          <div className="timeline-label timeline-label--story">故事板</div>
          {tracks.map(({id, label, icon: Icon}) => <div className="timeline-label" key={id}><Icon size={13} />{label}</div>)}
          <div className="timeline-label"><AudioWaveform size={13} />旁白</div>
        </div>
        <div
          className="timeline__tracks"
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
          }}
        >
          <div className="time-ruler">{timeMarks.map((mark) => <span key={mark} style={{left: `${(mark / duration) * 100}%`}}>{String(mark).padStart(2, '0')}:00</span>)}</div>
          <div className="timeline-row timeline-row--story">
            {shots.map((shot) => (
              <button
                key={shot.id}
                type="button"
                className={`story-clip ${shot.id === selectedShotId ? 'is-selected' : ''}`}
                style={{width: `${(shot.duration / duration) * 100}%`}}
                onClick={(event) => { event.stopPropagation(); onSelectShot(shot.id); }}
              >
                <span>{String(shot.index).padStart(2, '0')}</span><strong>{shot.title}</strong>
              </button>
            ))}
          </div>
          <div className="timeline-row">{shots.map((shot) => <span key={shot.id} className="event-clip event-clip--entrance" style={{width: `${(shot.duration / duration) * 100}%`}}>{shot.index % 2 ? '淡入' : '推入'}</span>)}</div>
          <div className="timeline-row">{shots.map((shot) => <span key={shot.id} className="event-clip event-clip--emphasis" style={{width: `${(shot.duration / duration) * 100}%`}}>{shot.energy === 'punchy' ? '关键帧强调' : '叙事停留'}</span>)}</div>
          <div className="timeline-row">{shots.map((shot) => <span key={shot.id} className="event-clip event-clip--camera" style={{width: `${(shot.duration / duration) * 100}%`}}>{shot.camera === 'push-in' ? '缓慢推进' : shot.camera === 'follow' ? '跟随' : '静止'}</span>)}</div>
          <div className="timeline-row">{shots.map((shot) => <span key={shot.id} className="transition-marker" style={{width: `${(shot.duration / duration) * 100}%`}}><i>{shot.transition === 'torn-paper' ? '撕纸' : shot.transition === 'flash-frame' ? '闪白' : '滑入'}</i></span>)}</div>
          <div className="timeline-row timeline-row--audio"><span className="waveform">{Array.from({length: 88}, (_, index) => <i key={index} style={{height: `${18 + ((index * 17) % 54)}%`}} />)}</span></div>
          <div className="playhead" style={{left: `${percentage}%`}} aria-hidden="true"><i /></div>
        </div>
      </div>
    </section>
  );
}
