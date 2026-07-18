(() => {
  'use strict';

  const session = new URLSearchParams(window.location.search).get('session') || '';
  const state = {projects: [], jobs: [], project: null, selectedProjectId: null, preview: null};
  const elements = Object.fromEntries([
    'connection-label', 'project-count', 'project-list', 'project-title', 'project-meta', 'production-ribbon',
    'stage', 'preview-label', 'shot-summary', 'shot-list', 'delivery-reason', 'detect-runtime',
    'start-narration', 'start-render', 'active-job-count', 'job-list', 'live-status',
  ].map((id) => [id, document.getElementById(id)]));

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const api = async (pathname, options = {}) => {
    const response = await fetch(pathname, {
      ...options,
      headers: {authorization: `Bearer ${session}`, 'content-type': 'application/json', ...(options.headers || {})},
    });
    const body = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };

  const announce = (message) => {
    elements['live-status'].textContent = message;
  };

  const formatDuration = (seconds) => {
    const value = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(value / 60);
    return `${String(minutes).padStart(2, '0')}:${String(Math.round(value % 60)).padStart(2, '0')}`;
  };

  const labels = {
    'detect-runtime': '模型检测',
    'generate-shot': '候选生成',
    'synthesize-narration': '旁白合成',
    'render-project': '成片渲染',
    queued: '排队中', running: '执行中', complete: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  };

  const mediaUrl = (projectId, relativePath, scope = 'project') => {
    const query = new URLSearchParams({session, scope, projectId, path: relativePath});
    return `/api/media?${query.toString()}`;
  };

  const renderProjects = () => {
    elements['project-count'].textContent = String(state.projects.length);
    if (!state.projects.length) {
      elements['project-list'].innerHTML = '<div class="empty-copy">还没有项目。回到 Codex 对话创建第一条视频。</div>';
      return;
    }
    elements['project-list'].innerHTML = state.projects.map((project) => `
      <button class="project-button" type="button" data-project="${escapeHtml(project.projectId)}" ${project.projectId === state.selectedProjectId ? 'aria-current="page"' : ''}>
        <strong>${escapeHtml(project.title)}</strong>
        <span><em>${escapeHtml(formatDuration(project.durationSeconds))}</em><em>${project.selectedShotCount}/${project.generatedShotCount} 已审</em></span>
      </button>`).join('');
  };

  const findStateShot = (shotId) => state.project?.state?.shots?.find((shot) => shot.shotId === shotId) || null;
  const currentProjectId = () => state.selectedProjectId;
  const activeFor = (action, shotId) => state.jobs.find((job) =>
    job.projectId === currentProjectId() && job.action === action && (!shotId || job.shotId === shotId)
    && (job.status === 'queued' || job.status === 'running'));

  const setPreview = (preview) => {
    state.preview = preview;
    if (!preview) {
      elements.stage.innerHTML = '<div class="empty-stage"><span aria-hidden="true">9:16</span><p>候选视频和关键帧会在这里出现。</p></div>';
      elements['preview-label'].textContent = '未载入';
      return;
    }
    const source = mediaUrl(currentProjectId(), preview.path, preview.scope || 'project');
    elements.stage.innerHTML = preview.kind === 'video'
      ? `<video controls preload="metadata" src="${escapeHtml(source)}" aria-label="${escapeHtml(preview.label)}"></video>`
      : `<img src="${escapeHtml(source)}" alt="${escapeHtml(preview.label)}" />`;
    elements['preview-label'].textContent = preview.label;
  };

  const renderRibbon = () => {
    const plan = state.project?.plan;
    const productionState = state.project?.state;
    const generated = productionState?.shots?.filter((shot) => shot.shotKind === 'generated-performance') || [];
    const allSelected = generated.length > 0 && generated.every((shot) => shot.status === 'selected' || shot.status === 'complete');
    const hasCandidates = generated.some((shot) => shot.candidates.some((candidate) => candidate.status === 'complete'));
    const narrationComplete = productionState?.narration?.status === 'complete';
    const renderComplete = state.jobs.some((job) => job.projectId === currentProjectId() && job.action === 'render-project' && job.status === 'complete');
    const statuses = {
      pack: plan ? 'complete' : 'active',
      motion: hasCandidates ? 'complete' : plan ? 'active' : 'waiting',
      review: allSelected ? 'complete' : hasCandidates ? 'active' : 'waiting',
      voice: narrationComplete ? 'complete' : allSelected ? 'active' : 'waiting',
      render: renderComplete ? 'complete' : narrationComplete ? 'active' : 'waiting',
    };
    elements['production-ribbon'].querySelectorAll('li').forEach((item) => {
      const status = statuses[item.dataset.step] || 'waiting';
      item.dataset.status = status;
      item.querySelector('small').textContent = status === 'complete' ? '完成' : status === 'active' ? '当前' : '等待';
    });
  };

  const candidateMarkup = (shot, candidate) => {
    const selected = shot.selection?.candidateId === candidate.candidateId;
    const canReview = candidate.status === 'complete' && candidate.technicalQa?.result === 'pass';
    const qa = candidate.technicalQa?.result === 'pass' ? '技术 QA 通过' : candidate.technicalQa?.result === 'fail' ? '技术 QA 失败' : '等待技术 QA';
    return `<article class="candidate" data-selected="${selected}">
      <div class="candidate-head">
        <button type="button" data-preview-path="${escapeHtml(candidate.relativePath || '')}" data-preview-label="${escapeHtml(candidate.candidateId)}" ${candidate.relativePath ? '' : 'disabled'}>${escapeHtml(candidate.candidateId)}</button>
        <span class="candidate-state">${escapeHtml(selected ? '已选择' : labels[candidate.status] || candidate.status)}</span>
      </div>
      <div class="candidate-meta">seed ${escapeHtml(candidate.seed)} · ${escapeHtml(qa)}</div>
      ${candidate.error ? `<div class="candidate-meta">${escapeHtml(candidate.error)}</div>` : ''}
      ${canReview && !selected ? `<div class="candidate-actions">
        <button class="button button-primary" type="button" data-review="select" data-shot="${escapeHtml(shot.shotId)}" data-candidate="${escapeHtml(candidate.candidateId)}">审片通过</button>
        <button class="button button-secondary" type="button" data-review="reject" data-shot="${escapeHtml(shot.shotId)}" data-candidate="${escapeHtml(candidate.candidateId)}">拒绝</button>
      </div>` : ''}
    </article>`;
  };

  const renderProject = () => {
    const detail = state.project;
    if (!detail) return;
    const {plan, state: productionState} = detail;
    elements['project-title'].textContent = plan.metadata.title;
    elements['project-meta'].textContent = `${plan.metadata.locale} · ${formatDuration(plan.delivery.timeline.durationFrames / plan.delivery.timeline.fps)} · ${plan.shots.length} 个镜头 · MP4 + 外挂 SRT`;
    elements['detect-runtime'].disabled = Boolean(activeFor('detect-runtime'));
    elements['shot-summary'].textContent = `${plan.shots.length} 个镜头`;

    elements['shot-list'].innerHTML = plan.shots.map((planShot, index) => {
      const shot = findStateShot(planShot.shotId);
      const candidates = shot?.candidates || [];
      const active = activeFor('generate-shot', planShot.shotId);
      const startPath = planShot.kind === 'generated-performance' ? planShot.generation.conditioning.startKeyframePath : null;
      const generatedCount = candidates.filter((candidate) => candidate.status === 'complete').length;
      return `<article class="shot-row">
        <div class="shot-title">
          <strong>${String(index + 1).padStart(2, '0')} · ${escapeHtml(planShot.shotId)}</strong>
          <span>${escapeHtml(planShot.kind === 'generated-performance' ? `${generatedCount}/2 候选` : '确定性拼贴')}</span>
        </div>
        ${startPath ? `<div class="candidate-strip">
          ${candidates.length ? candidates.map((candidate) => candidateMarkup(shot, candidate)).join('') : `<button class="candidate" type="button" data-preview-path="${escapeHtml(startPath)}" data-preview-label="${escapeHtml(planShot.shotId)} 首帧"><span class="candidate-head"><strong>首帧</strong><span class="candidate-state">待生成</span></span><span class="candidate-meta">Imagegen source plate</span></button>`}
        </div>
        <div class="generate-line"><button class="button button-secondary" type="button" data-generate="${escapeHtml(planShot.shotId)}" ${active ? 'disabled' : ''}>${active ? '本地生成中' : generatedCount >= 2 ? '重新生成被拒候选' : '生成下一候选'}</button></div>` : '<div class="candidate-meta">由 Remotion 确定性排版与动画完成，不占用 WanGP 候选。</div>'}
      </article>`;
    }).join('');

    const generatedShots = productionState?.shots?.filter((shot) => shot.shotKind === 'generated-performance') || [];
    const allSelected = generatedShots.length > 0 && generatedShots.every((shot) => shot.status === 'selected' || shot.status === 'complete');
    const narrationComplete = productionState?.narration?.status === 'complete';
    elements['start-narration'].disabled = !allSelected || Boolean(activeFor('synthesize-narration')) || narrationComplete;
    elements['start-render'].disabled = !narrationComplete || Boolean(activeFor('render-project'));
    elements['delivery-reason'].textContent = !allSelected
      ? '所有连续表演镜头都需人工选择一个通过候选。'
      : !narrationComplete ? '候选已通过，可以生成本地 F5-TTS 旁白。' : '旁白已完成，可以渲染 MP4 与外挂 SRT。';
    renderRibbon();

    if (!state.preview) {
      const firstSelected = generatedShots.flatMap((shot) => shot.candidates).find((candidate) => candidate.relativePath && candidate.humanDecision?.decision === 'accept');
      const firstCandidate = generatedShots.flatMap((shot) => shot.candidates).find((candidate) => candidate.relativePath);
      const firstGenerated = plan.shots.find((shot) => shot.kind === 'generated-performance');
      if (firstSelected?.relativePath) setPreview({kind: 'video', path: firstSelected.relativePath, label: firstSelected.candidateId});
      else if (firstCandidate?.relativePath) setPreview({kind: 'video', path: firstCandidate.relativePath, label: firstCandidate.candidateId});
      else if (firstGenerated) setPreview({kind: 'image', path: firstGenerated.generation.conditioning.startKeyframePath, label: `${firstGenerated.shotId} 首帧`});
    }
  };

  const renderJobs = () => {
    const active = state.jobs.filter((job) => job.status === 'running' || job.status === 'queued').length;
    elements['active-job-count'].textContent = `${active} 进行中`;
    if (!state.jobs.length) {
      elements['job-list'].innerHTML = '<div class="empty-copy">还没有本地任务。</div>';
      return;
    }
    elements['job-list'].innerHTML = state.jobs.slice(0, 20).map((job) => {
      const lastLog = job.logs?.at(-1)?.text || job.error || '';
      const progress = Math.round(Number(job.progress || 0) * 100);
      return `<article class="job" data-status="${escapeHtml(job.status)}">
        <div class="job-top"><strong>${escapeHtml(labels[job.action] || job.action)}</strong><span>${escapeHtml(labels[job.status] || job.status)} · ${progress}%</span></div>
        <progress class="job-progress" max="100" value="${progress}" aria-label="任务进度 ${progress}%">${progress}%</progress>
        <p>${escapeHtml(job.projectId)}${job.shotId ? ` · ${escapeHtml(job.shotId)}` : ''}</p>
        ${lastLog ? `<small>${escapeHtml(lastLog)}</small>` : ''}
        ${(job.status === 'queued' || job.status === 'running') ? `<button class="button button-secondary" type="button" data-cancel="${escapeHtml(job.id)}">停止任务</button>` : ''}
      </article>`;
    }).join('');
  };

  const loadProject = async (projectId) => {
    state.selectedProjectId = projectId;
    state.preview = null;
    renderProjects();
    state.project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    renderProject();
  };

  const refresh = async (quiet = false) => {
    if (!session) throw new Error('缺少本地会话。请从 Codex 返回的制作台链接打开。');
    const [projectResponse, jobResponse] = await Promise.all([api('/api/projects'), api('/api/jobs')]);
    state.projects = projectResponse.projects;
    state.jobs = jobResponse.jobs;
    document.querySelector('.connection').dataset.ready = 'true';
    elements['connection-label'].textContent = '本地制作链路已连接';
    renderProjects();
    renderJobs();
    if (!state.selectedProjectId && state.projects[0]) state.selectedProjectId = state.projects[0].projectId;
    if (state.selectedProjectId) {
      state.project = await api(`/api/projects/${encodeURIComponent(state.selectedProjectId)}`);
      renderProject();
    }
    if (!quiet) announce('本地状态已刷新。');
  };

  const postAndRefresh = async (pathname, body = {}) => {
    await api(pathname, {method: 'POST', body: JSON.stringify(body)});
    await refresh(true);
  };

  document.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    try {
      if (target.dataset.project) await loadProject(target.dataset.project);
      if (target.dataset.previewPath) setPreview({kind: target.dataset.previewPath.endsWith('.mp4') ? 'video' : 'image', path: target.dataset.previewPath, label: target.dataset.previewLabel || '预览'});
      if (target.dataset.generate) await postAndRefresh(`/api/projects/${encodeURIComponent(currentProjectId())}/shots/${encodeURIComponent(target.dataset.generate)}/generate`);
      if (target.dataset.cancel) await postAndRefresh(`/api/jobs/${encodeURIComponent(target.dataset.cancel)}/cancel`);
      if (target.dataset.review) {
        const notes = target.dataset.review === 'reject'
          ? window.prompt('写下可见的拒绝原因，例如“右脚滑动且没有踩稳地面”')
          : window.prompt('可选：记录通过理由或审片备注', '方向、支撑与接触均正确');
        if (target.dataset.review === 'reject' && !notes?.trim()) return;
        await postAndRefresh(`/api/projects/${encodeURIComponent(currentProjectId())}/shots/${encodeURIComponent(target.dataset.shot)}/candidates/${encodeURIComponent(target.dataset.candidate)}/${target.dataset.review}`, notes?.trim() ? {notes: notes.trim()} : {});
        state.preview = null;
      }
    } catch (error) {
      announce(`操作失败：${error.message}`);
    }
  });

  document.getElementById('refresh').addEventListener('click', () => refresh().catch((error) => announce(`刷新失败：${error.message}`)));
  elements['detect-runtime'].addEventListener('click', () => postAndRefresh(`/api/projects/${encodeURIComponent(currentProjectId())}/detect`).catch((error) => announce(error.message)));
  elements['start-narration'].addEventListener('click', () => postAndRefresh(`/api/projects/${encodeURIComponent(currentProjectId())}/narrate`).catch((error) => announce(error.message)));
  elements['start-render'].addEventListener('click', () => postAndRefresh(`/api/projects/${encodeURIComponent(currentProjectId())}/render`).catch((error) => announce(error.message)));
  document.getElementById('copy-prompt').addEventListener('click', async () => {
    const prompt = state.selectedProjectId
      ? `请使用 $gen-video-studio 检查项目 ${state.selectedProjectId}，按门禁继续下一步。`
      : '请使用 $gen-video-studio 按我们的工作流创建一条 20 秒竖屏视频，并打开本地制作台。';
    await navigator.clipboard.writeText(prompt);
    announce('对话指令已复制。');
  });

  refresh().catch((error) => {
    elements['connection-label'].textContent = '本地制作链路未连接';
    announce(`加载失败：${error.message}`);
  });
  window.setInterval(() => { if (!document.hidden) void refresh(true).catch(() => undefined); }, 3_000);
})();
