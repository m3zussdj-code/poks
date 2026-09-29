/**
 * driver.test.mjs — integracyjny self-test driver/pg-cdp-driver.mjs.
 *
 * Mock CDP (HTTP /json/version + WebSocket) udaje Chrome:
 *   – Target.getTargets / attachToTarget → sessionId 'S1'
 *   – Runtime.evaluate: zwraca zakolejkowane żądania kliknięcia window.__pgClick,
 *     liczy heartbeaty i wywołania wyczyszczenia żądania
 *   – Input.dispatchMouseEvent: nagrywa sekwencję
 *
 * Scenariusze:
 *   1. świeże żądanie → sekwencja ruchów (≥3 mouseMoved) → pressed → released,
 *      koordynaty pressed = żądane, sessionId='S1', żądanie wyczyszczone
 *   2. stare żądanie (ts sprzed 10 s) → wyczyszczone BEZ dispatcha
 *   3. kolejne świeże → dispatched (2. pressed)
 *
 * Uruchomienie: node tests/driver.test.mjs  (Node ≥ 21)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const fails = [];
const ok = [];
function check(cond, msg) {
  if (cond) ok.push(msg);
  else { fails.push(msg); console.error(`  ✗ ${msg}`); }
}
function waitFor(fn, ms, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout: ${label}`));
      }
    }, 30);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock CDP ───────────────────────────────────────────────────────────────
const state = {
  attached: false, heartbeats: 0,
  recorded: [], clears: [], pollQueue: [],
};

function handleClientMessage(send, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (_) { return; }
  const reply = (result) => send(JSON.stringify({ id: m.id, result }));
  if (m.method === 'Target.getTargets') {
    reply({
      targetInfos: [{
        targetId: 'page1', type: 'page',
        url: 'https://pokeglory.pl/mapa?areaId=2', title: 'Mapa świata | PokeGlory',
      }],
    });
  } else if (m.method === 'Target.attachToTarget') {
    state.attached = true;
    reply({ sessionId: 'S1' });
  } else if (m.method === 'Runtime.evaluate') {
    const e = String(m.params.expression || '');
    if (e.includes('__pgClick ?')) {
      const v = state.pollQueue.length ? state.pollQueue.shift() : null;
      reply({ result: { type: v === null ? 'undefined' : 'object', value: v } });
    } else if (e.includes('__pgBridge')) {
      state.heartbeats += 1;
      reply({ result: { type: 'undefined' } });
    } else if (e.includes('__pgClick = null')) {
      state.clears.push(e);
      reply({ result: { type: 'undefined' } });
    } else {
      reply({ result: { type: 'undefined' } });
    }
  } else if (m.method === 'Input.dispatchMouseEvent') {
    state.recorded.push({ ...m.params, sessionId: m.sessionId });
    reply({});
  } else {
    reply({});
  }
}

function encodeServerFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        const port = server.address().port;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          Browser: 'MockChrome/120',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/mock`,
        }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });

    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      const send = (str) => { try { socket.write(encodeServerFrame(str)); } catch (_) { /* koniec */ } };
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const maskLen = masked ? 4 : 0;
          if (buf.length < off + maskLen + len) return;
          let payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
          if (masked) {
            const mask = buf.subarray(off, off + 4);
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
          }
          buf = buf.subarray(off + maskLen + len);
          if (opcode === 0x8) { socket.end(); return; }
          if (opcode === 0x9) { // ping → pong
            const pong = Buffer.alloc(2 + payload.length);
            pong[0] = 0x8a; pong[1] = payload.length;
            payload.copy(pong, 2);
            socket.write(pong);
            continue;
          }
          if (opcode === 0x1) handleClientMessage(send, payload.toString('utf8'));
        }
      });
      socket.on('error', () => { /* ignore */ });
    });

    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ── przebieg ───────────────────────────────────────────────────────────────
const driverPath = fileURLToPath(new URL('../driver/pg-cdp-driver.mjs', import.meta.url));
let driverProc = null;

