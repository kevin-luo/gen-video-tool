import {useEffect, useState} from 'react';
import {Film, HardDrive, Search, ShieldCheck, Trash2, Upload} from 'lucide-react';
import type {RecentProject} from '../../shared/desktop-api';
import {IconButton} from '../components/IconButton';
import {Modal} from '../components/Modal';
import {ProjectCover} from '../components/ProjectCover';
import {WorkflowSteps} from '../components/WorkflowSteps';
import {desktopService} from '../services/desktop-service';

interface HomeScreenProps {
  busy: boolean;
  error: string | null;
  onImport: () => void;
  onOpenProject: (projectId: string) => void;
}

const UPDATED_AT_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const formatUpdatedAt = (updatedAt: string): string => {
  const timestamp = new Date(updatedAt);
  return Number.isNaN(timestamp.getTime()) ? '更新时间未知' : UPDATED_AT_FORMATTER.format(timestamp);
};

export function HomeScreen({busy, error, onImport, onOpenProject}: HomeScreenProps) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [query, setQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RecentProject | null>(null);

  useEffect(() => {
    void desktopService.listRecentProjects().then(setProjects);
  }, []);

  const filtered = projects.filter((project) => project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  const deleteProject = async () => {
    if (!deleteTarget) return;
    await desktopService.deleteProject(deleteTarget.id);
    setProjects((current) => current.filter((project) => project.id !== deleteTarget.id));
    setDeleteTarget(null);
  };

  return (
    <main className="home-shell">
      <header className="home-header">
        <div className="brand-lockup">
          <span className="brand-mark"><Film size={19} /></span>
          <span>Gen Video Tool</span>
        </div>
        <div className="home-header__actions">
          <span className="local-only-label"><ShieldCheck size={15} /> 全程本地处理</span>
          <button className="button button--primary" type="button" onClick={onImport} disabled={busy}>
            <Upload size={16} /> {busy ? '正在检查…' : '导入资产包'}
          </button>
        </div>
      </header>

      <section className="home-content" aria-labelledby="home-title">
        {error ? <div className="inline-note inline-note--error" role="alert">{error}</div> : null}
        <div className="home-intro">
          <div className="home-intro__copy">
            <p className="eyebrow">Gen Video v3 · 本地制作</p>
            <h1 id="home-title">从资产包到成片，<br />都留在你的电脑里</h1>
            <p>从 Codex / ChatGPT 对话生成并下载结构化资产包，再导入本机完成 WanGP 画面生成、候选审片、F5-TTS 旁白和 Remotion 合成。</p>
            <div className="home-intro__action">
              <button type="button" className="button button--primary button--large" onClick={onImport} disabled={busy}>
                <Upload size={17} /> 选择 ZIP 或项目目录
              </button>
              <small><HardDrive size={14} /> 模型、素材和生成结果不会上传</small>
            </div>
          </div>
          <WorkflowSteps current="assets" />
        </div>

        <div className="section-heading">
          <div>
            <h2>最近项目</h2>
            <p>{projects.length} 个本地项目</p>
          </div>
          <label className="search-field">
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">搜索项目</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" />
          </label>
        </div>

        <div className="project-grid">
          {filtered.map((project) => (
            <article className="project-card" key={project.id}>
              <button type="button" className="project-card__open" onClick={() => onOpenProject(project.id)} aria-label={`打开 ${project.name}`}>
                <ProjectCover project={project} />
              </button>
              <div className="project-card__meta">
                <div>
                  <h3>{project.name}</h3>
                  <p>{project.shotCount} 镜头 · {project.durationSeconds.toFixed(1)} 秒 · {project.aspectRatio}</p>
                </div>
                <IconButton label={project.readOnly ? `${project.name} 是只读示例` : `删除 ${project.name}`} compact disabled={project.readOnly} onClick={() => setDeleteTarget(project)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
              <div className="project-card__footer">
                <span className={`status-dot status-dot--${project.status}`} />
                <span>{project.status === 'ready' ? '可导出' : project.status === 'draft' ? '草稿' : '需要处理'}</span>
                <time dateTime={project.updatedAt}>{formatUpdatedAt(project.updatedAt)}</time>
              </div>
            </article>
          ))}
          {!filtered.length ? (
            <div className="project-empty">
              <HardDrive size={24} />
              <div><strong>{query ? '没有匹配的本地项目' : '还没有本地项目'}</strong><small>{query ? '换一个关键词，或导入新的资产包。' : '从 Codex / ChatGPT 资产包开始第一条视频。'}</small></div>
              {!query ? <button type="button" className="button button--quiet" onClick={onImport}><Upload size={15} /> 导入第一个资产包</button> : null}
            </div>
          ) : null}
        </div>
      </section>

      {deleteTarget ? (
        <Modal
          title="删除本地项目"
          description="这会删除项目 JSON 和导入素材；已经导出的成片不会被删除。"
          onClose={() => setDeleteTarget(null)}
          footer={<><button type="button" className="button button--ghost" onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="button button--danger" onClick={() => void deleteProject()}><Trash2 size={15} />确认删除</button></>}
        >
          <p>确定删除“{deleteTarget.name}”吗？此操作无法从应用内撤销。</p>
        </Modal>
      ) : null}
    </main>
  );
}
