import {ArrowLeft, CircleStop, Gauge, LoaderCircle, Play, RefreshCw} from 'lucide-react';
import {useCallback, useEffect, useState} from 'react';

import type {WanGPBenchmarkEntry, WanGPBenchmarkSnapshot} from '../../shared/desktop-api';
import {Modal} from '../components/Modal';
import {desktopService} from '../services/desktop-service';

interface WanGPBenchmarkPanelProps {
  projectId: string;
  shotIds: string[];
  initialShotId: string;
  onClose: () => void;
}

const duration = (milliseconds?: number): string =>
  milliseconds === undefined ? '—' : `${(milliseconds / 1_000).toFixed(2)}s`;

const metricCells = (entry: WanGPBenchmarkEntry) => [
  duration(entry.metrics?.providerStartupMs),
  duration(entry.metrics?.modelLoadMs),
  duration(entry.metrics?.textEncodeMs),
  duration(entry.metrics?.denoiseMs),
  duration(entry.metrics?.vaeDecodeMs),
  duration(entry.metrics?.videoEncodeMs),
  duration(entry.metrics?.totalMs),
  entry.metrics?.peakVramMb ? `${entry.metrics.peakVramMb} MB` : '—',
  entry.metrics?.peakRamMb ? `${entry.metrics.peakRamMb} MB` : '—',
];

export function WanGPBenchmarkPanel({projectId, shotIds, initialShotId, onClose}: WanGPBenchmarkPanelProps) {
  const [snapshot, setSnapshot] = useState<WanGPBenchmarkSnapshot | null>(null);
  const [shotId, setShotId] = useState(initialShotId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setSnapshot(await desktopService.getWanGPBenchmark(projectId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取基准报告失败'); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => desktopService.onWanGPBenchmarkProgress((next) => {
    if (next.projectId === projectId) setSnapshot(next);
  }), [projectId]);

  const run = async (entry: WanGPBenchmarkEntry) => {
    setError(null);
    try { setSnapshot(await desktopService.startWanGPBenchmark({projectId, shotId, targetId: entry.targetId})); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '启动真实基准测试失败'); }
  };

  const cancel = async () => {
    setError(null);
    try { setSnapshot(await desktopService.cancelWanGPBenchmark(projectId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '取消基准测试失败'); }
  };

  const running = snapshot?.runningTargetId !== undefined;
  return (
    <Modal
      title="WanGP 同首帧性能基准"
      description="四条目标链路使用同一张首帧、同一条动作提示和固定 Seed；每次点击只生成一个候选，所有数据来自真实本地运行。"
      width="workspace"
      onClose={onClose}
      footer={<button type="button" className="button button--ghost" onClick={onClose}><ArrowLeft size={15} />返回本地制作</button>}
    >
      <div className="benchmark-page">
        <header className="benchmark-toolbar">
          <div>
            <Gauge size={20} />
            <div><strong>测试首帧</strong><small>{snapshot?.firstFramePath ?? '首次运行后记录到报告'}</small></div>
          </div>
          <label><span>基准镜头</span><select value={shotId} disabled={running} onChange={(event) => setShotId(event.target.value)}>{shotIds.map((id) => <option key={id}>{id}</option>)}</select></label>
          {running ? <button type="button" className="button button--danger button--compact" onClick={() => void cancel()}><CircleStop size={14} />取消当前测试</button> : <button type="button" className="button button--quiet button--compact" onClick={() => void load()}><RefreshCw size={14} />刷新报告</button>}
        </header>

        {loading ? <div className="production-loading"><LoaderCircle className="spin" size={20} />正在读取本地基准数据…</div> : null}
        {error ? <div className="notice notice--error">{error}</div> : null}

        {!loading ? (
          <div className="benchmark-table-wrap">
            <table className="benchmark-table">
              <thead><tr><th>目标链路</th><th>启动</th><th>模型加载</th><th>文本编码</th><th>去噪</th><th>VAE</th><th>编码</th><th>总耗时</th><th>峰值显存</th><th>峰值内存</th><th>实测</th></tr></thead>
              <tbody>
                {snapshot?.entries.map((entry) => {
                  const cells = metricCells(entry);
                  const isRunning = snapshot.runningTargetId === entry.targetId;
                  return (
                    <tr key={entry.targetId}>
                      <th scope="row"><strong>{entry.label}</strong><small>{entry.discovered ? `${entry.modelLabel} · ${entry.installed ? '已安装' : '未安装，请先准备本地权重'}` : '当前 WanGP 未发现'}</small><small>{entry.acceleratorProfileLabel ?? '模型默认加速设置'}</small></th>
                      {cells.map((value, index) => <td key={index}>{value}</td>)}
                      <td>
                        {entry.outputUrl ? <a className="button button--quiet button--compact" href={entry.outputUrl} target="_blank" rel="noreferrer"><Play size={13} />查看</a> : null}
                        <button type="button" className="button button--primary button--compact" disabled={!entry.discovered || running} onClick={() => void run(entry)}>{isRunning ? <LoaderCircle className="spin" size={13} /> : null}{entry.status === 'complete' ? '重新实测' : '开始实测'}</button>
                        {entry.error ? <small className="benchmark-error">{entry.error}</small> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {snapshot?.contactSheetUrl ? <section className="benchmark-contact"><header><strong>同首帧对比联系表</strong><small>{snapshot.contactSheetRelativePath}</small></header><img src={snapshot.contactSheetUrl} alt="WanGP 同首帧真实输出联系表" /></section> : null}
        {snapshot?.reportRelativePath ? <p className="benchmark-report-path">计时报告：<code>{snapshot.reportRelativePath}</code></p> : null}
      </div>
    </Modal>
  );
}
