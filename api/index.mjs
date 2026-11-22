import { createAppContext } from '../src/router.mjs';

let ctxPromise = null;
function getCtx() {
  if (!ctxPromise) ctxPromise = createAppContext();
  return ctxPromise;
}

export default async function handler(req, res) {
  const ctx = await getCtx();
  return ctx.handleRequest(req, res);
}
