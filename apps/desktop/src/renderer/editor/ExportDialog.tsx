import {Check, FileVideo2, FolderOpen, LoaderCircle, ShieldCheck, TriangleAlert} from 'lucide-react';
import {useEffect, useState} from 'react';
import {Modal} from '../components/Modal';
import type {ExportProjectResult} from '../../shared/desktop-api';
import type {ExportState, ProjectModel} from '../domain/editor';
import {desktopService} from '../services/desktop-service';

interface ExportDialogProps { project: ProjectModel; onClose: () => void; }

const stepLabels: Record<Exclude<ExportState, 'idle' | 'done' | 'error'>, string> = {
  preparing: '验证 v3 生产状态',
  rendering: 'Remotion 正在渲染画面',
  checking: 'FFmpeg 正在抽帧检查',
};

export function ExportDialog({project, onClose}: ExportDialogProps) {
  const [state, setState] = useState<ExportState>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportProjectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {raster, timeline} = project.plan.delivery;

  useEffect(() => desktopService.onExportProgress((update) => {
    if (update.projectId !== project.id) return;
    setProgress(Math.round(update.progress * 100));
    if (update.phase !== 'done') setState(update.phase);
  }), [project.id]);

  const startExport = async () => {
    setError(null);
    if (!project.renderData || project.state.narration.status !== 'complete') {
      setError('导出门禁未通过：必须完成两个候选的人工选片，并生成本地 F5-TTS 旁白。');
      setState('error');
      return;
    }
    setProgress(4);
    setState('preparing');
    try {
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

  return (
    <Modal
      title={state === 'done' ? '视频已导出' : state === 'error' ? '导出未完成' : '导出视频'}
      description={state === 'done' ? 'MP4 与外挂 SRT 已写入本地输出目录。' : '使用已审片的 WanGP 画面、F5-TTS WAV 与 v3 确定性时间线。'}
      width="wide"
      onClose={onClose}
      footer={state === 'done' ? (
        <><button type="button" className="button button--ghost" onClick={onClose}>关闭</button><button type="button" className="button button--primary" onClick={() => void desktopService.revealOutput(project.id)}><FolderOpen size={16} /> 打开输出目录</button></>
      ) : state === 'idle' || state === 'error' ? (
        <><button type="button" className="button button--ghost" onClick={onClose}>取消</button><button type="button" className="button button--primary" onClick={() => void startExport()}><FileVideo2 size={16} /> {state === 'error' ? '重新导出' : '开始导出'}</button></>
      ) : <button type="button" className="button button--ghost" onClick={() => void cancelExport()}>取消渲染</button>}
    >
      {state === 'idle' ? (
        <div className="export-settings">
          <div className="export-summary-card"><div className="export-summary-card__poster"><span>9:16</span></div><div><strong>{project.name}</strong><p>{project.shots.length} 个镜头 · {timeline.fps} fps · {timeline.durationFrames} 帧</p><span className="verified-label"><ShieldCheck size={14} /> v3 生产门禁已通过</span></div></div>
          <div className="field-grid field-grid--export">
            <label className="field-stack"><span>交付分辨率</span><select value="delivery" disabled><option value="delivery">{raster.width} × {raster.height}</option></select></label>
            <label className="field-stack"><span>编码</span><select value="h264" disabled><option value="h264">H.264 · yuv420p</option></select></label>
          </div>
          <label className="switch-row switch-row--boxed"><span><b>外挂字幕</b><small>复制独立 SRT，不烧录到画面</small></span><input type="checkbox" checked readOnly /></label>
          <label className="switch-row switch-row--boxed"><span><b>成片 QA</b><small>均匀抽帧，并检查动作里程碑与接触邻帧</small></span><input type="checkbox" checked readOnly /></label>
          <div className="export-path"><span>输出目录</span><code>本地应用数据/output/{project.id}/</code></div>
        </div>
      ) : state === 'done' && result ? (
        <div className="export-complete" aria-live="polite">
          <div className="export-complete__mark"><Check size={30} /></div>
          <div className="output-file"><FileVideo2 size={20} /><div><strong>{result.videoName}</strong><small>{raster.width} × {raster.height} · H.264 · {result.durationSeconds.toFixed(1)} 秒</small></div><span>已完成</span></div>
          {result.subtitlesName ? <div className="output-file"><span className="srt-file">SRT</span><div><strong>{result.subtitlesName}</strong><small>UTF-8 · 外挂字幕，未烧录</small></div><span>已完成</span></div> : null}
          <div className="inline-note inline-note--success">已生成 {result.qaFrameCount} 张 QA 抽帧。</div>
        </div>
      ) : state === 'error' ? (
        <div className="export-complete" role="alert"><div className="export-complete__mark"><TriangleAlert size={30} /></div><div className="inline-note inline-note--error">{error}</div></div>
      ) : (
        <div className="export-progress" aria-live="polite">
          <div className="export-progress__meter"><span style={{width: `${progress}%`}} /></div>
          <div className="export-progress__headline"><LoaderCircle size={19} className="spin" /><strong>{stepLabels[state as keyof typeof stepLabels]}</strong><output>{progress}%</output></div>
          <ol className="export-steps">{(['preparing', 'rendering', 'checking'] as const).map((step, index) => { const order = {preparing: 0, rendering: 1, checking: 2}; const current = order[state as keyof typeof order] ?? 0; return <li key={step} className={index < current ? 'is-complete' : index === current ? 'is-active' : ''}><span>{index < current ? <Check size={13} /> : index + 1}</span><div><strong>{stepLabels[step]}</strong><small>{step === 'preparing' ? '校验候选、旁白、SRT 与资产摘要' : step === 'rendering' ? '按 v3 时间线逐帧合成，无静态降级' : '混合音频、抽帧并写入 MP4'}</small></div></li>; })}</ol>
        </div>
      )}
    </Modal>
  );
}
