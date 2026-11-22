import http from 'node:http';
import { createAppContext, getLanUrls } from './router.mjs';

const ctx = await createAppContext();

const server = http.createServer((req, res) => {
  ctx.handleRequest(req, res);
});

// Optimize HTTP server for 3,000+ concurrent keep-alive connections
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxConnections = 10000;

setInterval(() => ctx.keepAliveHeartbeat(), 20000).unref();

server.listen(ctx.port, '0.0.0.0', () => {
  const lan = getLanUrls(ctx.port);
  console.log('====================================================');
  console.log(`  通用型全網頁互動簡報與即時互動系統已啟動 (Port: ${ctx.port})`);
  console.log(`  儲存模式               : ${ctx.store.kind === 'redis' ? 'Upstash Redis' : 'Memory + SSE'}`);
  console.log(`  大螢幕端 (Stage /)     : http://localhost:${ctx.port}/?room=${ctx.defaultRoom}`);
  console.log(`  觀眾手機端 (Mobile /m) : ${lan[0]}/m?room=${ctx.defaultRoom}`);
  console.log(`  控場提詞端 (/admin)    : http://localhost:${ctx.port}/admin?room=${ctx.defaultRoom}`);
  console.log(`  密碼 (ADMIN_PASSWORD)  : ${ctx.adminPassword}`);
  console.log('====================================================');
});
