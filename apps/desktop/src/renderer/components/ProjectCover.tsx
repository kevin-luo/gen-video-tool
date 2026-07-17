import type {RecentProject} from '../../shared/desktop-api';

type ProjectCoverData = Pick<RecentProject, 'aspectRatio' | 'locale' | 'name' | 'shotCount' | 'status'>;

interface ProjectCoverProps {
  project: ProjectCoverData;
  compact?: boolean;
}

const STATUS_LABELS: Record<RecentProject['status'], string> = {
  ready: '可导出',
  draft: '制作中',
  'needs-attention': '需处理',
};

export function ProjectCover({project, compact = false}: ProjectCoverProps) {
  return (
    <div className={`project-cover project-cover--${project.status} ${compact ? 'project-cover--compact' : ''}`} aria-hidden="true">
      <div className="project-cover__paper project-cover__paper--back" />
      <div className="project-cover__meta">
        <span>{project.locale}</span>
        <span>{STATUS_LABELS[project.status]}</span>
      </div>
      <strong className="project-cover__title">{project.name}</strong>
      <div className="project-cover__format">
        <span>{project.aspectRatio}</span>
        <span>{project.shotCount} 镜头</span>
      </div>
      <div className="project-cover__paper project-cover__paper--front" />
    </div>
  );
}
