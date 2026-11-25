import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { deckToCsvText, listPresets, loadDeckFromCsvTexts, loadDeckPackage, loadPreset } from './sheets.mjs';
import { createRoomStore, sanitizeRoomId } from './store.mjs';
import { generateBatchImagePrompts, generateSlideIllustration, saveDataUrlImage } from './media.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');

export function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function getLanUrls(port = 3000) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  if (urls.length === 0) urls.push(`http://localhost:${port}`);
  return urls;
}

export function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function readJsonBody(req, maxBytes = 65536) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function createAppContext() {
  loadEnvFile();
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const defaultRoom = sanitizeRoomId(process.env.DEFAULT_ROOM || 'main');
  const adminPassword = process.env.ADMIN_PASSWORD || '2026';
  const remoteToken =
    process.env.REMOTE_TOKEN ||
    crypto.createHash('sha256').update(`sdi-remote:${adminPassword}`).digest('hex').slice(0, 12);

  let defaultPackage;
  try {
    defaultPackage = await loadDeckPackage({
      deckUrl: process.env.DEFAULT_DECK_CSV_URL || '',
      configUrl: process.env.DEFAULT_CONFIG_CSV_URL || '',
    });
  } catch (err) {
    console.error('[預設題庫載入失敗，改用內建範本]', err.message);
    defaultPackage = await loadDeckPackage({});
  }

  const presetMap = {};
  for (const p of listPresets()) {
    if (p.id === 'default') continue;
    try {
      presetMap[p.id] = await loadPreset(p.id);
    } catch {
      // Ignore optional broken preset
    }
  }

  const store = createRoomStore(defaultPackage, presetMap);

  // Cache HTML pages in memory for fast serving (local/persistent Node; Vercel serves public/ directly)
  const htmlCache = {};
  for (const name of ['index', 'mobile', 'admin', 'remote']) {
    const htmlPath = path.join(PUBLIC_DIR, `${name}.html`);
    if (fs.existsSync(htmlPath)) {
      const raw = fs.readFileSync(htmlPath);
      htmlCache[name] = { raw, gzip: zlib.gzipSync(raw) };
    }
  }

  // SSE clients per room (only active in non-serverless MemoryStore mode)
  const mobileClients = new Map(); // roomId -> Set<res>
  const stageClients = new Map();

  function addClient(map, roomId, res) {
    if (!map.has(roomId)) map.set(roomId, new Set());
    map.get(roomId).add(res);
  }
  function removeClient(map, roomId, res) {
    map.get(roomId)?.delete(res);
  }

  const stageBroadcastTimers = new Map();
  function scheduleRoomBroadcast(roomId, eventType) {
    if (eventType === 'state' || eventType === 'deck') {
      const mSet = mobileClients.get(roomId);
      if (mSet && mSet.size > 0) {
        store.getMobileState(roomId).then((st) => {
          const payload = `data: ${JSON.stringify(st)}\n\n`;
          for (const res of mSet) res.write(payload);
        });
      }
    }
    const sSet = stageClients.get(roomId);
    if (!sSet || sSet.size === 0 || stageBroadcastTimers.has(roomId)) return;
    const t = setTimeout(async () => {
      stageBroadcastTimers.delete(roomId);
      const st = await store.getStageState(roomId);
      const payload = `data: ${JSON.stringify(st)}\n\n`;
      for (const res of sSet) res.write(payload);
    }, 70);
    stageBroadcastTimers.set(roomId, t);
  }

  // Subscribe MemoryStore rooms dynamically as SSE connects
  const hookedRooms = new Set();
  function ensureRoomHook(roomId) {
    if (store.kind !== 'memory' || hookedRooms.has(roomId)) return;
    hookedRooms.add(roomId);
    store.subscribe(roomId, (ev) => scheduleRoomBroadcast(roomId, ev));
  }

  function isAuthorized(req, body) {
    const headerPass = req.headers['x-admin-password'] || '';
    const pass = headerPass || body?.password || '';
    return pass === adminPassword || pass === remoteToken;
  }

  function isStagePresenterAuthorized(req, body) {
    if (isAuthorized(req, body)) return true;
    const host = String(req.headers.host || '');
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return true;
    return false;
  }

  function sendHtml(req, res, name) {
    const asset = htmlCache[name];
    if (!asset) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const acceptEnc = req.headers['accept-encoding'] || '';
    if (acceptEnc.includes('gzip')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-cache',
      });
      res.end(asset.gzip);
    } else {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(asset.raw);
    }
  }

  function keepAliveHeartbeat() {
    for (const set of mobileClients.values()) {
      for (const res of set) res.write(': ping\n\n');
    }
    for (const set of stageClients.values()) {
      for (const res of set) res.write(': ping\n\n');
    }
  }

  async function handleRequest(req, res) {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;
    const roomId = sanitizeRoomId(reqUrl.searchParams.get('room') || defaultRoom);
    const isVercel = process.env.VERCEL === '1';

    try {
      // Page routes (local Node; on Vercel, vercel.json serves static files directly)
      if (req.method === 'GET' && pathname === '/') return sendHtml(req, res, 'index');
      if (req.method === 'GET' && (pathname === '/m' || pathname === '/pc')) return sendHtml(req, res, 'mobile');
      if (req.method === 'GET' && pathname === '/admin') return sendHtml(req, res, 'admin');
      if (req.method === 'GET' && pathname === '/remote') return sendHtml(req, res, 'remote');

      // Global short-link redirector (/go/:slug, /api/go?slug=..., or Vercel rewrite ?go_slug=...)
      if (req.method === 'GET' && (pathname.startsWith('/go/') || pathname === '/api/go' || reqUrl.searchParams.has('go_slug'))) {
        const rawSlug = reqUrl.searchParams.has('go_slug')
          ? reqUrl.searchParams.get('go_slug') || ''
          : pathname === '/api/go'
            ? reqUrl.searchParams.get('slug') || ''
            : decodeURIComponent(pathname.slice(4).split('/')[0] || '');
        const lookupRoom = reqUrl.searchParams.get('room') ? roomId : defaultRoom;
        const found = await store.resolveShortLink(lookupRoom, rawSlug);
        if (found && /^https?:\/\//i.test(found.url)) {
          res.writeHead(302, {
            Location: found.url,
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>找不到短網址</title></head><body style="font-family:sans-serif;background:#090f1f;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center"><div style="max-width:440px;background:#121b30;border:1px solid #24324d;border-radius:18px;padding:28px"><h2 style="margin:0 0 10px">找不到短網址 <code>/go/${rawSlug.replace(/[<>&"]/g, '')}</code></h2><p style="color:#94a3b8;line-height:1.6">請確認代碼是否正確，或直接進入筆電同步入口查看全部實作連結。</p><a href="/pc" style="display:inline-block;margin-top:12px;padding:12px 20px;border-radius:12px;background:#6366f1;color:#fff;text-decoration:none;font-weight:700">💻 前往筆電工作區 (/pc)</a></div></body></html>`);
        return;
      }

      // Static assets & local uploads
      if (req.method === 'GET' && (pathname.startsWith('/assets/') || pathname.startsWith('/uploads/'))) {
        const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(PUBLIC_DIR, rel);
        if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath)) {
          const ext = path.extname(filePath).toLowerCase();
          const mime =
            ext === '.svg' ? 'image/svg+xml' :
              ext === '.png' ? 'image/png' :
                ext === '.webp' ? 'image/webp' :
                  (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' :
                    'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
          res.end(fs.readFileSync(filePath));
          return;
        }
      }

      // Sample CSV downloads
      if (req.method === 'GET' && pathname === '/api/sample-deck.csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="sample-deck.csv"',
        });
        res.end(fs.readFileSync(path.join(DATA_DIR, 'sample-deck.csv')));
        return;
      }
      if (req.method === 'GET' && pathname === '/api/sample-config.csv') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="sample-config.csv"',
        });
        res.end(fs.readFileSync(path.join(DATA_DIR, 'sample-config.csv')));
        return;
      }

      // QR Code SVG generator
      if (req.method === 'GET' && pathname === '/api/qr.svg') {
        const target = reqUrl.searchParams.get('url') || `${getLanUrls(port)[0]}/m?room=${encodeURIComponent(roomId)}`;
        const svg = await QRCode.toString(target, {
          type: 'svg',
          margin: 1,
          color: { dark: '#0f172a', light: '#ffffff' },
        });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        res.end(svg);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/network-info') {
        return sendJson(res, 200, {
          port,
          urls: isVercel ? [] : getLanUrls(port),
          isVercel,
          storageKind: store.kind,
          defaultRoom,
        });
      }

      // Mobile state (CDN s-maxage=2 on Vercel absorbs 1,000~3,000 concurrent phones!)
      if (req.method === 'GET' && pathname === '/api/state') {
        const mobileState = await store.getMobileState(roomId);
        const sse = store.kind === 'memory' && !isVercel;
        const cacheHeaders = isVercel
          ? { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=2' }
          : { 'Cache-Control': 'no-store' };
        return sendJson(res, 200, { ...mobileState, sse, pollMs: isVercel ? 3000 : 1500 }, cacheHeaders);
      }

      // Presets listing
      if (req.method === 'GET' && pathname === '/api/presets') {
        return sendJson(res, 200, { presets: listPresets() });
      }

      // Stage state (supports ?sheet=... & ?config=... & ?preset=... initialization)
      if (req.method === 'GET' && pathname === '/api/stage-state') {
        const sheetUrl = reqUrl.searchParams.get('sheet') || '';
        const configUrl = reqUrl.searchParams.get('config') || '';
        const presetId = reqUrl.searchParams.get('preset') || '';
        if (sheetUrl) {
          await store.ensureRoomInitialized(roomId, { sheetUrl, configUrl });
        } else if (presetId) {
          const loaded = await loadPreset(presetId);
          await store.setDeckPackage(roomId, loaded, { explicitLock: true });
        }
        const stageState = await store.getStageState(roomId);
        return sendJson(res, 200, {
          ...stageState,
          storageKind: store.kind,
          isVercel,
          presenterAuthorized: isStagePresenterAuthorized(req, null),
        });
      }

      // SSE Streams (local/persistent Node only; Vercel tells client to use polling)
      if (req.method === 'GET' && pathname === '/api/stream/mobile') {
        if (store.kind !== 'memory' || isVercel) {
          return sendJson(res, 501, { ok: false, polling: true });
        }
        ensureRoomHook(roomId);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const initial = await store.getMobileState(roomId);
        res.write(`data: ${JSON.stringify(initial)}\n\n`);
        addClient(mobileClients, roomId, res);
        req.on('close', () => removeClient(mobileClients, roomId, res));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/stream/stage') {
        if (store.kind !== 'memory' || isVercel) {
          return sendJson(res, 501, { ok: false, polling: true });
        }
        ensureRoomHook(roomId);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const initial = await store.getStageState(roomId);
        res.write(`data: ${JSON.stringify(initial)}\n\n`);
        addClient(stageClients, roomId, res);
        req.on('close', () => removeClient(stageClients, roomId, res));
        return;
      }

      // High-concurrency mobile submission
      if (req.method === 'POST' && pathname === '/api/vote') {
        const body = await readJsonBody(req);
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const result = await store.submitVote(targetRoom, body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // Stage presenter & hotkeys (nextStep, prevSlide, goto, toggleQr, reload, burst, adjust)
      if (req.method === 'POST' && pathname === '/api/stage/control') {
        const body = await readJsonBody(req);
        if (!isStagePresenterAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '請輸入講師控場密碼以同步全場' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const { action } = body;
        if (action === 'next') await store.nextStep(targetRoom);
        else if (action === 'prev') await store.prevSlide(targetRoom);
        else if (action === 'goto') await store.gotoSlide(targetRoom, Number(body.index));
        else if (action === 'toggleQr') await store.toggleQr(targetRoom, body.value);
        else if (action === 'burst') await store.simulateBurst(targetRoom, Number(body.count) || 30);
        else if (action === 'adjust') await store.adjustVoteHotkey(targetRoom, Number(body.optNum), Number(body.delta) || 1);
        else if (action === 'reload') {
          const cur = await store.getStageState(targetRoom);
          const loaded = await loadDeckPackage({
            deckUrl: body.sheetUrl ?? cur.deckUrl,
            configUrl: body.configUrl ?? cur.configUrl,
          });
          await store.setDeckPackage(targetRoom, loaded, { explicitLock: Boolean(body.sheetUrl) });
        } else {
          return sendJson(res, 400, { ok: false, message: '未知操作' });
        }
        const stageState = await store.getStageState(targetRoom);
        return sendJson(res, 200, { ok: true, state: stageState });
      }

      // Admin Auth
      if (req.method === 'POST' && pathname === '/api/admin/login') {
        const body = await readJsonBody(req);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '控場密碼錯誤' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        return sendJson(res, 200, {
          ok: true,
          remoteToken,
          hasServerGeminiKey: Boolean(process.env.GEMINI_API_KEY),
          hasBlobStorage: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
          state: await store.getAdminState(targetRoom),
        });
      }

      // Admin State
      if (req.method === 'GET' && pathname === '/api/admin/state') {
        if (!isAuthorized(req, null)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        return sendJson(res, 200, {
          ...(await store.getAdminState(roomId)),
          remoteToken,
          hasServerGeminiKey: Boolean(process.env.GEMINI_API_KEY),
          hasBlobStorage: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
        });
      }

      // Admin Control
      if (req.method === 'POST' && pathname === '/api/admin/control') {
        const body = await readJsonBody(req);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const { action } = body;

        if (action === 'next') await store.nextStep(targetRoom);
        else if (action === 'prev') await store.prevSlide(targetRoom);
        else if (action === 'goto') await store.gotoSlide(targetRoom, Number(body.index));
        else if (action === 'phase') await store.setPhase(targetRoom, body.phase);
        else if (action === 'subStep') await store.setSubStep(targetRoom, body.subStep);
        else if (action === 'toggleQr') await store.toggleQr(targetRoom, body.value);
        else if (action === 'reset') await store.resetCurrentSlide(targetRoom);
        else if (action === 'spotlight') await store.setSpotlight(targetRoom, body.msgId || null);
        else if (action === 'hideMessage') await store.toggleHideMessage(targetRoom, body.msgId, body.hidden);
        else if (action === 'burst') await store.simulateBurst(targetRoom, Number(body.count) || 30);
        else if (action === 'adjust') await store.adjustVoteHotkey(targetRoom, Number(body.optNum), Number(body.delta) || 1);
        else return sendJson(res, 400, { ok: false, message: '未知指令' });

        return sendJson(res, 200, {
          ok: true,
          state: await store.getAdminState(targetRoom),
        });
      }

      // Admin Google Sheets Hot Reload
      if (req.method === 'POST' && pathname === '/api/admin/sheet') {
        const body = await readJsonBody(req);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const deckUrl = String(body.deckUrl || body.sheetUrl || '').trim();
        const configUrl = String(body.configUrl || '').trim();
        const loaded = await loadDeckPackage({ deckUrl, configUrl });
        await store.setDeckPackage(targetRoom, loaded, { explicitLock: true });
        return sendJson(res, 200, {
          ok: true,
          count: loaded.deck.length,
          source: loaded.source,
          state: await store.getAdminState(targetRoom),
        });
      }

      // Admin Built-in Preset Switch
      if (req.method === 'POST' && pathname === '/api/admin/preset') {
        const body = await readJsonBody(req);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const loaded = await loadPreset(body.presetId);
        await store.setDeckPackage(targetRoom, loaded, { explicitLock: true });
        return sendJson(res, 200, {
          ok: true,
          count: loaded.deck.length,
          source: loaded.source,
          state: await store.getAdminState(targetRoom),
        });
      }

      // Admin Direct CSV Upload Import
      if (req.method === 'POST' && pathname === '/api/admin/upload-csv') {
        const body = await readJsonBody(req, 524288);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const loaded = loadDeckFromCsvTexts({
          deckCsv: String(body.deckCsv || ''),
          configCsv: String(body.configCsv || ''),
          sourceLabel: String(body.sourceLabel || '本機 CSV 上傳匯入'),
        });
        await store.setDeckPackage(targetRoom, loaded, { explicitLock: true });
        return sendJson(res, 200, {
          ok: true,
          count: loaded.deck.length,
          source: loaded.source,
          state: await store.getAdminState(targetRoom),
        });
      }

      // Admin Upload Slide Image / PDF Page to Vercel Blob (or local uploads)
      if (req.method === 'POST' && pathname === '/api/admin/upload-media') {
        const body = await readJsonBody(req, 4500000);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const saved = await saveDataUrlImage({
          dataUrl: body.dataUrl,
          filenamePrefix: body.filenamePrefix || 'slide',
        });
        return sendJson(res, 200, { ok: true, url: saved.url, storage: saved.storage });
      }

      // Admin Batch Visual Metaphor Prompt Generator (fast text model)
      if (req.method === 'POST' && pathname === '/api/admin/generate-prompts') {
        const body = await readJsonBody(req);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const curState = await store.getAdminState(targetRoom);
        const apiKey = req.headers['x-gemini-api-key'] || body.geminiApiKey || '';
        const prompts = await generateBatchImagePrompts({
          apiKey,
          slides: body.slides || [],
          styleLabel: body.styleLabel || '現代扁平向量插畫',
          bgTheme: curState.config?.bg_theme || 'DARK_NEBULA',
          primaryColor: curState.config?.primary_color || '#6366f1',
        });
        return sendJson(res, 200, { ok: true, prompts });
      }

      // Admin AI Generate Illustration (Gemini Nano Banana 2.1 -> SVG fallback -> Vercel Blob)
      if (req.method === 'POST' && pathname === '/api/admin/generate-image') {
        const body = await readJsonBody(req);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        const curState = await store.getAdminState(targetRoom);
        const apiKey = req.headers['x-gemini-api-key'] || body.geminiApiKey || '';
        const saved = await generateSlideIllustration({
          apiKey,
          prompt: body.prompt || '',
          title: body.title || '',
          subtitle: body.subtitle || '',
          bgTheme: curState.config?.bg_theme || 'DARK_NEBULA',
          primaryColor: curState.config?.primary_color || '#6366f1',
        });
        if (body.slideIndex !== undefined && body.slideIndex !== null) {
          await store.mutateDeck(targetRoom, {
            op: 'setSlideMedia',
            index: Number(body.slideIndex),
            mediaUrl: saved.url,
            imagePrompt: body.prompt || '',
          });
        }
        return sendJson(res, 200, {
          ok: true,
          url: saved.url,
          storage: saved.storage,
          model: saved.model || '',
          state: await store.getAdminState(targetRoom),
        });
      }

      // Admin Visual Deck Editor (upsert, move, delete, batchSlides, updateConfig)
      if (req.method === 'POST' && pathname === '/api/admin/deck-edit') {
        const body = await readJsonBody(req, 2097152);
        if (!isAuthorized(req, body)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const targetRoom = sanitizeRoomId(body.roomId || roomId);
        if (body.op === 'updateConfig') {
          await store.updateConfig(targetRoom, body.config || {});
        } else {
          await store.mutateDeck(targetRoom, body);
        }
        return sendJson(res, 200, {
          ok: true,
          state: await store.getAdminState(targetRoom),
        });
      }

      // Admin Export current deck as CSV
      if (req.method === 'GET' && pathname === '/api/admin/export-csv') {
        if (!isAuthorized(req, null)) {
          return sendJson(res, 401, { ok: false, message: '未授權' });
        }
        const st = await store.getAdminState(roomId);
        const csv = deckToCsvText(st.deckList || []);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="deck-${roomId}.csv"`,
        });
        res.end(csv);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      sendJson(res, 500, { ok: false, message: err?.message || 'Internal Server Error' });
    }
  }

  return {
    port,
    defaultRoom,
    adminPassword,
    remoteToken,
    store,
    handleRequest,
    keepAliveHeartbeat,
  };
}
