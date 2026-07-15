import {ArrowLeft, CheckCircle2, ChevronDown, Film, MonitorSmartphone, Redo2, Save, Undo2} from 'lucide-react';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {IconButton} from '../components/IconButton';
import {ExportDialog} from '../editor/ExportDialog';
import {Inspector} from '../editor/Inspector';
import {PreviewStage} from '../editor/PreviewStage';
import {ShotRail} from '../editor/ShotRail';
import {Timeline} from '../editor/Timeline';
import type {ProjectModel} from '../domain/editor';
import {materializeProjectDocument} from '../domain/project-adapter';
import {desktopService} from '../services/desktop-service';
import {useEditorSession} from '../hooks/use-editor-session';

interface EditorScreenProps {
  initialProject: ProjectModel;
  onBack: () => void;
}

export function EditorScreen({initialProject, onBack}: EditorScreenProps) {
  const save = useCallback(async (model: ProjectModel) => {
    if (model.readOnly) return;
    await desktopService.saveProject(model.id, materializeProjectDocument(model));
  }, []);
  const session = useEditorSession(initialProject, save);
  const [playhead, setPlayhead] = useState(13.42);
  const [playing, setPlaying] = useState(false);
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      setPlayhead((current) => {
        const next = current + delta;
        if (next >= session.duration) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, session.duration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editingText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) session.redo(); else session.undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        session.redo();
      }
      if (!editingText && event.code === 'Space') {
        event.preventDefault();
        setPlaying((current) => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session]);

  const shotStarts = useMemo(() => {
    let cursor = 0;
    return new Map(session.project.shots.map((shot) => {
      const start = cursor;
      cursor += shot.duration;
      return [shot.id, start];
    }));
  }, [session.project.shots]);
  const previewProject = useMemo(() => materializeProjectDocument(session.project), [session.project]);

  const selectShot = useCallback((shotId: string) => {
    session.selectShot(shotId);
    setPlayhead(shotStarts.get(shotId) ?? 0);
  }, [session, shotStarts]);

  if (!session.selectedShot) return null;

  return (
    <main className="editor-shell">
      <header className="editor-header">
        <div className="editor-header__left">
          <span className="brand-mark brand-mark--small"><Film size={16} /></span>
          <button type="button" className="button button--ghost button--compact" onClick={onBack}><ArrowLeft size={15} /> 返回项目</button>
          <span className="header-divider" />
          <div className="project-title"><small>项目</small><strong>{session.project.name}</strong></div>
          <div className={`save-state save-state--${session.autosave}`} aria-live="polite">
            {session.autosave === 'saved' ? <CheckCircle2 size={14} /> : <Save size={14} />}
            {session.project.readOnly ? '示例只读' : session.autosave === 'saved' ? '已保存' : session.autosave === 'saving' ? '正在保存' : session.autosave === 'error' ? '保存失败' : '未保存'}
          </div>
        </div>
        <div className="editor-header__right">
          <div className="undo-group">
            <IconButton label="撤销 Ctrl+Z" disabled={!session.canUndo} onClick={session.undo}><Undo2 size={16} /></IconButton>
            <IconButton label="重做 Ctrl+Y" disabled={!session.canRedo} onClick={session.redo}><Redo2 size={16} /></IconButton>
          </div>
          <button type="button" className="select-button"><MonitorSmartphone size={15} /> {session.project.aspectRatio} 竖屏 <ChevronDown size={14} /></button>
          <button type="button" className="select-button">预览质量 1080p <ChevronDown size={14} /></button>
          <button type="button" className="button button--primary button--export" onClick={() => setShowExport(true)}>导出视频 <ChevronDown size={15} /></button>
        </div>
      </header>

      <div className="editor-main-grid">
        <ShotRail shots={session.project.shots} selectedShotId={session.selectedShotId} onSelect={selectShot} onReorder={session.reorderShot} />
        <PreviewStage shot={session.selectedShot} project={previewProject} assetBase={session.project.assetBase} playhead={playhead} duration={session.duration} playing={playing} onTogglePlay={() => setPlaying((current) => !current)} onSeek={setPlayhead} />
        <Inspector shot={session.selectedShot} onUpdate={(update) => session.updateShot(session.selectedShot!.id, update)} />
      </div>

      <Timeline shots={session.project.shots} selectedShotId={session.selectedShotId} duration={session.duration} playhead={playhead} onSeek={setPlayhead} onSelectShot={selectShot} />
      {showExport ? <ExportDialog project={session.project} onClose={() => setShowExport(false)} /> : null}
    </main>
  );
}
