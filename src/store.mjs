import { buildSlideObject, DEFAULT_CONFIG, loadDeckPackage, sanitizeConfig } from './sheets.mjs';

const BAD_WORDS = [
  '幹你娘', '靠北', '靠腰', '白痴', '智障', '垃圾', '去死', 'fuck', 'shit', 'bitch', 'asshole',
];

export function filterSensitiveText(input) {
  let text = String(input || '').replace(/[\r\n\t]+/g, ' ').trim();
  for (const w of BAD_WORDS) {
    const re = new RegExp(w, 'gi');
    text = text.replace(re, '***');
  }
  return text;
}

export function sanitizeRoomId(raw) {
  const clean = String(raw || 'main').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return (clean || 'main').slice(0, 32);
}

export function getSlideMaxSubSteps(slide) {
  if (!slide) return 0;
  if (slide.mode === 'SLIDE' && slide.layout === 'BULLETS') {
    return Array.isArray(slide.bullets) ? slide.bullets.length : 0;
  }
  return 0;
}

export function getInitialPhaseForSlide(slide) {
  if (!slide) return 'VOTING';
  if (slide.mode === 'MYTH') return 'READY';
  return 'VOTING';
}

function createResponseBucket(slide) {
  const counts = {};
  for (const opt of slide.options || []) {
    counts[opt.key] = 0;
  }
  return {
    voters: new Set(),
    totalVotes: 0,
    counts,
    sumScore: 0,
    sumX: 0,
    sumY: 0,
    points: [],
    blessings: [],
    messages: [],
    spotlightId: null,
    lastDanmakuByUuid: new Map(),
  };
}

function resolveEffectivePhase(session, slide) {
  if (!slide) return session.phase;
  if (
    slide.mode !== 'SLIDE' &&
    session.phase === 'VOTING' &&
    session.timerEndsAt > 0 &&
    Date.now() >= session.timerEndsAt
  ) {
    return 'LOCKED';
  }
  return session.phase;
}

function formatMobilePayload(session, slide, config, deckLen) {
  const phase = resolveEffectivePhase(session, slide);
  if (!slide) {
    return {
      v: session.version,
      roomId: session.roomId,
      config,
      idx: 0,
      total: 0,
      phase: 'LOCKED',
    };
  }
  const base = {
    v: session.version,
    roomId: session.roomId,
    config,
    idx: session.currentIndex,
    total: deckLen,
    slideId: slide.id,
    order: slide.order,
    mode: slide.mode,
    layout: slide.layout,
    title: slide.title,
    subtitle: slide.subtitle,
    body: slide.body,
    bullets: slide.bullets,
    columns: slide.columns,
    diagramCode: slide.diagramCode || '',
    chartSpec: slide.chartSpec || null,
    cardsSpec: slide.cardsSpec || null,
    mediaUrl: slide.mediaUrl,
    options: slide.options,
    phase,
    subStep: session.subStep,
    timerEndsAt: phase === 'VOTING' ? session.timerEndsAt : 0,
  };
  if (slide.mode === 'MYTH' && phase === 'REVEALED') {
    base.correctOpt = slide.correctOpt;
    base.explanation = slide.explanation;
  }
  return base;
}

function toBuildArgs(item, order, rIdx) {
  const options = Array.isArray(item.options)
    ? item.options.filter((o) => o && o.label).map((o, i) => ({ key: o.key || `opt_${i + 1}`, label: String(o.label).trim() }))
    : [1, 2, 3, 4, 5]
        .filter((k) => item[`opt_${k}`])
        .map((k) => ({ key: `opt_${k}`, label: String(item[`opt_${k}`]).trim() }));
  return buildSlideObject({
    order,
    mode: item.mode || 'SLIDE',
    layout: item.layout || '',
    title: item.title || `第 ${order} 頁`,
    subtitle: item.subtitle || '',
    body: item.body || '',
    mediaUrl: item.mediaUrl || item.media_url || '',
    imagePrompt: item.imagePrompt || item.image_prompt || '',
    options,
    correctOpt: item.correctOpt || item.correct_opt || '',
    explanation: item.explanation || '',
    timerSec: Math.max(0, Number.parseInt(item.timerSec ?? item.timer_sec, 10) || 0),
    speakerNote: item.speakerNote || item.speaker_note || '',
    diagramCode: item.diagramCode || '',
    rIdx,
  });
}

function mutateDeckArray(currentDeck, opPayload) {
  const next = currentDeck.slice();
  const { op } = opPayload;

  if (op === 'upsert') {
    const { afterIndex, replaceIndex, slideData } = opPayload;
    if (replaceIndex !== undefined && replaceIndex !== null && replaceIndex >= 0 && replaceIndex < next.length) {
      const old = next[replaceIndex];
      const built = toBuildArgs(slideData, replaceIndex + 1, replaceIndex + 1);
      if (old.mode === built.mode) built.id = old.id;
      next[replaceIndex] = built;
    } else {
      const insertAt =
        afterIndex !== undefined && afterIndex !== null && afterIndex >= -1 && afterIndex < next.length
          ? afterIndex + 1
          : next.length;
      const built = toBuildArgs(slideData, insertAt + 1, Date.now() % 100000);
      next.splice(insertAt, 0, built);
    }
  } else if (op === 'move') {
    const idx = Number(opPayload.index);
    const dir = Number(opPayload.direction) < 0 ? -1 : 1;
    const target = idx + dir;
    if (idx >= 0 && idx < next.length && target >= 0 && target < next.length) {
      [next[idx], next[target]] = [next[target], next[idx]];
    }
  } else if (op === 'delete') {
    const idx = Number(opPayload.index);
    if (next.length > 1 && idx >= 0 && idx < next.length) {
      next.splice(idx, 1);
    }
  } else if (op === 'batchSlides') {
    const incoming = (opPayload.slides || []).map((s, i) => toBuildArgs(s, i + 1, Date.now() % 10000 + i));
    if (incoming.length === 0) throw new Error('沒有可匯入的頁面');
    if (opPayload.append) {
      next.push(...incoming);
    } else {
      next.splice(0, next.length, ...incoming);
    }
  } else if (op === 'setSlideMedia') {
    const idx = Number(opPayload.index);
    if (idx >= 0 && idx < next.length) {
      const cur = next[idx];
      next[idx] = toBuildArgs(
        {
          ...cur,
          mediaUrl: opPayload.mediaUrl !== undefined ? opPayload.mediaUrl : cur.mediaUrl,
          imagePrompt: opPayload.imagePrompt !== undefined ? opPayload.imagePrompt : cur.imagePrompt,
        },
        idx + 1,
        idx + 1
      );
      next[idx].id = cur.id;
    }
  } else if (op === 'batchSlideMedia') {
    for (const u of opPayload.updates || []) {
      const idx = Number(u.index);
      if (idx >= 0 && idx < next.length) {
        const cur = next[idx];
        next[idx] = toBuildArgs(
          {
            ...cur,
            mediaUrl: u.mediaUrl !== undefined ? u.mediaUrl : cur.mediaUrl,
            imagePrompt: u.imagePrompt !== undefined ? u.imagePrompt : cur.imagePrompt,
          },
          idx + 1,
          idx + 1
        );
        next[idx].id = cur.id;
      }
    }
  } else {
    throw new Error('不支援的編排操作');
  }

  return next.map((s, i) => ({ ...s, order: i + 1 }));
}

