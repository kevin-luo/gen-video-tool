import {Maximize2, Pause, Play, SkipBack, SkipForward, Volume2} from 'lucide-react';
import {useEffect, useRef} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import type {ProjectDocument} from '@gen-video-tool/schema';
import {ProjectVideo} from '@gen-video-tool/remotion-engine';
import type {ShotModel} from '../domain/editor';
import {IconButton} from '../components/IconButton';

interface PreviewStageProps {
  shot: ShotModel;
  project: ProjectDocument;
  assetBase: string;
  playhead: number;
  duration: number;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}

const formatTime = (seconds: number) => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const frames = Math.floor((safe % 1) * 30);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
};

export function PreviewStage({shot, project, assetBase, playhead, duration, playing, onTogglePlay, onSeek}: PreviewStageProps) {
  const player = useRef<PlayerRef>(null);
  const fps = project.manifest.fps;
  const durationInFrames = project.shots.reduce((sum, item) => sum + item.durationFrames, 0);

  useEffect(() => {
    if (playing) player.current?.play();
    else player.current?.pause();
  }, [playing]);

  useEffect(() => {
    if (!playing) player.current?.seekTo(Math.min(durationInFrames - 1, Math.max(0, Math.round(playhead * fps))));
  }, [durationInFrames, fps, playhead, playing]);

  const seek = (seconds: number) => {
    const next = Math.min(duration, Math.max(0, seconds));
    player.current?.seekTo(Math.min(durationInFrames - 1, Math.round(next * fps)));
    onSeek(next);
  };

  return (
    <section className="preview-pane" aria-label="视频预览">
      <div className="preview-toolbar">
        <select aria-label="画布缩放" defaultValue="78%"><option>78%</option><option>50%</option><option>100%</option></select>
        <select aria-label="画布适配方式" defaultValue="fit"><option value="fit">适合</option><option value="fill">填满</option></select>
        <span className="preview-toolbar__hint">共享 Remotion 运动求值器 · {shot.title}</span>
      </div>
      <div className="stage-well">
        <div className="video-canvas video-canvas--live" style={{aspectRatio: `${project.manifest.canvas.width} / ${project.manifest.canvas.height}`}} aria-label={`当前画面：${shot.title}`}>
          <Player
            ref={player}
            component={ProjectVideo}
            inputProps={{project, assetBase}}
            durationInFrames={durationInFrames}
            compositionWidth={project.manifest.canvas.width}
            compositionHeight={project.manifest.canvas.height}
            fps={fps}
            controls={false}
            loop={false}
            style={{width: '100%', height: '100%'}}
          />
          <div className="video-canvas__safe" />
        </div>
      </div>
      <footer className="transport-bar">
        <div className="timecode"><strong>{formatTime(playhead)}</strong><span>/ {formatTime(duration)}</span></div>
        <div className="transport-controls">
          <IconButton label="回到开头" onClick={() => seek(0)}><SkipBack size={17} /></IconButton>
          <IconButton label={playing ? '暂停' : '播放'} className="transport-play" onClick={onTogglePlay}>{playing ? <Pause size={19} /> : <Play size={19} fill="currentColor" />}</IconButton>
          <IconButton label="前进一秒" onClick={() => seek(playhead + 1)}><SkipForward size={17} /></IconButton>
        </div>
        <div className="transport-extras"><Volume2 size={16} /><input aria-label="预览音量" type="range" min="0" max="100" defaultValue="78" /><IconButton label="全屏预览"><Maximize2 size={16} /></IconButton></div>
      </footer>
    </section>
  );
}
