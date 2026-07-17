import {Check} from 'lucide-react';

export type WorkflowStage = 'assets' | 'generate' | 'review' | 'deliver';

interface WorkflowStepsProps {
  current: WorkflowStage;
  completed?: WorkflowStage[];
  compact?: boolean;
}

const stages: Array<{id: WorkflowStage; label: string; detail: string}> = [
  {id: 'assets', label: '导入资产', detail: '检查 v3 生产契约'},
  {id: 'generate', label: '生成画面', detail: 'WanGP 本地生成'},
  {id: 'review', label: '审片配音', detail: '选片并合成旁白'},
  {id: 'deliver', label: '合成导出', detail: 'MP4 与外挂 SRT'},
];

export function WorkflowSteps({current, completed = [], compact = false}: WorkflowStepsProps) {
  const currentIndex = stages.findIndex((stage) => stage.id === current);

  return (
    <nav className={`workflow-steps ${compact ? 'workflow-steps--compact' : ''}`} aria-label="本地视频制作流程">
      <ol>
        {stages.map((stage, index) => {
          const isComplete = completed.includes(stage.id) || index < currentIndex;
          const isActive = stage.id === current;
          return (
            <li key={stage.id} className={isComplete ? 'is-complete' : isActive ? 'is-active' : ''} aria-current={isActive ? 'step' : undefined}>
              <span className="workflow-steps__marker" aria-hidden="true">{isComplete ? <Check size={13} /> : index + 1}</span>
              <span className="workflow-steps__copy">
                <strong>{stage.label}</strong>
                {!compact ? <small>{stage.detail}</small> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
