import {Bone, Check, LoaderCircle, Play, Save, TriangleAlert, WandSparkles} from 'lucide-react';
import {useEffect, useMemo, useRef, useState} from 'react';
import type {MeshActionTemplate, Rig} from '@gen-video-tool/schema';
import type {MeshPreviewResult, MeshRigPayload} from '../../shared/desktop-api';
import {Modal} from '../components/Modal';
import {desktopService} from '../services/desktop-service';

interface RigCorrectionModalProps {
  projectId: string;
  shotId: string;
  actorId: string;
  initialAction: string;
  initialAmplitude: number;
  onClose: () => void;
}

type BonePoint = 'pivot' | 'tip';
type DragState = {boneId: string; point: BonePoint} | null;
type WorkState = 'loading' | 'idle' | 'auto-rigging' | 'rendering' | 'saving' | 'saved' | 'error';

const actionLabels: Record<MeshActionTemplate, string> = {
  'idle-breathe': '轻微呼吸',
  'look-down': '低头',
  'look-left': '向左看',
  'look-right': '向右看',
  reach: '伸手',
  point: '指向',
  'small-step': '小步移动',
  celebrate: '庆祝',
  nod: '点头',
  'shoulder-relax': '肩部放松',
};

const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, value));

export function RigCorrectionModal({projectId, shotId, actorId, initialAction, initialAmplitude, onClose}: RigCorrectionModalProps) {
  const [payload, setPayload] = useState<MeshRigPayload | null>(null);
  const [rig, setRig] = useState<Rig | null>(null);
  const [action, setAction] = useState<MeshActionTemplate>(initialAction as MeshActionTemplate);
  const [amplitude, setAmplitude] = useState(initialAmplitude);
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [preview, setPreview] = useState<MeshPreviewResult | null>(null);
  const [state, setState] = useState<WorkState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let active = true;
    void desktopService.loadMeshRig(projectId, shotId, actorId).then((loaded) => {
      if (!active) return;
      setPayload(loaded);
      setRig(loaded.rig);
      setSelectedBoneId(loaded.rig.bones[0]?.id ?? null);
      setState('idle');
    }).catch((reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : '读取 rig.json 失败');
      setState('error');
    });
    return () => { active = false; };
  }, [actorId, projectId, shotId]);

  const updateBonePoint = (boneId: string, point: BonePoint, x: number, y: number) => {
    setRig((current) => current ? ({
      ...current,
      bones: current.bones.map((bone) => bone.id === boneId ? {
        ...bone,
        [point]: {x: clamp(x, current.canvas.width), y: clamp(y, current.canvas.height)},
      } : bone),
    }) : current);
    setSelectedBoneId(boneId);
    setDirty(true);
    setPreview(null);
    if (state === 'saved') setState('idle');
  };

  useEffect(() => {
    if (!drag || !rig) return;
    const move = (event: PointerEvent) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      updateBonePoint(
        drag.boneId,
        drag.point,
        ((event.clientX - rect.left) / rect.width) * rig.canvas.width,
        ((event.clientY - rect.top) / rect.height) * rig.canvas.height,
      );
    };
    const stop = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, {once: true});
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
  }, [drag, rig]);

  const selectedBone = useMemo(() => rig?.bones.find((bone) => bone.id === selectedBoneId) ?? null, [rig, selectedBoneId]);

  const nudge = (boneId: string, point: BonePoint, key: string, multiplier: number) => {
    if (!rig) return;
    const bone = rig.bones.find((candidate) => candidate.id === boneId);
    if (!bone) return;
    const delta = key === 'ArrowLeft' || key === 'ArrowUp' ? -multiplier : multiplier;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    updateBonePoint(boneId, point, bone[point].x + (horizontal ? delta : 0), bone[point].y + (horizontal ? 0 : delta));
  };

  const renderPreview = async () => {
    if (!rig) return;
    setError(null);
    setState('rendering');
    try {
      const result = await desktopService.renderMeshPreview({projectId, shotId, actorId, action, amplitude, rig});
      setPreview(result);
      setState('idle');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '透明动作预览失败');
      setState('error');
    }
  };

  const autoRig = async () => {
    setError(null);
    setState('auto-rigging');
    try {
      const generated = await desktopService.autoRigMesh(projectId, shotId, actorId);
      setPayload(generated);
      setRig(generated.rig);
      setSelectedBoneId(generated.rig.bones[0]?.id ?? null);
      setPreview(null);
      setDirty(true);
      setState('idle');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '自动绑定失败');
      setState('error');
    }
  };

  const saveRig = async () => {
    if (!rig || payload?.readOnly) return;
    setError(null);
    setState('saving');
    try {
      const saved = await desktopService.saveMeshRig(projectId, shotId, actorId, rig);
      setPayload(saved);
      setRig(saved.rig);
      setDirty(false);
      setState('saved');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存 rig.json 失败');
      setState('error');
    }
  };

  const requestClose = () => {
    if (dirty && !window.confirm('绑定位置还没有保存，确定关闭吗？')) return;
    onClose();
  };

  const footer = (
    <>
      <span className="rig-footer-status" aria-live="polite">
        {payload?.readOnly ? '示例项目只读：可校正并预览，不能覆盖 rig.json' : dirty ? '绑定有未保存更改' : state === 'saved' ? 'rig.json 已保存' : '绑定已同步'}
      </span>
      <button type="button" className="button button--ghost" onClick={requestClose}>关闭</button>
      <button type="button" className="button button--primary" disabled={!rig || payload?.readOnly || state === 'saving'} title={payload?.readOnly ? '只读示例不能写回；导入为本地项目后即可保存' : undefined} onClick={() => void saveRig()}>
        {state === 'saving' ? <LoaderCircle className="spin" size={16} /> : state === 'saved' ? <Check size={16} /> : <Save size={16} />}
        {state === 'saving' ? '正在保存' : '保存 rig.json'}
      </button>
    </>
  );

  return (
    <Modal title="Mesh Puppet 绑定校正" description="在完整人物纹理上校正骨骼，再由 Godot Skeleton2D + Polygon2D 生成透明动作。" width="workspace" onClose={requestClose} footer={footer}>
      {state === 'loading' ? <div className="rig-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取完整人物与 rig.json…</div> : null}
      {rig && payload ? (
        <div className="rig-workspace">
          <section className="rig-bind-panel" aria-labelledby="rig-bind-title">
            <header className="rig-panel-header"><div><h3 id="rig-bind-title">绑定画布</h3><p>拖动圆点校正骨骼端点；方向键微调，Shift + 方向键移动 5 px。</p></div><div className="rig-panel-actions"><code>{rig.canvas.width} × {rig.canvas.height}</code><button type="button" className="button button--quiet button--compact" disabled={state === 'auto-rigging'} onClick={() => void autoRig()}>{state === 'auto-rigging' ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />}自动绑定</button></div></header>
            <div className="rig-canvas" style={{aspectRatio: `${rig.canvas.width} / ${rig.canvas.height}`}}>
              <img src={payload.textureUrl} alt="当前完整人物纹理" draggable={false} />
              <svg ref={svgRef} viewBox={`0 0 ${rig.canvas.width} ${rig.canvas.height}`} aria-label="人物骨骼绑定图">
                {rig.bones.map((bone) => <line key={`${bone.id}-line`} className={selectedBoneId === bone.id ? 'is-selected' : ''} x1={bone.pivot.x} y1={bone.pivot.y} x2={bone.tip.x} y2={bone.tip.y} />)}
                {rig.bones.flatMap((bone) => (['pivot', 'tip'] as const).map((point) => (
                  <circle
                    key={`${bone.id}-${point}`}
                    className={selectedBoneId === bone.id ? 'is-selected' : ''}
                    cx={bone[point].x}
                    cy={bone[point].y}
                    r={selectedBoneId === bone.id ? 9 : 7}
                    role="button"
                    tabIndex={0}
                    aria-label={`${bone.id} ${point === 'pivot' ? '起点' : '终点'}，x ${Math.round(bone[point].x)}，y ${Math.round(bone[point].y)}；使用方向键微调`}
                    onPointerDown={(event) => { event.preventDefault(); setSelectedBoneId(bone.id); setDrag({boneId: bone.id, point}); }}
                    onKeyDown={(event) => {
                      if (!event.key.startsWith('Arrow')) return;
                      event.preventDefault();
                      nudge(bone.id, point, event.key, event.shiftKey ? 5 : 1);
                    }}
                  />
                )))}
              </svg>
            </div>
            {selectedBone ? <div className="rig-coordinate-strip"><strong>{selectedBone.id}</strong><span>起点 {Math.round(selectedBone.pivot.x)}, {Math.round(selectedBone.pivot.y)}</span><span>终点 {Math.round(selectedBone.tip.x)}, {Math.round(selectedBone.tip.y)}</span><span>旋转 {selectedBone.rotationMin}°—{selectedBone.rotationMax}°</span></div> : null}
          </section>

          <section className="rig-preview-panel" aria-labelledby="rig-preview-title" aria-busy={state === 'rendering'}>
            <header className="rig-panel-header"><div><h3 id="rig-preview-title">透明动作预览</h3><p>预览使用当前未保存绑定，不会降级成静态贴图。</p></div><span className="rig-alpha-label">Alpha</span></header>
            <div className="rig-preview-stage">
              {preview ? <video key={preview.videoUrl} src={preview.videoUrl} autoPlay loop muted playsInline controls aria-label={`${actionLabels[action]}透明动作预览`} /> : (
                <div className="rig-preview-empty"><Bone size={34} /><strong>等待 Godot Worker</strong><span>选择动作后生成 2 秒透明 WebM，检查肢体连贯性与关节幅度。</span></div>
              )}
              {state === 'rendering' ? <div className="rig-rendering"><LoaderCircle className="spin" size={22} /><span>Skeleton2D 正在逐帧渲染…</span></div> : null}
            </div>
            <div className="rig-preview-controls">
              <label className="field-stack"><span>动作模板</span><select value={action} onChange={(event) => { setAction(event.target.value as MeshActionTemplate); setPreview(null); }}>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="range-field"><span><b>动作幅度</b><output>{Math.round(amplitude * 100)}%</output></span><input aria-label="透明预览动作幅度" type="range" min="0" max="1" step="0.01" value={amplitude} onChange={(event) => { setAmplitude(Number(event.target.value)); setPreview(null); }} /></label>
              <button type="button" className="button button--quiet button--full" disabled={state === 'rendering'} onClick={() => void renderPreview()}>{state === 'rendering' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} {state === 'rendering' ? '正在生成透明预览' : '生成透明动作预览'}</button>
              {preview ? <div className="rig-preview-meta" aria-live="polite"><span>{preview.frameCount} 帧</span><span>{preview.fps} fps</span><span>{preview.durationSeconds.toFixed(1)} 秒</span><span>VP9 Alpha</span></div> : null}
              {error ? <div className="inline-note inline-note--error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div> : null}
            </div>
          </section>
        </div>
      ) : state === 'error' ? <div className="inline-note inline-note--error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div> : null}
    </Modal>
  );
}
