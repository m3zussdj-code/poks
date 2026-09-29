#!/usr/bin/env node
/**
 * pg-cdp-driver.mjs — trusted clicks dla PokeGlory Edu Bot (v0.10.0+).
 *
 * Mostek działania:
 *   1. Userscript (Tampermonkey, @grant none = kontekst strony) nie klika
 *      sam — el.click() ma isTrusted=false i antycheat gry wystawia flagę
 *      „Mocny sygnał automatyzacji” (event.untrusted +80 > próg 70).
 *   2. Zamiast tego zapisuje żądanie w window.__pgClick = {id,x,y,ts}.
 *   3. Driver odpytuje stronę przez CDP (Runtime.evaluate) i klika przez
 *      Input.dispatchMouseEvent: sekwencja mouseMoved (trajektoria) →
 *      mousePressed → mouseReleased. Przeglądarka generuje ZAUFAŁY event
 *      (isTrusted=true, pełny trajektoria, koordynaty) → sygnały = 0.
 *   4. Heartbeat: window.__pgBridge = {ok, ts} — userscript widzi CDP✓/✗.
 *
 * Wymagania:
 *   • Node ≥ 21 (globalny WebSocket — zero zależności).
 *   • Chrome z portem CDP i otwartą kartą gry:
 *       google-chrome --remote-debugging-port=9222 --user-data-dir=<profil>
 *     (osobny profil: zainstaluj Tampermonkey, zaloguj się do gry),
 *     albo zamknij CAŁEGO Chrome i odpal z samą flagą --remote-debugging-port.
 *   • node driver/pg-cdp-driver.mjs
 *
 * Sterowanie (env): PG_CDP (http://127.0.0.1:9222), PG_POLL (ms, dom. 100).
 */

const cdpHttp = process.env.PG_CDP || 'http://127.0.0.1:9222';
const pollMs = Math.max(30, Number(process.env.PG_POLL) || 100);
const MAX_AGE_MS = 3000;      // żądanie starsze niż to → pomiń (driver był wyłączony)
const HB_MS = 1000;           // heartbeat dla userscripta
const CDP_TIMEOUT_MS = 8000;

