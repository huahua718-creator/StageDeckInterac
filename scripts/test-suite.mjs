import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  parseCSV,
  normalizeSheetCsvUrl,
  normalizeMediaUrl,
  rowsToConfig,
  rowsToDeck,
  loadDeckPackage,
  listPresets,
  loadPreset,
  loadDeckFromCsvTexts,
} from '../src/sheets.mjs';
import { MemoryRoomStore } from '../src/store.mjs';
import { createAppContext } from '../src/router.mjs';
import vercelHandler from '../api/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('1. Testing CSV parser & URL normalizers...');
  const csv = '\uFEFFkey,value\r\nevent_title,"AI, Workshop"\r\nprimary_color,#10b981\r\nbg_theme,CLEAN_LIGHT\r\n';
  const rows = parseCSV(csv);
  assert.equal(rows.length, 4);
  const cfg = rowsToConfig(rows);
  assert.equal(cfg.event_title, 'AI, Workshop');
  assert.equal(cfg.primary_color, '#10b981');
  assert.equal(cfg.bg_theme, 'CLEAN_LIGHT');

  assert.equal(
    normalizeMediaUrl('https://drive.google.com/file/d/1AbCDefG123/view?usp=sharing'),
    'https://drive.google.com/thumbnail?id=1AbCDefG123&sz=w1600'
  );
  assert.equal(normalizeMediaUrl('*(可放系統架構圖或試算表截圖)*'), '');
  assert.equal(
    normalizeSheetCsvUrl('https://docs.google.com/spreadsheets/d/1XYZ/edit#gid=42'),
    'https://docs.google.com/spreadsheets/d/1XYZ/export?format=csv&gid=42'
  );
  assert.equal(
    normalizeSheetCsvUrl('https://docs.google.com/document/d/1DocAbc/edit?usp=sharing'),
    'https://docs.google.com/document/d/1DocAbc/export?format=txt'
  );
  assert.equal(
    normalizeSheetCsvUrl('https://drive.google.com/file/d/1DriveFile/view?usp=sharing'),
    'https://drive.google.com/uc?export=download&id=1DriveFile'
  );

  console.log('2. Testing 18-slide workshop package, presets & CSV/JSON export...');
  const pkg = await loadDeckPackage({});
  assert.equal(pkg.deck.length, 18, 'Default workshop deck should have 18 slides');
  assert.equal(pkg.config.primary_color, '#6366f1');
  assert.equal(pkg.config.event_subtitle, '高中教師增能研習工作坊');

  const presets = listPresets();
  assert.ok(presets.some((p) => p.id === 'parent-orientation'));
  const parentPkg = await loadPreset('parent-orientation');
  assert.equal(parentPkg.config.bg_theme, 'CLEAN_LIGHT');
  assert.equal(parentPkg.deck.length, 5);

  const jsonPkg = loadDeckFromCsvTexts({
    deckCsv: JSON.stringify({
      config: { event_title: 'JSON Deck', primary_color: '#10b981' },
      deck: [{ order: 1, mode: 'SLIDE', layout: 'CARDS', title: 'Steps', body: 'S1|A|B::S2|C|D', image_prompt: 'AI robot teacher' }],
    }),
  });
  assert.equal(jsonPkg.config.event_title, 'JSON Deck');
  assert.equal(jsonPkg.deck[0].imagePrompt, 'AI robot teacher');

  const uploadedPkg = loadDeckFromCsvTexts({
    deckCsv: 'order,mode,layout,title,body\n1,SLIDE,COVER,Test Import,Sub\n',
    configCsv: 'key,value\nevent_title,Imported Workshop\nprimary_color,#ec4899\n',
  });
  assert.equal(uploadedPkg.config.event_title, 'Imported Workshop');
  assert.equal(uploadedPkg.config.primary_color, '#ec4899');

  const inlineDeckRows = parseCSV(
    'order,mode,layout,title,body\n' +
    '0,CONFIG,event_title,,Custom Event\n' +
    '1,SLIDE,BULLETS,Intro,A|B|C\n' +
    '2,SLIDE,SPLIT,Compare,Left 1|Left 2::Right 1|Right 2\n'
  );
  const parsedInline = rowsToDeck(inlineDeckRows);
  assert.equal(parsedInline.inlineConfig.event_title, 'Custom Event');
  assert.deepEqual(parsedInline.deck[0].bullets, ['A', 'B', 'C']);
  assert.deepEqual(parsedInline.deck[1].columns.left, ['Left 1', 'Left 2']);
  assert.deepEqual(parsedInline.deck[1].columns.right, ['Right 1', 'Right 2']);

  console.log('3. Testing Step State Machine (BULLETS progressive reveal + MYTH READY/VOTING/REVEALED)...');
  const customPkg = await loadDeckPackage({});
  const store = new MemoryRoomStore(customPkg);

  // Find BULLETS slide (order 5 in sample-deck.csv)
  const bulletsIdx = customPkg.deck.findIndex((s) => s.mode === 'SLIDE' && s.layout === 'BULLETS');
  assert.ok(bulletsIdx >= 0);
  await store.gotoSlide('roomA', bulletsIdx);
  let st = await store.getStageState('roomA');
  assert.equal(st.subStep, 0);
  const maxBullets = st.bullets.length;
  for (let i = 1; i <= maxBullets; i++) {
    await store.nextStep('roomA');
    st = await store.getStageState('roomA');
    assert.equal(st.idx, bulletsIdx);
    assert.equal(st.subStep, i);
  }
  // Next press after all bullets advances to next slide
  await store.nextStep('roomA');
  st = await store.getStageState('roomA');
  assert.equal(st.idx, bulletsIdx + 1);
  assert.equal(st.subStep, 0);

  // Find MYTH slide
  const mythIdx = customPkg.deck.findIndex((s) => s.mode === 'MYTH');
  assert.ok(mythIdx >= 0);
  await store.gotoSlide('roomA', mythIdx);
  st = await store.getStageState('roomA');
  assert.equal(st.phase, 'READY');
  // Vote blocked during READY
  const rReady = await store.submitVote('roomA', { slideId: st.slideId, uuid: 'u1', payload: { optKey: 'opt_2' } });
  assert.equal(rReady.ok, false);
  // Advance to VOTING
  await store.nextStep('roomA');
  st = await store.getStageState('roomA');
  assert.equal(st.phase, 'VOTING');
  // Vote succeeds + deduplication works
  const rVote1 = await store.submitVote('roomA', { slideId: st.slideId, uuid: 'u1', payload: { optKey: 'opt_2' } });
  assert.equal(rVote1.ok, true);
  const rVoteDup = await store.submitVote('roomA', { slideId: st.slideId, uuid: 'u1', payload: { optKey: 'opt_1' } });
  assert.equal(rVoteDup.ok, false);
  assert.equal(rVoteDup.code, 'DUPLICATE');
  // Mobile hides correctOpt before REVEALED
  const mobBefore = await store.getMobileState('roomA');
  assert.equal(mobBefore.correctOpt, undefined);
  // Advance to REVEALED
  await store.nextStep('roomA');
  const mobAfter = await store.getMobileState('roomA');
  assert.equal(mobAfter.phase, 'REVEALED');
  assert.equal(mobAfter.correctOpt, 'opt_3');

  console.log('4. Testing DANMAKU profanity filter & mobile payload budget (< 80 KB)...');
  const dmIdx = customPkg.deck.findIndex((s) => s.mode === 'DANMAKU');
  await store.gotoSlide('roomA', dmIdx);
  st = await store.getStageState('roomA');
  const dmRes = await store.submitVote('roomA', {
    slideId: st.slideId,
    uuid: 'u2',
    payload: { tag: '提問', text: '這不是垃圾問題，請問怎麼用？' },
  });
  assert.equal(dmRes.ok, true);
  st = await store.getStageState('roomA');
  assert.ok(st.stats.messages[0].text.includes('***'));

  const mobileSize = fs.statSync(path.join(ROOT_DIR, 'public/mobile.html')).size;
  console.log(`   mobile.html size: ${(mobileSize / 1024).toFixed(2)} KB (limit: 80 KB)`);
  assert.ok(mobileSize < 80 * 1024, 'mobile.html must be under 80 KB');

  console.log('5. Testing live HTTP router endpoints (/, /m, /admin, /remote, /api/state, /api/vote)...');
  const ctx = await createAppContext();
  const srv = http.createServer((req, res) => ctx.handleRequest(req, res));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    for (const p of ['/', '/m', '/admin', '/remote', '/assets/workflow-diagram.svg', '/assets/agent-demo-diagram.svg', '/api/presets', '/api/sample-deck.csv', '/api/sample-config.csv']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, `GET ${p} should return 200`);
    }
    const qrRes = await fetch(`${base}/api/qr.svg?url=${encodeURIComponent(base + '/m')}`);
    assert.equal(qrRes.status, 200);
    assert.ok((await qrRes.text()).includes('<svg'));

    const stateRes = await fetch(`${base}/api/state?room=testroom`);
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.roomId, 'testroom');
    assert.equal(stateJson.speakerNote, undefined); // never exposed to mobile!

    // Test admin login + goto + all interactive modes + stage hotkey control
    const loginRes = await fetch(`${base}/api/admin/login?room=testroom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'testroom', password: ctx.adminPassword }),
    });
    assert.equal(loginRes.status, 200);
    const loginJson = await loginRes.json();
    assert.ok(loginJson.state.speakerNote.length > 0);

    for (const mode of ['QUADRANT', 'BUBBLE', 'SPECTRUM', 'TREE']) {
      const idx = pkg.deck.findIndex((s) => s.mode === mode);
      const gotoRes = await fetch(`${base}/api/admin/control?room=testroom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': ctx.adminPassword },
        body: JSON.stringify({ roomId: 'testroom', action: 'goto', index: idx }),
      });
      assert.equal(gotoRes.status, 200);
      const gJson = await gotoRes.json();
      const slideId = gJson.state.slideId;
      const payload =
        mode === 'BUBBLE' ? { optKey: 'opt_1' } :
        mode === 'SPECTRUM' ? { score: 75 } :
        mode === 'QUADRANT' ? { x: 40, y: 80 } :
        { text: '測試祝福' };
      const vRes = await fetch(`${base}/api/vote?room=testroom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'testroom', slideId, uuid: 'http_u1', payload }),
      });
      assert.equal(vRes.status, 200);
    }

    // Test Visual Deck Editor (batchSlides, upsert, move, delete, export-csv, upload-media)
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const upRes = await fetch(`${base}/api/admin/upload-media?room=editorroom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': ctx.adminPassword },
      body: JSON.stringify({ dataUrl: tinyPng, filenamePrefix: 'test' }),
    });
    assert.equal(upRes.status, 200);
    const upJson = await upRes.json();
    assert.ok(upJson.url);
    if (upJson.url.startsWith('/uploads/')) {
      const imgGet = await fetch(`${base}${upJson.url}`);
      assert.equal(imgGet.status, 200);
      // Clean up temporary test upload file
      const uploadedFilePath = path.join(ROOT_DIR, 'public', upJson.url);
      if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath);
    }

    const batchRes = await fetch(`${base}/api/admin/deck-edit?room=editorroom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': ctx.adminPassword },
      body: JSON.stringify({
        roomId: 'editorroom',
        op: 'batchSlides',
        slides: [
          { mode: 'SLIDE', layout: 'MEDIA', title: 'PDF Page 1', mediaUrl: upJson.url },
          { mode: 'SLIDE', layout: 'MEDIA', title: 'PDF Page 2', mediaUrl: upJson.url },
        ],
      }),
    });
    assert.equal(batchRes.status, 200);
    const batchJson = await batchRes.json();
    assert.equal(batchJson.state.total, 2);

    const insertRes = await fetch(`${base}/api/admin/deck-edit?room=editorroom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': ctx.adminPassword },
      body: JSON.stringify({
        roomId: 'editorroom',
        op: 'upsert',
        afterIndex: 0,
        slideData: { mode: 'BUBBLE', title: 'Inserted Poll', opt_1: 'A', opt_2: 'B' },
      }),
    });
    assert.equal(insertRes.status, 200);
    const insJson = await insertRes.json();
    assert.equal(insJson.state.total, 3);
    assert.equal(insJson.state.deckList[1].mode, 'BUBBLE');

    const expRes = await fetch(`${base}/api/admin/export-csv?room=editorroom`, {
      headers: { 'x-admin-password': ctx.adminPassword },
    });
    assert.equal(expRes.status, 200);
    assert.ok((await expRes.text()).includes('Inserted Poll'));

    const batchMediaRes = await fetch(`${base}/api/admin/deck-edit?room=editorroom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': ctx.adminPassword },
      body: JSON.stringify({
        roomId: 'editorroom',
        op: 'batchSlideMedia',
        updates: [{ index: 0, mediaUrl: '/assets/workflow-diagram.svg', imagePrompt: 'test prompt' }],
      }),
    });
    assert.equal(batchMediaRes.status, 200);
    const bmJson = await batchMediaRes.json();
    assert.equal(bmJson.state.deckList[0].mediaUrl, '/assets/workflow-diagram.svg');

    // Verify Vercel serverless entrypoint works cleanly
    const mockServer = http.createServer((req, res) => vercelHandler(req, res));
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const vAddr = mockServer.address();
    const vCheck = await fetch(`http://127.0.0.1:${vAddr.port}/api/state?room=vercelcheck`);
    assert.equal(vCheck.status, 200);
    mockServer.close();
  } finally {
    srv.close();
  }

  console.log('✅ All automated tests passed!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
