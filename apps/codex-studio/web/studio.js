(() => {
  'use strict';

  const session = new URLSearchParams(window.location.search).get('session') || '';
  const state = {
    creations: [],
    current: null,
    currentId: null,
    pollTimer: null,
    toastTimer: null,
    finalizeRequested: new Set(),
    visibleMode: 'compose',
    view: 'new',
    settings: {durationSeconds: 20, voice: true},
  };

  const ids = [
    'local-status', 'local-status-label', 'new-view', 'works-view', 'creation-form', 'creation-card',
    'script-input', 'script-file', 'character-count', 'script-error', 'duration-summary', 'voice-summary',
    'generate-button', 'creation-progress', 'progress-kicker', 'progress-title', 'progress-message',
    'progress-fill', 'progress-stage', 'progress-percent', 'creation-result', 'result-player', 'result-title',
    'result-message', 'download-video', 'download-srt', 'creation-failure', 'failure-title', 'failure-message', 'copy-asset-request',
    'recent-works', 'works-library', 'settings-dialog', 'settings-form', 'duration-input', 'duration-output',
    'voice-input', 'runtime-detail', 'project-count', 'job-count', 'engineering-list', 'toast',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const api = async (pathname, options = {}) => {
    const headers = {authorization: `Bearer ${session}`, ...(options.headers || {})};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(pathname, {...options, headers});
    const body = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
    if (!response.ok) throw new Error(body.error || body.message || `HTTP ${response.status}`);
    return body;
  };

  const showToast = (message) => {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 4_500);
  };

  const creationId = (creation) => String(creation?.id || creation?.creationId || creation?.projectId || creation?.slug || '');
  const creationStatus = (creation) => String(creation?.status || creation?.state || creation?.phase || 'queued').toLowerCase();
  const getCreations = (payload) => {
    if (Array.isArray(payload)) return payload;
    return payload?.creations || payload?.items || payload?.results || [];
  };
  const unwrapCreation = (payload) => payload?.creation || payload?.result?.creation || payload?.result || payload;

  const artifactPath = (creation, type) => {
    const output = creation?.output || creation?.result || creation?.delivery || {};
    const media = creation?.media || {};
    const candidates = type === 'video'
      ? [creation?.videoPath, creation?.outputPath, creation?.finalVideoPath, output.videoPath, output.mp4Path, output.outputPath, output.finalVideoPath, media.videoPath, media.mp4]
      : type === 'subtitle'
        ? [creation?.srtPath, creation?.subtitlePath, output.srtPath, output.subtitlePath, media.srtPath, media.subtitle]
        : [creation?.thumbnailPath, creation?.posterPath, creation?.previewPath, output.thumbnailPath, output.posterPath, output.previewPath, media.thumbnailPath, media.posterPath];
    const artifact = Array.isArray(creation?.artifacts)
      ? creation.artifacts.find((item) => String(item?.kind || item?.type || '').toLowerCase().includes(type === 'subtitle' ? 'srt' : type))
      : null;
    candidates.push(artifact?.path, artifact?.relativePath, artifact?.url);
    return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
  };

  const mediaUrl = (path) => {
    if (!path) return '';
    if (/^(blob:|data:|https?:)/i.test(path)) return path;
    if (path.startsWith('/api/media')) {
      const url = new URL(path, window.location.origin);
      if (session && !url.searchParams.has('session')) url.searchParams.set('session', session);
      return `${url.pathname}${url.search}`;
    }
    const query = new URLSearchParams({path});
    if (session) query.set('session', session);
    return `/api/media?${query.toString()}`;
  };

  const platformLabel = (platform) => ({
    douyin: '抖音', xiaohongshu: '小红书', 'wechat-channels': '视频号', channels: '视频号', wechat: '视频号',
  }[platform] || '竖屏视频');

  const titleFor = (creation) => {
    const explicit = creation?.title || creation?.name || creation?.metadata?.title;
    if (explicit) return String(explicit);
    const script = String(creation?.script || creation?.prompt || creation?.brief?.script || '').trim();
    if (!script) return '未命名作品';
    return script.length > 18 ? `${script.slice(0, 18)}…` : script;
  };

  const formatDuration = (seconds) => {
    const value = Math.max(0, Math.round(Number(seconds || 0)));
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  };

  const displayStatus = (status) => {
    if (['complete', 'completed', 'succeeded', 'success', 'delivered', 'finalized'].includes(status)) return '已完成';
    if (['failed', 'error', 'cancelled', 'canceled', 'interrupted'].includes(status)) return '未完成';
    if (['queued', 'pending', 'created'].includes(status)) return '排队中';
    return '生成中';
  };

  const workMarkup = (creation) => {
    const id = creationId(creation);
    const title = titleFor(creation);
    const videoPath = artifactPath(creation, 'video');
    const imagePath = artifactPath(creation, 'image');
    const status = creationStatus(creation);
    const duration = Number(creation?.durationSeconds || creation?.duration || creation?.metadata?.durationSeconds || 0);
    const media = imagePath
      ? `<img src="${escapeHtml(mediaUrl(imagePath))}" alt="${escapeHtml(title)} 的封面" loading="lazy" />`
      : videoPath
        ? `<video src="${escapeHtml(mediaUrl(videoPath))}" muted preload="metadata" aria-label="${escapeHtml(title)} 预览"></video>`
        : `<div class="work-fallback">${escapeHtml(platformLabel(creation?.platform || creation?.brief?.platform))}</div>`;
    const body = `<article class="work-card" data-creation-id="${escapeHtml(id)}">
      <button type="button" data-open-creation="${escapeHtml(id)}" aria-label="打开 ${escapeHtml(title)}">
        ${media}
        <span class="work-status">${escapeHtml(displayStatus(status))}</span>
        <span class="work-meta"><strong>${escapeHtml(title)}</strong><span>${duration ? escapeHtml(formatDuration(duration)) : escapeHtml(platformLabel(creation?.platform || creation?.brief?.platform))}</span></span>
      </button>
    </article>`;
    return body;
  };

  const renderWorks = () => {
    const sorted = [...state.creations].sort((a, b) => {
      const aTime = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
      const bTime = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
      return bTime - aTime;
    });
    const empty = '<div class="empty-state">还没有本地作品。写下第一句文案，生成你的第一条视频。</div>';
    elements['recent-works'].innerHTML = sorted.length ? sorted.slice(0, 3).map(workMarkup).join('') : empty;
    elements['works-library'].innerHTML = sorted.length ? sorted.map(workMarkup).join('') : empty;
  };

  const setConnection = (mode, label) => {
    elements['local-status'].dataset.ready = mode;
    elements['local-status-label'].textContent = label;
  };

  const loadCreations = async ({quiet = false} = {}) => {
    if (!session) throw new Error('缺少本地会话参数，请从 Codex 提供的链接重新打开。');
    const payload = await api('/api/creations');
    state.creations = getCreations(payload);
    setConnection('true', '本地模型已就绪');
    renderWorks();
    if (!quiet) showToast('本地作品已刷新');
    return state.creations;
  };

  const setView = (view) => {
    state.view = view === 'works' ? 'works' : 'new';
    elements['new-view'].hidden = state.view !== 'new';
    elements['works-view'].hidden = state.view !== 'works';
    document.querySelectorAll('[data-view]').forEach((item) => {
      const active = item.dataset.view === state.view;
      if (item.classList.contains('nav-item')) {
        item.classList.toggle('is-active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
    });
    window.location.hash = state.view === 'works' ? 'works' : 'new';
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  const setCreationMode = (mode) => {
    state.visibleMode = mode;
    elements['creation-card'].dataset.mode = mode;
    elements['creation-form'].hidden = mode !== 'compose';
    elements['creation-progress'].hidden = mode !== 'progress';
    elements['creation-result'].hidden = mode !== 'result';
    elements['creation-failure'].hidden = mode !== 'failure';
  };

  const progressValue = (creation) => {
    let value = Number(creation?.progress ?? creation?.job?.progress ?? creation?.result?.progress ?? 0);
    if (value > 1) value /= 100;
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  };

  const stageFor = (creation, progress) => {
    const raw = String(creation?.stage || creation?.currentStage || creation?.phase || creation?.message || '').toLowerCase();
    if (/render|final|export|mux|compose-video|渲染|导出/.test(raw)) return 'render';
    if (/voice|audio|tts|narrat|旁白|配音|语音/.test(raw)) return 'voice';
    if (/visual|video|shot|frame|generat|asset|paper|collage|local-model|prepare-local|画面|镜头|视频|纸片|素材/.test(raw)) return 'visual';
    if (progress >= .85) return 'render';
    if (progress >= .12) return 'visual';
    if (progress >= .04) return 'voice';
    return 'script';
  };

  const stageCopy = (stage, creation) => {
    const backendMessage = creation?.progressMessage || creation?.message || creation?.job?.message;
    const defaults = {
      script: ['正在理解文案', '拆分叙事节奏、主体动作与镜头关系。'],
      visual: ['正在准备纸片素材', '检查完整角色、环境、道具和前景图层，不把角色交给视频模型变形。'],
      voice: ['正在合成配音', '本地 F5-TTS 正在生成旁白与外挂字幕时间轴。'],
      render: ['正在组装纸片动画', '按图层顺序执行滑入、弹入、盖章和定格，再合并旁白并保留独立 SRT。'],
    };
    return [defaults[stage][0], backendMessage || defaults[stage][1]];
  };

  const renderProgress = (creation) => {
    const progress = progressValue(creation);
    const stage = stageFor(creation, progress);
    const [title, message] = stageCopy(stage, creation);
    const percent = Math.max(1, Math.round(progress * 100));
    elements['progress-title'].textContent = title;
    elements['progress-message'].textContent = message;
    elements['progress-stage'].textContent = ({script: '拆解脚本', visual: '准备纸片素材', voice: '本地配音', render: '纸片组装与交付'}[stage]);
    elements['progress-percent'].textContent = `${percent}%`;
    elements['progress-fill'].style.width = `${percent}%`;
    const hasVoice = creation?.voice !== false;
    const progressSteps = document.querySelector('.progress-steps');
    if (progressSteps) progressSteps.dataset.voice = String(hasVoice);
    const voiceStep = document.querySelector('.progress-steps li[data-step="voice"]');
    if (voiceStep) voiceStep.hidden = !hasVoice;
    const order = hasVoice ? ['script', 'visual', 'voice', 'render'] : ['script', 'visual', 'render'];
    const activeIndex = order.indexOf(stage);
    document.querySelectorAll('.progress-steps li').forEach((item) => {
      const index = order.indexOf(item.dataset.step);
      item.dataset.status = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : 'waiting';
    });
  };

  const renderResult = (creation) => {
    const videoPath = artifactPath(creation, 'video');
    const subtitlePath = artifactPath(creation, 'subtitle');
    const videoUrl = mediaUrl(videoPath);
    elements['result-title'].textContent = titleFor(creation);
    elements['result-player'].innerHTML = videoUrl
      ? `<video controls preload="metadata" src="${escapeHtml(videoUrl)}" aria-label="${escapeHtml(titleFor(creation))}"></video>`
      : '<div class="work-fallback">成片已完成，输出文件路径暂不可预览</div>';
    elements['download-video'].href = videoUrl || '#';
    elements['download-video'].hidden = !videoUrl;
    elements['download-srt'].href = mediaUrl(subtitlePath) || '#';
    elements['download-srt'].hidden = !subtitlePath;
    elements['result-message'].textContent = subtitlePath
      ? '成片不含烧录字幕和背景音乐，外挂 SRT 已单独生成。'
      : '成片不含烧录字幕和背景音乐。';
    setCreationMode('result');
  };

  const renderFailure = (creation) => {
    const error = creation?.error?.message || creation?.error || creation?.failureReason || creation?.message;
    const needsPaperAssets = String(error || '').includes('PAPER_COLLAGE_ASSET_PROJECT_REQUIRED');
    elements['failure-title'].textContent = needsPaperAssets ? '纸片素材待准备' : '这次没有生成成功';
    elements['failure-message'].textContent = needsPaperAssets
      ? '文案已保存。下一步请回到 Codex 对话，让它用 Imagegen 生成完整角色与分层纸片资产，并附加到这个任务；系统不会回退到会失真的 Wan 视频。'
      : error || '本地生成链路返回了错误，文案和设置已经保留。';
    elements['copy-asset-request'].hidden = !needsPaperAssets;
    elements['retry-creation'].textContent = needsPaperAssets ? '资产附加后刷新' : '重新生成';
    setCreationMode('failure');
  };

  const successful = (status) => ['complete', 'completed', 'succeeded', 'success', 'delivered', 'finalized'].includes(status);
  const failed = (status) => ['failed', 'error', 'cancelled', 'canceled', 'interrupted'].includes(status);
  const awaitingAssets = (creation) => creationStatus(creation) === 'awaiting-assets' || creation?.assetStatus === 'awaiting-assets';
  const finalizable = (status) => ['ready', 'generated', 'clips-complete', 'clips_complete', 'ready-to-finalize', 'ready_to_finalize', 'awaiting-finalize', 'awaiting_finalize', 'needs-finalize'].includes(status);

  const openCreation = async (id) => {
    if (!id) return;
    try {
      const cached = state.creations.find((item) => creationId(item) === id);
      const creation = cached ?? unwrapCreation(await api(`/api/creations/${encodeURIComponent(id)}`));
      state.current = creation;
      state.currentId = id;
      elements['script-input'].value = String(creation.script || '');
      elements['script-input'].dispatchEvent(new Event('input'));
      setView('new');
      const status = creationStatus(creation);
      if (awaitingAssets(creation)) renderFailure({...creation, error: 'PAPER_COLLAGE_ASSET_PROJECT_REQUIRED'});
      else if (successful(status)) renderResult(creation);
      else if (failed(status)) renderFailure(creation);
      else watchCreation(creation);
    } catch (error) {
      showToast(`无法打开作品：${error.message}`);
    }
  };

  const finalizeCreation = async (id) => {
    if (!id || state.finalizeRequested.has(id)) return;
    state.finalizeRequested.add(id);
    try {
      const response = await api(`/api/creations/${encodeURIComponent(id)}/finalize`, {method: 'POST', body: JSON.stringify({})});
      const creation = unwrapCreation(response);
      if (creationId(creation)) state.current = creation;
    } catch (error) {
      state.finalizeRequested.delete(id);
      throw error;
    }
  };

  const readCurrentCreation = async () => {
    if (!state.currentId) return null;
    try {
      return unwrapCreation(await api(`/api/creations/${encodeURIComponent(state.currentId)}`));
    } catch (error) {
      const creations = await loadCreations({quiet: true});
      const found = creations.find((item) => creationId(item) === state.currentId);
      if (found) return found;
      throw error;
    }
  };

  const pollCurrent = async () => {
    if (!state.currentId) return;
    try {
      const creation = await readCurrentCreation();
      if (!creation) return;
      state.current = creation;
      const status = creationStatus(creation);
      const index = state.creations.findIndex((item) => creationId(item) === state.currentId);
      if (index >= 0) state.creations[index] = creation;
      else state.creations.unshift(creation);
      renderWorks();

      if (awaitingAssets(creation)) {
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
        if (state.visibleMode === 'progress') renderFailure({...creation, error: 'PAPER_COLLAGE_ASSET_PROJECT_REQUIRED'});
        return;
      }

      if (successful(status)) {
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
        if (state.visibleMode === 'progress') renderResult(creation);
        else showToast('视频已生成完成，可在作品中查看');
        return;
      }
      if (failed(status)) {
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
        if (state.visibleMode === 'progress') renderFailure(creation);
        else showToast('视频生成未完成，请打开作品查看');
        return;
      }
      if (finalizable(status)) await finalizeCreation(state.currentId);
      if (state.visibleMode === 'progress') renderProgress(creation);
    } catch (error) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
      if (state.visibleMode === 'progress') renderFailure({error: error.message});
      else showToast(`读取生成进度失败：${error.message}`);
    }
  };

  const watchCreation = (creation) => {
    window.clearInterval(state.pollTimer);
    state.current = creation;
    state.currentId = creationId(creation);
    if (!state.currentId) throw new Error('服务未返回创作任务编号。');
    if (awaitingAssets(creation)) {
      renderFailure({...creation, error: 'PAPER_COLLAGE_ASSET_PROJECT_REQUIRED'});
      return;
    }
    setCreationMode('progress');
    renderProgress(creation);
    state.pollTimer = window.setInterval(() => { void pollCurrent(); }, 2_000);
    void pollCurrent();
  };

  const selectedPlatform = () => document.querySelector('input[name="platform"]:checked')?.value || 'douyin';

  const validateScript = () => {
    const value = elements['script-input'].value.trim();
    const field = elements['script-input'].closest('.script-field');
    const message = !value ? '先写下一句文案，再开始生成。' : value.length < 2 ? '再多写一点，让模型知道主角在做什么。' : '';
    elements['script-error'].textContent = message;
    field.dataset.invalid = message ? 'true' : 'false';
    elements['script-input'].setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) elements['script-input'].focus();
    return message ? null : value;
  };

  const createVideo = async () => {
    const script = validateScript();
    if (!script) return;
    elements['generate-button'].disabled = true;
    elements['generate-button'].dataset.busy = 'true';
    try {
      const payload = {
        script,
        platform: selectedPlatform(),
        durationSeconds: state.settings.durationSeconds,
        voice: state.settings.voice,
      };
      const response = await api('/api/creations', {method: 'POST', body: JSON.stringify(payload)});
      const creation = unwrapCreation(response);
      watchCreation({...payload, ...creation});
    } catch (error) {
      elements['script-error'].textContent = error.message;
      elements['script-input'].closest('.script-field').dataset.invalid = 'true';
      showToast(`无法开始生成：${error.message}`);
    } finally {
      elements['generate-button'].disabled = false;
      elements['generate-button'].dataset.busy = 'false';
    }
  };

  const loadEngineeringState = async () => {
    elements['runtime-detail'].textContent = '正在读取本地工程与任务队列……';
    try {
      const [projectsPayload, jobsPayload] = await Promise.all([api('/api/projects'), api('/api/jobs')]);
      const projects = projectsPayload.projects || [];
      const jobs = jobsPayload.jobs || [];
      const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
      elements['project-count'].textContent = String(projects.length);
      elements['job-count'].textContent = String(activeJobs.length);
      elements['runtime-detail'].textContent = projects.length
        ? '本地模型链路已连接。工程级审片与候选控制保留在此处。'
        : '链路已连接，当前没有旧工程项目。';
      elements['engineering-list'].innerHTML = projects.slice(0, 5).map((project) => `
        <div class="engineering-item"><span>${escapeHtml(project.title || project.projectId)}</span><span>${escapeHtml(project.projectId)}</span></div>`).join('');
      elements['engineering-list'].dataset.projectId = projects[0]?.projectId || '';
    } catch (error) {
      elements['runtime-detail'].textContent = `工程控制台暂不可用：${error.message}`;
    }
  };

  const openSettings = () => {
    elements['duration-input'].value = String(state.settings.durationSeconds);
    elements['duration-output'].textContent = String(state.settings.durationSeconds);
    elements['voice-input'].checked = state.settings.voice;
    elements['settings-dialog'].showModal();
    void loadEngineeringState();
  };

  elements['creation-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    void createVideo();
  });
  elements['script-input'].addEventListener('input', () => {
    elements['character-count'].textContent = `${elements['script-input'].value.length} / 300`;
    if (elements['script-error'].textContent) validateScript();
  });
  elements['script-input'].addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void createVideo();
    }
  });
  elements['script-file'].addEventListener('change', async () => {
    const file = elements['script-file'].files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      showToast('文案文件不能超过 1 MB');
      elements['script-file'].value = '';
      return;
    }
    try {
      const text = (await file.text()).trim().slice(0, 300);
      elements['script-input'].value = text;
      elements['script-input'].dispatchEvent(new Event('input'));
      elements['script-input'].focus();
      showToast('文案已导入');
    } catch (error) {
      showToast(`读取文案失败：${error.message}`);
    }
    elements['script-file'].value = '';
  });

  document.addEventListener('click', (event) => {
    const work = event.target.closest('[data-open-creation]');
    if (work) {
      void openCreation(work.dataset.openCreation);
      return;
    }
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.view) setView(target.dataset.view);
  });
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); setView('new'); });
  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('edit-quick-settings').addEventListener('click', openSettings);
  elements['duration-input'].addEventListener('input', () => { elements['duration-output'].textContent = elements['duration-input'].value; });
  elements['settings-dialog'].addEventListener('close', () => {
    if (elements['settings-dialog'].returnValue !== 'default') return;
    state.settings.durationSeconds = Number(elements['duration-input'].value);
    state.settings.voice = elements['voice-input'].checked;
    elements['duration-summary'].textContent = String(state.settings.durationSeconds);
    elements['voice-summary'].textContent = state.settings.voice ? '自动配音' : '不配音';
    showToast('视频设置已保存');
  });
  document.getElementById('detect-runtime').addEventListener('click', async () => {
    const projectId = elements['engineering-list'].dataset.projectId;
    if (!projectId) {
      await loadEngineeringState();
      return;
    }
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/detect`, {method: 'POST', body: JSON.stringify({})});
      elements['runtime-detail'].textContent = '模型检测已加入本地任务队列。';
      showToast('模型检测已开始');
    } catch (error) {
      elements['runtime-detail'].textContent = `模型检测失败：${error.message}`;
    }
  });
  document.getElementById('leave-progress').addEventListener('click', () => setCreationMode('compose'));
  document.getElementById('create-another').addEventListener('click', () => {
    state.current = null;
    state.currentId = null;
    elements['script-input'].value = '';
    elements['script-input'].dispatchEvent(new Event('input'));
    setCreationMode('compose');
    elements['script-input'].focus();
  });
  document.getElementById('back-to-script').addEventListener('click', () => {
    setCreationMode('compose');
    elements['script-input'].focus();
  });
  document.getElementById('retry-creation').addEventListener('click', async () => {
    if (!state.currentId) {
      await createVideo();
      return;
    }
    try {
      if (awaitingAssets(state.current)) {
        const refreshed = await readCurrentCreation();
        if (!refreshed || awaitingAssets(refreshed)) {
          showToast('纸片资产还没有附加，请先回到 Codex 对话继续');
          return;
        }
        watchCreation(refreshed);
        return;
      }
      const response = await api(`/api/creations/${encodeURIComponent(state.currentId)}/retry`, {method: 'POST', body: JSON.stringify({})});
      const creation = unwrapCreation(response);
      watchCreation({...state.current, ...creation});
    } catch (error) {
      elements['failure-message'].textContent = `重试失败：${error.message}`;
    }
  });
  elements['copy-asset-request'].addEventListener('click', async () => {
    if (!state.currentId) return;
    const prompt = `请继续 Gen Video Tool 创作任务 ${state.currentId}：根据已保存文案，用 Imagegen 生成完整角色、环境、道具和前景纸片，制作纯 layered-collage v3 资产包；先调用 gen_video_inspect_collage_assets，再调用 gen_video_attach_collage_assets。不要使用 FastWan 生成人物，不要拆肢，不加 BGM，不烧录字幕。`;
    try {
      await navigator.clipboard.writeText(prompt);
      showToast('已复制纸片资产生成指令，请粘贴回 Codex 对话');
    } catch (error) {
      showToast(`复制失败：${error.message}`);
    }
  });

  const initialView = window.location.hash === '#works' ? 'works' : 'new';
  setView(initialView);
  setCreationMode('compose');
  loadCreations({quiet: true}).catch((error) => {
    setConnection('error', '本地模型未连接');
    elements['recent-works'].innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    elements['works-library'].innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    showToast(`加载失败：${error.message}`);
  });
  window.setInterval(() => {
    if (!document.hidden && !state.pollTimer) void loadCreations({quiet: true}).catch(() => undefined);
  }, 10_000);
})();
