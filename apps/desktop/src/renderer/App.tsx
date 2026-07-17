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
  if (inspection.productionSchemaVersion !== 3) {
    checks.unshift({
      id: 'production-v3-required',
      label: 'Gen Video v3 生产契约',
      detail: '缺少 production.json v3。请重新下载由最新版资产包 Skill 生成的项目。',
      status: 'error',
    });
  } else if (inspection.status === 'ready') {
    checks.unshift(
      {id: 'schema', label: 'v3 生产契约', detail: 'production.json、镜头映射与固定候选计划有效', status: 'pass'},
      {id: 'paths', label: '路径与压缩包安全', detail: '未发现越界、碰撞、符号链接或压缩炸弹风险', status: 'pass'},
      {id: 'media', label: '关键帧与配音素材', detail: '首尾关键帧、参考音频、旁白文本与交付路径可读取', status: 'pass'},
      {id: 'logic', label: '镜头与世界约束', detail: '动作轴、接触里程碑和确定性道具计划已通过结构检查', status: 'pass'},
    );
  }
  return {
    packName: selection.name,
    path: selection.displayPath,
    projectName: inspection.title ?? selection.name,
    manifestVersion: '3',
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
    setBusy(true);
    try {
      const selected = await desktopService.selectAssetPack();
      if (!selected) return;
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
    return <HomeScreen busy={busy} error={error} onImport={() => void selectPack()} onOpenProject={(id) => void openProject(id)} />;
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
  return <HomeScreen busy={busy} error={error} onImport={() => void selectPack()} onOpenProject={(id) => void openProject(id)} />;
}
