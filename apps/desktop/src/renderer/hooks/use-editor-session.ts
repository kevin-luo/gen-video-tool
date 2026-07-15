import {useCallback, useEffect, useMemo, useState} from 'react';
import type {AutosaveState, ProjectModel, ShotModel} from '../domain/editor';

interface HistoryState {
  past: ProjectModel[];
  present: ProjectModel;
  future: ProjectModel[];
}

const cloneProject = (project: ProjectModel): ProjectModel => structuredClone(project);

export function useEditorSession(initialProject: ProjectModel, onSave: (project: ProjectModel) => Promise<void>) {
  const [history, setHistory] = useState<HistoryState>({past: [], present: cloneProject(initialProject), future: []});
  const [selectedShotId, setSelectedShotId] = useState(initialProject.shots[3]?.id ?? initialProject.shots[0]?.id ?? '');
  const [autosave, setAutosave] = useState<AutosaveState>('saved');

  useEffect(() => {
    if (autosave !== 'unsaved') return;
    const snapshot = cloneProject(history.present);
    const timer = window.setTimeout(() => {
      setAutosave('saving');
      void onSave(snapshot).then(() => setAutosave('saved')).catch(() => setAutosave('error'));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [autosave, history.present, onSave]);

  const commit = useCallback((update: (project: ProjectModel) => ProjectModel) => {
    setHistory((current) => ({
      past: [...current.past.slice(-49), cloneProject(current.present)],
      present: update(cloneProject(current.present)),
      future: [],
    }));
    setAutosave('unsaved');
  }, []);

  const updateShot = useCallback(
    (shotId: string, update: (shot: ShotModel) => ShotModel) => {
      commit((project) => ({
        ...project,
        shots: project.shots.map((shot) => (shot.id === shotId ? update(shot) : shot)),
      }));
    },
    [commit],
  );

  const reorderShot = useCallback(
    (shotId: string, delta: -1 | 1) => {
      commit((project) => {
        const currentIndex = project.shots.findIndex((shot) => shot.id === shotId);
        const nextIndex = currentIndex + delta;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= project.shots.length) return project;
        const shots = [...project.shots];
        const [shot] = shots.splice(currentIndex, 1);
        if (!shot) return project;
        shots.splice(nextIndex, 0, shot);
        return {...project, shots: shots.map((item, index) => ({...item, index: index + 1}))};
      });
    },
    [commit],
  );

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past.at(-1);
      if (!previous) return current;
      return {
        past: current.past.slice(0, -1),
        present: cloneProject(previous),
        future: [cloneProject(current.present), ...current.future],
      };
    });
    setAutosave('unsaved');
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return {
        past: [...current.past, cloneProject(current.present)],
        present: cloneProject(next),
        future: current.future.slice(1),
      };
    });
    setAutosave('unsaved');
  }, []);

  const selectedShot = useMemo(
    () => history.present.shots.find((shot) => shot.id === selectedShotId) ?? history.present.shots[0],
    [history.present.shots, selectedShotId],
  );
  const duration = useMemo(
    () => history.present.shots.reduce((sum, shot) => sum + shot.duration, 0),
    [history.present.shots],
  );

  return {
    project: history.present,
    selectedShot,
    selectedShotId,
    selectShot: setSelectedShotId,
    updateShot,
    reorderShot,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    autosave,
    duration,
  };
}
