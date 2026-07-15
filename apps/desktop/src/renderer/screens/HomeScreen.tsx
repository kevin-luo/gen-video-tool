import {useEffect, useState} from 'react';
import {ArchiveRestore, Film, FolderOpen, Plus, Search, Trash2, Upload} from 'lucide-react';
import type {CreateProjectRequest, RecentProject} from '../../shared/desktop-api';
import {IconButton} from '../components/IconButton';
import {Modal} from '../components/Modal';
import {ProjectCover} from '../components/ProjectCover';
import {desktopService} from '../services/desktop-service';

interface HomeScreenProps {
  busy: boolean;
  error: string | null;
  onImport: () => void;
  onOpenProject: (projectId: string) => void;
  onProjectCreated: (projectId: string) => void;
}

export function HomeScreen({busy, error, onImport, onOpenProject, onProjectCreated}: HomeScreenProps) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecentProject | null>(null);
  const [name, setName] = useState('未命名纸片视频');
  const [aspect, setAspect] = useState<CreateProjectRequest['aspectRatio']>('9:16');

  useEffect(() => {
    void desktopService.listRecentProjects().then(setProjects);
  }, []);

  const filtered = projects.filter((project) => project.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));

  const createProject = async () => {
    const project = await desktopService.createProject({name, aspectRatio: aspect});
    setShowCreate(false);
    onProjectCreated(project.id);
  };

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
          <button className="button button--ghost" type="button" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> 新建项目
          </button>
          <button className="button button--primary" type="button" onClick={onImport} disabled={busy}>
            <Upload size={16} /> 导入资产包
          </button>
        </div>
      </header>

      <section className="home-content" aria-labelledby="home-title">
        {error ? <div className="inline-note inline-note--error" role="alert">{error}</div> : null}
        <div className="home-intro">
          <div>
            <p className="eyebrow">本地视频工作台</p>
            <h1 id="home-title">继续你的纸片叙事</h1>
            <p>导入结构化资产包，检查镜头，再用固定运动模板完成剪辑与导出。</p>
          </div>
          <div className="home-intro__shortcuts" aria-label="快捷操作">
            <button type="button" className="shortcut-card" onClick={onImport}>
              <span className="shortcut-card__icon"><ArchiveRestore size={20} /></span>
              <span><strong>检查资产包</strong><small>ZIP 或项目目录</small></span>
            </button>
            <button type="button" className="shortcut-card" onClick={() => setShowCreate(true)}>
              <span className="shortcut-card__icon"><FolderOpen size={20} /></span>
              <span><strong>从空项目开始</strong><small>稍后添加镜头资产</small></span>
            </button>
          </div>
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
          {filtered.map((project, index) => (
            <article className="project-card" key={project.id}>
              <button type="button" className="project-card__open" onClick={() => onOpenProject(project.id)} aria-label={`打开 ${project.name}`}>
                <ProjectCover variant={index === 0 ? 'football' : 'story'} />
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
                <time dateTime={project.updatedAt}>{index === 0 ? '刚刚编辑' : '昨天编辑'}</time>
              </div>
            </article>
          ))}
          <button type="button" className="project-card project-card--new" onClick={() => setShowCreate(true)}>
            <span><Plus size={22} /></span>
            <strong>新建空白项目</strong>
            <small>创建画幅后进入编辑器</small>
          </button>
        </div>
      </section>

      {showCreate ? (
        <Modal
          title="新建项目"
          description="先确定项目名称和画幅，镜头与素材可稍后添加。"
          onClose={() => setShowCreate(false)}
          footer={
            <>
              <button type="button" className="button button--ghost" onClick={() => setShowCreate(false)}>取消</button>
              <button type="button" className="button button--primary" disabled={!name.trim()} onClick={() => void createProject()}>创建并进入编辑器</button>
            </>
          }
        >
          <label className="field-stack">
            <span>项目名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <fieldset className="choice-fieldset">
            <legend>视频画幅</legend>
            <div className="segmented-control segmented-control--three">
              {(['9:16', '16:9', '1:1'] as const).map((value) => (
                <button key={value} type="button" className={aspect === value ? 'is-active' : ''} onClick={() => setAspect(value)}>{value}</button>
              ))}
            </div>
          </fieldset>
        </Modal>
      ) : null}
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
