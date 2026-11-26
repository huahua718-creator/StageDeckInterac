import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');

export const VALID_MODES = new Set([
  'SLIDE',
  'BUBBLE',
  'SPECTRUM',
  'MYTH',
  'QUADRANT',
  'TREE',
  'DANMAKU',
]);

export const VALID_LAYOUTS = new Set([
  'COVER',
  'QUOTE',
  'BULLETS',
  'SPLIT',
  'MEDIA',
  'DIAGRAM',
  'CHART',
  'CARDS',
  'LINKS',
]);

export const VALID_THEMES = new Set([
  'DARK_NEBULA',
  'CLEAN_LIGHT',
  'TECH_GRID',
]);

export const DEFAULT_CONFIG = {
  event_title: '用 AI 改善工作流──邁向優雅的教師生活',
  event_subtitle: '高中教師增能研習工作坊',
  primary_color: '#6366f1',
  bg_theme: 'DARK_NEBULA',
  logo_url: '',
  join_url_display: '',
};

/**
 * Parse RFC 4180 CSV text into an array of row arrays.
 */
export function parseCSV(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r' && next === '\n') {
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

/**
 * Normalize Google Sheets, Google Docs, or Google Drive file URLs into direct raw download URLs.
 */
export function normalizeSheetCsvUrl(rawUrl, sheetName = '') {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';

  // Google Docs -> plain text / markdown export
  const docMatch = trimmed.match(/https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch) {
    return `https://docs.google.com/document/d/${docMatch[1]}/export?format=txt`;
  }

  // Google Drive file link -> direct download
  const driveFileMatch = trimmed.match(/https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveFileMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveFileMatch[1]}`;
  }
  const driveOpenMatch = trimmed.match(/https?:\/\/drive\.google\.com\/(?:open|uc)\?.*[?&]?id=([a-zA-Z0-9_-]+)/);
  if (driveOpenMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveOpenMatch[1]}`;
  }

  if (
    !sheetName &&
    (trimmed.includes('output=csv') ||
      trimmed.includes('format=csv') ||
      trimmed.includes('tqx=out:csv'))
  ) {
    return trimmed;
  }
  if (trimmed.includes('/pubhtml')) {
    return trimmed.replace(/\/pubhtml.*$/, '/pub?output=csv');
  }
  const match = trimmed.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && !trimmed.includes('/d/e/')) {
    if (sheetName) {
      return `https://docs.google.com/spreadsheets/d/${match[1]}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
    }
    const gidMatch = trimmed.match(/gid=(\d+)/);
    const gid = gidMatch ? `&gid=${gidMatch[1]}` : '';
    return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv${gid}`;
  }
  return trimmed;
}

/**
 * Convert Google Drive file sharing URLs into direct image URLs.
 * Ignores placeholder notes like "*(可放截圖)*".
 */
export function normalizeMediaUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  const fileMatch = url.match(/https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) {
    return `https://drive.google.com/thumbnail?id=${fileMatch[1]}&sz=w1600`;
  }
  const openMatch = url.match(/https?:\/\/drive\.google\.com\/(?:open|uc)\?.*[?&]?id=([a-zA-Z0-9_-]+)/);
  if (openMatch) {
    return `https://drive.google.com/thumbnail?id=${openMatch[1]}&sz=w1600`;
  }
  if (/^(https?:\/\/|\/|data:image\/)/i.test(url)) {
    return url;
  }
  return '';
}

export function sanitizeConfig(raw = {}) {
  const merged = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (raw[k] !== undefined && String(raw[k]).trim() !== '') {
      merged[k] = String(raw[k]).trim();
    }
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(merged.primary_color)) {
    merged.primary_color = DEFAULT_CONFIG.primary_color;
  }
  const upperTheme = merged.bg_theme.toUpperCase();
  merged.bg_theme = VALID_THEMES.has(upperTheme) ? upperTheme : DEFAULT_CONFIG.bg_theme;
  merged.logo_url = normalizeMediaUrl(merged.logo_url);
  return merged;
}

