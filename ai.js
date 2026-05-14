/* Doubao / OpenAI-compatible AI client.
 *
 * Uses chat-completions style API. By default targets Volcengine Ark (Doubao).
 *   POST <endpoint>
 *   Authorization: Bearer <key>
 *   { model, messages, temperature }
 */
window.AI = (function () {
  const LS_KEY = 'pptApp.aiSettings';

  /* Preset providers — pick one and the endpoint / model hints auto-fill. */
  const PRESETS = {
    doubao: {
      name: '豆包 (火山方舟)',
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      keyUrl: 'https://console.volcengine.com/ark',
      modelHint: '推理接入点 ID（ep-xxx）或模型名',
      sampleModels: ['doubao-1-5-pro-32k', 'doubao-1-5-lite-32k', 'doubao-seed-1-6-flash'],
    },
    qwen: {
      name: '通义千问 (阿里 DashScope)',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      keyUrl: 'https://dashscope.console.aliyun.com',
      modelHint: 'qwen-plus / qwen-max / qwen-turbo',
      sampleModels: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-235b-a22b-instruct-2507'],
    },
    deepseek: {
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/chat/completions',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      modelHint: 'deepseek-chat / deepseek-reasoner',
      sampleModels: ['deepseek-chat', 'deepseek-reasoner'],
    },
    kimi: {
      name: 'Kimi (月之暗面)',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      keyUrl: 'https://platform.moonshot.cn/console/api-keys',
      modelHint: 'moonshot-v1-32k / 128k',
      sampleModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
    },
    zhipu: {
      name: '智谱 GLM',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      keyUrl: 'https://open.bigmodel.cn',
      modelHint: 'glm-4-plus / glm-4-air',
      sampleModels: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    },
    openai: {
      name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      keyUrl: 'https://platform.openai.com/api-keys',
      modelHint: 'gpt-4o / gpt-4o-mini',
      sampleModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    },
    custom: {
      name: '自定义 (OpenAI 兼容)',
      endpoint: '',
      keyUrl: '',
      modelHint: '任意 OpenAI 兼容接口',
      sampleModels: [],
    },
  };

  /* 预置默认设置：开箱即用，用户也可在 ⚙️ 设置中自行覆盖（存 localStorage）。
   * ⚠️ Key 暴露风险：明文 Key 写在公网静态 JS 里，建议给 Key 设消费额度上限。 */
  const DEFAULT_SETTINGS = {
    provider: 'qwen',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKey: 'sk-请填入你自己的-DashScope-API-Key',
    model: 'qwen-plus',
  };

  function getSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // 用户自己完整填过就用用户的（4 个字段都得有），否则整体回落到预置，
        // 避免出现 provider=doubao 但 endpoint=qwen 之类的混合配置。
        if (parsed && parsed.apiKey && parsed.endpoint && parsed.model && parsed.provider) {
          return parsed;
        }
      }
    } catch (_) {}
    return { ...DEFAULT_SETTINGS };
  }

  function resetToDefault() {
    localStorage.removeItem(LS_KEY);
  }

  function saveSettings(s) {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  }

  function isConfigured() {
    const s = getSettings();
    return !!(s.endpoint && s.apiKey && s.model);
  }

  /* 用 DashScope 原生 multimodal-generation 接口做语音转写。
   * 不走 OpenAI 兼容接口（它不支持 audio 类型），但鉴权用同一个 Bearer key。
   * 接受任意可被浏览器解码的音频 Blob（webm/wav/mp3/m4a 都行）。 */
  async function transcribeAudio(blob) {
    const s = getSettings();
    if (!s.apiKey) throw new Error('AI 未配置 API Key');
    if (s.provider !== 'qwen' && !/dashscope\.aliyuncs\.com/.test(s.endpoint || '')) {
      throw new Error('语音转写仅支持 DashScope (Qwen) 服务商。请在 ⚙️ 设置 切到 Qwen 或点"恢复默认"。');
    }
    const dataUrl = await blobToDataUrl(blob);
    const body = {
      model: 'qwen-audio-turbo-latest',
      input: {
        messages: [{
          role: 'user',
          content: [
            { audio: dataUrl },
            { text: '请将音频精确转写为简体中文文字，只返回转写内容，不要任何额外说明、不要标点说明。' },
          ],
        }],
      },
    };
    const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + s.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('转写失败 ' + res.status + ': ' + errText.slice(0, 200));
    }
    const data = await res.json();
    const arr = data?.output?.choices?.[0]?.message?.content;
    let text = '';
    if (Array.isArray(arr)) text = arr.map(x => x.text || '').join('');
    else if (typeof arr === 'string') text = arr;
    return text.trim();
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function chat(messages, opts = {}) {
    const s = getSettings();
    if (!isConfigured()) {
      throw new Error('AI 未配置：请在 ⚙️ 设置中填入 Endpoint / Key / 模型。');
    }
    const body = {
      model: s.model,
      messages,
      temperature: opts.temperature ?? 0.4,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    const res = await fetch(s.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + s.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error('AI 调用失败 ' + res.status + ': ' + errText);
    }
    const data = await res.json();
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      '';
    return String(content || '').trim();
  }

  /* ---------- Helpers that parse JSON out of AI replies ---------- */
  function extractJson(text) {
    // Strip code fences first
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1];
    text = text.trim();
    try { return JSON.parse(text); } catch (_) {}
    // Try to find first {...} or [...]
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) {}
    }
    return null;
  }

  /* ---------- Higher-level prompts ---------- */

  async function genTagsFromSelection(selection, slideText) {
    const sys = '你是一个学习辅助 AI。根据用户选中的笔记文本片段，提炼 1-3 个简短的"知识点标签"。每个标签 2-8 个字，名词为主。返回 JSON 数组：[{"text":"标签","note":"一句话解释"}]，不要其它文字。';
    const user = `所在幻灯片完整文本（参考）：\n${slideText || '（无）'}\n\n用户选中片段：\n${selection}`;
    const reply = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.3 });
    const arr = extractJson(reply);
    if (Array.isArray(arr)) return arr.filter(x => x && x.text).slice(0, 5);
    return [{ text: selection.slice(0, 12), note: reply.slice(0, 80) }];
  }

  async function genErrorPoints(selection, slideText) {
    const sys = '你是一个学习辅助 AI。根据用户选中的笔记文本，列出 1-3 条"易错点 / 注意事项"，每条 1-2 句，避免空话。返回 JSON 数组（仅字符串），不要其它文字：["条目1","条目2"]';
    const user = `所在幻灯片完整文本：\n${slideText || '（无）'}\n\n选中片段：\n${selection}`;
    const reply = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.4 });
    const arr = extractJson(reply);
    if (Array.isArray(arr)) return arr.map(String).slice(0, 5);
    return [reply];
  }

  async function explainSelection(selection, slideText) {
    const sys = '你是一个学习辅助 AI。用通俗、准确的中文解释用户选中的内容，3-6 句话。';
    const user = `所在幻灯片：\n${slideText || ''}\n\n选中：\n${selection}`;
    return chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.4 });
  }

  /* tags: array of { text, note?, slideIndex? } */
  /* 思维导图：基于"用户选中的若干种子标签"生成
   *   pptName : 主题名（多份笔记 时为综合标题）
   *   ctxTags : 上下文标签集合（让 AI 知道还有哪些已存在标签可以做为节点）
   *   seeds   : Array<tag> 用户实际选中的标签，必须出现在最终树里
   *
   * 返回： {root, children:[{name, tag, children:[...]}]}
   *   - tag 字段如果对应到上下文里某个标签，前端就给该节点开"点击跳转"
   */
  async function genMindmap(pptName, ctxTags, seeds) {
    const seedArr = Array.isArray(seeds) ? seeds : (seeds ? [seeds] : []);
    if (!seedArr.length) {
      // 兜底：用所有 ctxTags 当 seeds
      seedArr.push(...ctxTags.slice(0, 8));
    }

    const sys = '你是一个学习辅助 AI。请基于用户选中的"种子标签"生成层级思维导图：\n' +
      '- 如果只有 1 个种子，把它作为 root；如果有多个种子，用"综合主题"作为 root，每个种子作为第 1 层子节点。\n' +
      '- 每个种子下面展开 2-5 个相关知识点，每个相关知识点最多再展开 2-3 个细分点（总共最多 3 层）。\n' +
      '- 节点的 tag 字段：如果该节点的名字恰好出现在"上下文标签列表"里，就把 tag 设为该标签文本；否则 tag 为 null。\n' +
      '- 用户选中的种子节点，tag 必须填它自己。\n' +
      '返回严格的 JSON：{"root":"主题","children":[{"name":"...","tag":"...|null","children":[...]}]}。只返回 JSON，不要任何其它文字。';

    const seedListStr = seedArr.map(s => `- ${s.text}${s.note ? '（' + s.note + '）' : ''}`).join('\n');
    const ctxListStr  = ctxTags.map(t => `- ${t.text}${t.note ? '（' + t.note + '）' : ''}`).join('\n');
    const user = `主题：${pptName}\n用户选中的种子标签（必须出现在树里）：\n${seedListStr}\n\n上下文标签列表（节点名字命中这里时 tag 就填它）：\n${ctxListStr || '（无）'}`;

    const reply = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.4 });

    const obj = extractJson(reply);
    if (obj && obj.root) return obj;

    // 兜底树：root + 每个 seed 作为 children
    if (seedArr.length === 1) {
      return { root: seedArr[0].text, children: [] };
    }
    return {
      root: pptName,
      children: seedArr.map(s => ({ name: s.text, tag: s.text, children: [] })),
    };
  }

  /* Basic quiz: question for one selected tag */
  async function genQuestionForTag(tag, slideText) {
    const sys = '你是一个学习辅助 AI。根据给定的知识点标签和原文，出一道考察该知识点的题（简答或选择题任选其一）。返回 JSON：{"question":"题目","answer":"答案及简要解析"}。仅返回 JSON。';
    const user = `标签：${tag.text}${tag.note ? '\n注释：' + tag.note : ''}\n原文（来自 该页笔记）：\n${slideText || '（无）'}`;
    const reply = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.6 });
    const obj = extractJson(reply);
    if (obj && obj.question) return obj;
    return { question: reply, answer: '（AI 未返回结构化答案）' };
  }

  /* Advanced quiz: identify all knowledge points across PPT, then ask one random question with tags */
  async function genRandomQuestion(ppt) {
    const allTextParts = ppt.slides.map(s => `【第${s.index}页】\n${s.text}`).join('\n\n').slice(0, 8000);
    const sys = '你是一个学习辅助 AI。先从给定 笔记全文中识别 5-15 个知识点，然后随机选一个出一道考察题。返回 JSON：{"question":"题目","answer":"答案及简要解析","tags":[{"text":"标签名","slideIndex":页码数字}]}，tags 列出题目涉及的知识点和它们出现的页码（页码必须是数字，不要带"第"或"页"字）。仅返回 JSON。';
    const user = `笔记标题：${ppt.name}\n笔记全文：\n${allTextParts}`;
    const reply = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.7 });
    const obj = extractJson(reply);
    if (obj && obj.question) {
      obj.tags = Array.isArray(obj.tags) ? obj.tags.filter(t => t && t.text) : [];
      return obj;
    }
    return { question: reply, answer: '（AI 未返回结构化答案）', tags: [] };
  }

  /* Free-form chat with optional PPT context */
  async function freeChat(history, contextText) {
    const sys = '你是一个学习辅助 AI，主要帮助用户理解 笔记内容。回答简明准确，使用中文。' +
      (contextText ? '\n\n用户当前笔记 的相关上下文：\n' + contextText.slice(0, 4000) : '');
    const messages = [{ role: 'system', content: sys }, ...history];
    return chat(messages, { temperature: 0.5 });
  }

  async function ping() {
    const reply = await chat([
      { role: 'user', content: '只回复"OK"两个字符。' },
    ], { temperature: 0 });
    return reply;
  }

  return {
    PRESETS, DEFAULT_SETTINGS,
    getSettings, saveSettings, resetToDefault, isConfigured,
    genTagsFromSelection, genErrorPoints, explainSelection,
    genMindmap, genQuestionForTag, genRandomQuestion,
    freeChat, ping, transcribeAudio,
  };
})();
