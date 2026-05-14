/* Main app controller — view routing, state, all event wiring. */
(function () {
  const STORE_KEY = 'pptApp.state.v1';   // legacy localStorage key (migrated from)
  const IDB_KEY = 'state';                // IndexedDB key

  let state = { ppts: [], lastPptId: null };
  let currentView = 'home';
  let currentPptId = null;
  let currentSlideIdx = 0;     // 0-based index into current ppt's slides array
  let aiHistory = [];          // [{role, content}]
  let basicSelectedTag = null; // {text, note} of selected tag in basic quiz
  let mindmapSeedTags = [];    // [{pptId, text, slideIndex}] 多选种子标签

  /* ----------------- State (IndexedDB-backed) ----------------- */
  async function loadState() {
    // 1. Try IndexedDB
    try {
      const s = await IDB.get(IDB_KEY);
      if (s && Array.isArray(s.ppts)) return s;
    } catch (_) {}
    // 2. Migrate any legacy localStorage state on first run
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.ppts)) {
          await IDB.set(IDB_KEY, parsed);
          localStorage.removeItem(STORE_KEY);
          return parsed;
        }
      }
    } catch (_) {}
    return { ppts: [], lastPptId: null };
  }

  let saveTimer = null;
  function saveState() {
    // Debounce + fire-and-forget. IndexedDB is async, but we don't want
    // every UI tick to await — schedule a write 150ms later, coalescing
    // bursts (e.g. selecting/deleting multiple tags in a row).
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await IDB.set(IDB_KEY, state);
      } catch (e) {
        console.error('saveState failed:', e);
        toast('保存失败：' + (e.message || e) + ' — 数据仍在内存中，刷新可能丢失');
      }
    }, 150);
  }

  function currentPpt() {
    return state.ppts.find(p => p.id === currentPptId) || null;
  }

  function currentSlide() {
    const ppt = currentPpt();
    if (!ppt || !ppt.slides.length) return null;
    if (currentSlideIdx < 0) currentSlideIdx = 0;
    if (currentSlideIdx >= ppt.slides.length) currentSlideIdx = ppt.slides.length - 1;
    return ppt.slides[currentSlideIdx];
  }

  /* ----------------- View routing ----------------- */
  function showView(name) {
    if (name !== 'home' && !currentPpt()) {
      // need a PPT first
      if (!state.ppts.length) {
        toast('请先上传笔记');
        name = 'home';
      } else if (!currentPptId) {
        currentPptId = state.ppts[0].id;
        state.lastPptId = currentPptId;
        saveState();
      }
    }
    currentView = name;
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('view-' + name).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    document.getElementById('currentPptName').textContent =
      currentPpt() ? '当前：' + currentPpt().name : '';
    if (name === 'home') renderHome();
    if (name === 'viewer') renderViewer();
    if (name === 'mindmap') renderMindmap();
    if (name === 'quiz') renderQuizPicker();
  }

  /* ----------------- Toast ----------------- */
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  /* ============================================================
   * HOME VIEW
   * ============================================================ */
  function renderHome() {
    const sel = document.getElementById('pptSelector');
    sel.innerHTML = '<option value="">— 未选择 —</option>' +
      state.ppts.map(p => `<option value="${p.id}" ${p.id === currentPptId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

    const list = document.getElementById('pptList');
    const empty = document.getElementById('pptListEmpty');
    if (!state.ppts.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      const cnt = document.getElementById('pptCount');
      if (cnt) cnt.textContent = state.ppts.length + ' 个 PPT';
      list.innerHTML = state.ppts.map(p => {
        const tagCount = p.slides.reduce((a, s) => a + (s.tags?.length || 0), 0);
        const errCount = p.slides.reduce((a, s) => a + (s.errorPoints?.length || 0), 0);
        return `
        <div class="ppt-card ${p.id === currentPptId ? 'selected' : ''}" data-id="${p.id}">
          <div class="flex items-start gap-2">
            <div class="text-2xl">📄</div>
            <div class="flex-1 min-w-0">
              <div class="font-semibold truncate text-slate-900" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
              <div class="text-xs text-slate-400 mt-0.5">${new Date(p.createdAt).toLocaleDateString()}</div>
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-3">
            <span class="text-xs px-2 py-0.5 rounded-md bg-slate-100 text-slate-600">${p.slides.length} 页</span>
            <span class="text-xs px-2 py-0.5 rounded-md bg-brand-50 text-brand-700">${tagCount} 标签</span>
            <span class="text-xs px-2 py-0.5 rounded-md bg-amber-50 text-amber-700">${errCount} 易错</span>
          </div>
          <div class="mt-3 flex gap-2 text-xs">
            <button class="px-3 py-1 rounded-md bg-brand-600 text-white hover:bg-brand-700 act-open transition">打开</button>
            <button class="ml-auto px-3 py-1 rounded-md text-rose-600 hover:bg-rose-50 act-del transition">删除</button>
          </div>
        </div>`;
      }).join('');
      list.querySelectorAll('.ppt-card').forEach(card => {
        const id = card.dataset.id;
        card.addEventListener('click', (e) => {
          if (e.target.classList.contains('act-del')) {
            if (confirm('删除这份笔记及其全部标签 / 易错点 / 课堂记录？')) {
              state.ppts = state.ppts.filter(p => p.id !== id);
              if (currentPptId === id) {
                currentPptId = state.ppts[0]?.id || null;
                state.lastPptId = currentPptId;
              }
              saveState();
              renderHome();
            }
            return;
          }
          // 点卡片任意位置（含"打开"按钮）→ 选中并直接进笔记界面
          currentPptId = id;
          state.lastPptId = id;
          currentSlideIdx = 0;
          saveState();
          showView('viewer');
        });
      });
    }
  }

  /* ----------- Upload ----------- */
  function setupUpload() {
    const drop = document.getElementById('dropZone');
    const input = document.getElementById('fileInput');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('dragging');
      const files = Array.from(e.dataTransfer.files || []);
      await handleFiles(files);
    });
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      await handleFiles(files);
      input.value = '';
    });
  }

  async function handleFiles(files) {
    if (!files.length) return;
    const status = document.getElementById('uploadStatus');
    const pptxFiles = files.filter(f => /\.pptx$/i.test(f.name));
    const pdfFiles  = files.filter(f => /\.pdf$/i.test(f.name));
    const imgFiles  = files.filter(f => f.type.startsWith('image/'));

    try {
      for (const f of pptxFiles) {
        status.innerHTML = '<span class="spinner"></span> 解析 ' + escapeHtml(f.name) + ' …';
        const ppt = await PPTParser.parsePptx(f);
        state.ppts.push(ppt);
        currentPptId = ppt.id;
        state.lastPptId = ppt.id;
      }
      for (const f of pdfFiles) {
        status.innerHTML = '<span class="spinner"></span> 渲染 PDF ' + escapeHtml(f.name) + ' …';
        const ppt = await PPTParser.parsePdf(f);
        state.ppts.push(ppt);
        currentPptId = ppt.id;
        state.lastPptId = ppt.id;
      }
      if (imgFiles.length) {
        status.innerHTML = '<span class="spinner"></span> 处理 ' + imgFiles.length + ' 张图片 …';
        const ppt = await PPTParser.buildFromImages(imgFiles);
        state.ppts.push(ppt);
        currentPptId = ppt.id;
        state.lastPptId = ppt.id;
      }
      saveState();
      status.textContent = '✅ 已添加。';
      renderHome();
    } catch (e) {
      console.error(e);
      status.textContent = '❌ 失败：' + e.message;
    }
  }

  /* ============================================================
   * VIEWER (Interface 1)
   * ============================================================ */
  function renderViewer() {
    const ppt = currentPpt();
    const area = document.getElementById('slideArea');
    const ind = document.getElementById('slideIndicator');
    const tagList = document.getElementById('tagList');
    const errList = document.getElementById('errList');

    if (!ppt || !ppt.slides.length) {
      area.innerHTML = '<div class="text-slate-400 text-sm">未选择笔记，或该笔记没有内容页。</div>';
      ind.textContent = '';
      tagList.innerHTML = '';
      errList.innerHTML = '';
      const ta = document.getElementById('notesArea');
      if (ta) ta.value = '';
      return;
    }
    const slide = currentSlide();
    ind.textContent = `第 ${currentSlideIdx + 1} / ${ppt.slides.length} 页`;
    area.innerHTML = renderSlideHtml(slide);

    // Tags
    if (!slide.tags?.length) {
      tagList.innerHTML = '<div class="text-xs text-slate-400">这一页还没有标签。选中文本生成，或手写一个。</div>';
    } else {
      tagList.innerHTML = slide.tags.map((t, i) => `
        <div class="tag-item">
          <div class="font-medium">${escapeHtml(t.text)}</div>
          ${t.note ? `<div class="meta">${escapeHtml(t.note)}</div>` : ''}
          <span class="del" data-i="${i}">×</span>
        </div>`).join('');
      tagList.querySelectorAll('.del').forEach(el => {
        el.addEventListener('click', () => {
          slide.tags.splice(parseInt(el.dataset.i, 10), 1);
          saveState();
          renderViewer();
        });
      });
    }

    // Error points
    if (!slide.errorPoints?.length) {
      errList.innerHTML = '<div class="text-xs text-slate-400">这一页还没有易错点。</div>';
    } else {
      errList.innerHTML = slide.errorPoints.map((e, i) => `
        <div class="err-item">${escapeHtml(e)}<span class="del" data-i="${i}">×</span></div>
      `).join('');
      errList.querySelectorAll('.del').forEach(el => {
        el.addEventListener('click', () => {
          slide.errorPoints.splice(parseInt(el.dataset.i, 10), 1);
          saveState();
          renderViewer();
        });
      });
    }

    // Notes (course memo)
    const ta = document.getElementById('notesArea');
    if (ta) ta.value = slide.notes || '';
  }

  function renderSlideHtml(slide) {
    // 优先按 blocks 顺序渲染（保留文本/图片在原位置）；
    // 老数据没有 blocks 时回落到 images + text
    let body;
    if (Array.isArray(slide.blocks) && slide.blocks.length) {
      body = slide.blocks.map((b, i) => {
        if (b.type === 'image') return `<img src="${b.dataUrl}" alt="slide image" />`;
        if (b.type === 'text')  return `<div class="text-block">${escapeHtml(b.content || '')}</div>`;
        return '';
      }).join('');
    } else {
      const imgs = (slide.images || []).map(src => `<img src="${src}" alt="slide image" />`).join('');
      body = imgs + `<div class="text">${escapeHtml(slide.text || '（此页无可提取文本）')}</div>`;
    }
    return `
      <div class="slide-block" data-slide-id="${slide.id}">
        <div class="slide-page-label">第 ${slide.index} 页</div>
        ${body}
      </div>`;
  }

  /* Selection toolbar — appears when user selects text inside slideArea */
  function setupSelectionToolbar() {
    const slideArea = document.getElementById('slideArea');
    const tb = document.getElementById('selectionToolbar');
    let lastSelection = '';

    slideArea.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 2) { tb.classList.add('hidden'); return; }
        lastSelection = text;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        tb.style.top = (rect.top + window.scrollY - 36) + 'px';
        tb.style.left = (rect.left + window.scrollX + rect.width / 2 - 90) + 'px';
        tb.classList.remove('hidden');
      }, 0);
    });
    document.addEventListener('mousedown', (e) => {
      if (!tb.contains(e.target)) tb.classList.add('hidden');
    });

    tb.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', async () => {
        const action = b.dataset.action;
        tb.classList.add('hidden');
        const slide = currentSlide();
        if (!slide) return;
        const sel = lastSelection;
        if (!sel) return;

        try {
          if (action === 'tag') {
            toast('AI 生成标签中…');
            const tags = await AI.genTagsFromSelection(sel, slide.text);
            slide.tags = slide.tags || [];
            for (const t of tags) slide.tags.push({ text: t.text, note: t.note || '' });
            saveState();
            renderViewer();
            toast('已生成 ' + tags.length + ' 个标签');
          } else if (action === 'err') {
            toast('AI 生成易错点中…');
            const eps = await AI.genErrorPoints(sel, slide.text);
            slide.errorPoints = slide.errorPoints || [];
            for (const ep of eps) slide.errorPoints.push(ep);
            saveState();
            renderViewer();
            toast('已添加 ' + eps.length + ' 条易错点');
          } else if (action === 'explain') {
            openAiPanel();
            pushAiMessage('user', '请解释：' + sel);
            const reply = await AI.explainSelection(sel, slide.text);
            pushAiMessage('assistant', reply);
          }
        } catch (e) {
          toast(e.message);
        }
      });
    });
  }

  /* Manual add tag / err */
  function setupManualAdds() {
    document.getElementById('addManualTag').addEventListener('click', () => {
      const slide = currentSlide();
      if (!slide) return;
      const text = prompt('输入标签：');
      if (!text) return;
      const note = prompt('给个简短解释（可空）：') || '';
      slide.tags = slide.tags || [];
      slide.tags.push({ text: text.trim(), note: note.trim() });
      saveState();
      renderViewer();
    });
    document.getElementById('addManualErr').addEventListener('click', () => {
      const slide = currentSlide();
      if (!slide) return;
      const text = prompt('输入易错点 / 注意事项：');
      if (!text) return;
      slide.errorPoints = slide.errorPoints || [];
      slide.errorPoints.push(text.trim());
      saveState();
      renderViewer();
    });
  }

  /* Slide nav */
  function setupSlideNav() {
    document.getElementById('prevSlide').addEventListener('click', () => {
      if (currentSlideIdx > 0) { currentSlideIdx--; renderViewer(); }
    });
    document.getElementById('nextSlide').addEventListener('click', () => {
      const ppt = currentPpt();
      if (ppt && currentSlideIdx < ppt.slides.length - 1) { currentSlideIdx++; renderViewer(); }
    });
  }

  /* 课堂记录 (textarea + 浏览器原生语音识别) */
  function setupNotesAndVoice() {
    const ta = document.getElementById('notesArea');
    const btn = document.getElementById('voiceToggle');
    const status = document.getElementById('voiceStatus');
    if (!ta || !btn) return;

    // textarea 内容写回当前 slide
    ta.addEventListener('input', () => {
      const slide = currentSlide();
      if (!slide) return;
      slide.notes = ta.value;
      saveState();
    });

    setupAudioUpload(ta, status);

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      // 当前环境不支持原生 ASR，"实时"按钮就别露脸了 —— 用户可以走📁上传
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    // 国内 Chrome 走 Google，多数情况会 network 失败 — 提前给个提示
    const ua = navigator.userAgent || '';
    const isEdge   = /Edg\//.test(ua);
    const isChrome = /Chrome\//.test(ua) && !isEdge;
    if (isChrome && !isEdge) {
      btn.title = '提示：Chrome 国内常因连不上 Google 而失败，识别失败时改用「📁 录音 / 上传」';
    }

    let rec = null;
    let listening = false;

    btn.addEventListener('click', () => {
      if (listening) { rec && rec.stop(); return; }
      const slide = currentSlide();
      if (!slide) { toast('请先选择笔记'); return; }
      status.textContent = ''; // 清掉旧错误

      rec = new SR();
      rec.lang = 'zh-CN';
      rec.continuous = true;
      rec.interimResults = true;

      let baseText = ta.value;
      if (baseText && !/\s$/.test(baseText)) baseText += '\n';

      rec.onstart = () => {
        listening = true;
        btn.textContent = '⏹ 停止';
        btn.classList.add('voice-on');
        status.textContent = '🔴 正在听… 再点按钮停止';
      };
      rec.onresult = (e) => {
        let finalAdd = '', interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalAdd += t;
          else interim += t;
        }
        if (finalAdd) {
          baseText += finalAdd;
          if (!/[。！？.?!]\s*$/.test(baseText)) baseText += '\n';
        }
        ta.value = baseText + (interim ? '【…' + interim + '】' : '');
        // 即时持久化（即使中途断电也尽量保住）
        const slideNow = currentSlide();
        if (slideNow) { slideNow.notes = baseText; saveState(); }
      };
      rec.onerror = (e) => {
        const err = e.error || '未知';
        const tips = {
          'network':              '🌐 网络错误：当前浏览器（Chrome）的语音识别走 Google 服务器，国内通常无法访问。建议改用 Edge 浏览器，或手动打字。',
          'service-not-allowed':  '🔒 服务被拒：HTTP 站点+某些浏览器不允许语音识别。请改用 Edge，或部署 HTTPS 后重试。',
          'not-allowed':          '🎤 麦克风权限被拒。请在浏览器地址栏左侧点击锁/i 图标 → 允许麦克风。',
          'audio-capture':        '🎧 找不到麦克风设备。',
          'no-speech':            '🤫 没听到说话内容（停顿太久会自动结束）。',
          'aborted':              '⏹ 已手动停止。',
          'language-not-supported': '🗣 不支持中文识别（这种情况罕见，换个浏览器试试）。',
        };
        status.innerHTML = (tips[err] || ('⚠️ 语音识别出错：' + err)) + ' <a href="#" id="voiceHelp" class="text-brand-600 underline">查看建议</a>';
        const help = document.getElementById('voiceHelp');
        if (help) help.addEventListener('click', (ev) => {
          ev.preventDefault();
          alert([
            '语音识别失败的常见原因：',
            '',
            '1. 国内 Chrome 走 Google 服务器，常常不通 → 改用 Edge 浏览器',
            '2. HTTP 站点被部分浏览器拒 → 等部署 HTTPS 再试',
            '3. 没给麦克风权限 → 地址栏锁图标里允许',
            '4. 没接麦克风',
            '',
            '当前错误代码：' + err,
            '当前 origin：'   + location.origin,
            '当前浏览器：'    + (navigator.userAgentData?.brands?.map(b => b.brand).join(', ') || navigator.userAgent.slice(0, 80)),
            '是否安全上下文：' + (window.isSecureContext ? '是 (HTTPS / localhost)' : '否 (HTTP)'),
          ].join('\n'));
        });
      };
      rec.onend = () => {
        listening = false;
        rec = null;
        btn.textContent = '🎤 语音';
        btn.classList.remove('voice-on');
        // 不清空 status —— 如果有错误信息，让用户看完
        // 收尾：擦掉 interim 占位
        ta.value = baseText;
        const slideNow = currentSlide();
        if (slideNow) { slideNow.notes = baseText; saveState(); }
      };

      try { rec.start(); }
      catch (err) {
        status.textContent = '⚠️ 启动失败：' + err.message;
        listening = false;
      }
    });
  }

  /* "📁 录音 / 上传"：用 input file 选/录音频，调 Qwen 转写 → 追加到 textarea。
   * 这条路对环境零要求：HTTP 站点能用，微信内能用，Safari/Firefox 能用，
   * 移动端 capture=microphone 会拉起系统录音 app。 */
  function setupAudioUpload(ta, status) {
    const btn = document.getElementById('audioUploadBtn');
    const inp = document.getElementById('audioFileInput');
    if (!btn || !inp) return;

    btn.addEventListener('click', () => {
      const slide = currentSlide();
      if (!slide) { toast('请先选择笔记'); return; }
      inp.value = '';
      inp.click();
    });

    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      const slide = currentSlide();
      if (!slide) return;

      // 大小护栏：base64 化后约 1.35× 增长，超过 10MB 警告
      const sizeMB = file.size / 1024 / 1024;
      if (sizeMB > 15) {
        if (!confirm(`音频文件较大（${sizeMB.toFixed(1)} MB），AI 调用可能慢且耗 token，确认继续？`)) return;
      }

      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = '⏳ 转写中…';
      status.innerHTML = '<span class="spinner"></span> 上传给 AI 转写中…';

      try {
        const text = await AI.transcribeAudio(file);
        if (!text) throw new Error('AI 没返回文字');
        // 追加到 textarea：原内容尾部 + 换行 + 转写结果
        let base = ta.value;
        if (base && !/\n$/.test(base)) base += '\n';
        ta.value = base + text;
        slide.notes = ta.value;
        saveState();
        status.textContent = '✅ 转写完成（' + text.length + ' 字）';
      } catch (e) {
        status.textContent = '❌ ' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    });
  }

  /* ============================================================
   * MINDMAP (Interface 2)
   * ============================================================ */
  function renderMindmap() {
    const overview = document.getElementById('tagOverview');
    if (!state.ppts.length) {
      overview.innerHTML = '<div class="text-sm text-slate-400">还没有笔记。</div>';
      return;
    }
    overview.innerHTML = state.ppts.map(p => {
      const allTags = [];
      p.slides.forEach(s => (s.tags || []).forEach(t => allTags.push({ ...t, slideIndex: s.index })));
      const inner = allTags.length
        ? allTags.map((t, i) => {
            const sel = isSeedSelected(p.id, t.text, t.slideIndex) ? ' selected' : '';
            return `<span class="tag-chip${sel}" data-ppt="${p.id}" data-slide="${t.slideIndex}" data-tag="${escapeHtml(t.text)}" title="第${t.slideIndex}页 · 点击多选">${escapeHtml(t.text)}</span>`;
          }).join('')
        : '<span class="text-xs text-slate-400">（无标签）</span>';
      return `
        <div class="border border-slate-200 rounded-lg p-3 ${p.id === currentPptId ? 'bg-indigo-50/40' : ''}">
          <div class="font-semibold text-sm mb-2">${escapeHtml(p.name)} <span class="text-xs text-slate-400">(${allTags.length})</span></div>
          <div class="flex flex-wrap gap-1">${inner}</div>
        </div>`;
    }).join('');

    overview.querySelectorAll('.tag-chip').forEach(el => {
      el.addEventListener('click', () => {
        toggleSeed({
          pptId: el.dataset.ppt,
          text: el.dataset.tag,
          slideIndex: parseInt(el.dataset.slide, 10) || 1,
        });
      });
    });

    updateSeedSummary();
  }

  function isSeedSelected(pptId, text, slideIndex) {
    return mindmapSeedTags.some(s =>
      s.pptId === pptId && s.text === text && s.slideIndex === slideIndex);
  }

  function toggleSeed(tag) {
    const i = mindmapSeedTags.findIndex(s =>
      s.pptId === tag.pptId && s.text === tag.text && s.slideIndex === tag.slideIndex);
    if (i >= 0) mindmapSeedTags.splice(i, 1);
    else        mindmapSeedTags.push(tag);
    renderMindmap();
  }

  function updateSeedSummary() {
    const cnt = document.getElementById('seedCount');
    const sum = document.getElementById('seedSummary');
    const btn = document.getElementById('genMindmap');
    if (!cnt || !sum || !btn) return;
    btn.disabled = mindmapSeedTags.length === 0;
    if (!mindmapSeedTags.length) {
      cnt.textContent = '';
      sum.innerHTML = '<span class="text-slate-400">尚未选中任何标签</span>';
      return;
    }
    cnt.textContent = `已选 ${mindmapSeedTags.length} 个`;
    sum.innerHTML = '已选标签：' + mindmapSeedTags.map(s =>
      `<span class="tag-chip selected" data-remove="${escapeHtml(s.pptId)}|${escapeHtml(s.text)}|${s.slideIndex}">${escapeHtml(s.text)} <span class="text-[10px] opacity-60">P${s.slideIndex}</span> ×</span>`
    ).join('');
    sum.querySelectorAll('[data-remove]').forEach(el => {
      el.addEventListener('click', () => {
        const [pptId, text, slideIndex] = el.dataset.remove.split('|');
        toggleSeed({ pptId, text, slideIndex: parseInt(slideIndex, 10) });
      });
    });
  }

  async function generateMindmap() {
    const area = document.getElementById('mindmapArea');
    if (!mindmapSeedTags.length) { toast('请先在左侧选择至少一个标签'); return; }

    // 把选中的多个标签按所属 PPT 分组（多数情况是同一 PPT，但允许跨 PPT）
    const pptIds = Array.from(new Set(mindmapSeedTags.map(s => s.pptId)));
    const pptList = pptIds.map(id => state.ppts.find(p => p.id === id)).filter(Boolean);

    // 跨标签的"全部上下文标签"（用于 AI 知道有哪些已存在标签可以挂在树里）
    const ctxTags = [];
    pptList.forEach(p => p.slides.forEach(s => (s.tags || []).forEach(t => {
      ctxTags.push({ ...t, slideIndex: s.index, pptId: p.id, pptName: p.name });
    })));

    const themeName = pptList.length === 1 ? pptList[0].name : '多 PPT 综合';

    area.innerHTML = `<div class="text-sm text-slate-500 mb-3">基于 ${mindmapSeedTags.length} 个种子标签生成中… <span class="spinner"></span></div>`;
    try {
      const tree = await AI.genMindmap(themeName, ctxTags, mindmapSeedTags);
      area.innerHTML =
        `<div class="text-xs text-slate-500 mb-3">点击带颜色的节点可跳转到对应笔记页面</div>` +
        renderMindmapTree(tree, ctxTags);
      area.querySelectorAll('.mindmap-node[data-tag]').forEach(el => {
        el.addEventListener('click', () => {
          const tagText = el.dataset.tag;
          // 跳到该标签所在的 PPT + 页（优先匹配 currentPptId 的同名标签）
          let t = ctxTags.find(x => x.text === tagText && x.pptId === currentPptId);
          if (!t) t = ctxTags.find(x => x.text === tagText);
          if (t) {
            currentPptId = t.pptId;
            state.lastPptId = t.pptId;
            currentSlideIdx = (t.slideIndex || 1) - 1;
            saveState();
            showView('viewer');
          }
        });
      });
    } catch (e) {
      area.innerHTML = '<div class="text-rose-600 text-sm">' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderMindmapTree(tree, allTags) {
    function nodeHtml(node, depth) {
      const cls = depth === 0 ? 'mindmap-node root' : 'mindmap-node';
      const tagAttr = node.tag ? ` data-tag="${escapeHtml(node.tag)}"` : '';
      const title = node.tag ? ` title="点击跳转到第${(allTags.find(t => t.text === node.tag)?.slideIndex || '?')}页"` : '';
      const head = `<div class="mindmap-row"><span class="${cls}"${tagAttr}${title}>${escapeHtml(node.name || node.root)}</span></div>`;
      const kids = (node.children || []).map(c => nodeHtml(c, depth + 1)).join('');
      return head + (kids ? `<div class="mindmap-tree">${kids}</div>` : '');
    }
    const root = { name: tree.root, children: tree.children || [] };
    return nodeHtml(root, 0);
  }

  /* ============================================================
   * QUIZ (Interface 3)
   * ============================================================ */
  function renderQuizPicker() {
    document.getElementById('quizPicker').classList.remove('hidden');
    document.getElementById('quizBasic').classList.add('hidden');
    document.getElementById('quizAdvanced').classList.add('hidden');
  }
  function showQuizMode(mode) {
    document.getElementById('quizPicker').classList.add('hidden');
    if (mode === 'basic') {
      document.getElementById('quizBasic').classList.remove('hidden');
      document.getElementById('quizAdvanced').classList.add('hidden');
      renderBasicTagPicker();
    } else {
      document.getElementById('quizAdvanced').classList.remove('hidden');
      document.getElementById('quizBasic').classList.add('hidden');
      document.getElementById('advancedQuestionArea').innerHTML = '';
    }
  }

  function renderBasicTagPicker() {
    const ppt = currentPpt();
    const list = document.getElementById('basicTagList');
    const btn = document.getElementById('basicGenerate');
    document.getElementById('basicQuestionArea').innerHTML = '';
    basicSelectedTag = null;
    btn.disabled = true;

    if (!ppt) { list.innerHTML = '<span class="text-sm text-slate-400">请先选择笔记。</span>'; return; }
    const tags = [];
    ppt.slides.forEach(s => (s.tags || []).forEach(t => tags.push({ ...t, slideIndex: s.index })));
    if (!tags.length) { list.innerHTML = '<span class="text-sm text-slate-400">该笔记没有标签，先去笔记界面生成。</span>'; return; }

    list.innerHTML = tags.map((t, i) => `<span class="tag-chip" data-i="${i}" title="第${t.slideIndex}页">${escapeHtml(t.text)}</span>`).join('');
    list.querySelectorAll('.tag-chip').forEach(el => {
      el.addEventListener('click', () => {
        list.querySelectorAll('.tag-chip').forEach(x => x.classList.remove('selected'));
        el.classList.add('selected');
        basicSelectedTag = tags[parseInt(el.dataset.i, 10)];
        btn.disabled = false;
      });
    });
  }

  async function generateBasicQuestion() {
    const ppt = currentPpt();
    if (!ppt || !basicSelectedTag) return;
    const slide = ppt.slides.find(s => s.index === basicSelectedTag.slideIndex);
    const area = document.getElementById('basicQuestionArea');
    area.innerHTML = '<span class="spinner"></span> AI 出题中…';
    try {
      const q = await AI.genQuestionForTag(basicSelectedTag, slide?.text || '');
      area.innerHTML = renderQuestion(q, []);
      bindQuestionInteractions(area, ppt);
    } catch (e) {
      area.innerHTML = '<div class="text-rose-600 text-sm">' + escapeHtml(e.message) + '</div>';
    }
  }

  async function generateAdvancedQuestion() {
    const ppt = currentPpt();
    if (!ppt) { toast('请先选择笔记'); return; }
    const area = document.getElementById('advancedQuestionArea');
    area.innerHTML = '<span class="spinner"></span> AI 识别知识点并出题中…';
    try {
      const q = await AI.genRandomQuestion(ppt);
      area.innerHTML = renderQuestion(q, q.tags || []);
      bindQuestionInteractions(area, ppt);
    } catch (e) {
      area.innerHTML = '<div class="text-rose-600 text-sm">' + escapeHtml(e.message) + '</div>';
    }
  }

  /* 给已渲染的 question-card 容器绑事件：显示答案 + 知识点跳转。
   * 答案和"涉及知识点"块都默认 hidden，点一次按钮一起出来。 */
  function bindQuestionInteractions(area, ppt) {
    area.querySelectorAll('[data-toggle-answer]').forEach(el => {
      el.addEventListener('click', () => {
        const ans  = area.querySelector('.answer-box');
        const tags = area.querySelector('.answer-tags');
        const hide = ans && !ans.classList.contains('hidden');
        if (ans)  ans.classList.toggle('hidden',  hide);
        if (tags) tags.classList.toggle('hidden', hide);
        el.textContent = hide ? '👀 显示答案' : '🙈 隐藏答案';
      });
    });
    area.querySelectorAll('[data-jump-slide]').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.jumpSlide, 10);
        if (ppt && idx > 0 && idx <= ppt.slides.length) {
          currentSlideIdx = idx - 1;
          showView('viewer');
        }
      });
    });
  }

  function renderQuestion(q, tags) {
    const tagLine = (tags && tags.length)
      ? `<div class="answer-tags hidden mt-4 pt-4 border-t border-brand-100/60"><div class="text-xs text-slate-500 mb-2 font-medium">涉及知识点（点击跳转到来源页）</div><div class="flex flex-wrap gap-1.5">${tags.map(t => `<span class="tag-chip" data-jump-slide="${parseInt(t.slideIndex, 10) || 1}" title="跳转到第${t.slideIndex}页">${escapeHtml(t.text)} <span class="text-[10px] opacity-60">P${t.slideIndex}</span></span>`).join('')}</div></div>`
      : '';
    return `
      <div class="question-card">
        <div class="label">📌 题目</div>
        <div class="question-text">${escapeHtml(q.question || '')}</div>
        <button class="btn-ghost mt-4 text-sm" data-toggle-answer>👀 显示答案</button>
        <div class="answer-box hidden"><span class="answer-box-content">${escapeHtml(q.answer || '')}</span></div>
        ${tagLine}
      </div>`;
  }

  /* ============================================================
   * AI Floating Panel
   * ============================================================ */
  function openAiPanel() {
    document.getElementById('aiPanel').classList.remove('hidden');
    setTimeout(() => document.getElementById('aiInput').focus(), 50);
  }
  function closeAiPanel() {
    document.getElementById('aiPanel').classList.add('hidden');
  }
  function pushAiMessage(role, content) {
    aiHistory.push({ role, content });
    const box = document.getElementById('aiHistory');
    const div = document.createElement('div');
    div.className = role === 'user' ? 'ai-msg-user' : 'ai-msg-ai';
    div.textContent = content;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }
  async function sendAi() {
    const input = document.getElementById('aiInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    pushAiMessage('user', text);
    const slide = currentSlide();
    const ppt = currentPpt();
    let context = '';
    if (slide) context += `当前第${slide.index}页文本：\n${slide.text}\n`;
    if (ppt && currentView !== 'viewer') {
      context += `\n笔记全部页面摘要：\n` + ppt.slides.map(s => `第${s.index}页：${(s.text || '').slice(0, 200)}`).join('\n');
    }
    const placeholder = document.createElement('div');
    placeholder.className = 'ai-msg-ai';
    placeholder.innerHTML = '<span class="spinner"></span> 思考中…';
    document.getElementById('aiHistory').appendChild(placeholder);
    try {
      const reply = await AI.freeChat(aiHistory, context);
      placeholder.remove();
      pushAiMessage('assistant', reply);
    } catch (e) {
      placeholder.remove();
      pushAiMessage('assistant', '出错：' + e.message);
    }
  }

  /* ============================================================
   * Settings
   * ============================================================ */
  function openSettings() {
    const s = AI.getSettings();
    populateProviderControls();
    document.getElementById('aiProvider').value = s.provider || 'doubao';
    document.getElementById('aiEndpoint').value = s.endpoint || '';
    document.getElementById('aiKey').value = s.apiKey || '';
    document.getElementById('aiModel').value = s.model || '';
    document.getElementById('settingsMsg').textContent = '';
    document.getElementById('settingsModal').classList.remove('hidden');
    applyProviderUI(s.provider || 'doubao');
    refreshStorageInfo();
  }

  function populateProviderControls() {
    const sel = document.getElementById('aiProvider');
    const chips = document.getElementById('providerChips');
    if (sel.options.length) return;  // already populated
    const presets = AI.PRESETS;
    sel.innerHTML = Object.entries(presets).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
    chips.innerHTML = Object.entries(presets).map(([k, v]) => {
      return `<button type="button" class="provider-chip" data-provider="${k}">${escapeHtml(v.name.split(' ')[0])}</button>`;
    }).join('');
    chips.querySelectorAll('.provider-chip').forEach(b => {
      b.addEventListener('click', () => {
        const k = b.dataset.provider;
        sel.value = k;
        applyProviderUI(k);
      });
    });
    sel.addEventListener('change', () => applyProviderUI(sel.value));
  }

  function applyProviderUI(key) {
    const preset = AI.PRESETS[key] || AI.PRESETS.custom;
    const epField = document.getElementById('aiEndpoint');
    const modelField = document.getElementById('aiModel');
    const link = document.getElementById('providerKeyLink');
    const hint = document.getElementById('modelHint');
    const chips = document.getElementById('modelChips');

    // Auto-fill endpoint if user hasn't entered something for a different host
    if (preset.endpoint && (!epField.value.trim() || isPresetEndpoint(epField.value))) {
      epField.value = preset.endpoint;
    }
    epField.placeholder = preset.endpoint || 'https://...';
    modelField.placeholder = preset.modelHint || '模型名';
    hint.textContent = preset.modelHint ? '提示：' + preset.modelHint : '';

    if (preset.keyUrl) {
      link.href = preset.keyUrl;
      link.classList.remove('hidden');
    } else {
      link.classList.add('hidden');
    }

    chips.innerHTML = (preset.sampleModels || []).map(m => `<button type="button" class="model-chip" data-m="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('');
    chips.querySelectorAll('.model-chip').forEach(b => {
      b.addEventListener('click', () => { modelField.value = b.dataset.m; });
    });

    // Highlight active provider chip
    document.querySelectorAll('.provider-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.provider === key);
    });
  }

  function isPresetEndpoint(url) {
    return Object.values(AI.PRESETS).some(p => p.endpoint && p.endpoint === url.trim());
  }

  async function refreshStorageInfo() {
    const el = document.getElementById('storageInfo');
    if (!el) return;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const used = (est.usage || 0) / 1024 / 1024;
        const quota = (est.quota || 0) / 1024 / 1024;
        const fmt = (n) => n >= 1024 ? (n/1024).toFixed(1) + ' GB' : n.toFixed(1) + ' MB';
        el.textContent = `已用 ${fmt(used)} / ${fmt(quota)}`;
      } else {
        el.textContent = '浏览器不支持配额查询';
      }
    } catch (_) {
      el.textContent = '配额查询失败';
    }
  }
  function closeSettings() {
    document.getElementById('settingsModal').classList.add('hidden');
  }
  function saveSettings() {
    const s = {
      provider: document.getElementById('aiProvider').value,
      endpoint: document.getElementById('aiEndpoint').value.trim(),
      apiKey: document.getElementById('aiKey').value.trim(),
      model: document.getElementById('aiModel').value.trim(),
    };
    AI.saveSettings(s);
    document.getElementById('settingsMsg').textContent = '✅ 已保存';
  }
  async function testAi() {
    saveSettings();
    const msg = document.getElementById('settingsMsg');
    msg.innerHTML = '<span class="spinner"></span> 测试中…';
    try {
      const reply = await AI.ping();
      msg.textContent = '✅ 连接正常，回复：' + reply;
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
    }
  }

  /* ============================================================
   * Util
   * ============================================================ */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ============================================================
   * Bootstrap
   * ============================================================ */
  document.addEventListener('DOMContentLoaded', async () => {
    state = await loadState();
    currentPptId = state.lastPptId || null;

    setupUpload();
    setupSelectionToolbar();
    setupManualAdds();
    setupSlideNav();
    setupNotesAndVoice();

    document.querySelectorAll('.nav-btn').forEach(b => {
      b.addEventListener('click', () => showView(b.dataset.view));
    });
    document.getElementById('navHome').addEventListener('click', () => showView('home'));
    document.getElementById('pptSelector').addEventListener('change', (e) => {
      currentPptId = e.target.value || null;
      state.lastPptId = currentPptId;
      currentSlideIdx = 0;
      saveState();
      renderHome();
    });

    document.getElementById('genMindmap').addEventListener('click', generateMindmap);
    document.getElementById('selectAllTagsCurrent').addEventListener('click', () => {
      const ppt = currentPpt();
      if (!ppt) { toast('请先选择笔记'); return; }
      mindmapSeedTags = mindmapSeedTags.filter(s => s.pptId !== ppt.id);
      ppt.slides.forEach(s => (s.tags || []).forEach(t => {
        mindmapSeedTags.push({ pptId: ppt.id, text: t.text, slideIndex: s.index });
      }));
      renderMindmap();
    });
    document.getElementById('clearSelectedTags').addEventListener('click', () => {
      mindmapSeedTags = [];
      renderMindmap();
    });

    document.querySelectorAll('.quiz-mode-btn').forEach(b => {
      b.addEventListener('click', () => showQuizMode(b.dataset.mode));
    });
    document.querySelectorAll('.back-to-picker').forEach(b => {
      b.addEventListener('click', renderQuizPicker);
    });
    document.getElementById('basicGenerate').addEventListener('click', generateBasicQuestion);
    document.getElementById('advancedGenerate').addEventListener('click', generateAdvancedQuestion);

    document.getElementById('askAiFab').addEventListener('click', openAiPanel);
    document.getElementById('closeAi').addEventListener('click', closeAiPanel);
    document.getElementById('aiSend').addEventListener('click', sendAi);
    document.getElementById('aiInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAi(); }
    });

    document.getElementById('openSettings').addEventListener('click', openSettings);
    document.getElementById('closeSettings').addEventListener('click', closeSettings);
    document.getElementById('saveSettings').addEventListener('click', saveSettings);
    document.getElementById('testAi').addEventListener('click', testAi);
    document.getElementById('resetSettings').addEventListener('click', () => {
      if (!confirm('恢复为站点预置 AI 设置 (Qwen)？这会清掉你在浏览器里保存过的自定义配置。')) return;
      AI.resetToDefault();
      const s = AI.getSettings();
      document.getElementById('aiProvider').value = s.provider;
      document.getElementById('aiEndpoint').value = s.endpoint;
      document.getElementById('aiKey').value = s.apiKey;
      document.getElementById('aiModel').value = s.model;
      applyProviderUI(s.provider);
      document.getElementById('settingsMsg').textContent = '✅ 已恢复为预置 (Qwen / qwen-plus)';
    });
    document.getElementById('clearAll').addEventListener('click', () => {
      if (confirm('清空所有笔记、标签和课堂记录？此操作不可恢复。')) {
        state.ppts = [];
        state.lastPptId = null;
        currentPptId = null;
        saveState();
        renderHome();
        toast('已清空');
      }
    });

    showView('home');

    // Friendly nudge if AI not configured
    if (!AI.isConfigured()) {
      setTimeout(() => toast('提示：先到 ⚙️ 设置中填入豆包 API Key'), 800);
    }
  });
})();