export function rowsToConfig(rows) {
  const cfg = {};
  if (!rows || rows.length === 0) return sanitizeConfig(cfg);
  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const iKey = headers.indexOf('key');
  const iVal = headers.indexOf('value');

  const startIdx = iKey !== -1 && iVal !== -1 ? 1 : 0;
  const kCol = iKey !== -1 ? iKey : 0;
  const vCol = iVal !== -1 ? iVal : 1;

  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    const k = (r[kCol] || '').trim().toLowerCase();
    const v = (r[vCol] || '').trim();
    if (k && k in DEFAULT_CONFIG) {
      cfg[k] = v;
    }
  }
  return sanitizeConfig(cfg);
}

export function splitBodyBullets(body) {
  return String(body || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function splitBodyColumns(body) {
  const parts = String(body || '').split('::');
  const left = splitBodyBullets(parts[0] || '');
  const right = splitBodyBullets(parts[1] || '');
  return { left, right };
}

/**
 * Parse CHART body text into { chartType, unit, items: [{ label, value }] }.
 */
export function parseChartSpec(body) {
  const raw = String(body || '').replace(/\\n/g, '\n');
  const lines = raw
    .split(/\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);

  let chartType = 'bar';
  let unit = '';
  const items = [];

  for (const line of lines) {
    const clean = line.replace(/^[-*•]\s*/, '');
    const mType = clean.match(/^type\s*[:：]\s*(bar|pie|donut|line|radar)$/i);
    if (mType) {
      chartType = mType[1].toLowerCase();
      continue;
    }
    const mUnit = clean.match(/^unit\s*[:：]\s*(.+)$/i);
    if (mUnit) {
      unit = mUnit[1].trim();
      continue;
    }
    const kv = clean.match(/^(.+?)\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*(.*)$/);
    if (kv) {
      const label = kv[1].trim();
      const value = Number.parseFloat(kv[2]);
      if (label && Number.isFinite(value)) {
        if (!unit && kv[3]) unit = kv[3].trim();
        items.push({ label, value });
      }
    }
  }
  return { chartType, unit, items };
}

/**
 * Parse CARDS body text into { flow, cards: [{ tag, title, desc }] }.
 */
export function parseCardsSpec(body, flowFlag = false) {
  const raw = String(body || '').replace(/\\n/g, '\n');
  let flow = Boolean(flowFlag);
  let chunks = [];

  if (raw.includes('::')) {
    chunks = raw.split('::').map((s) => s.trim()).filter(Boolean);
  } else {
    chunks = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
  }

  const cards = [];
  for (const chunk of chunks) {
    const clean = chunk.replace(/^[-*•]\s*/, '').trim();
    if (!clean) continue;
    if (/^flow\s*[:：]\s*(true|yes|1)$/i.test(clean)) {
      flow = true;
      continue;
    }
    const parts = clean.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 3) {
      cards.push({ tag: parts[0], title: parts[1], desc: parts.slice(2).join(' · ') });
    } else if (parts.length === 2) {
      cards.push({ tag: '', title: parts[0], desc: parts[1] });
    } else if (parts.length === 1) {
      cards.push({ tag: '', title: parts[0], desc: '' });
    }
  }
  return { flow, cards };
}

export function normalizeLinkUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  if (/^https?:\/\/\S+/i.test(url)) return url;
  return '';
}