function mapAdminDeckList(deck) {
  return deck.map((s, index) => ({
    index,
    id: s.id,
    order: s.order,
    mode: s.mode,
    layout: s.layout,
    title: s.title,
    subtitle: s.subtitle,
    body: s.body,
    mediaUrl: s.mediaUrl,
    imagePrompt: s.imagePrompt || '',
    options: s.options || [],
    correctOpt: s.correctOpt || '',
    explanation: s.explanation || '',
    timerSec: s.timerSec,
    bulletsCount: getSlideMaxSubSteps(s),
    speakerNote: s.speakerNote,
  }));
}

/**
 * In-memory multi-room store (used locally or on persistent Node.js hosts with SSE).
 */
export class MemoryRoomStore {
  constructor(defaultPackage) {
    this.kind = 'memory';
    this.defaultPackage = defaultPackage;
    this.rooms = new Map();
    this.listeners = new Map(); // roomId -> Set<fn>
  }

  subscribe(roomId, fn) {
    const id = sanitizeRoomId(roomId);
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(fn);
    return () => this.listeners.get(id)?.delete(fn);
  }

  _notify(roomId, eventType = 'state') {
    const set = this.listeners.get(roomId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(eventType);
      } catch {
        // Ignore listener error
      }
    }
  }

  _ensureRoom(roomId) {
    const id = sanitizeRoomId(roomId);
    if (this.rooms.has(id)) return this.rooms.get(id);
    const pkg = this.defaultPackage;
    const firstSlide = pkg.deck[0] || null;
    const room = {
      roomId: id,
      config: sanitizeConfig(pkg.config),
      deck: pkg.deck,
      source: pkg.source,
      configSource: pkg.configSource || '',
      deckUrl: pkg.deckUrl || '',
      configUrl: pkg.configUrl || '',
      explicitSheetLock: false,
      responses: new Map(),
      session: {
        roomId: id,
        currentIndex: 0,
        subStep: 0,
        phase: getInitialPhaseForSlide(firstSlide),
        timerEndsAt: 0,
        qrVisible: true,
        version: 1,
      },
    };
    this.rooms.set(id, room);
    return room;
  }

  async ensureRoomInitialized(roomId, { sheetUrl = '', configUrl = '', force = false } = {}) {
    const room = this._ensureRoom(roomId);
    const cleanSheet = String(sheetUrl || '').trim();
    if (cleanSheet && (force || (!room.explicitSheetLock && room.deckUrl !== cleanSheet))) {
      const pkg = await loadDeckPackage({ deckUrl: cleanSheet, configUrl });
      await this.setDeckPackage(room.roomId, pkg, { explicitLock: force });
    }
    return room;
  }

  async setDeckPackage(roomId, pkg, { explicitLock = true } = {}) {
    const room = this._ensureRoom(roomId);
    room.config = sanitizeConfig(pkg.config);
    room.deck = pkg.deck;
    room.source = pkg.source;
    room.configSource = pkg.configSource || '';
    room.deckUrl = pkg.deckUrl || '';
    room.configUrl = pkg.configUrl || '';
    if (explicitLock) room.explicitSheetLock = true;

    for (const s of room.deck) {
      if (!room.responses.has(s.order)) {
        room.responses.set(s.order, createResponseBucket(s));
      } else {
        const b = room.responses.get(s.order);
        for (const opt of s.options || []) {
          if (!(opt.key in b.counts)) b.counts[opt.key] = 0;
        }
      }
    }

    if (room.session.currentIndex >= room.deck.length) {
      room.session.currentIndex = 0;
      room.session.subStep = 0;
    }
    const cur = room.deck[room.session.currentIndex];
    const maxSub = getSlideMaxSubSteps(cur);
    if (room.session.subStep > maxSub) room.session.subStep = maxSub;
    room.session.version++;
    this._notify(room.roomId, 'deck');
    return room;
  }

  _getBucket(room, slide) {
    if (!slide) return null;
    if (!room.responses.has(slide.order)) {
      room.responses.set(slide.order, createResponseBucket(slide));
    }
    return room.responses.get(slide.order);
  }

  _activateSlide(room, index) {
    if (index < 0 || index >= room.deck.length) return false;
    const slide = room.deck[index];
    const phase = getInitialPhaseForSlide(slide);
    room.session.currentIndex = index;
    room.session.subStep = 0;
    room.session.phase = phase;
    room.session.timerEndsAt =
      phase === 'VOTING' && slide.mode !== 'SLIDE' && slide.timerSec > 0
        ? Date.now() + slide.timerSec * 1000
        : 0;
    room.session.version++;
    this._notify(room.roomId, 'state');
    return true;
  }

  async nextStep(roomId) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    if (!cur) return false;

    const maxSub = getSlideMaxSubSteps(cur);
    if (cur.mode === 'SLIDE' && maxSub > 0 && room.session.subStep < maxSub) {
      room.session.subStep++;
      room.session.version++;
      this._notify(room.roomId, 'state');
      return true;
    }

    if (cur.mode === 'MYTH') {
      const effPhase = resolveEffectivePhase(room.session, cur);
      if (effPhase === 'READY') {
        room.session.phase = 'VOTING';
        room.session.timerEndsAt = cur.timerSec > 0 ? Date.now() + cur.timerSec * 1000 : 0;
        room.session.version++;
        this._notify(room.roomId, 'state');
        return true;
      }
      if (effPhase === 'VOTING' || effPhase === 'LOCKED') {
        room.session.phase = 'REVEALED';
        room.session.timerEndsAt = 0;
        room.session.version++;
        this._notify(room.roomId, 'state');
        return true;
      }
    }

    if (room.session.currentIndex + 1 < room.deck.length) {
      return this._activateSlide(room, room.session.currentIndex + 1);
    }
    return false;
  }

  async prevSlide(roomId) {
    const room = this._ensureRoom(roomId);
    if (room.session.currentIndex > 0) {
      return this._activateSlide(room, room.session.currentIndex - 1);
    }
    return false;
  }

  async gotoSlide(roomId, index) {
    const room = this._ensureRoom(roomId);
    return this._activateSlide(room, index);
  }

  async setPhase(roomId, newPhase) {
    if (!['READY', 'VOTING', 'LOCKED', 'REVEALED'].includes(newPhase)) return false;
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    room.session.phase = newPhase;
    room.session.timerEndsAt =
      newPhase === 'VOTING' && cur && cur.mode !== 'SLIDE' && cur.timerSec > 0
        ? Date.now() + cur.timerSec * 1000
        : 0;
    room.session.version++;
    this._notify(room.roomId, 'state');
    return true;
  }

  async setSubStep(roomId, subStep) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    const maxSub = getSlideMaxSubSteps(cur);
    room.session.subStep = Math.max(0, Math.min(maxSub, Number(subStep) || 0));
    room.session.version++;
    this._notify(room.roomId, 'state');
    return true;
  }

  async toggleQr(roomId, value) {
    const room = this._ensureRoom(roomId);
    room.session.qrVisible = value === undefined ? !room.session.qrVisible : Boolean(value);
    room.session.version++;
    this._notify(room.roomId, 'state');
    return room.session.qrVisible;
  }

  async resetCurrentSlide(roomId) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    if (!cur) return false;
    room.responses.set(cur.order, createResponseBucket(cur));
    room.session.phase = getInitialPhaseForSlide(cur);
    room.session.timerEndsAt =
      room.session.phase === 'VOTING' && cur.mode !== 'SLIDE' && cur.timerSec > 0
        ? Date.now() + cur.timerSec * 1000
        : 0;
    room.session.version++;
    this._notify(room.roomId, 'data');
    return true;
  }

  async setSpotlight(roomId, msgId) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    const b = this._getBucket(room, cur);
    if (!b) return false;
    b.spotlightId = msgId || null;
    room.session.version++;
    this._notify(room.roomId, 'data');
    return true;
  }

  async toggleHideMessage(roomId, msgId, hidden) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    const b = this._getBucket(room, cur);
    if (!b) return false;
    const msg = b.messages.find((m) => m.id === msgId);
    if (!msg) return false;
    msg.hidden = Boolean(hidden);
    if (msg.hidden && b.spotlightId === msgId) b.spotlightId = null;
    room.session.version++;
    this._notify(room.roomId, 'data');
    return true;
  }

  async adjustVoteHotkey(roomId, optNum, delta = 1) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    const b = this._getBucket(room, cur);
    if (!cur || !b || cur.mode === 'SLIDE') return false;
    const key = `opt_${optNum}`;
    if (key in b.counts) {
      b.counts[key] = Math.max(0, b.counts[key] + delta);
      b.totalVotes = Math.max(0, b.totalVotes + delta);
      room.session.version++;
      this._notify(room.roomId, 'data');
      return true;
    }
    return false;
  }

  async simulateBurst(roomId, count = 30) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    const b = this._getBucket(room, cur);
    if (!cur || !b || cur.mode === 'SLIDE') return false;

    for (let i = 0; i < count; i++) {
      const fakeId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (cur.mode === 'BUBBLE' || cur.mode === 'MYTH') {
        const opts = cur.options || [];
        if (opts.length > 0) {
          const pick = opts[Math.floor(Math.random() * opts.length)].key;
          b.counts[pick] = (b.counts[pick] || 0) + 1;
          b.totalVotes++;
        }
      } else if (cur.mode === 'SPECTRUM') {
        const score = Math.round(Math.random() * 100);
        b.sumScore += score;
        if (score < 50 && cur.options[0]) b.counts[cur.options[0].key]++;
        else if (cur.options[1]) b.counts[cur.options[1].key]++;
        b.totalVotes++;
      } else if (cur.mode === 'QUADRANT') {
        const x = Math.round(20 + Math.random() * 65);
        const y = Math.round(20 + Math.random() * 65);
        b.sumX += x;
        b.sumY += y;
        b.totalVotes++;
        b.points.push({ x, y });
        if (b.points.length > 3000) b.points.shift();
      } else if (cur.mode === 'TREE') {
        const samples = ['準時下班！', '少一點公文', '陪孩子吃晚餐', '多一點備課靈感', '優雅生活✨'];
        b.totalVotes++;
        b.blessings.push({ id: fakeId, text: samples[i % samples.length], ts: Date.now() });
        if (b.blessings.length > 300) b.blessings.shift();
      } else if (cur.mode === 'DANMAKU') {
        if (i < 5) {
          const qs = [
            '想要自動產出週報的工具！',
            '班親會通知單一鍵翻譯排版',
            '段考題庫自動檢查難度分佈',
            '學生作業缺交自動提醒機器人',
            '請問 Google Sheets 要怎麼發布 CSV？',
          ];
          const tag = cur.options?.[i % Math.max(1, cur.options.length)]?.label || '許願';
          b.messages.push({ id: fakeId, tag, text: qs[i % qs.length], ts: Date.now(), hidden: false });
          if (b.messages.length > 500) b.messages.shift();
          b.totalVotes++;
        }
      }
    }
    room.session.version++;
    this._notify(room.roomId, 'data');
    return true;
  }

  async submitVote(roomId, { slideId, order, uuid, payload }) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex];
    if (!cur || cur.mode === 'SLIDE') {
      return { ok: false, code: 'NOT_INTERACTIVE', message: '目前為簡報講義頁，請專注聆聽講解' };
    }
    if ((slideId && slideId !== cur.id) || (order !== undefined && Number(order) !== cur.order)) {
      return { ok: false, code: 'STALE_SLIDE', message: '頁面已切換，請作答目前畫面' };
    }
    const phase = resolveEffectivePhase(room.session, cur);
    if (phase !== 'VOTING') {
      return { ok: false, code: 'LOCKED', message: phase === 'READY' ? '題目尚未開始作答' : '本題已截止作答' };
    }
    const cleanUuid = String(uuid || '').trim().slice(0, 64);
    if (!cleanUuid) {
      return { ok: false, code: 'MISSING_UUID', message: '缺少裝置識別碼' };
    }

    const b = this._getBucket(room, cur);

    if (cur.mode === 'DANMAKU') {
      const now = Date.now();
      const last = b.lastDanmakuByUuid.get(cleanUuid) || 0;
      if (now - last < 3000) {
        return { ok: false, code: 'RATE_LIMIT', message: '發送太快了，請稍候 3 秒再試' };
      }
      const rawText = String(payload?.text || '').trim();
      if (!rawText) return { ok: false, code: 'EMPTY', message: '請輸入留言內容' };
      const text = filterSensitiveText(rawText).slice(0, 60);
      const tag = String(payload?.tag || '許願').slice(0, 12);
      const msg = {
        id: `m_${now}_${Math.random().toString(36).slice(2, 7)}`,
        tag,
        text,
        ts: now,
        hidden: false,
      };
      b.messages.push(msg);
      if (b.messages.length > 500) b.messages.shift();
      b.totalVotes++;
      b.voters.add(cleanUuid);
      b.lastDanmakuByUuid.set(cleanUuid, now);
      room.session.version++;
      this._notify(room.roomId, 'data');
      return { ok: true, message: '已送出至大螢幕！', id: msg.id };
    }

    if (b.voters.has(cleanUuid)) {
      return { ok: false, code: 'DUPLICATE', message: '您已完成本題作答' };
    }

    if (cur.mode === 'BUBBLE' || cur.mode === 'MYTH') {
      const optKey = String(payload?.optKey || '');
      if (!(optKey in b.counts)) {
        return { ok: false, code: 'INVALID_OPTION', message: '無效的選項' };
      }
      b.voters.add(cleanUuid);
      b.counts[optKey]++;
      b.totalVotes++;
      room.session.version++;
      this._notify(room.roomId, 'data');
      return { ok: true, message: '作答已送出！' };
    }

    if (cur.mode === 'SPECTRUM') {
      const score = Number(payload?.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        return { ok: false, code: 'INVALID_SCORE', message: '數值需介於 0 ~ 100' };
      }
      b.voters.add(cleanUuid);
      b.sumScore += score;
      if (score < 50 && cur.options[0]) b.counts[cur.options[0].key]++;
      else if (cur.options[1]) b.counts[cur.options[1].key]++;
      b.totalVotes++;
      room.session.version++;
      this._notify(room.roomId, 'data');
      return { ok: true, message: '傾向已送出！' };
    }

    if (cur.mode === 'QUADRANT') {
      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
        return { ok: false, code: 'INVALID_COORDS', message: '座標需介於 0 ~ 100' };
      }
      b.voters.add(cleanUuid);
      b.sumX += x;
      b.sumY += y;
      b.totalVotes++;
      b.points.push({ x, y });
      if (b.points.length > 3000) b.points.shift();
      room.session.version++;
      this._notify(room.roomId, 'data');
      return { ok: true, message: '落點已送出！' };
    }

    if (cur.mode === 'TREE') {
      const rawText = String(payload?.text || '').trim();
      const text = rawText ? filterSensitiveText(rawText).slice(0, 20) : '點亮願景燈火 ✨';
      b.voters.add(cleanUuid);
      b.totalVotes++;
      b.blessings.push({
        id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        ts: Date.now(),
      });
      if (b.blessings.length > 300) b.blessings.shift();
      room.session.version++;
      this._notify(room.roomId, 'data');
      return { ok: true, message: '已點亮願景燈火！' };
    }

    return { ok: false, code: 'UNSUPPORTED', message: '不支援的互動模式' };
  }

  async getMobileState(roomId) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex] || null;
    return formatMobilePayload(room.session, cur, room.config, room.deck.length);
  }

  async getStageState(roomId) {
    const room = this._ensureRoom(roomId);
    const cur = room.deck[room.session.currentIndex] || null;
    const mobile = formatMobilePayload(room.session, cur, room.config, room.deck.length);
    const b = this._getBucket(room, cur);
    const stats = b
      ? {
          totalVotes: b.totalVotes,
          counts: b.counts,
          avgSpectrum: b.totalVotes > 0 ? Math.round((b.sumScore / b.totalVotes) * 10) / 10 : 50,
          avgX: b.totalVotes > 0 ? Math.round((b.sumX / b.totalVotes) * 10) / 10 : 50,
          avgY: b.totalVotes > 0 ? Math.round((b.sumY / b.totalVotes) * 10) / 10 : 50,
          recentPoints: b.points.slice(-600),
          recentBlessings: b.blessings.slice(-40),
          messages: b.messages.filter((m) => !m.hidden).slice(-80),
          spotlightId: b.spotlightId,
        }
      : null;

    return {
      ...mobile,
      correctOpt: cur?.correctOpt || '',
      explanation: cur?.explanation || '',
      qrVisible: room.session.qrVisible,
      deckSource: room.source,
      deckUrl: room.deckUrl,
      configUrl: room.configUrl,
      mediaUrls: room.deck.map((s) => s.mediaUrl).filter(Boolean),
      deckOverview: room.deck.map((s, index) => ({
        index,
        order: s.order,
        mode: s.mode,
        layout: s.layout,
        title: s.title,
      })),
      stats,
    };
  }

  async getAdminState(roomId) {
    const room = this._ensureRoom(roomId);
    const stage = await this.getStageState(roomId);
    const cur = room.deck[room.session.currentIndex] || null;
    const nextSlide = room.deck[room.session.currentIndex + 1] || null;
    const b = this._getBucket(room, cur);

    return {
      ...stage,
      storageKind: this.kind,
      speakerNote: cur?.speakerNote || '',
      nextSlide: nextSlide
        ? {
            order: nextSlide.order,
            mode: nextSlide.mode,
            layout: nextSlide.layout,
            title: nextSlide.title,
          }
        : null,
      deckList: mapAdminDeckList(room.deck),
      allMessages: b ? b.messages.slice().reverse() : [],
    };
  }

  async mutateDeck(roomId, opPayload) {
    const room = this._ensureRoom(roomId);
    const updatedDeck = mutateDeckArray(room.deck, opPayload);
    const prevIdx = room.session.currentIndex;
    room.deck = updatedDeck;
    room.explicitSheetLock = true;
    if (opPayload.op === 'batchSlides' && !opPayload.append) {
      room.source = opPayload.sourceLabel || 'PDF / 圖片簡報匯入';
      room.session.currentIndex = 0;
      room.session.subStep = 0;
      room.session.phase = getInitialPhaseForSlide(updatedDeck[0]);
    } else if (opPayload.op === 'upsert' && opPayload.jumpToNew && opPayload.replaceIndex === undefined) {
      const targetIdx = Math.min(updatedDeck.length - 1, Math.max(0, (opPayload.afterIndex ?? prevIdx) + 1));
      this._activateSlide(room, targetIdx);
      return room;
    } else if (room.session.currentIndex >= updatedDeck.length) {
      room.session.currentIndex = updatedDeck.length - 1;
      room.session.subStep = 0;
    }
    for (const s of updatedDeck) {
      if (!room.responses.has(s.order)) room.responses.set(s.order, createResponseBucket(s));
    }
    room.session.version++;
    this._notify(room.roomId, 'deck');
    return room;
  }

  async updateConfig(roomId, partialConfig) {
    const room = this._ensureRoom(roomId);
    room.config = sanitizeConfig({ ...room.config, ...partialConfig });
    room.explicitSheetLock = true;
    room.session.version++;
    this._notify(room.roomId, 'deck');
    return room;
  }
}