async function main() {
  const server = await startMock();
  const port = server.address().port;
  const cdpUrl = `http://127.0.0.1:${port}`;
  console.log(`mock CDP: ${cdpUrl}`);

  driverProc = spawn(process.execPath, [driverPath], {
    env: { ...process.env, PG_CDP: cdpUrl, PG_POLL: '40' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let driverLog = '';
  driverProc.stdout.on('data', (d) => { driverLog += d; });
  driverProc.stderr.on('data', (d) => { driverLog += d; });

  try {
    // 1) podpięcie + heartbeat
    await waitFor(() => state.attached && state.heartbeats >= 1, 8000, 'attach + heartbeat');
    check(state.attached, 'driver podłącza się do karty pokeglory (attachToTarget)');
    check(state.heartbeats >= 1, 'heartbeat window.__pgBridge dociera do strony');

    // 2) świeże żądanie → dispatch
    const fresh = Date.now();
    state.pollQueue.push(null, null, [77, 300, 220, fresh, 'visible']);
    await waitFor(
      () => state.recorded.some((r) => r.type === 'mouseReleased') && state.clears.length >= 1,
      8000, 'dispatch świeże żądanie'
    );

    const seq = state.recorded.map((r) => r.type);
    const moves = state.recorded.filter((r) => r.type === 'mouseMoved');
    const pressed = state.recorded.find((r) => r.type === 'mousePressed');
    const released = state.recorded.find((r) => r.type === 'mouseReleased');

    check(moves.length >= 3, `trajektoria: ≥3 mouseMoved (jest ${moves.length})`);
    check(seq.lastIndexOf('mouseMoved') < seq.indexOf('mousePressed'),
      'kolejność: ruchy PRZED naciśnięciem');
    check(!!pressed && !!released && seq.indexOf('mouseReleased') > seq.indexOf('mousePressed'),
      'kolejność: pressed → released');
    check(pressed && pressed.x === 300 && pressed.y === 220,
      'pressed w żądanych koordynatach (300,220)');
    check(pressed && pressed.clickCount === 1 && pressed.buttons === 1,
      'pressed: clickCount=1, buttons=1');
    check(released && released.clickCount === 1,
      'released: clickCount=1');
    check(state.recorded.every((r) => r.sessionId === 'S1'),
      'wszystkie eventy na sesji strony gry (S1)');
    check(state.clears[0] && state.clears[0].includes('77'),
      'żądanie id=77 wyczyszczone po kliknięciu');
    const pressedCount1 = state.recorded.filter((r) => r.type === 'mousePressed').length;
    check(pressedCount1 === 1, `dokładnie 1 pressed w scenariuszu 1 (jest ${pressedCount1})`);

    // 3) stare żądanie → bez dispatcha
    state.pollQueue.push([78, 400, 300, Date.now() - 99999, 'visible']);
    await waitFor(() => state.clears.length >= 2, 6000, 'stare żądanie wyczyszczone');
    await sleep(300); // ewentualny złapany dispatch powinien się nie pojawić
    const pressedAfterStale = state.recorded.filter((r) => r.type === 'mousePressed').length;
    check(pressedAfterStale === 1,
      `stare żądanie (ts-10 s) NIE zostaje skliknięte (pressed ${pressedAfterStale} === 1)`);
    check(state.clears[1] && state.clears[1].includes('78'),
      'stare żądanie id=78 wyczyszczone');

    // 4) kolejne świeże → dispatch po poprzednim
    state.pollQueue.push([79, 400, 300, Date.now(), 'visible']);
    await waitFor(
      () => state.recorded.filter((r) => r.type === 'mousePressed').length === 2
        && state.clears.length >= 3,
      8000, 'dispatch po scenariuszu stale'
    );
    check(true, 'żądanie po restarcie/stare nie blokuje kolejnego (id=79 skliknięty)');
  } catch (e) {
    fails.push(`EXC: ${e.message}`);
    console.error(`  ✗ ${e.message}`);
  } finally {
    if (driverProc) driverProc.kill('SIGKILL');
    server.close();
  }

  console.log(`\n${fails.length === 0 ? '✅' : '❌'} driver.test: ${ok.length} OK, ${fails.length} błędów`);
  if (fails.length) {
    console.error('--- log drivera ---\n' + driverLog.slice(-2000));
    process.exit(1);
  }
  process.exit(0);
}

main();
