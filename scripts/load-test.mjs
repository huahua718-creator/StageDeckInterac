const TARGET = process.env.TARGET || 'http://localhost:3000';
const ROOM = process.env.ROOM || 'main';
const TOTAL = Number.parseInt(process.env.COUNT || '1500', 10);

async function main() {
  const stRes = await fetch(`${TARGET}/api/state?room=${encodeURIComponent(ROOM)}`);
  const st = await stRes.json();
  if (st.mode === 'SLIDE' || st.phase !== 'VOTING') {
    console.log(`目前頁面 [${st.mode} / ${st.phase}] 非開放作答狀態，請先切到互動題目並設為 VOTING。`);
    process.exit(1);
  }

  console.log(`開始對 [${st.mode}] "${st.title}" 發動 ${TOTAL} 筆併發投票...`);
  const t0 = performance.now();

  const tasks = Array.from({ length: TOTAL }, (_, i) => {
    const uuid = `load_${Date.now()}_${i}`;
    let payload = {};
    if (st.mode === 'BUBBLE' || st.mode === 'MYTH') {
      const opts = st.options || [{ key: 'opt_1' }];
      payload = { optKey: opts[i % opts.length].key };
    } else if (st.mode === 'SPECTRUM') {
      payload = { score: Math.round((i / TOTAL) * 100) };
    } else if (st.mode === 'QUADRANT') {
      payload = { x: Math.round(Math.random() * 100), y: Math.round(Math.random() * 100) };
    } else if (st.mode === 'TREE') {
      payload = { text: `願景祝福 #${i}` };
    } else if (st.mode === 'DANMAKU') {
      payload = { tag: st.options?.[0]?.label || '許願', text: `壓測留言 #${i}` };
    }
    return fetch(`${TARGET}/api/vote?room=${encodeURIComponent(ROOM)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM, slideId: st.slideId, order: st.order, uuid, payload }),
    }).then((r) => r.json());
  });

  const results = await Promise.all(tasks);
  const okCount = results.filter((r) => r.ok).length;
  const elapsed = (performance.now() - t0).toFixed(1);
  console.log(`完成：${okCount} / ${TOTAL} 筆成功，耗時 ${elapsed} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