export function sanitizeLinkSlug(rawSlug) {
  return String(rawSlug || '')
    .trim()
    .replace(/^\/?go\//i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase()
    .slice(0, 32);
}

/**
 * Parse LINKS body text into { links: [{ tag, title, url, desc, slug }] }.
 * Canonical chunk format: "tag | title | url | desc | slug" separated by "::" or "\n".
 */
export function parseLinksSpec(body, order = 1) {
  const raw = String(body || '').replace(/\\n/g, '\n');
  const chunks = raw.includes('::')
    ? raw.split('::').map((s) => s.trim()).filter(Boolean)
    : raw.split(/\n/).map((s) => s.trim()).filter(Boolean);

  const links = [];
  for (const chunk of chunks) {
    const clean = chunk.replace(/^[-*•]\s*/, '').trim();
    if (!clean) continue;
    const parts = clean.split('|').map((s) => s.trim());
    const uIdx = parts.findIndex((p) => /^https?:\/\//i.test(p));
    let tag = '';
    let title = '';
    let url = '';
    let desc = '';
    let slug = '';

    if (uIdx !== -1) {
      url = normalizeLinkUrl(parts[uIdx]);
      if (uIdx === 0) {
        title = parts[1] || url;
        desc = parts[2] || '';
        slug = sanitizeLinkSlug(parts[3] || '');
      } else if (uIdx === 1) {
        title = parts[0] || url;
        desc = parts[2] || '';
        slug = sanitizeLinkSlug(parts[3] || '');
      } else {
        tag = parts[0] || '';
        title = parts.slice(1, uIdx).filter(Boolean).join(' · ') || url;
        desc = parts[uIdx + 1] || '';
        slug = sanitizeLinkSlug(parts[uIdx + 2] || '');
      }
    } else if (parts.length >= 2) {
      tag = parts[0] || '';
      title = parts[1] || parts[0] || '';
      desc = parts.slice(2).filter(Boolean).join(' · ');
    }

    if (!url && !title) continue;
    if (!slug) {
      slug = `link${order}-${links.length + 1}`;
    }
    links.push({
      tag: tag || `STEP ${String(links.length + 1).padStart(2, '0')}`,
      title: title || url,
      url,
      desc,
      slug,
    });
  }
  return { links };
}

export function extractDeckLinks(deck = []) {
  const out = [];
  const seenSlugs = new Set();
  for (const s of deck) {
    if (!s || s.mode !== 'SLIDE' || s.layout !== 'LINKS') continue;
    const items = s.linksSpec?.links || [];
    for (const item of items) {
      if (!item.url) continue;
      let slug = sanitizeLinkSlug(item.slug);
      if (!slug || seenSlugs.has(slug)) {
        slug = sanitizeLinkSlug(`${slug || 'go'}-${s.order}-${out.length + 1}`);
      }
      seenSlugs.add(slug);
      out.push({
        order: s.order,
        slideTitle: s.title,
        tag: item.tag || '',
        title: item.title || item.url,
        desc: item.desc || '',
        url: item.url,
        slug,
      });
    }
  }
  return out;
}

function buildSlideObject({
  order,
  mode,
  layout,
  title,
  subtitle,
  body,
  mediaUrl,
  imagePrompt = '',
  options,
  correctOpt,
  explanation,
  timerSec,
  speakerNote,
  diagramCode = '',
  chartSpec = null,
  cardsSpec = null,
  linksSpec = null,
  rIdx = 1,
}) {
  const cleanBody = String(body || '').replace(/\\n/g, '\n');
  const normMode = String(mode || 'SLIDE').toUpperCase();
  let normLayout = '';
  if (normMode === 'SLIDE') {
    const up = String(layout || '').toUpperCase();
    normLayout = VALID_LAYOUTS.has(up) ? up : 'BULLETS';
  }

  const bullets =
    normMode === 'SLIDE' && (normLayout === 'BULLETS' || normLayout === 'QUOTE')
      ? splitBodyBullets(cleanBody)
      : [];
  const columns =
    normMode === 'SLIDE' && normLayout === 'SPLIT'
      ? splitBodyColumns(cleanBody)
      : { left: [], right: [] };

  let resolvedDiagram = diagramCode;
  if (normMode === 'SLIDE' && normLayout === 'DIAGRAM' && !resolvedDiagram) {
    const m = cleanBody.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/i);
    resolvedDiagram = m ? m[1].trim() : cleanBody.trim();
  }

  const resolvedChart =
    normMode === 'SLIDE' && normLayout === 'CHART'
      ? chartSpec || parseChartSpec(cleanBody)
      : null;

  const resolvedCards =
    normMode === 'SLIDE' && normLayout === 'CARDS'
      ? cardsSpec || parseCardsSpec(cleanBody)
      : null;

  const resolvedLinks =
    normMode === 'SLIDE' && normLayout === 'LINKS'
      ? linksSpec || parseLinksSpec(cleanBody, order)
      : null;

  return {
    id: `s_${order}_${normMode}_${rIdx}`,
    order,
    mode: normMode,
    layout: normLayout,
    title,
    subtitle,
    body: cleanBody,
    bullets,
    columns,
    diagramCode: resolvedDiagram,
    chartSpec: resolvedChart,
    cardsSpec: resolvedCards,
    linksSpec: resolvedLinks,
    mediaUrl: normalizeMediaUrl(mediaUrl),
    imagePrompt: String(imagePrompt || '').trim(),
    options,
    correctOpt,
    explanation,
    timerSec,
    speakerNote,
  };
}

export { buildSlideObject };

/**
 * Convert parsed CSV rows into structured Deck slides and inline Config overrides.
 */
export function rowsToDeck(rows) {
  if (!rows || rows.length < 2) {
    throw new Error('Deck 試算表內容為空或缺少標題列');
  }
  const headers = rows[0].map((h) => h.toLowerCase().trim());
  const idx = (name) => headers.indexOf(name);

  const iOrder = idx('order');
  const iMode = idx('mode');
  const iTitle = idx('title');
  if (iOrder === -1 || iMode === -1 || iTitle === -1) {
    throw new Error('Deck 試算表缺少必要欄位：order, mode, title');
  }

  const get = (r, name) => {
    const i = idx(name);
    return i >= 0 && i < r.length ? (r[i] || '').trim() : '';
  };

  const inlineConfig = {};
  const deck = [];

  for (let rIdx = 1; rIdx < rows.length; rIdx++) {
    const r = rows[rIdx];
    const mode = get(r, 'mode').toUpperCase();
    const title = get(r, 'title');

    if (mode === 'CONFIG') {
      const key = (get(r, 'layout') || title || '').toLowerCase();
      const val = get(r, 'body') || get(r, 'subtitle') || '';
      if (key in DEFAULT_CONFIG && val) {
        inlineConfig[key] = val;
      }
      continue;
    }

    if (!title || !VALID_MODES.has(mode)) continue;

    const orderNum = Number.parseInt(get(r, 'order'), 10);
    const order = Number.isFinite(orderNum) ? orderNum : rIdx;
    const options = [];
    for (let k = 1; k <= 5; k++) {
      const val = get(r, `opt_${k}`);
      if (val) options.push({ key: `opt_${k}`, label: val });
    }
    const timerSec = Math.max(0, Number.parseInt(get(r, 'timer_sec'), 10) || 0);

    deck.push(
      buildSlideObject({
        order,
        mode,
        layout: get(r, 'layout'),
        title,
        subtitle: get(r, 'subtitle'),
        body: get(r, 'body'),
        mediaUrl: get(r, 'media_url'),
        imagePrompt: get(r, 'image_prompt'),
        options,
        correctOpt: get(r, 'correct_opt'),
        explanation: get(r, 'explanation'),
        timerSec,
        speakerNote: get(r, 'speaker_note'),
        rIdx,
      })
    );
  }

  deck.sort((a, b) => a.order - b.order);
  if (deck.length === 0) {
    throw new Error('Deck 試算表中沒有任何有效頁面（mode 需為 SLIDE/BUBBLE/SPECTRUM/MYTH/QUADRANT/TREE/DANMAKU）');
  }

  return { deck, inlineConfig };
}

/**
 * Split Markdown deck into sections by `---` outside code fences.
 */
function splitMarkdownSections(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const sections = [];
  let cur = [];
  let inFence = false;

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('```')) inFence = !inFence;
    if (!inFence && t === '---') {
      sections.push(cur.join('\n'));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) sections.push(cur.join('\n'));
  return sections.map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse NotebookLM-friendly Markdown slide deck into { config, deck }.
 */
export function parseMarkdownDeck(text) {
  const sections = splitMarkdownSections(text);
  if (sections.length === 0) {
    throw new Error('Markdown 簡報內容為空');
  }

  const configRaw = {};
  const slideSections = [];

  // Check if first section is global config / YAML frontmatter
  const first = sections[0];
  const isConfigOnly =
    !/^mode\s*:/im.test(first) &&
    /^(?:event_title|event_subtitle|primary_color|bg_theme|logo_url|join_url_display)\s*:/im.test(first);

  if (isConfigOnly) {
    for (const line of first.split(/\r?\n/)) {
      const m = line.trim().match(/^([a-z_]+)\s*:\s*(.+)$/i);
      if (m) {
        const k = m[1].toLowerCase();
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (k in DEFAULT_CONFIG) configRaw[k] = v;
      }
    }
    slideSections.push(...sections.slice(1));
  } else {
    slideSections.push(...sections);
  }

  const deck = [];
  const metaKeys = new Set([
    'order', 'mode', 'layout', 'title', 'subtitle', 'body', 'media_url',
    'opt_1', 'opt_2', 'opt_3', 'opt_4', 'opt_5',
    'correct_opt', 'explanation', 'timer_sec', 'speaker_note', 'flow',
  ]);

  slideSections.forEach((sec, idx) => {
    const meta = {};
    const bodyLines = [];
    const lines = sec.split(/\r?\n/);
    let inFence = false;
    let diagramCode = '';
    let fenceLang = '';
    let fenceBuf = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('```')) {
        if (!inFence) {
          inFence = true;
          fenceLang = trimmed.slice(3).trim().toLowerCase();
          fenceBuf = [];
        } else {
          inFence = false;
          if (fenceLang === 'mermaid' || (!fenceLang && !diagramCode)) {
            diagramCode = fenceBuf.join('\n').trim();
          } else {
            bodyLines.push('```' + fenceLang + '\n' + fenceBuf.join('\n') + '\n```');
          }
        }
        continue;
      }
      if (inFence) {
        fenceBuf.push(rawLine);
        continue;
      }

      if (/^\[META\]$/i.test(trimmed)) continue;

      // Speaker note blockquote: > speaker_note: ...
      const noteMatch = trimmed.match(/^>?\s*speaker_note\s*[:：]\s*(.+)$/i);
      if (noteMatch) {
        meta.speaker_note = noteMatch[1].trim();
        continue;
      }

      // Metadata line (allow optional leading `- ` or `**key**:`)
      const kv = trimmed.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').match(/^([a-z0-9_]+)\s*[:：]\s*(.*)$/i);
      if (kv && metaKeys.has(kv[1].toLowerCase())) {
        const k = kv[1].toLowerCase();
        meta[k] = kv[2].trim().replace(/^["']|["']$/g, '');
        continue;
      }

      // Fallback markdown headings
      if (!meta.title && /^#\s+(.+)$/.test(trimmed)) {
        meta.title = trimmed.replace(/^#\s+/, '').trim();
        continue;
      }
      if (!meta.subtitle && /^##\s+(.+)$/.test(trimmed)) {
        meta.subtitle = trimmed.replace(/^##\s+/, '').trim();
        continue;
      }

      if (trimmed) bodyLines.push(trimmed);
    }

    const mode = (meta.mode || 'SLIDE').toUpperCase();
    if (!VALID_MODES.has(mode)) return;

    const title = meta.title || `第 ${idx + 1} 頁`;
    const order = Number.parseInt(meta.order, 10) || idx + 1;
    let layout = (meta.layout || (diagramCode ? 'DIAGRAM' : 'BULLETS')).toUpperCase();
    if (mode === 'SLIDE' && diagramCode && !meta.layout) layout = 'DIAGRAM';

    let body = meta.body || '';
    if (!body && bodyLines.length > 0) {
      if (mode === 'SLIDE' && layout === 'BULLETS') {
        body = bodyLines.map((l) => l.replace(/^[-*•]\s*/, '')).join(' | ');
      } else {
        body = bodyLines.join('\n');
      }
    }

    const options = [];
    for (let k = 1; k <= 5; k++) {
      if (meta[`opt_${k}`]) options.push({ key: `opt_${k}`, label: meta[`opt_${k}`] });
    }

    const flowFlag = /^(true|yes|1)$/i.test(meta.flow || '');
    const cardsSpec = mode === 'SLIDE' && layout === 'CARDS' ? parseCardsSpec(body, flowFlag) : null;

    deck.push(
      buildSlideObject({
        order,
        mode,
        layout,
        title,
        subtitle: meta.subtitle || '',
        body,
        mediaUrl: meta.media_url || '',
        options,
        correctOpt: meta.correct_opt || '',
        explanation: meta.explanation || '',
        timerSec: Math.max(0, Number.parseInt(meta.timer_sec, 10) || 0),
        speakerNote: meta.speaker_note || '',
        diagramCode,
        cardsSpec,
        rIdx: idx + 1,
      })
    );
  });

  deck.sort((a, b) => a.order - b.order);
  if (deck.length === 0) {
    throw new Error('Markdown 簡報中找不到任何有效頁面（請檢查是否包含 mode: SLIDE / title: ...）');
  }

  return { config: sanitizeConfig(configRaw), deck };
}

/**
 * Parse JSON deck { config, deck } or array of slides.
 */
export function parseJsonDeck(text) {
  const parsed = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  const rawList = Array.isArray(parsed) ? parsed : parsed.deck || parsed.slides || [];
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error('JSON 簡報缺少 deck 陣列');
  }
  const cfg = sanitizeConfig(Array.isArray(parsed) ? {} : parsed.config || {});
  const deck = rawList
    .map((item, i) => {
      const options = Array.isArray(item.options)
        ? item.options.map((o, oi) => (typeof o === 'string' ? { key: `opt_${oi + 1}`, label: o } : o))
        : [1, 2, 3, 4, 5]
            .filter((k) => item[`opt_${k}`])
            .map((k) => ({ key: `opt_${k}`, label: item[`opt_${k}`] }));

      return buildSlideObject({
        order: Number.parseInt(item.order, 10) || i + 1,
        mode: item.mode || 'SLIDE',
        layout: item.layout || '',
        title: item.title || `第 ${i + 1} 頁`,
        subtitle: item.subtitle || '',
        body: item.body || '',
        mediaUrl: item.media_url || item.mediaUrl || '',
        imagePrompt: item.image_prompt || item.imagePrompt || '',
        options,
        correctOpt: item.correct_opt || item.correctOpt || '',
        explanation: item.explanation || '',
        timerSec: Math.max(0, Number.parseInt(item.timer_sec || item.timerSec, 10) || 0),
        speakerNote: item.speaker_note || item.speakerNote || '',
        diagramCode: item.diagramCode || item.mermaid || '',
        rIdx: i + 1,
      });
    })
    .filter((s) => VALID_MODES.has(s.mode));

  deck.sort((a, b) => a.order - b.order);
  return { config: cfg, deck };
}

/**
 * Auto-detect JSON, Markdown, or CSV deck text.
 */
export function parseAnyDeckText(rawText, configCsvText = '') {
  const clean = String(rawText || '').replace(/^\uFEFF/, '').trim();
  if (!clean) throw new Error('匯入內容為空');

  // Strip outer markdown ```markdown / ```csv / ```json wrapper if copied from AI chat
  let text = clean;
  const wrapped = clean.match(/^```(?:markdown|md|csv|json)?\s*\n([\s\S]*?)\n```$/i);
  if (wrapped) text = wrapped[1].trim();

  if (text.startsWith('{') || text.startsWith('[')) {
    const res = parseJsonDeck(text);
    const extraCfg = configCsvText ? rowsToConfig(parseCSV(configCsvText)) : {};
    return {
      config: sanitizeConfig({ ...res.config, ...extraCfg }),
      deck: res.deck,
      format: 'JSON',
    };
  }

  const looksLikeMarkdown =
    text.startsWith('---') ||
    /(?:^|\n)\s*mode\s*[:：]/i.test(text) ||
    /(?:^|\n)\s*```mermaid/i.test(text) ||
    /(?:^|\n)\s*#\s+/.test(text);

  if (looksLikeMarkdown && !/^\s*order\s*,\s*mode/i.test(text)) {
    const res = parseMarkdownDeck(text);
    const extraCfg = configCsvText ? rowsToConfig(parseCSV(configCsvText)) : {};
    return {
      config: sanitizeConfig({ ...res.config, ...extraCfg }),
      deck: res.deck,
      format: 'Markdown',
    };
  }

  const { deck, inlineConfig } = rowsToDeck(parseCSV(text));
  const baseCfg = configCsvText ? rowsToConfig(parseCSV(configCsvText)) : {};
  return {
    config: sanitizeConfig({ ...baseCfg, ...inlineConfig }),
    deck,
    format: 'CSV',
  };
}

async function fetchTextResource(url, label = '雲端檔案') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`${label} 回應錯誤 HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      throw new Error(`${label} 取得 HTML 而非純文字/CSV，請確認雲端檔案已開啟「知道連結者可檢視」或「發布到網路」`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load both Config and Deck from Google Sheets / Google Docs / Google Drive / URL or local sample.
 */
export async function loadDeckPackage({ deckUrl = '', configUrl = '' } = {}) {
  const rawDeck = String(deckUrl || '').trim();
  const rawConfig = String(configUrl || '').trim();
  const normalizedDeck = normalizeSheetCsvUrl(rawDeck);

  if (normalizedDeck) {
    const deckText = await fetchTextResource(normalizedDeck, '講題來源');
    let configCsvText = '';
    let resolvedConfigSource = '';
    const explicitConfigUrl = normalizeSheetCsvUrl(rawConfig);

    if (explicitConfigUrl) {
      configCsvText = await fetchTextResource(explicitConfigUrl, 'Config 工作表');
      resolvedConfigSource = explicitConfigUrl;
    } else if (/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9-_]+/.test(rawDeck) && !rawDeck.includes('/d/e/')) {
      const autoCfgUrl = normalizeSheetCsvUrl(rawDeck, 'Config');
      try {
        configCsvText = await fetchTextResource(autoCfgUrl, 'Config 工作表');
        resolvedConfigSource = autoCfgUrl;
      } catch {
        // Optional Config tab
      }
    }

    const parsed = parseAnyDeckText(deckText, configCsvText);
    return {
      config: parsed.config,
      deck: parsed.deck,
      source: `${normalizedDeck} (${parsed.format})`,
      configSource: resolvedConfigSource,
      deckUrl: rawDeck,
      configUrl: rawConfig,
      isFallback: false,
    };
  }

  const sampleConfigPath = path.join(DATA_DIR, 'sample-config.csv');
  const sampleDeckPath = path.join(DATA_DIR, 'sample-deck.csv');
  const cfgText = fs.readFileSync(sampleConfigPath, 'utf8');
  const deckText = fs.readFileSync(sampleDeckPath, 'utf8');
  const builtInHash = crypto.createHash('sha1').update(cfgText + '\n' + deckText).digest('hex').slice(0, 12);
  const { deck, inlineConfig } = rowsToDeck(parseCSV(deckText));
  const config = sanitizeConfig({ ...rowsToConfig(parseCSV(cfgText)), ...inlineConfig });

  return {
    config,
    deck,
    builtInHash,
    source: 'sample-deck.csv (中學招生說明會全模式展示範本 15 頁)',
    configSource: 'sample-config.csv',
    deckUrl: '',
    configUrl: '',
    isFallback: true,
  };
}

/**
 * Parse raw CSV / Markdown / JSON strings uploaded directly from /admin.
 */
export function loadDeckFromCsvTexts({ deckCsv, configCsv = '', sourceLabel = '本機匯入檔案' }) {
  const parsed = parseAnyDeckText(deckCsv, configCsv);
  return {
    config: parsed.config,
    deck: parsed.deck,
    source: `${sourceLabel} (${parsed.format})`,
    configSource: configCsv ? '本機匯入 Config' : '',
    deckUrl: '',
    configUrl: '',
    isFallback: false,
  };
}

const PRESET_LABELS = {
  default: '中學招生說明會 — 全功能展示範本（6大互動 × 9種簡報版型，共15頁）',
  lecture: '用 AI 改善工作流 — 教師研習完整講座版（28頁：自介＋架構＋成績系統＋四大類工具）',
  'parent-orientation': '115 學年度新生入學說明會（淺色主題範例）',
};

function csvEscape(val) {
  const s = String(val ?? '').replace(/\r?\n/g, '\\n');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function deckToCsvText(deck = []) {
  const cols = [
    'order', 'mode', 'layout', 'title', 'subtitle', 'body', 'media_url', 'image_prompt',
    'opt_1', 'opt_2', 'opt_3', 'opt_4', 'opt_5', 'correct_opt', 'explanation', 'timer_sec', 'speaker_note',
  ];
  const lines = [cols.join(',')];
  for (const s of deck) {
    const opts = {};
    for (const o of s.options || []) opts[o.key] = o.label;
    lines.push([
      s.order, s.mode, s.layout || '', s.title, s.subtitle || '', s.body || '',
      s.mediaUrl || '', s.imagePrompt || '',
      opts.opt_1 || '', opts.opt_2 || '', opts.opt_3 || '', opts.opt_4 || '', opts.opt_5 || '',
      s.correctOpt || '', s.explanation || '', s.timerSec || 0, s.speakerNote || '',
    ].map(csvEscape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function listPresets() {
  const presets = [{ id: 'default', label: PRESET_LABELS.default }];
  const decksDir = path.join(DATA_DIR, 'decks');
  if (fs.existsSync(decksDir)) {
    const seen = new Set();
    for (const f of fs.readdirSync(decksDir)) {
      if (f.endsWith('.config.csv')) continue;
      if (!f.endsWith('.csv') && !f.endsWith('.md') && !f.endsWith('.json')) continue;
      const id = f.replace(/\.(csv|md|json)$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      presets.push({ id, label: PRESET_LABELS[id] || id });
    }
  }
  return presets;
}

export async function loadPreset(presetId = 'default') {
  const cleanId = String(presetId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId || cleanId === 'default') {
    const pkg = await loadDeckPackage({});
    return { ...pkg, isFallback: false };
  }
  const decksDir = path.join(DATA_DIR, 'decks');
  const candidateExts = ['.md', '.json', '.csv'];
  let deckPath = '';
  for (const ext of candidateExts) {
    const p = path.join(decksDir, `${cleanId}${ext}`);
    if (fs.existsSync(p)) {
      deckPath = p;
      break;
    }
  }
  if (!deckPath) {
    throw new Error(`找不到內建範本：${cleanId}`);
  }
  const cfgPath = path.join(decksDir, `${cleanId}.config.csv`);
  const deckText = fs.readFileSync(deckPath, 'utf8');
  const configCsv = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  return loadDeckFromCsvTexts({
    deckCsv: deckText,
    configCsv,
    sourceLabel: `preset:${cleanId} (${PRESET_LABELS[cleanId] || cleanId})`,
  });
}
