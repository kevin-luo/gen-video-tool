import {
  Ban,
  Check,
  CircleStop,
  Clapperboard,
  Cpu,
  FileVideo2,
  ListChecks,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Volume2,
  WandSparkles,
} from 'lucide-react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
  ProductionCandidateSnapshot,
  ProductionShotSnapshot,
  ProductionSnapshot,
} from '../../shared/desktop-api';
import {Modal} from '../components/Modal';
import {WorkflowSteps, type WorkflowStage} from '../components/WorkflowSteps';
import {desktopService} from '../services/desktop-service';

interface ProductionPanelProps {
  projectId: string;
  initialShotId: string;
  readOnly: boolean;
  onClose: () => void;
}

const activeCandidateStatus = (candidate: ProductionCandidateSnapshot): boolean =>
  ['queued', 'preparing', 'running', 'downloading'].includes(candidate.status);

const shotLabels: Record<ProductionShotSnapshot['status'], string> = {
  'not-required': '无需模型',
  'ready-to-generate': '等待生成',
  generating: '正在生成',
  'awaiting-selection': '等待选择',
  selected: '已选片',
  failed: '生成失败',
  interrupted: '可恢复',
};

const candidateLabels: Record<ProductionCandidateSnapshot['status'], string> = {
  planned: '待生成',
  queued: '排队中',
  preparing: '准备模型',
  running: '正在生成',
  downloading: '整理输出',
  complete: '生成完成',
  failed: '生成失败',
  cancelled: '已取消',
  interrupted: '意外中断',
};

const narrationLabels = {
  queued: '等待合成',
  generating: '正在合成',
  complete: '旁白就绪',
  failed: '合成失败',
  interrupted: '可重新合成',
} as const;

const readableError = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : fallback;

