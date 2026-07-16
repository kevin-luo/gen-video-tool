import {Bone, Camera, Eye, EyeOff, Layers3, PersonStanding, RotateCcw, Type} from 'lucide-react';
import {useState} from 'react';
import {motionRecipeLabels} from '../data/demo';
import type {ActorMode, LayerModel, ShotModel} from '../domain/editor';

interface InspectorProps {
  shot: ShotModel;
  onUpdate: (update: (shot: ShotModel) => ShotModel) => void;
  onEditRig?: () => void;
}

type InspectorTab = 'shot' | 'layers' | 'text' | 'actor';

const actorModeLabels: Record<ActorMode, string> = {
  rigid: 'Rigid Actor',
  mesh: 'Mesh Puppet',
  'pose-cut': 'Pose Cut',
};

export function Inspector({shot, onUpdate, onEditRig}: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('actor');
  const selectedLayer = shot.layers.find((layer) => layer.id === shot.selectedLayerId) ?? shot.layers[0];

  const updateLayer = (changes: Partial<LayerModel>) => {
    if (!selectedLayer) return;
    onUpdate((current) => ({
      ...current,
      layers: current.layers.map((layer) => layer.id === selectedLayer.id ? {...layer, ...changes} : layer),
    }));
  };

  return (
    <aside className="inspector" aria-label="属性面板" data-actor-id={shot.actor.id} data-actor-mode={shot.actor.mode}>
      <div className="inspector-tabs" role="tablist" aria-label="属性类别">
        {([
          ['shot', '镜头', Camera],
          ['layers', '图层', Layers3],
          ['text', '文字', Type],
          ['actor', '人物', PersonStanding],
        ] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}><Icon size={14} />{label}</button>
        ))}
      </div>

      <div className="inspector-scroll">
        {tab === 'shot' ? (
          <>
            <InspectorSection title="镜头设置">
              <label className="field-stack"><span>镜头名称</span><input value={shot.title} onChange={(event) => onUpdate((current) => ({...current, title: event.target.value}))} /></label>
              <div className="field-row">
                <label className="field-stack"><span>时长（秒）</span><input type="number" min="0.5" max="30" step="0.1" value={shot.duration} onChange={(event) => onUpdate((current) => ({...current, duration: Number(event.target.value)}))} /></label>
                <label className="field-stack"><span>能量</span><select value={shot.energy} onChange={(event) => onUpdate((current) => ({...current, energy: event.target.value as ShotModel['energy']}))}><option value="quiet">安静</option><option value="balanced">平衡</option><option value="punchy">强烈</option></select></label>
              </div>
              <label className="field-stack"><span>运动配方</span><select value={shot.recipe} onChange={(event) => onUpdate((current) => ({...current, recipe: event.target.value as ShotModel['recipe']}))}>{Object.entries(motionRecipeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field-stack"><span>运镜</span><select value={shot.camera} onChange={(event) => onUpdate((current) => ({...current, camera: event.target.value as ShotModel['camera']}))}><option value="static">静止</option><option value="push-in">缓慢推进</option><option value="follow">跟随</option><option value="handheld">轻微手持</option><option value="orbit">环绕</option></select></label>
              <label className="field-stack"><span>转场</span><select value={shot.transition} onChange={(event) => onUpdate((current) => ({...current, transition: event.target.value as ShotModel['transition']}))}><option value="torn-paper">撕纸</option><option value="newspaper-slide">剪报滑入</option><option value="flash-frame">闪白</option><option value="foreground-wipe">前景遮挡</option><option value="hard-cut">硬切</option></select></label>
            </InspectorSection>
          </>
        ) : null}

        {tab === 'layers' ? (
          <>
            <InspectorSection title="图层顺序">
              <div className="layer-list">
                {[...shot.layers].reverse().map((layer) => (
                  <button key={layer.id} type="button" className={layer.id === selectedLayer?.id ? 'is-active' : ''} onClick={() => onUpdate((current) => ({...current, selectedLayerId: layer.id}))}>
                    <span>{layer.name}</span><small>深度 {layer.depth}</small>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                ))}
              </div>
            </InspectorSection>
            {selectedLayer ? (
              <InspectorSection title="变换与视差" action={<button className="text-button" type="button" onClick={() => updateLayer({x: 0, y: 0, scale: 100, rotation: 0})}><RotateCcw size={13} />重置</button>}>
                <div className="field-grid">
                  <NumberField label="X" value={selectedLayer.x} onChange={(x) => updateLayer({x})} />
                  <NumberField label="Y" value={selectedLayer.y} onChange={(y) => updateLayer({y})} />
                  <NumberField label="缩放 %" value={selectedLayer.scale} onChange={(scale) => updateLayer({scale})} />
                  <NumberField label="旋转 °" value={selectedLayer.rotation} onChange={(rotation) => updateLayer({rotation})} />
                </div>
                <label className="range-field"><span><b>视差深度</b><output>{selectedLayer.depth}</output></span><input type="range" min="0" max="100" value={selectedLayer.depth} onChange={(event) => updateLayer({depth: Number(event.target.value)})} /></label>
                <label className="switch-row"><span><b>显示图层</b><small>隐藏后不会参与导出</small></span><input type="checkbox" checked={selectedLayer.visible} onChange={(event) => updateLayer({visible: event.target.checked})} /></label>
              </InspectorSection>
            ) : null}
          </>
        ) : null}

        {tab === 'text' ? (
          <InspectorSection title="画面标题">
            <label className="field-stack"><span>标题文字</span><textarea rows={3} value={shot.title} onChange={(event) => onUpdate((current) => ({...current, title: event.target.value}))} /></label>
            <label className="field-stack"><span>年份标记</span><input value={shot.year} onChange={(event) => onUpdate((current) => ({...current, year: event.target.value}))} /></label>
            <div className="inline-note"><Type size={15} /><span>标题会合成进画面；旁白字幕仅导出为外置 SRT。</span></div>
          </InspectorSection>
        ) : null}

        {tab === 'actor' ? (
          <>
            <InspectorSection title="人物控制">
              <div className="actor-modes">
                {(Object.keys(actorModeLabels) as ActorMode[]).map((mode) => (
                  <button key={mode} type="button" disabled={!shot.actor.availableModes.includes(mode)} title={shot.actor.availableModes.includes(mode) ? undefined : '当前素材包没有此模式所需资产'} className={shot.actor.mode === mode ? 'is-active' : ''} onClick={() => onUpdate((current) => ({...current, actor: {...current.actor, mode}}))}>
                    <PersonStanding size={17} /><span>{actorModeLabels[mode]}</span>
                  </button>
                ))}
              </div>
              <p className="control-help">{shot.actor.mode === 'pose-cut' ? '用前景完整遮住切换点，只显示一张完整人物。' : shot.actor.mode === 'mesh' ? '完整纹理由隐藏骨骼驱动，适合小幅动作。' : '完整人物作为一个整体，适合位移、缩放与轻微旋转。'}</p>
            </InspectorSection>

            {shot.actor.mode === 'pose-cut' ? (
              <InspectorSection title="姿态设置">
                <div className="pose-pair">
                  <div className="pose-card"><div className="pose-card__figure">9</div><span>姿态 A（可见）</span><small>{shot.actor.poseA}</small></div>
                  <span className="pose-pair__swap">⇄</span>
                  <div className="pose-card"><div className="pose-card__figure pose-card__figure--after">9</div><span>姿态 B（遮挡时）</span><small>{shot.actor.poseB}</small></div>
                </div>
                <label className="field-stack"><span>切换遮挡</span><select value={shot.actor.switchCover} onChange={(event) => onUpdate((current) => ({...current, actor: {...current.actor, switchCover: event.target.value as ShotModel['actor']['switchCover']}}))}><option value="foreground">前景遮挡</option><option value="paper-tear">撕纸覆盖</option><option value="flash-frame">闪白帧</option><option value="hard-cut">硬切</option></select></label>
                <div className="inline-note inline-note--success"><span className="status-dot status-dot--ready" /><span>切换规则有效：不会交叉淡化两张人物。</span></div>
              </InspectorSection>
            ) : (
              <InspectorSection title="动作模板">
                <label className="field-stack"><span>动作</span><select value={shot.actor.action} onChange={(event) => onUpdate((current) => ({...current, actor: {...current.actor, action: event.target.value}}))}><option value="idle-breathe">轻微呼吸</option><option value="look-down">低头</option><option value="look-left">向左看</option><option value="look-right">向右看</option><option value="reach">伸手</option><option value="point">指向</option><option value="small-step">小步移动</option><option value="celebrate">庆祝</option><option value="nod">点头</option><option value="shoulder-relax">肩部放松</option></select></label>
                {shot.actor.mode === 'mesh' ? <label className="range-field"><span><b>动作幅度</b><output>{Math.round(shot.actor.actionStrength * 100)}%</output></span><input aria-label="Mesh Puppet 动作幅度" type="range" min="0" max="1" step="0.01" value={shot.actor.actionStrength} onChange={(event) => onUpdate((current) => ({...current, actor: {...current.actor, actionStrength: Number(event.target.value)}}))} /></label> : null}
                <button type="button" className="button button--quiet button--full" disabled={shot.actor.mode !== 'mesh' || !shot.actor.rigPath} title={shot.actor.mode === 'mesh' ? undefined : '只有 Mesh Puppet 使用本地骨骼绑定'} onClick={onEditRig}><Bone size={16} /> 打开绑定与透明预览</button>
              </InspectorSection>
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function InspectorSection({title, action, children}: {title: string; action?: React.ReactNode; children: React.ReactNode}) {
  return <section className="inspector-section"><header><h3>{title}</h3>{action}</header><div className="inspector-section__body">{children}</div></section>;
}

function NumberField({label, value, onChange}: {label: string; value: number; onChange: (value: number) => void}) {
  return <label className="field-stack"><span>{label}</span><input type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
