import {Maximize2, Pause, Play, SkipBack, SkipForward, Volume2} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {ProjectVideo, resolveAssetSource} from '@gen-video-tool/remotion-engine';
import type {ProjectModel, ShotModel} from '../domain/editor';
import {IconButton} from '../components/IconButton';

interface PreviewStageProps {
  shot: ShotModel;
  project: ProjectModel;
  playhead: number;
  duration: number;
  playing: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}

const formatTime = (seconds: number, fps: number) => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const frames = Math.floor((safe % 1) * fps);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
};

const previewGate = (shot: ShotModel, project: ProjectModel): string => {
  if (shot.kind === 'generated-performance') {
    if (shot.state.status === 'queued') return '尚未生成：当前显示 production.json 声明的起始关键帧。';
    if (shot.state.status === 'generating') return 'WanGP 正在生成两个候选：当前显示起始关键帧。';
    if (shot.state.status === 'awaiting-review') return '候选等待人工审片；选定通过技术检查的版本后才会进入动态预览。';
    if (shot.state.status === 'failed' || shot.state.status === 'interrupted') return '生成未完成；请在“本地制作”中重试。';
  }
  return project.renderGate?.message ?? '完整动态预览尚未就绪：所有生成镜头必须完成并由你明确选片。';
};

export function PreviewStage({shot, project, playhead, duration, playing, onTogglePlay, onSeek}: PreviewStageProps) {
  const player = useRef<PlayerRef>(null);
  const [volume, setVolume] = useState(0.78);
  const {fps, durationFrames} = {
    fps: project.plan.delivery.timeline.fps,
    durationFrames: project.plan.delivery.timeline.durationFrames,
  };
  const ready = project.renderData !== undefined;

  useEffect(() => {
    if (!ready) return;
    if (playing) player.current?.play();
    else player.current?.pause();
  }, [playing, ready]);

  useEffect(() => {
    if (!ready || playing) return;
    player.current?.seekTo(Math.min(durationFrames - 1, Math.max(0, Math.round(playhead * fps))));
  }, [durationFrames, fps, playhead, playing, ready]);

  useEffect(() => {
    if (ready) player.current?.setVolume(volume);
  }, [ready, volume]);

  const seek = (seconds: number) => {
    const next = Math.min(duration, Math.max(0, seconds));
    if (ready) player.current?.seekTo(Math.min(durationFrames - 1, Math.round(next * fps)));
    onSeek(next);
  };

  return (
    <section className="preview-pane" aria-label="视频预览">
      <div className="preview-toolbar">
        <span className={`preview-readiness ${ready ? 'is-ready' : 'is-gated'}`}>{ready ? 'v3 动态预览已就绪' : '关键帧检查模式'}</span>
        <span className="preview-toolbar__hint">{shot.kind === 'generated-performance' ? 'WanGP 连续表演' : 'Remotion 分层合成'} · {shot.id}</span>
      </div>
      <div className="stage-well">
        <div
          className={`video-canvas ${ready ? 'video-canvas--live' : 'video-canvas--keyframe'}`}
          style={{aspectRatio: `${project.plan.delivery.raster.width} / ${project.plan.delivery.raster.height}`}}
          aria-label={`当前画面：${shot.title}`}
        >
          {ready ? (
            <Player
              ref={player}
              component={ProjectVideo}
              inputProps={{productionRenderData: project.renderData!, assetBase: project.assetBase}}
              durationInFrames={durationFrames}
              compositionWidth={project.plan.delivery.raster.width}
              compositionHeight={project.plan.delivery.raster.height}
              fps={fps}
              controls={false}
              loop={false}
              initialVolume={volume}
              acknowledgeRemotionLicense
              style={{width: '100%', height: '100%'}}
            />
          ) : (
            <>
              <img src={resolveAssetSource(project.assetBase, shot.previewAssetPath)} alt={`${shot.title} 起始关键帧`} />
              <div className="preview-gate" role="status">
                <strong>这不是成片动画</strong>
                <span>{previewGate(shot, project)}</span>
              </div>
            </>
          )}
          <div className="video-canvas__safe" />
        </div>
      </div>
      <footer className="transport-bar">
        <div className="timecode"><strong>{formatTime(playhead, fps)}</strong><span>/ {formatTime(duration, fps)}</span></div>
        <div className="transport-controls">
          <IconButton label="回到开头" onClick={() => seek(0)}><SkipBack size={17} /></IconButton>
          <IconButton label={ready ? (playing ? '暂停' : '播放') : '动态预览尚未解锁'} className="transport-play" disabled={!ready} onClick={onTogglePlay}>{playing && ready ? <Pause size={19} /> : <Play size={19} fill="currentColor" />}</IconButton>
          <IconButton label="前进一秒" onClick={() => seek(playhead + 1)}><SkipForward size={17} /></IconButton>
        </div>
        <div className="transport-extras">
          <Volume2 size={16} />
          <input
            aria-label="预览音量"
            type="range"
            min="0"
            max="100"
            value={Math.round(volume * 100)}
            onChange={(event) => {
              const nextVolume = Number(event.currentTarget.value) / 100;
              setVolume(nextVolume);
              player.current?.setVolume(nextVolume);
            }}
            disabled={!ready}
          />
          <IconButton
            label="全屏预览"
            disabled={!ready}
            onClick={() => void player.current?.requestFullscreen()}
          >
            <Maximize2 size={16} />
          </IconButton>
        </div>
      </footer>
    </section>
  );
}