/**
 * Upstash Redis REST-backed multi-room store for 1,000~3,000 concurrent users on Vercel Serverless.
 */
export class UpstashRedisRoomStore {
  constructor(defaultPackage, { url, token }) {
    this.kind = 'redis';
    this.defaultPackage = defaultPackage;
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.roomTtlSec = 60 * 60 * 24; // 24 hours
  }

  subscribe() {
    return () => {};
  }

  async _cmd(args) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `Upstash Redis HTTP ${res.status}`);
    }
    return data.result;
  }

  async _pipeline(commands) {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Upstash Pipeline HTTP ${res.status}`);
    }
    return data.map((item) => item.result);
  }

  _keys(roomId) {
    const r = sanitizeRoomId(roomId);
    return {
      roomId: r,
      session: `sdi:${r}:session`,
      pkg: `sdi:${r}:pkg`,
      resp: (order) => `sdi:${r}:resp:${order}`,
      voters: (order) => `sdi:${r}:voters:${order}`,
      points: (order) => `sdi:${r}:pts:${order}`,
      blessings: (order) => `sdi:${r}:bless:${order}`,
      messages: (order) => `sdi:${r}:msgs:${order}`,
      hidden: (order) => `sdi:${r}:hidden:${order}`,
      dmCooldown: (order, uuid) => `sdi:${r}:dmcd:${order}:${uuid}`,
    };
  }

  async _loadRoom(roomId) {
    const k = this._keys(roomId);
    const [rawPkg, rawSession] = await this._pipeline([
      ['GET', k.pkg],
      ['GET', k.session],
    ]);

    if (rawPkg && rawSession) {
      const parsedPkg = JSON.parse(rawPkg);
      const parsedSession = JSON.parse(rawSession);
      if (
        !parsedPkg.explicitSheetLock &&
        this.defaultPackage.builtInHash &&
        parsedPkg.builtInHash !== this.defaultPackage.builtInHash
      ) {
        const refreshedPkg = {
          config: sanitizeConfig(this.defaultPackage.config),
          deck: this.defaultPackage.deck,
          builtInHash: this.defaultPackage.builtInHash,
          source: this.defaultPackage.source,
          configSource: this.defaultPackage.configSource || '',
          deckUrl: this.defaultPackage.deckUrl || '',
          configUrl: this.defaultPackage.configUrl || '',
          explicitSheetLock: false,
        };
        if (parsedSession.currentIndex >= refreshedPkg.deck.length) {
          parsedSession.currentIndex = 0;
          parsedSession.subStep = 0;
        }
        parsedSession.version = (parsedSession.version || 1) + 1;
        await this._pipeline([
          ['SET', k.pkg, JSON.stringify(refreshedPkg), 'EX', this.roomTtlSec],
          ['SET', k.session, JSON.stringify(parsedSession), 'EX', this.roomTtlSec],
        ]);
        return { roomId: k.roomId, pkg: refreshedPkg, session: parsedSession };
      }
      return {
        roomId: k.roomId,
        pkg: parsedPkg,
        session: parsedSession,
      };
    }

    const pkg = {
      config: sanitizeConfig(this.defaultPackage.config),
      deck: this.defaultPackage.deck,
      builtInHash: this.defaultPackage.builtInHash || '',
      source: this.defaultPackage.source,
      configSource: this.defaultPackage.configSource || '',
      deckUrl: this.defaultPackage.deckUrl || '',
      configUrl: this.defaultPackage.configUrl || '',
      explicitSheetLock: false,
    };
    const firstSlide = pkg.deck[0] || null;
    const session = {
      roomId: k.roomId,
      currentIndex: 0,
      subStep: 0,
      phase: getInitialPhaseForSlide(firstSlide),
      timerEndsAt: 0,
      qrVisible: true,
      version: 1,
    };
    await this._pipeline([
      ['SET', k.pkg, JSON.stringify(pkg), 'EX', this.roomTtlSec],
      ['SET', k.session, JSON.stringify(session), 'EX', this.roomTtlSec],
    ]);
    return { roomId: k.roomId, pkg, session };
  }

  async _saveSession(roomId, session) {
    const k = this._keys(roomId);
    session.version = (session.version || 1) + 1;
    await this._cmd(['SET', k.session, JSON.stringify(session), 'EX', this.roomTtlSec]);
  }

  async ensureRoomInitialized(roomId, { sheetUrl = '', configUrl = '', force = false } = {}) {
    const state = await this._loadRoom(roomId);
    const cleanSheet = String(sheetUrl || '').trim();
    if (cleanSheet && (force || (!state.pkg.explicitSheetLock && state.pkg.deckUrl !== cleanSheet))) {
      const loaded = await loadDeckPackage({ deckUrl: cleanSheet, configUrl });
      await this.setDeckPackage(state.roomId, loaded, { explicitLock: force });
    }
    return state;
  }

  async setDeckPackage(roomId, loaded, { explicitLock = true } = {}) {
    const state = await this._loadRoom(roomId);
    const k = this._keys(roomId);
    const pkg = {
      config: sanitizeConfig(loaded.config),
      deck: loaded.deck,
      builtInHash: loaded.builtInHash || this.defaultPackage.builtInHash || '',
      source: loaded.source,
      configSource: loaded.configSource || '',
      deckUrl: loaded.deckUrl || '',
      configUrl: loaded.configUrl || '',
      explicitSheetLock: explicitLock || state.pkg.explicitSheetLock,
    };
    if (state.session.currentIndex >= pkg.deck.length) {
      state.session.currentIndex = 0;
      state.session.subStep = 0;
    }
    const cur = pkg.deck[state.session.currentIndex];
    const maxSub = getSlideMaxSubSteps(cur);
    if (state.session.subStep > maxSub) state.session.subStep = maxSub;
    state.session.version = (state.session.version || 1) + 1;

    await this._pipeline([
      ['SET', k.pkg, JSON.stringify(pkg), 'EX', this.roomTtlSec],
      ['SET', k.session, JSON.stringify(state.session), 'EX', this.roomTtlSec],
    ]);
    return { roomId: k.roomId, pkg, session: state.session };
  }

  async _activateSlide(state, index) {
    if (index < 0 || index >= state.pkg.deck.length) return false;
    const slide = state.pkg.deck[index];
    const phase = getInitialPhaseForSlide(slide);
    state.session.currentIndex = index;
    state.session.subStep = 0;
    state.session.phase = phase;
    state.session.timerEndsAt =
      phase === 'VOTING' && slide.mode !== 'SLIDE' && slide.timerSec > 0
        ? Date.now() + slide.timerSec * 1000
        : 0;
    await this._saveSession(state.roomId, state.session);
    return true;
  }

  async nextStep(roomId) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    if (!cur) return false;

    const maxSub = getSlideMaxSubSteps(cur);
    if (cur.mode === 'SLIDE' && maxSub > 0 && state.session.subStep < maxSub) {
      state.session.subStep++;
      await this._saveSession(state.roomId, state.session);
      return true;
    }

    if (cur.mode === 'MYTH') {
      const effPhase = resolveEffectivePhase(state.session, cur);
      if (effPhase === 'READY') {
        state.session.phase = 'VOTING';
        state.session.timerEndsAt = cur.timerSec > 0 ? Date.now() + cur.timerSec * 1000 : 0;
        await this._saveSession(state.roomId, state.session);
        return true;
      }
      if (effPhase === 'VOTING' || effPhase === 'LOCKED') {
        state.session.phase = 'REVEALED';
        state.session.timerEndsAt = 0;
        await this._saveSession(state.roomId, state.session);
        return true;
      }
    }

    if (state.session.currentIndex + 1 < state.pkg.deck.length) {
      return this._activateSlide(state, state.session.currentIndex + 1);
    }
    return false;
  }

  async prevSlide(roomId) {
    const state = await this._loadRoom(roomId);
    if (state.session.currentIndex > 0) {
      return this._activateSlide(state, state.session.currentIndex - 1);
    }
    return false;
  }

  async gotoSlide(roomId, index) {
    const state = await this._loadRoom(roomId);
    return this._activateSlide(state, index);
  }

  async setPhase(roomId, newPhase) {
    if (!['READY', 'VOTING', 'LOCKED', 'REVEALED'].includes(newPhase)) return false;
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    state.session.phase = newPhase;
    state.session.timerEndsAt =
      newPhase === 'VOTING' && cur && cur.mode !== 'SLIDE' && cur.timerSec > 0
        ? Date.now() + cur.timerSec * 1000
        : 0;
    await this._saveSession(state.roomId, state.session);
    return true;
  }

  async setSubStep(roomId, subStep) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    const maxSub = getSlideMaxSubSteps(cur);
    state.session.subStep = Math.max(0, Math.min(maxSub, Number(subStep) || 0));
    await this._saveSession(state.roomId, state.session);
    return true;
  }

  async toggleQr(roomId, value) {
    const state = await this._loadRoom(roomId);
    state.session.qrVisible = value === undefined ? !state.session.qrVisible : Boolean(value);
    await this._saveSession(state.roomId, state.session);
    return state.session.qrVisible;
  }

  async resetCurrentSlide(roomId) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    if (!cur) return false;
    const k = this._keys(roomId);
    await this._pipeline([
      ['DEL', k.resp(cur.order), k.voters(cur.order), k.points(cur.order), k.blessings(cur.order), k.messages(cur.order), k.hidden(cur.order)],
    ]);
    state.session.phase = getInitialPhaseForSlide(cur);
    state.session.timerEndsAt =
      state.session.phase === 'VOTING' && cur.mode !== 'SLIDE' && cur.timerSec > 0
        ? Date.now() + cur.timerSec * 1000
        : 0;
    await this._saveSession(state.roomId, state.session);
    return true;
  }

  async setSpotlight(roomId, msgId) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    if (!cur) return false;
    const k = this._keys(roomId);
    if (msgId) {
      await this._cmd(['HSET', k.resp(cur.order), 'spotlightId', msgId]);
    } else {
      await this._cmd(['HDEL', k.resp(cur.order), 'spotlightId']);
    }
    return true;
  }

  async toggleHideMessage(roomId, msgId, hidden) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    if (!cur) return false;
    const k = this._keys(roomId);
    if (hidden) {
      await this._pipeline([
        ['SADD', k.hidden(cur.order), msgId],
        ['EXPIRE', k.hidden(cur.order), this.roomTtlSec],
      ]);
    } else {
      await this._cmd(['SREM', k.hidden(cur.order), msgId]);
    }
    return true;
  }

  async adjustVoteHotkey(roomId, optNum, delta = 1) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    if (!cur || cur.mode === 'SLIDE') return false;
    const key = `opt_${optNum}`;
    if (!cur.options.some((o) => o.key === key)) return false;
    const k = this._keys(roomId);
    await this._pipeline([
      ['HINCRBY', k.resp(cur.order), key, delta],
      ['HINCRBY', k.resp(cur.order), 'totalVotes', delta],
      ['EXPIRE', k.resp(cur.order), this.roomTtlSec],
    ]);
    return true;
  }

  async simulateBurst(roomId, count = 30) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    if (!cur || cur.mode === 'SLIDE') return false;
    const k = this._keys(roomId);
    const rk = k.resp(cur.order);
    const cmds = [];

    if (cur.mode === 'BUBBLE' || cur.mode === 'MYTH') {
      const opts = cur.options || [];
      if (opts.length > 0) {
        const tallies = {};
        for (let i = 0; i < count; i++) {
          const pick = opts[Math.floor(Math.random() * opts.length)].key;
          tallies[pick] = (tallies[pick] || 0) + 1;
        }
        for (const [optKey, inc] of Object.entries(tallies)) {
          cmds.push(['HINCRBY', rk, optKey, inc]);
        }
        cmds.push(['HINCRBY', rk, 'totalVotes', count]);
      }
    } else if (cur.mode === 'SPECTRUM') {
      let sum = 0;
      let left = 0;
      let right = 0;
      for (let i = 0; i < count; i++) {
        const s = Math.round(Math.random() * 100);
        sum += s;
        if (s < 50) left++;
        else right++;
      }
      cmds.push(['HINCRBYFLOAT', rk, 'sumScore', sum]);
      if (cur.options[0]) cmds.push(['HINCRBY', rk, cur.options[0].key, left]);
      if (cur.options[1]) cmds.push(['HINCRBY', rk, cur.options[1].key, right]);
      cmds.push(['HINCRBY', rk, 'totalVotes', count]);
    } else if (cur.mode === 'QUADRANT') {
      let sx = 0;
      let sy = 0;
      const pts = [];
      for (let i = 0; i < count; i++) {
        const x = Math.round(20 + Math.random() * 65);
        const y = Math.round(20 + Math.random() * 65);
        sx += x;
        sy += y;
        pts.push(JSON.stringify({ x, y }));
      }
      cmds.push(['HINCRBYFLOAT', rk, 'sumX', sx]);
      cmds.push(['HINCRBYFLOAT', rk, 'sumY', sy]);
      cmds.push(['HINCRBY', rk, 'totalVotes', count]);
      cmds.push(['RPUSH', k.points(cur.order), ...pts]);
      cmds.push(['LTRIM', k.points(cur.order), -3000, -1]);
      cmds.push(['EXPIRE', k.points(cur.order), this.roomTtlSec]);
    } else if (cur.mode === 'TREE') {
      const samples = ['準時下班！', '少一點公文', '陪孩子吃晚餐', '多一點備課靈感', '優雅生活✨'];
      const items = [];
      for (let i = 0; i < count; i++) {
        items.push(
          JSON.stringify({
            id: `sim_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
            text: samples[i % samples.length],
            ts: Date.now(),
          })
        );
      }
      cmds.push(['HINCRBY', rk, 'totalVotes', count]);
      cmds.push(['RPUSH', k.blessings(cur.order), ...items]);
      cmds.push(['LTRIM', k.blessings(cur.order), -300, -1]);
      cmds.push(['EXPIRE', k.blessings(cur.order), this.roomTtlSec]);
    } else if (cur.mode === 'DANMAKU') {
      const qs = [
        '想要自動產出週報的工具！',
        '班親會通知單一鍵翻譯排版',
        '段考題庫自動檢查難度分佈',
        '學生作業缺交自動提醒機器人',
        '請問 Google Sheets 要怎麼發布 CSV？',
      ];
      const items = qs.map((text, i) =>
        JSON.stringify({
          id: `sim_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          tag: cur.options?.[i % Math.max(1, cur.options.length)]?.label || '許願',
          text,
          ts: Date.now(),
        })
      );
      cmds.push(['HINCRBY', rk, 'totalVotes', items.length]);
      cmds.push(['RPUSH', k.messages(cur.order), ...items]);
      cmds.push(['LTRIM', k.messages(cur.order), -500, -1]);
      cmds.push(['EXPIRE', k.messages(cur.order), this.roomTtlSec]);
    }

    if (cmds.length > 0) {
      cmds.push(['EXPIRE', rk, this.roomTtlSec]);
      await this._pipeline(cmds);
    }
    return true;
  }

  async submitVote(roomId, { slideId, order, uuid, payload }) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex];
    if (!cur || cur.mode === 'SLIDE') {
      return { ok: false, code: 'NOT_INTERACTIVE', message: '目前為簡報講義頁，請專注聆聽講解' };
    }
    if ((slideId && slideId !== cur.id) || (order !== undefined && Number(order) !== cur.order)) {
      return { ok: false, code: 'STALE_SLIDE', message: '頁面已切換，請作答目前畫面' };
    }
    const phase = resolveEffectivePhase(state.session, cur);
    if (phase !== 'VOTING') {
      return { ok: false, code: 'LOCKED', message: phase === 'READY' ? '題目尚未開始作答' : '本題已截止作答' };
    }
    const cleanUuid = String(uuid || '').trim().slice(0, 64);
    if (!cleanUuid) {
      return { ok: false, code: 'MISSING_UUID', message: '缺少裝置識別碼' };
    }

    const k = this._keys(roomId);
    const rk = k.resp(cur.order);

    if (cur.mode === 'DANMAKU') {
      const cdKey = k.dmCooldown(cur.order, cleanUuid);
      const locked = await this._cmd(['SET', cdKey, '1', 'EX', 3, 'NX']);
      if (locked !== 'OK') {
        return { ok: false, code: 'RATE_LIMIT', message: '發送太快了，請稍候 3 秒再試' };
      }
      const rawText = String(payload?.text || '').trim();
      if (!rawText) return { ok: false, code: 'EMPTY', message: '請輸入留言內容' };
      const msg = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        tag: String(payload?.tag || '許願').slice(0, 12),
        text: filterSensitiveText(rawText).slice(0, 60),
        ts: Date.now(),
      };
      await this._pipeline([
        ['RPUSH', k.messages(cur.order), JSON.stringify(msg)],
        ['LTRIM', k.messages(cur.order), -500, -1],
        ['EXPIRE', k.messages(cur.order), this.roomTtlSec],
        ['HINCRBY', rk, 'totalVotes', 1],
        ['EXPIRE', rk, this.roomTtlSec],
      ]);
      return { ok: true, message: '已送出至大螢幕！', id: msg.id };
    }

    // Atomic idempotent deduplication
    const added = await this._cmd(['SADD', k.voters(cur.order), cleanUuid]);
    if (added === 0) {
      return { ok: false, code: 'DUPLICATE', message: '您已完成本題作答' };
    }

    if (cur.mode === 'BUBBLE' || cur.mode === 'MYTH') {
      const optKey = String(payload?.optKey || '');
      if (!cur.options.some((o) => o.key === optKey)) {
        await this._cmd(['SREM', k.voters(cur.order), cleanUuid]);
        return { ok: false, code: 'INVALID_OPTION', message: '無效的選項' };
      }
      await this._pipeline([
        ['EXPIRE', k.voters(cur.order), this.roomTtlSec],
        ['HINCRBY', rk, optKey, 1],
        ['HINCRBY', rk, 'totalVotes', 1],
        ['EXPIRE', rk, this.roomTtlSec],
      ]);
      return { ok: true, message: '作答已送出！' };
    }

    if (cur.mode === 'SPECTRUM') {
      const score = Number(payload?.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        await this._cmd(['SREM', k.voters(cur.order), cleanUuid]);
        return { ok: false, code: 'INVALID_SCORE', message: '數值需介於 0 ~ 100' };
      }
      const optCmd =
        score < 50 && cur.options[0]
          ? ['HINCRBY', rk, cur.options[0].key, 1]
          : cur.options[1]
            ? ['HINCRBY', rk, cur.options[1].key, 1]
            : null;
      const cmds = [
        ['EXPIRE', k.voters(cur.order), this.roomTtlSec],
        ['HINCRBYFLOAT', rk, 'sumScore', score],
        ['HINCRBY', rk, 'totalVotes', 1],
        ['EXPIRE', rk, this.roomTtlSec],
      ];
      if (optCmd) cmds.push(optCmd);
      await this._pipeline(cmds);
      return { ok: true, message: '傾向已送出！' };
    }

    if (cur.mode === 'QUADRANT') {
      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
        await this._cmd(['SREM', k.voters(cur.order), cleanUuid]);
        return { ok: false, code: 'INVALID_COORDS', message: '座標需介於 0 ~ 100' };
      }
      await this._pipeline([
        ['EXPIRE', k.voters(cur.order), this.roomTtlSec],
        ['HINCRBYFLOAT', rk, 'sumX', x],
        ['HINCRBYFLOAT', rk, 'sumY', y],
        ['HINCRBY', rk, 'totalVotes', 1],
        ['EXPIRE', rk, this.roomTtlSec],
        ['RPUSH', k.points(cur.order), JSON.stringify({ x, y })],
        ['LTRIM', k.points(cur.order), -3000, -1],
        ['EXPIRE', k.points(cur.order), this.roomTtlSec],
      ]);
      return { ok: true, message: '落點已送出！' };
    }

    if (cur.mode === 'TREE') {
      const rawText = String(payload?.text || '').trim();
      const text = rawText ? filterSensitiveText(rawText).slice(0, 20) : '點亮願景燈火 ✨';
      const item = {
        id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        ts: Date.now(),
      };
      await this._pipeline([
        ['EXPIRE', k.voters(cur.order), this.roomTtlSec],
        ['HINCRBY', rk, 'totalVotes', 1],
        ['EXPIRE', rk, this.roomTtlSec],
        ['RPUSH', k.blessings(cur.order), JSON.stringify(item)],
        ['LTRIM', k.blessings(cur.order), -300, -1],
        ['EXPIRE', k.blessings(cur.order), this.roomTtlSec],
      ]);
      return { ok: true, message: '已點亮願景燈火！' };
    }

    return { ok: false, code: 'UNSUPPORTED', message: '不支援的互動模式' };
  }

  async getMobileState(roomId) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex] || null;
    return formatMobilePayload(state.session, cur, state.pkg.config, state.pkg.deck.length);
  }

  _hashArrayToMap(arr) {
    const out = {};
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < arr.length; i += 2) {
      out[arr[i]] = arr[i + 1];
    }
    return out;
  }

  async _readStats(roomId, cur) {
    if (!cur) return { stats: null, allMessages: [] };
    const k = this._keys(roomId);
    const [rawHash, rawPts, rawBless, rawMsgs, rawHidden] = await this._pipeline([
      ['HGETALL', k.resp(cur.order)],
      ['LRANGE', k.points(cur.order), -600, -1],
      ['LRANGE', k.blessings(cur.order), -40, -1],
      ['LRANGE', k.messages(cur.order), -200, -1],
      ['SMEMBERS', k.hidden(cur.order)],
    ]);

    const h = this._hashArrayToMap(rawHash);
    const totalVotes = Number.parseInt(h.totalVotes || '0', 10) || 0;
    const counts = {};
    for (const o of cur.options || []) {
      counts[o.key] = Number.parseInt(h[o.key] || '0', 10) || 0;
    }
    const sumScore = Number.parseFloat(h.sumScore || '0') || 0;
    const sumX = Number.parseFloat(h.sumX || '0') || 0;
    const sumY = Number.parseFloat(h.sumY || '0') || 0;
    const hiddenSet = new Set(Array.isArray(rawHidden) ? rawHidden : []);
    const allMessages = (Array.isArray(rawMsgs) ? rawMsgs : [])
      .map((s) => {
        try {
          const m = JSON.parse(s);
          m.hidden = hiddenSet.has(m.id);
          return m;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return {
      stats: {
        totalVotes,
        counts,
        avgSpectrum: totalVotes > 0 ? Math.round((sumScore / totalVotes) * 10) / 10 : 50,
        avgX: totalVotes > 0 ? Math.round((sumX / totalVotes) * 10) / 10 : 50,
        avgY: totalVotes > 0 ? Math.round((sumY / totalVotes) * 10) / 10 : 50,
        recentPoints: (Array.isArray(rawPts) ? rawPts : []).map((s) => JSON.parse(s)),
        recentBlessings: (Array.isArray(rawBless) ? rawBless : []).map((s) => JSON.parse(s)),
        messages: allMessages.filter((m) => !m.hidden).slice(-80),
        spotlightId: h.spotlightId || null,
      },
      allMessages: allMessages.slice().reverse(),
    };
  }

  async getStageState(roomId) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex] || null;
    const mobile = formatMobilePayload(state.session, cur, state.pkg.config, state.pkg.deck.length);
    const { stats } = await this._readStats(roomId, cur);

    return {
      ...mobile,
      correctOpt: cur?.correctOpt || '',
      explanation: cur?.explanation || '',
      qrVisible: state.session.qrVisible,
      deckSource: state.pkg.source,
      deckUrl: state.pkg.deckUrl,
      configUrl: state.pkg.configUrl,
      mediaUrls: state.pkg.deck.map((s) => s.mediaUrl).filter(Boolean),
      deckOverview: state.pkg.deck.map((s, index) => ({
        index,
        order: s.order,
        mode: s.mode,
        layout: s.layout,
        title: s.title,
      })),
      stats,
    };
  }

  async getAdminState(roomId) {
    const state = await this._loadRoom(roomId);
    const cur = state.pkg.deck[state.session.currentIndex] || null;
    const nextSlide = state.pkg.deck[state.session.currentIndex + 1] || null;
    const mobile = formatMobilePayload(state.session, cur, state.pkg.config, state.pkg.deck.length);
    const { stats, allMessages } = await this._readStats(roomId, cur);

    return {
      ...mobile,
      correctOpt: cur?.correctOpt || '',
      explanation: cur?.explanation || '',
      qrVisible: state.session.qrVisible,
      deckSource: state.pkg.source,
      deckUrl: state.pkg.deckUrl,
      configUrl: state.pkg.configUrl,
      mediaUrls: state.pkg.deck.map((s) => s.mediaUrl).filter(Boolean),
      deckOverview: state.pkg.deck.map((s, index) => ({
        index,
        order: s.order,
        mode: s.mode,
        layout: s.layout,
        title: s.title,
      })),
      stats,
      storageKind: this.kind,
      speakerNote: cur?.speakerNote || '',
      nextSlide: nextSlide
        ? {
            order: nextSlide.order,
            mode: nextSlide.mode,
            layout: nextSlide.layout,
            title: nextSlide.title,
          }
        : null,
      deckList: mapAdminDeckList(state.pkg.deck),
      allMessages,
    };
  }

  async mutateDeck(roomId, opPayload) {
    const state = await this._loadRoom(roomId);
    const k = this._keys(roomId);
    const updatedDeck = mutateDeckArray(state.pkg.deck, opPayload);
    state.pkg.deck = updatedDeck;
    state.pkg.explicitSheetLock = true;

    if (opPayload.op === 'batchSlides' && !opPayload.append) {
      state.pkg.source = opPayload.sourceLabel || 'PDF / 圖片簡報匯入';
      state.session.currentIndex = 0;
      state.session.subStep = 0;
      state.session.phase = getInitialPhaseForSlide(updatedDeck[0]);
      state.session.timerEndsAt = 0;
    } else if (opPayload.op === 'upsert' && opPayload.jumpToNew && opPayload.replaceIndex === undefined) {
      const targetIdx = Math.min(updatedDeck.length - 1, Math.max(0, (opPayload.afterIndex ?? state.session.currentIndex) + 1));
      const slide = updatedDeck[targetIdx];
      state.session.currentIndex = targetIdx;
      state.session.subStep = 0;
      state.session.phase = getInitialPhaseForSlide(slide);
      state.session.timerEndsAt = 0;
    } else if (state.session.currentIndex >= updatedDeck.length) {
      state.session.currentIndex = updatedDeck.length - 1;
      state.session.subStep = 0;
    }

    state.session.version = (state.session.version || 1) + 1;
    await this._pipeline([
      ['SET', k.pkg, JSON.stringify(state.pkg), 'EX', this.roomTtlSec],
      ['SET', k.session, JSON.stringify(state.session), 'EX', this.roomTtlSec],
    ]);
    return state;
  }

  async updateConfig(roomId, partialConfig) {
    const state = await this._loadRoom(roomId);
    const k = this._keys(roomId);
    state.pkg.config = sanitizeConfig({ ...state.pkg.config, ...partialConfig });
    state.pkg.explicitSheetLock = true;
    state.session.version = (state.session.version || 1) + 1;
    await this._pipeline([
      ['SET', k.pkg, JSON.stringify(state.pkg), 'EX', this.roomTtlSec],
      ['SET', k.session, JSON.stringify(state.session), 'EX', this.roomTtlSec],
    ]);
    return state;
  }
}

export function createRoomStore(defaultPackage) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
  if (redisUrl && redisToken) {
    return new UpstashRedisRoomStore(defaultPackage, { url: redisUrl, token: redisToken });
  }
  return new MemoryRoomStore(defaultPackage);
}
