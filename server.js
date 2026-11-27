/* Trade-card backend (Node 18+, no dependencies).
 * Keeps secrets off the web page: Binance API key/secret, Anthropic key, stamping key.
 *
 *   APP_TOKEN=long-random-string  (required)  – the page sends it as "Authorization: Bearer …"
 *   ALLOW_ORIGIN=https://your-page-origin     – CORS origin ("null" for a local file:// page; never "*")
 *   BINANCE_API_KEY / BINANCE_API_SECRET      – use a READ-ONLY key, IP-restricted, no trading/withdraw rights
 *   BINANCE_FAPI=https://fapi.binance.com
 *   ANTHROPIC_API_KEY, AI_MODEL (default claude-sonnet-5-5)
 *   STAMP_SECRET                              – HMAC key for timestamp receipts (default: APP_TOKEN)
 *   DATA_DIR=./data   PORT=8787   HOST=127.0.0.1
 */
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const E = process.env, PORT = +E.PORT || 8787, HOST = E.HOST || '127.0.0.1';
const TOKEN = E.APP_TOKEN || '', ORIGIN = E.ALLOW_ORIGIN || '', DATA = path.resolve(E.DATA_DIR || './data');
const FAPI = E.BINANCE_FAPI || 'https://fapi.binance.com', STAMP_KEY = E.STAMP_SECRET || TOKEN;
if (TOKEN.length < 16) { console.error('Set APP_TOKEN to a random string of at least 16 characters.'); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });
const STAMPS = path.join(DATA, 'stamps.jsonl'), SYNC = path.join(DATA, 'sync.json');

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function send(res, code, obj) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (ORIGIN) { h['Access-Control-Allow-Origin'] = ORIGIN; h['Vary'] = 'Origin'; h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'; h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS'; }
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}
function body(req, max = 2 * 1024 * 1024) {
  return new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > max) { no(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}); } catch (e) { no(Object.assign(new Error('bad json'), { code: 400 })); } }); req.on('error', no); });
}
async function signed(p, params) {
  if (!E.BINANCE_API_KEY || !E.BINANCE_API_SECRET) throw Object.assign(new Error('BINANCE_API_KEY / BINANCE_API_SECRET not set'), { code: 501 });
  const q = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const sig = crypto.createHmac('sha256', E.BINANCE_API_SECRET).update(q).digest('hex');
  const r = await fetch(`${FAPI}${p}?${q}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': E.BINANCE_API_KEY }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error('binance ' + r.status), { code: 502 });
  return r.json();
}
const sym = s => { s = String(s || '').toUpperCase(); if (!/^[A-Z0-9]{3,30}$/.test(s)) throw Object.assign(new Error('bad symbol'), { code: 400 }); return s; };

const routes = {
  'GET /positions': async () => {
    const r = await signed('/fapi/v2/positionRisk', {});
    return { positions: r.filter(p => +p.positionAmt !== 0).map(p => ({ symbol: p.symbol, positionAmt: p.positionAmt, entryPrice: p.entryPrice, leverage: p.leverage, liquidationPrice: p.liquidationPrice })) };
  },
  'GET /fills': async (req, url) => {
    const s = sym(url.searchParams.get('symbol')), since = Math.max(+url.searchParams.get('since') || 0, Date.now() - 7 * 864e5);
    const r = await signed('/fapi/v1/userTrades', { symbol: s, startTime: Math.floor(since), limit: 500 });
    return { fills: r.map(t => ({ side: t.side, qty: t.qty, price: t.price, time: t.time })) };
  },
  'POST /stamp': async (req) => {
    const b = await body(req); if (!/^[a-f0-9]{64}$/.test(b.hash || '')) throw Object.assign(new Error('hash must be sha256 hex'), { code: 400 });
    const ts = new Date().toISOString(), id = 'S' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const mac = crypto.createHmac('sha256', STAMP_KEY).update(`${id}|${b.hash}|${ts}`).digest('hex');
    fs.appendFileSync(STAMPS, JSON.stringify({ id, hash: b.hash, ts, symbol: String(b.symbol || '').slice(0, 30), dir: String(b.dir || '').slice(0, 5), mac }) + '\n');
    return { id, ts: ts.replace('T', ' ').slice(0, 19) + ' UTC', mac };
  },
  'GET /verify': async (req, url) => {
    const id = url.pathname.split('/')[2] || '', hash = url.searchParams.get('hash') || '';
    const lines = fs.existsSync(STAMPS) ? fs.readFileSync(STAMPS, 'utf8').split('\n').filter(Boolean) : [];
    for (const l of lines) { const r = JSON.parse(l); if (r.id === id) { const mac = crypto.createHmac('sha256', STAMP_KEY).update(`${r.id}|${r.hash}|${r.ts}`).digest('hex'); return { found: true, ts: r.ts, hash: r.hash, macValid: mac === r.mac, matches: hash ? hash === r.hash : undefined }; } }
    return { found: false };
  },
  'POST /ai/draft': async (req) => {
    if (!E.ANTHROPIC_API_KEY) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { code: 501 });
    const b = await body(req), s = sym(b.symbol);
    const compact = a => (Array.isArray(a) ? a.slice(-60) : []).map(c => Array.isArray(c) ? c.map(v => +(+v).toPrecision(7)) : []);
    const prompt = `You are drafting a TRADE PLAN CANDIDATE for a human trader to review. It will not be executed automatically.
Symbol ${s} (${b.market}), candle interval ${b.interval}. Current price ${b.price}. Trader's current direction: ${b.direction}.
Trader's note: ${String(b.hint || '').slice(0, 300) || '(none)'}
Recent candles [open,high,low,close] (${b.interval}): ${JSON.stringify(compact(b.candles))}
Last 48 1h candles: ${JSON.stringify(compact(b.candles1h))}
Futures extras: ${JSON.stringify(b.extra || null)}
Mechanical rule draft (ATR/EMA): ${JSON.stringify(b.rule || null)}
Return ONLY a JSON object: {"dir":"long"|"short","entryLo":number,"entryHi":number,"sl":number,"tps":[{"lo":number,"hi":number?}] (1-3 items),"size":"short text like 0.2倍","trigger":"short condition, Chinese","note":"one-line risk note, Chinese","reason":"2-3 sentences in Chinese explaining the basis and the main risk"}.
Long: sl < entryLo < tps. Short: sl > entryHi > tps. Prices must be near the current price. Be conservative; if the picture is unclear, say so in "reason".`;
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: E.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(50000) });
    if (!r.ok) throw Object.assign(new Error('model api ' + r.status), { code: 502 });
    const j = await r.json(), txt = (j.content || []).map(c => c.text || '').join(''), m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw Object.assign(new Error('model returned no JSON'), { code: 502 });
    let d; try { d = JSON.parse(m[0]); } catch (e) { throw Object.assign(new Error('model JSON invalid'), { code: 502 }); }
    return { draft: d };
  },
  'GET /sync': async () => fs.existsSync(SYNC) ? JSON.parse(fs.readFileSync(SYNC, 'utf8')) : { items: [] },
  'PUT /sync': async (req) => {
    const b = await body(req, 8 * 1024 * 1024); if (!Array.isArray(b.items) || b.items.length > 1000) throw Object.assign(new Error('items must be an array (<=1000)'), { code: 400 });
    fs.writeFileSync(SYNC + '.tmp', JSON.stringify({ items: b.items, updated: new Date().toISOString() })); fs.renameSync(SYNC + '.tmp', SYNC); return { ok: true, count: b.items.length };
  }
};

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (ORIGIN && req.headers.origin && req.headers.origin !== ORIGIN) return send(res, 403, { error: 'origin not allowed' });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m || !eq(m[1], TOKEN)) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://x'), key = req.method + ' ' + (url.pathname.startsWith('/verify/') ? '/verify' : url.pathname.replace(/\/+$/, ''));
    const h = routes[key]; if (!h) return send(res, 404, { error: 'not found' });
    send(res, 200, await h(req, url));
  } catch (e) { send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message || 'error' }); }
}).listen(PORT, HOST, () => console.log(`trade-card backend on http://${HOST}:${PORT}`));
