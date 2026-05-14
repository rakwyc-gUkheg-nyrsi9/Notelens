# 学习助手

基于「制作要求.docx」实现的纯浏览器学习应用：上传课件（PPT / PDF / 图片）→ AI 自动提取知识点标签和易错点 → 一键生成思维导图 → 智能出题 + 课堂语音笔记。**无需后端服务器**，全部在浏览器运行；AI 通过 OpenAI 兼容协议调用大模型（默认接通义千问 / DashScope，可换豆包 / Kimi / DeepSeek / 智谱等）。

---

## 文件结构

```
学习助手/
├── index.html      入口页面（4 个视图 + 浮动 AI 按钮 + 设置）
├── app.js          路由 / 状态 / 事件
├── pptParser.js    .pptx & .pdf 解析（JSZip + pdf.js）
├── ai.js           AI 客户端（chat completions + 语音转写）
├── idb.js          IndexedDB 持久化封装
├── style.css       视觉样式（搭配 Tailwind CDN）
├── 制作要求.docx   原始需求文档
└── README.md
```

---

## 启动

**不需要任何构建工具或 npm install。** 两种方式任选其一：

### 方式 A：直接双击 `index.html`

最简单，但有些浏览器在 `file://` 协议下会限制 fetch / IndexedDB。如果功能异常请用方式 B。

### 方式 B（推荐）：起一个简单本地服务器

```bash
cd 学习助手/
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

任意静态文件服务器都行（`npx serve` / `live-server` / Nginx / Apache 等）。

### 方式 C：部署到任何 Web 服务器

把所有文件丢到 Nginx / IIS / 阿里云 OSS / 腾讯云 COS 静态托管 / GitHub Pages 任一处即可，**不需要服务端代码**。

---

## 首次配置 AI（必做）

打开页面后，页面右上角点 ⚙️ → 在 7 个预置服务商里选一个，按提示填好。

### 推荐：通义千问（阿里云 DashScope）

1. 服务商：选 **「通义千问 (阿里 DashScope)」**
2. **API Endpoint**：自动填好 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
3. **API Key**：去 https://dashscope.console.aliyun.com 申请，形如 `sk-xxxxxxxx`
4. **模型 / Endpoint ID**：点下方 `qwen-plus` 这个胶囊一键填入（或填 `qwen-max` / `qwen-turbo`）
5. 点 「测试连接」 → 看到 `✅ 连接正常` 即配置完成

> **课堂记录的语音转写功能**仅在 DashScope 上工作（用 Qwen-Audio 模型）。如果用其他服务商，AI 出题等功能正常，但语音转写按钮会报错。

### 也支持的其他服务商

| 服务商 | API Key 申请地址 |
|---|---|
| 豆包 (火山方舟) | https://console.volcengine.com/ark |
| DeepSeek | https://platform.deepseek.com/api_keys |
| Kimi (月之暗面) | https://platform.moonshot.cn/console/api-keys |
| 智谱 GLM | https://open.bigmodel.cn |
| OpenAI | https://platform.openai.com/api-keys |
| 自定义 (任意 OpenAI 兼容接口) | — |

> **API Key 仅保存在浏览器本地 (`localStorage`)，不会上传到任何服务器。**
> ⚠️ 如果要把站点公开发布，**不要把 Key 写进代码**——任何打开 `ai.js` 的人都能抓到。建议交给最终用户自己在 ⚙️ 里填 Key。

---

## 功能流程

### 主界面 — 上传笔记

- 拖拽或点击上传 `.pptx` / `.pdf` / 图片（`.png` `.jpg` `.jpeg` `.webp`）
- 已上传的笔记会按卡片列出，点击进入笔记 / 标签界面
- 多张图片会按文件名顺序自动排成幻灯片

### 界面 1 — 笔记 / 标签

- 左侧：当前页的**标签** + **易错点 / 注意事项** + **课堂记录**
- 右侧：当前页内容（文本 + 嵌入图片，按阅读顺序排列）
- **选中右侧文本** → 弹出工具栏：
  - 🏷️ **生成标签**：AI 提炼知识点
  - ⚠️ **易错点**：AI 列出易错点 / 注意事项
  - 💡 **解释**：浮窗里 AI 详细解释选中内容
- **课堂记录**：手动打字 + 🎤 实时语音（Chrome / Edge）+ 📁 录音 / 上传（任何浏览器、任何环境）
- 翻页用 ‹ 上一页 / 下一页 › 按钮

### 界面 2 — 思维导图

- 左侧：所有笔记的标签总览（按笔记分组）
- 在左侧**多选**任意标签 → 右上点 「生成思维导图」 → AI 围绕选中标签展开层级图
- 思维导图里**带颜色的紫色节点**点击 → 跳到对应笔记页
- 也支持「全选当前笔记」一键圈选

### 界面 3 — AI 出题

- **基础版**：选一个标签 → AI 基于该标签出题（答案默认隐藏，点按钮才显示）
- **进阶版**：AI 通读全笔记识别知识点 → 随机出题 → 「显示答案」时同时列出涉及的知识点 chip，点 chip 跳到来源页

### 浮动 🤖 按钮

任何界面右下角都有，打开后基于当前笔记上下文随时提问 / 答疑。

---

## 数据存储

- 所有笔记 / 标签 / 课堂记录存在浏览器 **IndexedDB**（容量上限通常几百 MB ~ 几 GB），不上传服务器
- AI 设置存在 `localStorage`
- 在 ⚙️ 设置 → 「清空全部数据」可一键重置
- 在 ⚙️ 设置 → 「恢复默认」可清掉 localStorage 残留（用户填错配置时方便排错）

---

## 已知限制

- `.pptx` 渲染只提取**文本 + 嵌入图片**，不还原原版式。需 1:1 视觉效果时建议导出每页为 PNG 后以"图片"方式上传
- `.pdf` 走 pdf.js 直接渲染整页 + 文本提取，效果较好
- 浏览器原生语音识别（webkitSpeechRecognition）国内 Chrome 通常不可用（走 Google 服务），改用 「📁 录音 / 上传」 兜底
- 课堂记录的「📁 录音 / 上传」需要服务商是 DashScope（用 Qwen-Audio），其他模型暂不支持音频转写
- 在浏览器从 HTTP 站点访问时，麦克风权限可能被拒；如要常用，建议部署 HTTPS

---

## 浏览器兼容

| 浏览器 | 全部功能 | 实时语音识别 | 录音上传转写 |
|---|---|---|---|
| Chrome / Edge (桌面) | ✅ | ⚠️ 国内常失败 | ✅ |
| Safari / Firefox | ✅ | ❌ 无原生支持 | ✅ |
| 微信内置浏览器 | ✅ | ❌ | ✅（拉起手机录音） |
| 移动端 Chrome / Safari | ✅ | ⚠️ | ✅ |

---

## 开发自测

无构建步骤，改完任意文件刷新浏览器即可。如果想做个语法检查：

```bash
node --check ai.js
node --check pptParser.js
node --check app.js
node --check idb.js
```

---

## License

按客户协议交付。
