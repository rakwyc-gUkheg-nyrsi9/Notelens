/* PPTX / PDF 解析 —— 输出统一结构
 *
 * slide: {
 *   id, index,
 *   blocks: [{type:'text', content:'...'} | {type:'image', dataUrl:'...'}],
 *   text:   所有文本块拼接（给 AI 用），
 *   images: 所有图片 dataUrl 数组（向后兼容），
 *   tags, errorPoints
 * }
 */
window.PPTParser = (function () {
  /* ================= PPTX ================= */
  async function parsePptx(file) {
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    const slideFiles = [];
    zip.forEach((path) => {
      const m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      if (m) slideFiles.push({ path, num: parseInt(m[1], 10) });
    });
    slideFiles.sort((a, b) => a.num - b.num);

    const slides = [];
    for (const sf of slideFiles) {
      const xml = await zip.file(sf.path).async('string');

      // 读取 rels 建立 rId → media path 映射
      const relsPath = `ppt/slides/_rels/slide${sf.num}.xml.rels`;
      const rels = {};
      const relsFile = zip.file(relsPath);
      if (relsFile) {
        const relsXml = await relsFile.async('string');
        const re = /<Relationship[^>]*Id="([^"]+)"[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g;
        let m;
        while ((m = re.exec(relsXml)) !== null) {
          rels[m[1]] = normalizePath(`ppt/slides/${m[2]}`);
        }
      }

      // 按文档顺序遍历 p:spTree 的 shape / pic
      const blocks = await extractBlocksInOrder(xml, rels, zip);

      const texts = blocks.filter(b => b.type === 'text').map(b => b.content);
      const images = blocks.filter(b => b.type === 'image').map(b => b.dataUrl);

      slides.push({
        id: 'slide_' + sf.num + '_' + Math.random().toString(36).slice(2, 8),
        index: sf.num,
        blocks,
        text: texts.join('\n').trim(),
        images,
        tags: [],
        errorPoints: [],
      });
    }

    return {
      id: 'ppt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: file.name.replace(/\.pptx$/i, ''),
      createdAt: Date.now(),
      slides,
    };
  }

  /* 用 DOMParser 按 document order 遍历 spTree 子元素，保留文本/图片出现顺序 */
  async function extractBlocksInOrder(slideXml, relsMap, zip) {
    const blocks = [];
    let doc;
    try {
      doc = new DOMParser().parseFromString(slideXml, 'application/xml');
    } catch (_) {
      return blocks;
    }
    if (doc.getElementsByTagName('parsererror').length) return blocks;

    // 找到 spTree（命名空间不确定，用 localName）
    const allEls = doc.getElementsByTagName('*');
    let spTree = null;
    for (let i = 0; i < allEls.length; i++) {
      if (allEls[i].localName === 'spTree') { spTree = allEls[i]; break; }
    }
    if (!spTree) return blocks;

    // 递归遍历，按顺序处理每个 sp / pic / grpSp 节点
    await walkShapes(spTree, blocks, relsMap, zip);
    return blocks;
  }

  async function walkShapes(parent, blocks, relsMap, zip) {
    // 收集子节点 + 它们的位置信息，按"先上后下、再左后右"排序
    // —— PPTX XML 顺序是 z-order，不是阅读顺序，直接遍历会显得乱。
    const items = [];
    for (const child of Array.from(parent.children)) {
      const name = child.localName;
      if (name !== 'sp' && name !== 'pic' && name !== 'grpSp' && name !== 'graphicFrame') continue;
      const pos = readShapePos(child);
      items.push({ el: child, name, y: pos.y, x: pos.x });
    }
    items.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    for (const it of items) {
      const child = it.el;
      if (it.name === 'sp') {
        const text = collectShapeText(child);
        if (text.trim()) blocks.push({ type: 'text', content: text.trim() });
      } else if (it.name === 'pic') {
        const dataUrl = await extractPicImage(child, relsMap, zip);
        if (dataUrl) blocks.push({ type: 'image', dataUrl });
      } else if (it.name === 'grpSp') {
        await walkShapes(child, blocks, relsMap, zip);
      } else if (it.name === 'graphicFrame') {
        const text = collectShapeText(child);
        if (text.trim()) blocks.push({ type: 'text', content: text.trim() });
      }
    }
  }

  /* 从 sp/pic/grpSp/graphicFrame 里读 <a:off x= y=>。
   * 没读到坐标的（极少数）放到末尾。 */
  function readShapePos(shapeEl) {
    const offs = shapeEl.getElementsByTagName('*');
    for (const el of Array.from(offs)) {
      if (el.localName === 'off' && el.namespaceURI && el.namespaceURI.includes('drawingml')) {
        const x = parseInt(el.getAttribute('x') || '0', 10);
        const y = parseInt(el.getAttribute('y') || '0', 10);
        return { x: isNaN(x) ? 1e12 : x, y: isNaN(y) ? 1e12 : y };
      }
    }
    return { x: 1e12, y: 1e12 };
  }

  /* 一个 sp / graphicFrame 内：按 <a:p> 分段、<a:t> 合并，保留换行 */
  function collectShapeText(el) {
    const paragraphs = el.getElementsByTagName('*');
    const lines = [];
    let currentLine = null;
    const stack = [];

    // 遍历所有后代元素，按出现顺序处理 a:p / a:t
    function walk(node) {
      for (const c of Array.from(node.children)) {
        if (c.localName === 'p' && c.namespaceURI && c.namespaceURI.includes('drawingml')) {
          if (currentLine !== null) lines.push(currentLine);
          currentLine = '';
          walk(c);
          lines.push(currentLine);
          currentLine = null;
        } else if (c.localName === 't' && c.namespaceURI && c.namespaceURI.includes('drawingml')) {
          const txt = c.textContent || '';
          if (currentLine === null) currentLine = txt;
          else currentLine += txt;
        } else {
          walk(c);
        }
      }
    }
    walk(el);
    if (currentLine !== null) lines.push(currentLine);
    return lines.filter(s => s !== undefined).join('\n');
  }

  async function extractPicImage(picEl, relsMap, zip) {
    // <p:pic> → <p:blipFill> → <a:blip r:embed="rIdN"/>
    const blips = picEl.getElementsByTagName('*');
    let embed = null;
    for (const el of Array.from(blips)) {
      if (el.localName === 'blip') {
        // 属性命名空间 r=http://schemas.openxmlformats.org/officeDocument/2006/relationships
        const attrs = el.attributes;
        for (let i = 0; i < attrs.length; i++) {
          const a = attrs[i];
          if (a.localName === 'embed') { embed = a.value; break; }
        }
        if (embed) break;
      }
    }
    if (!embed) return null;
    const path = relsMap[embed];
    if (!path) return null;
    const f = zip.file(path);
    if (!f) return null;
    try {
      const blob = await f.async('blob');
      return await compressToDataUrl(blob);
    } catch (_) {
      return null;
    }
  }

  /* ================= PDF ================= */
  async function parsePdf(file) {
    if (!window.pdfjsLib) {
      throw new Error('PDF 解析库未加载（pdf.js）');
    }
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const slides = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);

      // 原尺寸 → 等比缩到最长边 1600
      const baseViewport = page.getViewport({ scale: 1 });
      const longest = Math.max(baseViewport.width, baseViewport.height);
      const scale = longest > 0 ? Math.min(2, 1600 / longest) : 1;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;

      const dataUrl = await new Promise((resolve) => {
        canvas.toBlob((b) => {
          if (!b) return resolve(canvas.toDataURL('image/jpeg', 0.82));
          blobToDataUrl(b).then(resolve);
        }, 'image/jpeg', 0.82);
      });

      // 提取文字（保持行内连贯，按 y 大致分行）
      let text = '';
      try {
        const tc = await page.getTextContent();
        const items = tc.items || [];
        const lines = [];
        let currentY = null;
        let currentLine = '';
        for (const it of items) {
          const y = Math.round((it.transform && it.transform[5]) || 0);
          if (currentY === null) { currentY = y; currentLine = it.str; }
          else if (Math.abs(y - currentY) <= 2) { currentLine += it.str; }
          else { lines.push(currentLine); currentY = y; currentLine = it.str; }
          if (it.hasEOL) { lines.push(currentLine); currentLine = ''; currentY = null; }
        }
        if (currentLine) lines.push(currentLine);
        text = lines.join('\n').trim();
      } catch (_) { /* 扫描版 PDF 无文字层 */ }

      slides.push({
        id: 'slide_' + i + '_' + Math.random().toString(36).slice(2, 8),
        index: i,
        blocks: [{ type: 'image', dataUrl }, ...(text ? [{ type: 'text', content: text }] : [])],
        text,
        images: [dataUrl],
        tags: [],
        errorPoints: [],
      });

      // 释放 page
      page.cleanup && page.cleanup();
    }
    try { pdf.destroy(); } catch (_) {}

    return {
      id: 'ppt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: file.name.replace(/\.pdf$/i, ''),
      createdAt: Date.now(),
      slides,
    };
  }

  /* ================= 图片数组 → 当 PPT ================= */
  async function buildFromImages(files, name) {
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const slides = [];
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i];
      const dataUrl = await compressToDataUrl(f);
      slides.push({
        id: 'slide_' + (i + 1) + '_' + Math.random().toString(36).slice(2, 8),
        index: i + 1,
        blocks: [{ type: 'image', dataUrl }],
        text: '',
        images: [dataUrl],
        tags: [],
        errorPoints: [],
      });
    }
    return {
      id: 'ppt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: name || ('图片 PPT — ' + new Date().toLocaleString()),
      createdAt: Date.now(),
      slides,
    };
  }

  /* ================= utils ================= */
  function normalizePath(p) {
    const segs = [];
    for (const s of p.split('/')) {
      if (s === '..') segs.pop();
      else if (s === '.' || s === '') continue;
      else segs.push(s);
    }
    return segs.join('/');
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  const MAX_WIDTH = 1600;
  const JPEG_QUALITY = 0.82;
  const SKIP_BELOW_BYTES = 120 * 1024;

  async function compressToDataUrl(blob) {
    if (blob.size < SKIP_BELOW_BYTES) return blobToDataUrl(blob);
    try {
      const url = URL.createObjectURL(blob);
      try {
        const img = await loadImage(url);
        const scale = Math.min(1, MAX_WIDTH / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const out = await new Promise((resolve) => {
          canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
        });
        if (!out) return blobToDataUrl(blob);
        return blobToDataUrl(out);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (_) {
      return blobToDataUrl(blob);
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = src;
    });
  }

  return { parsePptx, parsePdf, buildFromImages };
})();
