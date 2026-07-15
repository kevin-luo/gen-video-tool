import {Check, FileVideo2, FolderOpen, LoaderCircle, ShieldCheck, TriangleAlert} from 'lucide-react';
import {useEffect, useState} from 'react';
import {Modal} from '../components/Modal';
import type {ExportProjectResult} from '../../shared/desktop-api';
import type {ExportState, ProjectModel} from '../domain/editor';
import {materializeProjectDocument} from '../domain/project-adapter';
import {desktopService} from '../services/desktop-service';

interface ExportDialogProps { project: ProjectModel; onClose: () => void; }

const stepLabels: Record<Exclude<ExportState, 'idle' | 'done' | 'error'>, string> = {
  preparing: '准备镜头与音频', rendering: 'Remotion 正在渲染画面', checking: 'FFmpeg 抽帧与编码检查',
};

export function ExportDialog({project, onClose}: ExportDialogProps) {
  const [state, setState] = useState<ExportState>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportProjectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => desktopService.onExportProgress((update) => {
    if (update.projectId !== project.id) return;
    setProgress(Math.round(update.progress * 100));
    if (update.phase !== 'done') setState(update.phase);
  }), [project.id]);

  const startExport = async () => {
    setError(null);
    setProgress(4);
    setState('preparing');
    try {
      if (!project.readOnly) await desktopService.saveProject(project.id, materializeProjectDocument(project));
      const exported = await desktopService.exportProject(project.id);
      setResult(exported);
      setProgress(100);
      setState('done');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导出失败');
      setState('error');
    }
  };

  const cancelExport = async () => {
    await desktopService.cancelExport(project.id);
    setError('导出已取消，未完成的临时文件已清理。');
    setState('error');
  };

  const revealOutput = () => void desktopService.revealOutput(project.id);

  return (
    <Modal
      title={state === 'done' ? '视频已导出' : state === 'error' ? '导出未完成' : '导出视频'}
      description={state === 'done' ? 'MP4 与外挂字幕已写入本地输出目录。' : '本地完成确定性渲染、旁白混合与帧检查。'}
      width="wide" onClose={onClose}
      footer={state === 'done' ? (
        <><button type="button" className="button button--ghost" onClick={onClose}>关闭</button><button type="button" className="button button--primary" onClick={revealOutput}><FolderOpen size={16} /> 打开输出目录</button></>
      ) : state === 'idle' || state === 'error' ? (
        <><button type="button" className="button button--ghost" onClick={onClose}>取消</button><button type="button" className="button button--primary" onClick={() => void startExport()}><FileVideo2 size={16} /> {state === 'error' ? '重新导出' : '开始导出'}</button></>
      ) : <button type="button" className="button button--ghost" onClick={() => void cancelExport()}>取消渲染</button>}
    >
      {state === 'idle' ? (
        <div className="export-settings">
          <div className="export-summary-card"><div className="export-summary-card__poster"><span>{project.aspectRatio}</span></div><div><strong>{project.name}</strong><p>{project.shots.length} 个镜头 · {project.document.manifest.fps} fps</p><span className="verified-label"><ShieldCheck size={14} /> 资产包已通过检查</span></div></div>
          <div className="field-grid field-grid--export">
            <label className="field-stack"><span>分辨率</span><select value="native" disabled><option value="native">{project.document.manifest.canvas.width} × {project.document.manifest.canvas.height}</option></select></label>
            <label className="field-stack"><span>编码质量</span><select value="high" disabled><option value="high">H.264 高质量</option></select></label>
          </div>
          <label className="switch-row switch-row--boxed"><span><b>导出外挂字幕</b><small>若素材包含 SRT，则复制独立文件；不会烧录到视频</small></span><input type="checkbox" checked readOnly /></label>
          <label className="switch-row switch-row--boxed"><span><b>完成后抽帧检查</b><small>起始、中间、末尾三处检查空帧与异常编码</small></span><input type="checkbox" checked readOnly /></label>
          <div className="export-path"><span>输出目录</span><code>本地应用数据/output/{project.id}/</code></div>
        </div>
      ) : state === 'done' && result ? (
        <div className="export-complete" aria-live="polite">
          <div className="export-complete__mark"><Check size={30} /></div>
          <div className="output-file"><FileVideo2 size={20} /><div><strong>{result.videoName}</strong><small>{project.document.manifest.canvas.width} × {project.document.manifest.canvas.height} · H.264 · {result.durationSeconds.toFixed(1)} 秒</small></div><span>已完成</span></div>
          {result.subtitlesName ? <div className="output-file"><span className="srt-file">SRT</span><div><strong>{result.subtitlesName}</strong><small>UTF-8 · 外挂字幕，未烧录</small></div><span>已完成</span></div> : null}
          <div className="inline-note inline-note--success">已生成 {result.qaFrameCount} 张 QA 抽帧。</div>
        </div>
      ) : state === 'error' ? (
        <div className="export-complete" role="alert"><div className="export-complete__mark"><TriangleAlert size={30} /></div><div className="inline-note inline-note--error">{error}</div></div>
      ) : (
        <div className="export-progress" aria-live="polite">
          <div className="export-progress__meter"><span style={{width: `${progress}%`}} /></div>
          <div className="export-progress__headline"><LoaderCircle size={19} className="spin" /><strong>{stepLabels[state as keyof typeof stepLabels]}</strong><output>{progress}%</output></div>
          <ol className="export-steps">{(['preparing', 'rendering', 'checking'] as const).map((step, index) => { const order = {preparing: 0, rendering: 1, checking: 2}; const current = order[state as keyof typeof order] ?? 0; return <li key={step} className={index < current ? 'is-complete' : index === current ? 'is-active' : ''}><span>{index < current ? <Check size={13} /> : index + 1}</span><div><strong>{stepLabels[step]}</strong><small>{step === 'preparing' ? '验证时间线、字体与素材引用' : step === 'rendering' ? '逐帧合成纸片、人物与镜头运动' : '音画混合、抽帧检查并写入 MP4'}</small></div></li>; })}</ol>
        </div>
      )}
    </Modal>
  );
}
