/**
 * 60-panel.js — panel sterowania botem (Shadow DOM).
 *
 * Całość siedzi w Shadow DOM doklejonym do <body>, żeby:
 *  - style gry nie wchodziły nam w panel,
 *  - style panelu nie wchodziły w grę,
 *  - nie modyfikować żadnych węzłów należących do gry.
 *
 * Sekcje: nagłówek ze stanem, sterowanie, przełączniki konfiguracji,
 * lista questów, historia stanów, konsola logów + eksport telemetrii.
 */

PG.panel = (() => {
  let shadow = null;
  const MAX_LIVE_LOG_ROWS = 150;

  const BADGE = {
    STOPPED: ['gray', 'STOPPED'],
    SCANNING: ['blue', 'SCANNING'],
    WANDER: ['green', 'WANDER'],
    CATCH: ['orange', 'CATCH'],
    BATTLE: ['orange', 'BATTLE'],
    QUEST_TURNIN: ['teal', 'QUEST_TURNIN'],
    HEAL: ['teal', 'HEAL'],
    INVENTORY: ['teal', 'INVENTORY'],
    SPECIAL_ENCOUNTER: ['purple', 'SPECIAL'],
    NEEDS_REVIEW: ['red', 'NEEDS REVIEW'],
  };

  const TOGGLES = [
    ['autoWalk', 'Wędrówki'],
    ['autoCatch', 'Łapanie'],
    ['autoQuests', 'Questy'],
    ['autoHeal', 'Picie drinków'],
    ['autoManage', 'Ewolucja/sprzedaż'],
    ['pauseOnSpecial', 'Pauza: shiny/tutor'],
    ['debugConsole', 'Log do konsoli'],
  ];

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; width: 400px;
      max-height: calc(100vh - 32px);
      display: flex; flex-direction: column;
      background: #12151c; color: #e5e9f0;
      border: 1px solid #2a2f3a; border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.55);
      font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      z-index: 2147483647; overflow: hidden;
    }
    .header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; background: #1a1f2a;
      border-bottom: 1px solid #2a2f3a; cursor: default;
      user-select: none;
    }
    .title { font-weight: 700; font-size: 13px; flex: 1; }
    .ver { color: #7a8299; font-weight: 400; font-size: 11px; }
    .badge {
      font-size: 11px; font-weight: 700; padding: 2px 8px;
      border-radius: 999px; letter-spacing: .4px;
    }
    .badge.gray   { background: #3a3f4b; color: #c6cbd6; }
    .badge.blue   { background: #1d4ed8; color: #dbeafe; }
    .badge.green  { background: #15803d; color: #dcfce7; }
    .badge.orange { background: #c2410c; color: #ffedd5; }
    .badge.teal   { background: #0f766e; color: #ccfbf1; }
    .badge.purple { background: #6d28d9; color: #ede9fe; }
    .badge.red    { background: #b91c1c; color: #fee2e2; animation: pulse 1.2s infinite; }
    @keyframes pulse { 50% { opacity: .55; } }
    .icon-btn {
      background: #262b36; color: #c6cbd6; border: 1px solid #343a47;
      border-radius: 6px; width: 24px; height: 24px; cursor: pointer; font-size: 13px;
    }
    .icon-btn:hover { background: #323847; }
    .body { overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .panel.collapsed .body { display: none; }
    .banner {
      background: #3f1212; border: 1px solid #7f1d1d; color: #fecaca;
      padding: 8px 10px; border-radius: 8px; font-size: 12px;
    }
    .banner b { color: #fee2e2; }
    .banner button { margin-top: 6px; }
    .controls { display: flex; flex-wrap: wrap; gap: 6px; }
    button.act {
      background: #232936; color: #e5e9f0; border: 1px solid #394152;
      padding: 6px 10px; border-radius: 7px; cursor: pointer; font-size: 12px;
      font-weight: 600;
    }
    button.act:hover { background: #2d3546; }
    button.act.primary { background: #1d4ed8; border-color: #1d4ed8; }
    button.act.primary:hover { background: #2563eb; }
    button.act:disabled { opacity: .45; cursor: not-allowed; }
    .toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; }
    .toggles label {
      display: flex; align-items: center; gap: 6px; font-size: 12px;
      color: #aab1c0; cursor: pointer;
    }
    .toggles input { accent-color: #3b82f6; }
    .sec-title {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .6px; color: #7a8299; margin-bottom: 5px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .quest {
      background: #171b24; border: 1px solid #262c38;
      border-radius: 8px; padding: 7px 9px; margin-bottom: 6px;
    }
    .quest-title { font-weight: 600; font-size: 12px; margin-bottom: 5px; }
    .goal { font-size: 11.5px; padding: 3px 0; color: #c6cbd6; }
    .goal .chip {
      display: inline-block; font-size: 10px; font-weight: 700;
      padding: 0 5px; border-radius: 4px; margin-right: 5px;
    }
    .chip.done { background: #14532d; color: #bbf7d0; }
    .chip.active { background: #1e3a8a; color: #bfdbfe; }
    .chip.unknown { background: #7f1d1d; color: #fecaca; }
    .goal .prog { color: #7a8299; margin-left: 6px; font-variant-numeric: tabular-nums; }
    .goal .note { color: #8b93a7; font-size: 10.5px; margin-left: 14px; }
    .hist, .log {
      background: #0d1017; border: 1px solid #232936; border-radius: 8px;
      font-family: ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
      font-size: 11px; padding: 6px 8px;
    }
    .hist { max-height: 110px; overflow-y: auto; }
    .hist div { padding: 1px 0; color: #aab1c0; }
    .log { max-height: 160px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
    .log div { padding: 1px 0; border-bottom: 1px dashed #171b24; color: #9aa3b5; }
    .log .ev { color: #60a5fa; }
    .log .err { color: #f87171; }
    .log-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .muted { color: #5b6274; font-size: 11px; font-style: italic; }
    .empty { color: #5b6274; font-size: 11px; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: #2a2f3a; border-radius: 4px; }
  `;

  function el(id) { return shadow.getElementById(id); }

  function build() {
    if (document.getElementById('pg-bot-host')) return;

    const host = document.createElement('div');
    host.id = 'pg-bot-host';
    host.style.cssText = 'all:initial;display:block;position:fixed;right:0;bottom:0;z-index:2147483647;';

    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="panel" id="panel">
        <div class="header">
          <span class="title">🤖 PokeGlory Edu Bot <span class="ver">v${PG.version}</span></span>
          <span class="badge gray" id="badge">STOPPED</span>
          <button class="icon-btn" id="btnCollapse" title="Zwiń/rozwiń">–</button>
        </div>
        <div class="body" id="body">
          <div class="banner" id="banner" style="display:none"></div>

          <div class="controls">
            <button class="act primary" id="btnStart">▶ Start</button>
            <button class="act" id="btnPause">⏸ Pauza</button>
            <button class="act" id="btnStop">⏹ Stop</button>
            <button class="act" id="btnScan">🔍 Skan questów</button>
          </div>

          <div class="toggles" id="toggles"></div>

          <div>
            <div class="sec-title"><span>Questy</span><span id="questMeta"></span></div>
            <div id="questList"><div class="empty">Brak danych — kliknij „Skan questów”.</div></div>
          </div>

          <div>
            <div class="sec-title">Historia stanów</div>
            <div class="hist" id="histList"><div class="empty">—</div></div>
          </div>

          <div>
            <div class="sec-title"><span>Log telemetrii</span><span id="logMeta"></span></div>
            <div class="log" id="logView"></div>
            <div class="log-btns">
              <button class="act" id="btnCopy">📋 Kopiuj log</button>
              <button class="act" id="btnDownload">💾 Pobierz JSON</button>
              <button class="act" id="btnSnap">📸 Snapshot ekranu</button>
              <button class="act" id="btnClear">🗑 Wyczyść</button>
            </div>
          </div>
        </div>
      </div>`;

    (document.body || document.documentElement).appendChild(host);
    wire();
    PG.logger.subscribe(onLogEntry);
    render();
  }

  function wire() {
    el('btnCollapse').onclick = () => el('panel').classList.toggle('collapsed');
    el('btnStart').onclick = () => PG.main.start();
    el('btnPause').onclick = () => (PG.sm.paused ? PG.sm.resume() : PG.sm.pause());
    el('btnStop').onclick = () => PG.main.stop();
    el('btnScan').onclick = () => {
      const r = PG.quest.scan();
      if (!r) appendLogRow({ ts: new Date().toISOString(), event: 'quest_scan', msg: 'nie znaleziono kontenera questów — zobacz selector_miss' });
    };

    el('btnCopy').onclick = async () => {
      const ok = await PG.logger.copyAll();
      flash(el('btnCopy'), ok ? '📋 Skopiowano!' : '❌ Błąd kopiowania');
    };
    el('btnDownload').onclick = () => PG.logger.downloadAll();
    el('btnSnap').onclick = async () => {
      const snap = buildSnapshot();
      PG.logger.push('snapshot', snap);
      const ok = await PG.logger.copyToClipboard(JSON.stringify(snap, null, 2));
      flash(el('btnSnap'), ok ? '📸 Skopiowano!' : '📸 Zapisano w logu');
    };
    el('btnClear').onclick = () => { PG.logger.clear(); renderLogView(); };

    // Przełączniki konfiguracji:
    const tg = el('toggles');
    for (const [key, label] of TOGGLES) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!PG.config[key];
      cb.onchange = () => {
        PG.config[key] = cb.checked;
        PG.logger.push('config_change', { key, value: cb.checked });
        render();
      };
      lab.append(cb, document.createTextNode(label));
      tg.appendChild(lab);
    }
  }

  /** Snapshot ekranu: co bot „widzi” — do diagnostyki nowych ekranów. */
  function buildSnapshot() {
    const buttons = [...document.querySelectorAll('button, a[href], [role="button"]')]
      .slice(0, 200)
      .map((b) => {
        const o = {
          tag: b.tagName.toLowerCase(),
          text: pgText(b.textContent, 60),
          id: b.id || null,
          role: b.getAttribute('data-pokeglory-integrity-role'),
          cls: pgText(b.className, 100),
        };
        if (b.tagName === 'A') o.href = b.getAttribute('href');
        return o;
      });
    return {
      url: location.href,
      title: document.title,
      integrityRoles: PG.selectors.integrityRoles(),
      buttons,
      bodyText: pgText(document.body ? document.body.innerText : '', 8000),
    };
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1500);
  }

  // ── renderowanie ──────────────────────────────────────────────────────────

  function render() {
    if (!shadow) return;
    const [color, label] = BADGE[PG.sm.state] || ['gray', PG.sm.state];
    const badge = el('badge');
    badge.className = `badge ${color}`;
    badge.textContent = PG.sm.paused && PG.sm.state !== 'STOPPED' ? `${label} ⏸` : label;

    // Banner NEEDS_REVIEW:
    const banner = el('banner');
    if (PG.sm.state === 'NEEDS_REVIEW') {
      banner.style.display = '';
      banner.innerHTML = `<b>⚠ Bot nie rozpoznaje sytuacji:</b> ${escapeHtml(PG.sm.reason || '—')}<br/>
        Skopiuj log i prześlij go agentowi, żeby dopisał nowy stan/selektor.
        <br/><button class="act" id="btnAck">✅ Wznowię sam — skanuj ponownie</button>`;
      el('btnAck').onclick = () => PG.sm.acknowledge();
    } else {
      banner.style.display = 'none';
    }

    renderQuests();
    renderHistory();

    // Stan przycisków:
    const running = PG.sm.state !== 'STOPPED';
    el('btnStart').disabled = running;
    el('btnPause').disabled = !running;
    el('btnPause').textContent = PG.sm.paused ? '▶ Wznów' : '⏸ Pauza';
    el('btnStop').disabled = !running;

    // Aktywność przełączników:
    const inputs = [...el('toggles').querySelectorAll('input')];
    TOGGLES.forEach(([key], idx) => {
      if (inputs[idx]) inputs[idx].checked = !!PG.config[key];
    });
  }

  function renderQuests() {
    const list = el('questList');
    const meta = el('questMeta');
    const data = PG.quest.last;
    if (!data) {
      meta.textContent = '';
      list.innerHTML = '<div class="empty">Brak danych — kliknij „Skan questów”.</div>';
      return;
    }
    meta.textContent = data.unknownCount
      ? `${data.goals.length} celów, ${data.unknownCount} NIEZNANYCH`
      : `${data.goals.length} celów`;
    meta.style.color = data.unknownCount ? '#f87171' : '#7a8299';

    const goalsHtml = data.goals.map((g) => {
      const chip = g.status === 'done'
        ? '<span class="chip done">GOTOWE</span>'
        : g.parsed.ok
          ? '<span class="chip active">AKTYWNE</span>'
          : '<span class="chip unknown">NIEZNANY</span>';
      const prog = g.progress
        ? `<span class="prog">${g.progress.current}/${g.progress.total}</span>`
        : '';
      const text = g.parsed.ok ? g.parsed.raw : (g.text || g.parsed.raw || '???');
      const notes = g.notes.map((n) => `<div class="note">📎 ${escapeHtml(n)}</div>`).join('');
      return `<div class="goal">#${g.index} ${chip} ${escapeHtml(text)}${prog}${notes}</div>`;
    }).join('');

    list.innerHTML = `<div class="quest">
      <div class="quest-title">${escapeHtml(data.title || '(bez tytułu)')}</div>
      ${goalsHtml || '<div class="empty">Brak celów</div>'}
    </div>`;
  }

  function renderHistory() {
    const box = el('histList');
    if (!PG.sm.history.length) {
      box.innerHTML = '<div class="empty">—</div>';
      return;
    }
    box.innerHTML = PG.sm.history.slice(0, 30).map((h) =>
      `<div>${pgTime(h.ts)} ${escapeHtml(h.from)} → <b>${escapeHtml(h.to)}</b>${h.reason ? ` · ${escapeHtml(h.reason)}` : ''}</div>`
    ).join('');
  }

  /** Pojedynczy wiersz logu na żywo (bez pełnego re-renderu). */
  function onLogEntry(entry) {
    if (!shadow) return;
    if (entry.event === 'quest_scan' || entry.event === 'config_change') render();
    appendLogRow(entry);
  }

  function appendLogRow(entry) {
    const view = el('logView');
    if (!view) return;
    const row = document.createElement('div');
    if (entry.event.startsWith('exception') || entry.event === 'selector_miss') row.className = 'err';
    const { ts, event, ...rest } = entry;
    row.innerHTML = `<span class="ev">${escapeHtml(event)}</span> ${escapeHtml(pgText(JSON.stringify(rest), 240))}`;
    view.appendChild(row);
    while (view.children.length > MAX_LIVE_LOG_ROWS) view.firstChild.remove();
    view.scrollTop = view.scrollHeight;
    el('logMeta').textContent = `${PG.logger.all().length} zdarzeń`;
  }

  function renderLogView() {
    const view = el('logView');
    if (!view) return;
    view.innerHTML = '';
    for (const e of PG.logger.all().slice(-MAX_LIVE_LOG_ROWS)) appendLogRow(e);
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  return { build, render };
})();
