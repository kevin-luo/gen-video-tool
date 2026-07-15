interface ProjectCoverProps {
  variant: 'football' | 'story' | 'blank';
  compact?: boolean;
  label?: string;
}

export function ProjectCover({variant, compact = false, label}: ProjectCoverProps) {
  return (
    <div className={`project-cover project-cover--${variant} ${compact ? 'project-cover--compact' : ''}`} aria-hidden="true">
      <div className="project-cover__paper project-cover__paper--back" />
      <div className="project-cover__year">{label ?? (variant === 'football' ? '1966' : variant === 'story' ? '秋日' : 'NEW')}</div>
      <div className="project-cover__subject">
        <span>{variant === 'football' ? '9' : variant === 'story' ? '母女' : '+'}</span>
      </div>
      <div className="project-cover__paper project-cover__paper--front" />
    </div>
  );
}
