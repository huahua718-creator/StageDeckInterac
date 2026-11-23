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
]);

export const VALID_THEMES = new Set([
  'DARK_NEBULA',
  'CLEAN_LIGHT',
  'TECH_GRID',
]);

export const DEFAULT_CONFIG = {
  event_title: '用 AI 改善工作流──邁向優雅的教師生活',
  event_subtitle: '個人研習互動式講座 × 千人現場即時互動系統',
  primary_color: '#6366f1',
  bg_theme: 'DARK_NEBULA',
  logo_url: '',
  join_url_display: '',
};

/**
 * Parse RFC 4180 CSV text into an array of row arrays.
 * Handles UTF-8 BOM, CRLF/LF, and quoted fields with commas/newlines.
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
 * Normalize a Google Sheets URL to a CSV export URL when possible.
 */
export function normalizeSheetCsvUrl(rawUrl, sheetName = '') {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
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

    // Allow inline CONFIG rows inside a single-sheet Deck CSV
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

    let layout = get(r, 'layout').toUpperCase();
    if (mode === 'SLIDE') {
      layout = VALID_LAYOUTS.has(layout) ? layout : 'BULLETS';
    } else {
      layout = '';
    }

    const body = get(r, 'body');
    const mediaUrl = normalizeMediaUrl(get(r, 'media_url'));
    const options = [];
    for (let k = 1; k <= 5; k++) {
      const val = get(r, `opt_${k}`);
      if (val) options.push({ key: `opt_${k}`, label: val });
    }

    const timerSec = Math.max(0, Number.parseInt(get(r, 'timer_sec'), 10) || 0);
    const bullets = mode === 'SLIDE' && (layout === 'BULLETS' || layout === 'QUOTE') ? splitBodyBullets(body) : [];
    const columns = mode === 'SLIDE' && layout === 'SPLIT' ? splitBodyColumns(body) : { left: [], right: [] };

    deck.push({
      id: `s_${order}_${mode}_${rIdx}`,
      order,
      mode,
      layout,
      title,
      subtitle: get(r, 'subtitle'),
      body,
      bullets,
      columns,
      mediaUrl,
      options,
      correctOpt: get(r, 'correct_opt'),
      explanation: get(r, 'explanation'),
      timerSec,
      speakerNote: get(r, 'speaker_note'),
    });
  }

  deck.sort((a, b) => a.order - b.order);
  if (deck.length === 0) {
    throw new Error('Deck 試算表中沒有任何有效頁面（mode 需為 SLIDE/BUBBLE/SPECTRUM/MYTH/QUADRANT/TREE/DANMAKU）');
  }

  return { deck, inlineConfig };
}

async function fetchCsvText(url, label = 'Google Sheets') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${label} 回應錯誤 HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      throw new Error(`${label} 取得 HTML 而非 CSV，請確認已「發布到網路」並選 CSV 格式`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load both Config and Deck from Google Sheets URLs or local sample CSVs.
 */
export async function loadDeckPackage({ deckUrl = '', configUrl = '' } = {}) {
  const rawDeck = String(deckUrl || '').trim();
  const rawConfig = String(configUrl || '').trim();
  const normalizedDeck = normalizeSheetCsvUrl(rawDeck);

  if (normalizedDeck) {
    const deckText = await fetchCsvText(normalizedDeck, 'Deck 工作表');
    const { deck, inlineConfig } = rowsToDeck(parseCSV(deckText));

    let configObj = {};
    let resolvedConfigSource = '';
    const explicitConfigUrl = normalizeSheetCsvUrl(rawConfig);

    if (explicitConfigUrl) {
      const cfgText = await fetchCsvText(explicitConfigUrl, 'Config 工作表');
      configObj = rowsToConfig(parseCSV(cfgText));
      resolvedConfigSource = explicitConfigUrl;
    } else if (/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9-_]+/.test(rawDeck) && !rawDeck.includes('/d/e/')) {
      // Auto-try reading the "Config" tab on standard Google Sheets links
      const autoCfgUrl = normalizeSheetCsvUrl(rawDeck, 'Config');
      try {
        const cfgText = await fetchCsvText(autoCfgUrl, 'Config 工作表');
        configObj = rowsToConfig(parseCSV(cfgText));
        resolvedConfigSource = autoCfgUrl;
      } catch {
        configObj = sanitizeConfig(inlineConfig);
      }
    } else {
      configObj = sanitizeConfig(inlineConfig);
    }

    // Inline CONFIG rows override defaults if explicit config didn't specify them
    const finalConfig = sanitizeConfig({ ...configObj, ...inlineConfig });

    return {
      config: finalConfig,
      deck,
      source: normalizedDeck,
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
    source: 'sample-deck.csv (用 AI 改善工作流 18 頁研習版)',
    configSource: 'sample-config.csv',
    deckUrl: '',
    configUrl: '',
    isFallback: true,
  };
}

/**
 * Parse raw CSV strings uploaded directly from /admin or presets.
 */
export function loadDeckFromCsvTexts({ deckCsv, configCsv = '', sourceLabel = '本機匯入 CSV' }) {
  const { deck, inlineConfig } = rowsToDeck(parseCSV(deckCsv));
  const baseCfg = configCsv ? rowsToConfig(parseCSV(configCsv)) : {};
  const config = sanitizeConfig({ ...baseCfg, ...inlineConfig });
  return {
    config,
    deck,
    source: sourceLabel,
    configSource: configCsv ? '本機匯入 Config' : '',
    deckUrl: '',
    configUrl: '',
    isFallback: false,
  };
}

const PRESET_LABELS = {
  default: '用 AI 改善工作流──邁向優雅的教師生活（18頁研習版）',
  'parent-orientation': '115 學年度新生入學說明會（範例範本）',
};

export function listPresets() {
  const presets = [{ id: 'default', label: PRESET_LABELS.default }];
  const decksDir = path.join(DATA_DIR, 'decks');
  if (fs.existsSync(decksDir)) {
    for (const f of fs.readdirSync(decksDir)) {
      if (!f.endsWith('.csv') || f.endsWith('.config.csv')) continue;
      const id = f.slice(0, -4);
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
  const deckPath = path.join(decksDir, `${cleanId}.csv`);
  if (!fs.existsSync(deckPath)) {
    throw new Error(`找不到內建範本：${cleanId}`);
  }
  const cfgPath = path.join(decksDir, `${cleanId}.config.csv`);
  const deckCsv = fs.readFileSync(deckPath, 'utf8');
  const configCsv = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  return loadDeckFromCsvTexts({
    deckCsv,
    configCsv,
    sourceLabel: `preset:${cleanId} (${PRESET_LABELS[cleanId] || cleanId})`,
  });
}
