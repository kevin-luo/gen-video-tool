import {useState} from 'react';
import type {AssetPackInspection} from '@gen-video-tool/asset-pack';
import type {AssetPackSelection, ProjectPayload} from '../shared/desktop-api';
import type {AppScreen, ProjectModel, ValidationReport} from './domain/editor';
import {buildProjectModel} from './domain/project-adapter';
import {desktopService} from './services/desktop-service';
import {EditorScreen} from './screens/EditorScreen';
import {HomeScreen} from './screens/HomeScreen';
import {ImportScreen} from './screens/ImportScreen';

const validationReport = (selection: AssetPackSelection, inspection: AssetPackInspection): ValidationReport => {
  const checks: ValidationReport['checks'] = inspection.diagnostics.map((issue, index) => ({
    id: `${issue.code}-${index}`,
    label: issue.code,
    detail: `${issue.message}${issue.suggestion ? ` ${issue.suggestion}` : ''}`,
    status: issue.severity === 'error' ? 'error' : 'warning',
  }));
  if (inspection.status === 'ready') {
    checks.unshift(
      {id: 'schema', label: '结构与协议', detail: 'manifest、镜头引用和 schema v2 均有效', status: 'pass'},
      {id: 'paths', label: '路径与压缩包安全', detail: '未发现越界、碰撞、符号链接或压缩炸弹风险', status: 'pass'},
      {id: 'media', label: '图像、旁白与外挂字幕', detail: '媒体可读取，人物透明度与时间轴兼容', status: 'pass'},
      {id: 'actors', label: '人物动画模式', detail: 'Rigid、Mesh 与 Pose Cut 的素材约束已通过', status: 'pass'},
    );
  }
  return {
    packName: selection.name,
    path: selection.displayPath,
    projectName: inspection.title ?? selection.name,
    manifestVersion: '2',
    shots: inspection.shotCount,
    files: inspection.fileCount,
    checks,
  };
};

export function App() {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [selection, setSelection] = useState<AssetPackSelection | null>(null);
  const [inspection, setInspection] = useState<AssetPackInspection | null>(null);
  const [project, setProject] = useState<ProjectModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enterProject = (payload: ProjectPayload) => {
    setProject(buildProjectModel(payload));
    setScreen('editor');
  };

  const selectPack = async () => {
    setError(null);
    const selected = await desktopService.selectAssetPack();
    if (!selected) return;
    setBusy(true);
    try {
      const result = await desktopService.inspectAssetPack(selected.handle);
      setSelection(selected);
      setInspection(result);
      setScreen('import');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '资产包检查失败');
    } finally {
      setBusy(false);
    }
  };

  const importPack = async () => {
    if (!selection) return;
    setBusy(true);
    setError(null);
    try {
      const result = await desktopService.importAssetPack(selection.handle);
      setInspection(result.inspection);
      if (!result.project) {
        setError('资产包未提交：请按阻断项修复，或更换项目 ID 后重试。');
        return;
      }
      enterProject(result.project);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '资产包导入失败');
    } finally {
      setBusy(false);
    }
  };

  const openProject = async (projectId: string) => {
    setBusy(true);
    setError(null);
    try { enterProject(await desktopService.openProject(projectId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '项目打开失败'); }
    finally { setBusy(false); }
  };

  if (screen === 'home') {
    return <HomeScreen busy={busy} error={error} onImport={() => void selectPack()} onOpenProject={(id) => void openProject(id)} onProjectCreated={(id) => void openProject(id)} />;
  }
  if (screen === 'import' && selection && inspection) {
    return (
      <ImportScreen
        report={validationReport(selection, inspection)} busy={busy} error={error}
        onBack={() => setScreen('home')} onReselect={() => void selectPack()} onEnterEditor={() => void importPack()}
      />
    );
  }
  if (project) return <EditorScreen initialProject={project} onBack={() => setScreen('home')} />;
  setScreen('home');
  return null;
}