export function ProductionPanel({projectId, initialShotId, readOnly, onClose}: ProductionPanelProps) {
  const [snapshot, setSnapshot] = useState<ProductionSnapshot | null>(null);
  const [selectedShotId, setSelectedShotId] = useState(initialShotId);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const automaticDetectionStarted = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await desktopService.getProductionSnapshot(projectId));
    } catch (reason) {
      setError(readableError(reason, '读取本地制作状态失败'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => desktopService.onProductionProgress((progress) => {
    if (progress.projectId === projectId) setSnapshot(progress.snapshot);
  }), [projectId]);

  useEffect(() => {
    if (loading || !snapshot?.hasPlan || snapshot.provider || automaticDetectionStarted.current) return;
    automaticDetectionStarted.current = true;
    setDetecting(true);
    setError(null);
    void desktopService.detectProductionProvider(projectId)
      .then(setSnapshot)
      .catch((reason) => setError(readableError(reason, '本地 WanGP 自动检测失败')))
      .finally(() => setDetecting(false));
  }, [loading, projectId, snapshot?.hasPlan, snapshot?.provider]);

  const generatedShots = useMemo(
    () => snapshot?.shots.filter((shot) => shot.kind === 'generated-performance') ?? [],
    [snapshot],
  );

  useEffect(() => {
    if (!generatedShots.length) return;
    if (!generatedShots.some((shot) => shot.shotId === selectedShotId)) {
      setSelectedShotId(generatedShots[0]!.shotId);
    }
  }, [generatedShots, selectedShotId]);

  const shot = generatedShots.find((candidate) => candidate.shotId === selectedShotId) ?? null;
  const activeCandidate = shot?.candidates.find(activeCandidateStatus);
  const narration = snapshot?.narration;
  const narrationActive = narration?.status === 'generating';
  const generationReadyForReview = generatedShots.every((entry) => (
    entry.candidates.some((candidate) => candidate.status === 'complete')
    && !entry.candidates.some(activeCandidateStatus)
  ));
  const allShotsSelected = generatedShots.every((entry) => entry.status === 'selected');
  const narrationReady = narration?.status === 'complete';
  const deliveryReady = allShotsSelected && narrationReady;
  const currentStage: WorkflowStage = deliveryReady ? 'deliver' : generationReadyForReview || allShotsSelected ? 'review' : 'generate';
  const completedStages: WorkflowStage[] = deliveryReady
    ? ['assets', 'generate', 'review']
    : currentStage === 'review'
      ? ['assets', 'generate']
      : ['assets'];

  const detectProvider = async () => {
    setDetecting(true);
    setError(null);
    try { setSnapshot(await desktopService.detectProductionProvider(projectId)); }
    catch (reason) { setError(readableError(reason, '本地 WanGP 检测失败')); }
    finally { setDetecting(false); }
  };

  const generate = async () => {
    if (!shot) return;
    setPendingAction(`generate:${shot.shotId}`);
    setError(null);
    try { setSnapshot(await desktopService.generateProductionShot({projectId, shotId: shot.shotId})); }
    catch (reason) { setError(readableError(reason, '启动本地生成失败')); }
    finally { setPendingAction(null); }
  };

  const synthesizeNarration = async () => {
    setPendingAction('narration:start');
    setError(null);
    try { setSnapshot(await desktopService.synthesizeProductionNarration(projectId)); }
    catch (reason) { setError(readableError(reason, '启动本地 F5-TTS 失败')); }
    finally { setPendingAction(null); }
  };

  const cancelNarration = async () => {
    setPendingAction('narration:cancel');
    setError(null);
    try { setSnapshot(await desktopService.cancelProductionNarration(projectId)); }
    catch (reason) { setError(readableError(reason, '取消本地 F5-TTS 失败')); }
    finally { setPendingAction(null); }
  };

  const cancel = async () => {
    if (!shot) return;
    setPendingAction(`cancel:${shot.shotId}`);
    setError(null);
    try { setSnapshot(await desktopService.cancelProductionShot(projectId, shot.shotId)); }
    catch (reason) { setError(readableError(reason, '取消本地生成失败')); }
    finally { setPendingAction(null); }
  };

  const decide = async (candidate: ProductionCandidateSnapshot, decision: 'select' | 'reject') => {
    if (!shot) return;
    if (decision === 'reject' && !window.confirm('将这个候选标记为不采用？原始视频仍会保留在项目中。')) return;
    setPendingAction(`${decision}:${candidate.candidateId}`);
    setError(null);
    try {
      const updated = decision === 'select'
        ? await desktopService.selectProductionCandidate(projectId, shot.shotId, candidate.candidateId)
        : await desktopService.rejectProductionCandidate(projectId, shot.shotId, candidate.candidateId);
      setSnapshot(updated);
    } catch (reason) {
      setError(readableError(reason, decision === 'select' ? '选择候选失败' : '拒绝候选失败'));
    } finally {
      setPendingAction(null);
    }
  };

  const provider = snapshot?.provider;
  const providerReady = provider?.available === true;
  const generationLocked = readOnly || !providerReady || Boolean(activeCandidate) || narrationActive || pendingAction !== null;
  const narrationLocked = readOnly || !allShotsSelected || Boolean(activeCandidate) || pendingAction !== null;
  const generationBlockReason = readOnly
    ? '当前项目不可写，请重新导入资产包。'
    : !providerReady
      ? '先检测并接通本地 WanGP，才能生成候选。'
      : narrationActive
        ? '本地旁白正在合成，完成后才能占用 GPU 生成画面。'
        : pendingAction !== null
          ? '正在提交上一项本地操作，请稍候。'
          : null;
  const narrationBlockReason = readOnly
    ? '当前项目不可写，请重新导入资产包。'
    : !allShotsSelected
      ? '先为全部生成镜头选定正片，旁白步骤才会解锁。'
      : Boolean(activeCandidate)
        ? '画面生成正在占用本地运行时，完成后再合成旁白。'
        : pendingAction !== null
          ? '正在提交上一项本地操作，请稍候。'
          : null;
  const pendingActionLabel = pendingAction?.startsWith('generate:')
    ? '正在启动本地生成'
    : pendingAction?.startsWith('cancel:')
      ? '正在停止本地生成'
      : pendingAction?.startsWith('select:')
        ? '正在保存选片结果'
        : pendingAction?.startsWith('reject:')
          ? '正在保存不采用标记'
          : pendingAction === 'narration:start'
            ? '正在启动本地旁白'
            : pendingAction === 'narration:cancel'
              ? '正在停止本地旁白'
              : null;

  const footer = (
    <>
      <span className="production-footer-status" aria-live="polite">
        {readOnly
          ? '当前项目不可写，请重新导入资产包建立本地项目。'
          : deliveryReady
            ? '本地画面、人工选片和旁白均已就绪，可以进入合成导出。'
            : allShotsSelected
              ? '画面已选定，下一步合成本地旁白。'
              : '所有图片、视频与状态文件只写入当前项目目录。'}
      </span>
      <button type="button" className={deliveryReady ? 'button button--primary' : 'button button--ghost'} onClick={onClose}>
        {deliveryReady ? <><FileVideo2 size={15} />完成并返回编辑器</> : '关闭'}
      </button>
    </>
  );

  return (
    <Modal
      title="本地制作"
      description="先生成整帧人物表演，再人工选片和合成旁白；因果道具、遮挡与镜头运动在最终导出时确定性合成。"
      width="workspace"
      onClose={onClose}
      footer={footer}
    >
      {loading ? (
        <div className="production-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取 v3 生产计划与恢复状态…</div>
      ) : null}

      {!loading && snapshot && !snapshot.hasPlan ? (
        <div className="production-empty">
          <Clapperboard size={36} />
          <div><h3>缺少 v3 生产计划</h3><p>当前项目没有有效的 production.json，无法启动本地模型。请返回首页，导入由最新版资产包 Skill 生成的完整项目。</p></div>
        </div>
      ) : null}

      {!loading && snapshot?.hasPlan ? (
        <div className="production-surface">
          <div className={`production-flowbar ${deliveryReady ? 'is-ready' : ''}`}>
            <WorkflowSteps current={currentStage} completed={completedStages} compact />
            <p aria-live="polite">
              {pendingActionLabel ? <><LoaderCircle className="spin" size={14} />{pendingActionLabel}</> : deliveryReady ? <><Check size={14} />制作门禁已通过</> : currentStage === 'review' ? <><ListChecks size={14} />选定正片并完成旁白</> : <><Cpu size={14} />接通环境并生成候选</>}
            </p>
          </div>
          <div className="production-workspace">
          <aside className="production-sidebar" aria-label="生成镜头列表">
            <header><span>制作镜头</span><b>{generatedShots.length}</b></header>
            <ol>
              {generatedShots.map((entry, index) => (
                <li key={entry.shotId}>
                  <button type="button" className={entry.shotId === shot?.shotId ? 'is-active' : ''} onClick={() => setSelectedShotId(entry.shotId)}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <span><strong>{entry.shotId}</strong><small>{shotLabels[entry.status]}</small></span>
                    {entry.status === 'generating' ? <LoaderCircle className="spin" size={14} /> : entry.status === 'selected' ? <Check size={14} /> : null}
                  </button>
                </li>
              ))}
            </ol>
          </aside>

          <section className="production-detail" aria-busy={Boolean(activeCandidate)}>
            <header className="production-provider">
              <div className="production-provider__identity">
                <span className={`production-provider__mark ${providerReady ? 'is-ready' : ''}`}><Cpu size={18} /></span>
                <div><strong>WanGP 本地运行时</strong><small>{provider?.endpoint ?? '尚未检测本地服务'}</small></div>
              </div>
              <div className="production-provider__actions">
                {providerReady ? <span className="production-local-badge"><ShieldCheck size={14} />离线可用</span> : null}
                <button type="button" className="button button--quiet button--compact" disabled={detecting || Boolean(activeCandidate)} onClick={() => void detectProvider()}>
                  {detecting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                  {detecting ? '检测中' : provider ? '重新检测' : '检测本地环境'}
                </button>
              </div>
              {provider?.reason ? <p className={providerReady ? 'production-provider__note' : 'production-provider__note is-error'}>{provider.reason}</p> : null}
              {activeCandidate ? <p className="production-provider__note">当前候选仍在生成，任务结束后才能重新检测运行时。</p> : null}
            </header>

            {shot ? (
              <div className="production-shot">
                <div className="production-shot__heading">
                  <div><span className="eyebrow">{shot.shotId}</span><h3>整帧人物表演候选</h3><p>两个固定 seed 逐个生成。技术检查通过后仍需人工确认动作方向、接触时机和肢体完整性。</p></div>
                  <div className="production-shot__actions">
                  {activeCandidate ? (
                    <button type="button" className="button button--danger button--compact" disabled={pendingAction !== null} onClick={() => void cancel()}><CircleStop size={14} />取消当前任务</button>
                  ) : (
                    <button type="button" className="button button--primary" disabled={generationLocked} onClick={() => void generate()}>
                      {pendingAction?.startsWith('generate:') ? <LoaderCircle className="spin" size={15} /> : shot.candidates.some((candidate) => candidate.status === 'complete') ? <RotateCcw size={15} /> : <WandSparkles size={15} />}
                      {shot.candidates.some((candidate) => candidate.status === 'complete') ? '重新生成两版' : '生成两版候选'}
                    </button>
                  )}
                  {!activeCandidate && generationBlockReason ? <small>{generationBlockReason}</small> : null}
                  </div>
                </div>

                <div className="production-candidates">
                  {shot.candidates.map((candidate, index) => (
                    <article key={candidate.candidateId} className={`production-candidate ${candidate.humanDecision === 'selected' ? 'is-selected' : candidate.humanDecision === 'rejected' ? 'is-rejected' : ''}`}>
                      <header>
                        <div><span>候选 {String(index + 1).padStart(2, '0')}</span><strong>Seed {candidate.seed}</strong></div>
                        <span className={`production-status production-status--${candidate.status}`}>{candidateLabels[candidate.status]}</span>
                      </header>
                      <div className="production-candidate__preview">
                        {candidate.videoUrl ? (
                          <video src={candidate.videoUrl} controls muted playsInline loop preload="metadata" aria-label={`${candidate.candidateId} 视频预览`} />
                        ) : (
                          <div><Play size={28} /><span>{candidate.status === 'planned' ? '等待本地生成' : candidateLabels[candidate.status]}</span></div>
                        )}
                        {activeCandidateStatus(candidate) ? <progress max={1} value={candidate.progress} aria-label={`${candidateLabels[candidate.status]} ${Math.round(candidate.progress * 100)}%`} /> : null}
                      </div>
                      <div className="production-candidate__meta">
                        <span>{candidate.technicalQa?.status === 'passed' ? <><ShieldCheck size={13} />技术检查通过</> : candidate.technicalQa?.status === 'failed' ? <><TriangleAlert size={13} />技术检查失败</> : '尚未完成技术检查'}</span>
                        {candidate.sha256 ? <code title={candidate.sha256}>{candidate.sha256.slice(0, 10)}</code> : null}
                      </div>
                      {candidate.error ? <p className="production-candidate__error">{candidate.error.code}: {candidate.error.message}</p> : null}
                      <footer>
                        <button type="button" className="button button--quiet button--compact" disabled={candidate.status !== 'complete' || pendingAction !== null || readOnly} onClick={() => void decide(candidate, 'reject')}><Ban size={14} />不采用</button>
                        <button type="button" className="button button--primary button--compact" disabled={candidate.status !== 'complete' || candidate.technicalQa?.status !== 'passed' || pendingAction !== null || readOnly} onClick={() => void decide(candidate, 'select')}><Check size={14} />{candidate.humanDecision === 'selected' ? '已选定' : '选为正片'}</button>
                      </footer>
                      {candidate.status !== 'complete' ? <p className="production-candidate__gate">候选生成完成后解锁审片操作。</p> : candidate.technicalQa?.status !== 'passed' ? <p className="production-candidate__gate">通过技术检查后才能选为正片；当前仍可标记不采用。</p> : null}
                    </article>
                  ))}
                </div>
                <div className="production-review-note">
                  <ListChecks size={18} />
                  <div><strong>人工审片门禁</strong><span>朝向目标 · 支撑脚稳定 · 接触时机 · 肢体完整 · 无身份漂移</span></div>
                </div>
              </div>
            ) : (
              <div className="production-empty production-empty--compact"><Clapperboard size={30} /><div><h3>没有需要生成的镜头</h3><p>所有镜头都是确定性图层合成，可直接进入预览和导出。</p></div></div>
            )}

            {narration ? (
              <section className={`production-narration ${allShotsSelected ? 'is-unlocked' : ''}`} aria-busy={narrationActive}>
                <div className="production-narration__identity">
                  <span className={`production-provider__mark ${narration.status === 'complete' ? 'is-ready' : ''}`}>
                    {narrationActive ? <LoaderCircle className="spin" size={18} /> : <Volume2 size={18} />}
                  </span>
                  <div>
                    <strong>F5-TTS 本地旁白</strong>
                    <small>
                      {narrationLabels[narration.status]} · {narration.segmentCount} 段
                      {narration.durationSeconds ? ` · ${narration.durationSeconds.toFixed(2)} 秒` : ''}
                      {narration.tailPaddingSeconds ? ` · 尾部静音 ${narration.tailPaddingSeconds.toFixed(2)} 秒` : ''}
                    </small>
                  </div>
                </div>
                {narration.audioUrl ? <audio src={narration.audioUrl} controls preload="metadata" aria-label="本地旁白预览" /> : null}
                <div className="production-narration__actions">
                  {narrationActive ? (
                    <button type="button" className="button button--danger button--compact" disabled={pendingAction !== null} onClick={() => void cancelNarration()}>
                      <CircleStop size={14} />取消旁白
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button button--quiet button--compact"
                      disabled={narrationLocked}
                      onClick={() => void synthesizeNarration()}
                    >
                      {pendingAction === 'narration:start' ? <LoaderCircle className="spin" size={14} /> : <Volume2 size={14} />}
                      {narration.status === 'complete' ? '重新合成旁白' : '合成本地旁白'}
                    </button>
                  )}
                </div>
                {narrationBlockReason ? <p className="production-narration__gate"><ShieldCheck size={13} />{narrationBlockReason}</p> : null}
                {narration.error ? <p className="production-narration__error">{narration.error}</p> : null}
              </section>
            ) : null}
          </section>
          </div>
        </div>
      ) : null}

      {error ? <div className="inline-note inline-note--error production-error" role="alert"><TriangleAlert size={15} /><span>{error}</span></div> : null}
    </Modal>
  );
}
