import {ArrowLeft, Clapperboard, Film, MonitorSmartphone, ShieldCheck, TriangleAlert} from 'lucide-react';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {ExportDialog} from '../editor/ExportDialog';
import {Inspector} from '../editor/Inspector';
import {PreviewStage} from '../editor/PreviewStage';
import {ProductionPanel} from '../editor/ProductionPanel';
import {ShotRail} from '../editor/ShotRail';
import {Timeline} from '../editor/Timeline';
import type {ProjectModel} from '../domain/editor';
import {buildProjectModel} from '../domain/project-adapter';
import {desktopService} from '../services/desktop-service';

interface EditorScreenProps {
  initialProject: ProjectModel;
  onBack: () => void;
}

export function EditorScreen({initialProject, onBack}: EditorScreenProps) {
  const [project, setProject] = useState(initialProject);
  const [selectedShotId, setSelectedShotId] = useState(initialProject.shots[0]?.id ?? '');
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showProduction, setShowProduction] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const duration = project.plan.delivery.timeline.durationFrames / project.plan.delivery.timeline.fps;
  const selectedShot = project.shots.find((shot) => shot.id === selectedShotId) ?? project.shots[0];
  const exportReady = project.renderData !== undefined && project.state.narration.status === 'complete';

  const refreshProject = useCallback(async () => {
    try {
      const refreshed = buildProjectModel(await desktopService.openProject(project.id));
      setProject(refreshed);
      setRefreshError(null);
    } catch (reason) {
      setRefreshError(reason instanceof Error ? reason.message : '刷新本地生产状态失败');
    }
  }, [project.id]);

  useEffect(() => {
    if (!playing || !project.renderData) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      setPlayhead((current) => {
        const next = current + delta;
        if (next >= duration) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [duration, playing, project.renderData]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editingText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (!editingText && event.code === 'Space' && project.renderData) {
        event.preventDefault();
        setPlaying((current) => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [project.renderData]);

  const shotStarts = useMemo(() => new Map(project.shots.map((shot) => [
    shot.id,
    shot.startFrame / project.plan.delivery.timeline.fps,
  ])), [project.plan.delivery.timeline.fps, project.shots]);

  const selectShot = useCallback((shotId: string) => {
    setSelectedShotId(shotId);
    setPlayhead(shotStarts.get(shotId) ?? 0);
    setPlaying(false);
  }, [shotStarts]);

  if (!selectedShot) return null;

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <div className="editor-header__left">
          <span className="brand-mark brand-mark--small"><Film size={16} /></span>
          <button type="button" className="button button--ghost button--compact" onClick={onBack}><ArrowLeft size={15} /> 返回项目</button>
          <span className="header-divider" />
          <div className="project-title"><small>v3 本地项目</small><strong>{project.name}</strong></div>
          <div className="save-state save-state--saved"><ShieldCheck size={14} />production.json 为只读生产意图</div>
        </div>
        <div className="editor-header__right">
          <span className="editor-format"><MonitorSmartphone size={15} /> 9:16 · {project.plan.delivery.raster.width} × {project.plan.delivery.raster.height}</span>
          <button type="button" className="button button--workflow" onClick={() => setShowProduction(true)}><Clapperboard size={15} /> 本地制作</button>
          <button
            type="button"
            className="button button--primary button--export"
            disabled={!exportReady}
            title={exportReady ? undefined : '先完成 WanGP 选片与 F5-TTS 旁白'}
            onClick={() => setShowExport(true)}
          >合成导出</button>
        </div>
      </header>

      {refreshError ? <div className="editor-refresh-error" role="alert"><TriangleAlert size={14} />{refreshError}</div> : null}
      <div className="editor-main-grid">
        <ShotRail shots={project.shots} selectedShotId={selectedShotId} assetBase={project.assetBase} onSelect={selectShot} />
        <PreviewStage shot={selectedShot} project={project} playhead={playhead} duration={duration} playing={playing} onTogglePlay={() => setPlaying((current) => !current)} onSeek={setPlayhead} />
        <Inspector shot={selectedShot} fps={project.plan.delivery.timeline.fps} />
      </div>

      <Timeline project={project} shots={project.shots} selectedShotId={selectedShotId} duration={duration} playhead={playhead} onSeek={setPlayhead} onSelectShot={selectShot} />
      {showExport ? <ExportDialog project={project} onClose={() => setShowExport(false)} /> : null}
      {showProduction ? (
        <ProductionPanel
          projectId={project.id}
          initialShotId={selectedShot.id}
          readOnly={project.readOnly}
          onClose={() => {
            setShowProduction(false);
            void refreshProject();
          }}
        />
      ) : null}
    </main>
  );
}
