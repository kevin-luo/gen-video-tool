import {Camera, CheckCircle2, Film, Footprints, Image, Layers3, Route, ShieldCheck} from 'lucide-react';
import type {ShotModel} from '../domain/editor';

interface InspectorProps {
  shot: ShotModel;
  fps: number;
}

const cameraLabels = {
  locked: '锁定机位',
  push: '后期推进',
  pull: '后期拉远',
  'pan-left': '向左摇摄',
  'pan-right': '向右摇摄',
  'pan-up': '向上摇摄',
  'pan-down': '向下摇摄',
} as const;

const statusLabels = {
  queued: '等待处理',
  generating: '正在生成',
  'awaiting-review': '等待审片',
  selected: '已选片',
  complete: '已完成',
  failed: '失败',
  interrupted: '已中断',
} as const;

export function Inspector({shot, fps}: InspectorProps) {
  const generated = shot.plan.kind === 'generated-performance' ? shot.plan : null;
  const collage = shot.plan.kind === 'layered-collage' ? shot.plan : null;
  return (
    <aside className="inspector" aria-label="v3 镜头详情">
      <header className="pane-header">
        <div><strong>生产契约</strong><span>v3</span></div>
        <ShieldCheck size={16} aria-hidden="true" />
      </header>
      <div className="inspector-scroll">
        <section className="control-section">
          <h3><Film size={14} />镜头</h3>
          <dl className="production-facts">
            <div><dt>ID</dt><dd><code>{shot.id}</code></dd></div>
            <div><dt>类型</dt><dd>{generated ? 'WanGP 连续表演' : 'Remotion 分层合成'}</dd></div>
            <div><dt>时间</dt><dd>{shot.durationFrames} 帧 · {fps} fps</dd></div>
            <div><dt>状态</dt><dd>{statusLabels[shot.state.status]}</dd></div>
          </dl>
        </section>

        <section className="control-section">
          <h3><Camera size={14} />镜头语言</h3>
          <dl className="production-facts">
            <div><dt>运镜</dt><dd>{cameraLabels[shot.camera.operation]}</dd></div>
            <div><dt>强度</dt><dd>{Math.round(shot.camera.strength * 100)}%</dd></div>
            {generated ? <div><dt>生成机位</dt><dd>锁定，由 Remotion 后期运镜</dd></div> : null}
          </dl>
        </section>

        {generated ? (
          <>
            <section className="control-section">
              <h3><Image size={14} />本地生成</h3>
              <dl className="production-facts">
                <div><dt>关键帧</dt><dd className="path-text">{generated.generation.conditioning.startKeyframePath}</dd></div>
                <div><dt>原生规格</dt><dd>{generated.generation.raster.width} × {generated.generation.raster.height}</dd></div>
                <div><dt>时间基</dt><dd>{generated.generation.timeline.frameCount} 帧 · {generated.generation.timeline.fps} fps</dd></div>
                <div><dt>候选种子</dt><dd><code>{generated.generation.candidateSeeds.join(' / ')}</code></dd></div>
              </dl>
            </section>
            <section className="control-section">
              <h3><Route size={14} />世界逻辑</h3>
              <p className="control-help">{generated.hybridMotion.actor.action}</p>
              <dl className="production-facts">
                <div><dt>朝向约束</dt><dd>{generated.hybridMotion.world.constraints.facing.length}</dd></div>
                <div><dt>支撑约束</dt><dd>{generated.hybridMotion.world.constraints.support.length}</dd></div>
                <div><dt>接触约束</dt><dd>{generated.hybridMotion.world.constraints.contact.length}</dd></div>
                <div><dt>动作里程碑</dt><dd>{generated.hybridMotion.world.milestones.length}</dd></div>
              </dl>
              <div className="logic-badges">
                <span><Footprints size={13} />支撑与滑移</span>
                <span><CheckCircle2 size={13} />接触与因果</span>
              </div>
            </section>
          </>
        ) : (
          <section className="control-section">
            <h3><Layers3 size={14} />分层合成</h3>
            <dl className="production-facts">
              <div><dt>图层</dt><dd>{collage?.layers.length ?? 0}</dd></div>
              <div><dt>背景预览</dt><dd className="path-text">{shot.previewAssetPath}</dd></div>
            </dl>
          </section>
        )}

        <section className="control-section">
          <h3>旁白</h3>
          <p className="control-help">{shot.narration || '此镜头没有独立旁白段。'}</p>
        </section>
      </div>
    </aside>
  );
}