const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[pg-driver ${new Date().toISOString().slice(11, 19)}] ${msg}`);

let msgId = 0;
const pending = new Map();
let ws = null;
let sessionId = null;
let targetId = null;
let lastClickId = 0;
let lastHb = 0;
let stopping = false;

function send(method, params = {}, session) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('brak połączenia WS'));
    const id = ++msgId;
    const to = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, CDP_TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject: (e) => { clearTimeout(to); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}

function onMessage(data) {
  let m;
  try { m = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); }
  catch (_) { return; }
  if (m.id !== undefined && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || 'CDP error'));
    else p.resolve(m.result || {});
    return;
  }
  if (m.method === 'Target.detachedFromTarget') {
    if (!m.params.sessionId || m.params.sessionId === sessionId) sessionId = null;
  }
}

async function ensureSession() {
  if (sessionId && ws && ws.readyState === 1) return;

  if (ws) { try { ws.close(); } catch (_) { /* już zamknięte */ } ws = null; }

  const verRes = await fetch(`${cdpHttp}/json/version`);
  if (!verRes.ok) throw new Error(`CDP HTTP ${verRes.status} — czy Chrome ma --remote-debugging-port?`);
  const ver = await verRes.json();
  if (!ver.webSocketDebuggerUrl) throw new Error('brak webSocketDebuggerUrl w /json/version');

  ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(ver.webSocketDebuggerUrl);
    const to = setTimeout(() => { try { sock.close(); } catch (_) {}; reject(new Error('WS timeout')); }, 5000);
    sock.onopen = () => { clearTimeout(to); resolve(sock); };
    sock.onerror = () => { clearTimeout(to); reject(new Error('błąd WS do Chrome')); };
  });
  ws.onmessage = (ev) => onMessage(ev.data);
  ws.onclose = () => { sessionId = null; };
  ws.onerror = () => { /* obsłużone w main */ };

  const t = await send('Target.getTargets');
  const infos = (t && t.targetInfos) || [];
  const page = infos.find((x) => x.type === 'page' && /pokeglory/i.test(x.url || ''));
  if (!page) throw new Error('brak karty pokeglory.pl w Chrome (otwórz grę)');

  const a = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  sessionId = a.sessionId;
  targetId = page.targetId;
  lastHb = 0;
  log(`podpięto do karty: ${page.url}`);
}

async function heartbeat(ok = true) {
  if (!sessionId) return;
  await send('Runtime.evaluate', {
    expression: `window.__pgBridge = { ok: ${ok ? 'true' : 'false'}, ts: Date.now() };`,
    returnByValue: true,
  }, sessionId);
}

/** Klik jak u człowieka: start obok, trajektoria 3–5 ruchów, oddech, nacisk. */
async function humanClick(x, y) {
  const sx = Math.round(x + (Math.random() < 0.5 ? -1 : 1) * rnd(24, 70));
  const sy = Math.round(y + rnd(-40, 40));
  const steps = 3 + Math.floor(Math.random() * 3); // 3..5
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mx = Math.round(sx + (x - sx) * t + rnd(-1.5, 1.5));
    const my = Math.round(sy + (y - sy) * t + rnd(-1.5, 1.5));
    await send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: mx, y: my, button: 'left', buttons: 0, pointerType: 'mouse' },
      sessionId);
    await sleep(rnd(16, 42));
  }
  await sleep(rnd(50, 140)); // zawieszenie nad celem
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' },
    sessionId);
  await sleep(rnd(45, 130));
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' },
    sessionId);
}

const POLL_EXPR =
  'window.__pgClick ? [window.__pgClick.id, window.__pgClick.x, window.__pgClick.y, ' +
  'window.__pgClick.ts, document.visibilityState] : null';

async function poll() {
  const r = await send('Runtime.evaluate',
    { expression: POLL_EXPR, returnByValue: true }, sessionId);
  const v = r && r.result && r.result.value;
  if (!Array.isArray(v) || v.length < 5) return;

  const id = Number(v[0]);
  const x = Math.round(Number(v[1]));
  const y = Math.round(Number(v[2]));
  const ts = Number(v[3]);
  const vis = String(v[4] || '');
  if (!Number.isFinite(id) || id === lastClickId) return;

  const clear =
    `try { if (window.__pgClick && window.__pgClick.id === ${Number.isFinite(id) ? id : 'NaN'}) ` +
    'window.__pgClick = null; } catch (e) {}';

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ts)) {
    lastClickId = id;
    await send('Runtime.evaluate', { expression: clear }, sessionId);
    return;
  }
  if (Date.now() - ts > MAX_AGE_MS) {
    lastClickId = id;
    await send('Runtime.evaluate', { expression: clear }, sessionId);
    log(`pomijam stare żądanie (id ${id}, ${Math.round((Date.now() - ts) / 1000)} s)`);
    return;
  }

  if (vis !== 'visible') {
    // karta w tle — przywołaj, żeby klik nie poszedł w próżnię
    try { await send('Target.activateTarget', { targetId }); await sleep(150); }
    catch (_) { /* i tak spróbujemy kliknąć */ }
  }

  await humanClick(x, y);
  lastClickId = id;
  await send('Runtime.evaluate', { expression: clear }, sessionId);
  log(`klik id=${id} @ ${x},${y} (trusted)`);
}

async function main() {
  log(`start → CDP ${cdpHttp}, odpyt co ${pollMs} ms`);
  let fails = 0;
  while (!stopping) {
    try {
      await ensureSession();
      const now = Date.now();
      if (now - lastHb > HB_MS) { lastHb = now; await heartbeat(true); }
      await poll();
      fails = 0;
    } catch (e) {
      fails += 1;
      sessionId = null;
      if (ws) { try { ws.close(); } catch (_) { /* ignore */ } ws = null; }
      if (fails <= 2 || fails % 10 === 0) {
        const hint = fails <= 1
          ? ' — uruchom Chrome z --remote-debugging-port=9222 i otwartą grą'
          : '';
        log(`problem: ${e.message}${hint}; ponawiam za 1,5 s`);
      }
      await sleep(1500);
    }
    await sleep(pollMs);
  }
}

async function shutdown() {
  stopping = true;
  try { if (sessionId) await heartbeat(false); } catch (_) { /* best effort */ }
  try { if (ws) ws.close(); } catch (_) { /* ignore */ }
  log('zatrzymano');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => { log(`błąd krytyczny: ${e.message}`); process.exit(1); });
