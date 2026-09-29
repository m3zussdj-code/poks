// ==UserScript==
// @name         PokeGlory Edu Bot
// @namespace    https://github.com/m3zussdj-code/poks
// @version      0.1.0
// @description  Edukacyjny bot do gry PokeGlory: maszyna stanów, parser questów, panel sterowania i lokalna telemetria.
// @match        https://pokeglory.pl/*
// @match        https://*.pokeglory.pl/*
// @match        http://pokeglory.pl/*
// @match        http://*.pokeglory.pl/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
'use strict';

/* ===== src/js/00-namespace.js ===== */
/**
 * 00-namespace.js — przestrzeń nazw bota.
 *
 * Wszystkie moduły wieszają się na obiekcie `PG`.
 * Kolejność plików w `src/js/` ma znaczenie (buduje je build.sh),
 * dlatego numery są celowo prepended do nazw plików.
 */

const PG = {
  version: '0.1.0',

  /**
   * Konfiguracja bota. Panel steruje flagami auto* i pauseOnSpecial,
   * reszta to parametry techniczne.
   */
  config: {
    tickMs: 1500,          // jak często maszyna stanów wykonuje tick
    logLimit: 500,         // rozmiar ring buffera telemetrii
    missThrottleMs: 15000, // nie spamuj logów powtarzającymi się selector_miss

    // przełączniki widoczne w panelu:
    autoWalk: true,        // wędrówki ("Wędruj ponownie")
    autoCatch: false,      // łapanie — włączymy, gdy poznamy DOM ekranu spotkania
    autoQuests: true,      // skan i rozliczanie questów
    autoHeal: true,        // picie drinków (odnowa punktów akcji)
    autoManage: false,     // ewolucja + sprzedaż — wymaga DOM ekwipunku
    pauseOnSpecial: true,  // shiny / tutor → zatrzymaj się i pokaż NEEDS_REVIEW
    debugConsole: true,    // lustrzane logi do konsoli przeglądarki
  },
};

/** Normalizacja tekstu: usuwa podwójne spacje, NBSP, przycina. */
function pgText(value, max = 300) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Znacznik czasu do logów: HH:MM:SS */
function pgTime(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ===== src/js/10-logger.js ===== */
/**
 * 10-logger.js — lokalna telemetria.
 *
 * Ring buffer zdarzeń trzymany wyłącznie w pamięci przeglądarki.
 * Nic nie wychodzi na zewnątrz — użytkownik eksportuje log ręcznie
 * przyciskiem "📋 Kopiuj log" w panelu i wkleja agentowi.
 */

PG.logger = (() => {
  const buffer = [];
  const subscribers = []; // funkcje wywoływane przy każdym zdarzeniu
  const missSeen = new Map(); // throttling powtarzających się selector_miss

  /** Podstawowy zapis zdarzenia. */
  function push(event, data = {}) {
    const entry = { ts: new Date().toISOString(), event, ...data };
    buffer.push(entry);
    if (buffer.length > PG.config.logLimit) {
      buffer.splice(0, buffer.length - PG.config.logLimit);
    }
    if (PG.config.debugConsole) {
      try {
        console.log(`[PG ${pgTime()}]`, event, data);
      } catch (_) { /* console może być zablokowane */ }
    }
    for (const fn of subscribers) {
      try { fn(entry); } catch (_) { /* panel nie powinien łamać loggera */ }
    }
    return entry;
  }

  function subscribe(fn) {
    subscribers.push(fn);
  }

  function stateChange(from, to, reason) {
    return push('state_change', { from, to, reason: pgText(reason, 200) });
  }

  /**
   * Selektor nie trafił w DOM. Zapisujemy listę obecnych ról
   * data-pokeglory-integrity — to wystarczy agentowi, dobrać właściwy selektor.
   * Powtórzenia tego samego braku w ciągu missThrottleMs są liczone, nie logowane.
   */
  function selectorMiss(name, extra = {}) {
    const now = Date.now();
    const prev = missSeen.get(name);
    if (prev && now - prev.ts < PG.config.missThrottleMs) {
      prev.suppressed += 1;
      return null;
    }
    const suppressed = prev ? prev.suppressed : 0;
    missSeen.set(name, { ts: now, suppressed: 0 });

    let roles = [];
    try {
      roles = [...new Set(
        [...document.querySelectorAll('[data-pokeglory-integrity-role]')]
          .map((el) => el.getAttribute('data-pokeglory-integrity-role'))
      )];
    } catch (_) { /* brak document poza przeglądarką */ }

    return push('selector_miss', {
      name,
      suppressed,
      roles: roles.slice(0, 100),
      ...extra,
    });
  }

  function action(name, ok, extra = {}) {
    return push('action', { action: name, ok, ...extra });
  }

  /** Pełny eksport: konfiguracja, stan, historia, questy + wszystkie logi. */
  function exportPayload() {
    return {
      bot: { name: 'PokeGlory Edu Bot', version: PG.version },
      exportedAt: new Date().toISOString(),
      url: typeof location !== 'undefined' ? location.href : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      config: { ...PG.config },
      state: PG.sm
        ? { state: PG.sm.state, paused: PG.sm.paused, reason: PG.sm.reason, history: PG.sm.history }
        : null,
      quests: PG.quest ? PG.quest.last : null,
      logs: [...buffer],
    };
  }

  function toJSON() {
    return JSON.stringify(exportPayload(), null, 2);
  }

  /** Kopiowanie do schowka z fallbackiem (bezpieczny kontekst vs. stary API). */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* spadamy do fallbacku */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  async function copyAll() {
    return copyToClipboard(toJSON());
  }

  function downloadAll() {
    const blob = new Blob([toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pg-bot-log-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function clear() {
    buffer.length = 0;
    missSeen.clear();
    push('log_cleared', {});
  }

  function all() {
    return [...buffer];
  }

  return {
    push, subscribe, stateChange, selectorMiss, action,
    exportPayload, toJSON, copyToClipboard, copyAll, downloadAll,
    clear, all,
  };
})();

/* ===== src/js/20-selectors.js ===== */
/**
 * 20-selectors.js — rejestr selektorów.
 *
 * Każda logiczna nazwa mapuje się na listę kandydatów; pierwszy
 * trafiony wygrywa. Priorytet: atrybuty data-pokeglory-integrity-role
 * (stabilne haki wbudowane w grę) → klasyczne selektory CSS → tekst.
 *
 * ZASADA: bot TYLKO CZYTA atrybuty gry — nigdy ich nie modyfikuje.
 */

PG.selectors = (() => {
  /** @type {Record<string, string[]>} */
  const registry = {
    // Znane na 100% (przekazane przez użytkownika):
    'walk-again-button': [
      '[data-pokeglory-integrity-role="walk-again-button"]',
    ],

    // Kandydaci do doprecyzowania po pierwszych logach ze strony:
    'quest-container': [
      '[data-pokeglory-integrity-role*="quest"]',
      '[data-pokeglory-integrity-role*="objective"]',
      '[data-pokeglory-integrity-role*="task"]',
    ],
    'heal-button': [
      '[data-pokeglory-integrity-role*="heal"]',
      '[data-pokeglory-integrity-role*="drink"]',
    ],
    'encounter-catch-button': [
      '[data-pokeglory-integrity-role*="catch"]',
      '[data-pokeglory-integrity-role*="capture"]',
    ],
    'quest-claim-button': [
      '[data-pokeglory-integrity-role*="claim"]',
      '[data-pokeglory-integrity-role*="reward"]',
      '[data-pokeglory-integrity-role*="complete"]',
    ],
  };

  /** Zarejestruj (lub podmień) kandydatów dla nazwy logicznej. */
  function register(name, candidates) {
    registry[name] = [...candidates];
  }

  /**
   * Znajdź element. Zwraca element albo null.
   * Brak trafienia = log selector_miss (z listą obecnych ról na stronie).
   */
  function resolve(name, { reportMiss = true } = {}) {
    const candidates = registry[name];
    if (!candidates) {
      PG.logger.push('selector_unknown', { name });
      return null;
    }
    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {
        PG.logger.push('selector_invalid', { name, sel });
      }
    }
    if (reportMiss) PG.logger.selectorMiss(name);
    return null;
  }

  /** resolve() zwracający wszystkie trafienia. */
  function resolveAll(name) {
    const candidates = registry[name] || [];
    const out = [];
    for (const sel of candidates) {
      try {
        out.push(...document.querySelectorAll(sel));
        if (out.length) break;
      } catch (_) { /* ignoruj nieprawidłowy selektor */ }
    }
    return out;
  }

  /** Inwentarz haków gry: wszystkie obecne data-pokeglory-integrity-role. */
  function integrityRoles() {
    try {
      return [...new Set(
        [...document.querySelectorAll('[data-pokeglory-integrity-role]')]
          .map((el) => el.getAttribute('data-pokeglory-integrity-role'))
      )];
    } catch (_) {
      return [];
    }
  }

  return { registry, register, resolve, resolveAll, integrityRoles };
})();

/* ===== src/js/30-quest-parser.js ===== */
/**
 * 30-quest-parser.js — parser questów.
 *
 * Dwie warstwy:
 *   A) parseQuestText()  — heurystyka tekstowa na liniach (wyciągana
 *      z innerText kontenera questów). Struktura questów jest regularna:
 *      tekst celu → marker "#N" + status → licznik "cur/total" → notatki.
 *      Markery "#N" są kotwicą — celu szukamy wstecz do najbliższego
 *      wiersza zaczynającego się od czasownika (ZE SŁOWNIKA).
 *   B) classify()         — mapa tekst → kanoniczny typ akcji.
 *      Nieznany tekst = UNKNOWN_GOAL → bot czeka, telemetria zbiera
 *      surowy tekst, agent dopisuje wzorzec.
 *
 * Czyste funkcje (normalize/classify/parseQuestText) są testowane
 * w tests/quest-parser.test.js — bez DOM-u.
 */

PG.quest = (() => {
  // ───────────────────────── warstwa B: słownik wzorców ─────────────────────

  /** Normalizacja pułapek składni: "typuFire" → "typu Fire", "1xShiny" → "1x Shiny". */
  function normalize(text) {
    return String(text ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/typu(?=[A-ZŁŚŻŹĆĄĘÓŃ])/g, 'typu ')
      .replace(/(\d)x(?=[A-ZŁŚŻŹĆĄĘÓŃ])/g, '$1x ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Rejestr wzorców celów. Kolejność ma znaczenie — specyficzne
   * przed ogólnymi (np. WALK_IN przed WALK).
   * Każde dopasowanie daje kanoniczny typ używany przez maszynę stanów.
   */
  const PATTERNS = [
    { re: /^Złap\s+(\d+)\s+pok[eé]mon[oó]w?\s+typu\s+(.+)$/i,
      map: (m) => ({ type: 'CATCH_TYPE', count: +m[1], pokemonType: m[2].trim() }) },

    { re: /^Spotkaj\s+(\d+)\s+dwutypowych/i,
      map: (m) => ({ type: 'ENCOUNTER_DUALTYPE', count: +m[1] }) },

    { re: /^Spotkaj\s+(\d+)x?\s+pok[eé]mon[oó]w\s+trzymających\s+przedmiot\s+(.+)$/i,
      map: (m) => ({ type: 'ENCOUNTER_HELD_ITEM', count: +m[1], item: m[2].trim() }) },

    { re: /^Wykonaj\s+(\d+)\s+wędrówek\s+w\s+lokacji\s+(.+)$/i,
      map: (m) => ({ type: 'WALK_IN', count: +m[1], location: m[2].trim() }) },

    { re: /^Wykonaj\s+(\d+)\s+wędrówek/i,
      map: (m) => ({ type: 'WALK', count: +m[1] }) },

    { re: /^Zdobądź\s+(\d+)\s+doświadczenia/i,
      map: (m) => ({ type: 'GAIN_XP', count: +m[1] }) },

    { re: /^Wygraj\s+(\d+)\s+walk/i,
      map: (m) => ({ type: 'WIN_BATTLE', count: +m[1] }) },

    { re: /^Przeprowadź\s+(\d+)\s+badań\s+terenowych/i,
      map: (m) => ({ type: 'FIELD_RESEARCH', count: +m[1] }) },

    // Wymaga doprecyzowania (item vs. Pokémon) po kontekście strony:
    { re: /^Oddaj\s+(\d+)x?\s+(.+)$/i,
      map: (m) => ({ type: 'DELIVER', count: +m[1], target: m[2].trim() }) },
  ];

  /** Dopasuj tekst celu do wzorca. Nieznany → { ok:false, type:'UNKNOWN_GOAL' }. */
  function classify(text) {
    const t = normalize(text);
    for (const p of PATTERNS) {
      const m = p.re.exec(t);
      if (m) return { ok: true, raw: t, ...p.map(m) };
    }
    return { ok: false, type: 'UNKNOWN_GOAL', raw: t };
  }

  // ───────────────────────── warstwa A: parsing tekstu ──────────────────────

  /**
   * Czasowniki, od których zaczynają się opisy celów (polska wersja gry).
   * UWAGA: bez \\b — word boundary nie widzi polskich znaków (ź, ć, ł…),
   * po czasowniku wymagamy spacji.
   */
  const GOAL_VERBS = /^(Złap|Spotkaj|Wykonaj|Zdobądź|Wygraj|Przeprowadź|Oddaj)(\s|$)/i;

  /** Linie, po których przestajemy czytać notatki celu. */
  const STOP_LINES = /^(Nagrody\b)/i;

  function parseStatus(text) {
    const t = pgText(text, 40);
    if (/^gotowe$/i.test(t)) return 'done';
    if (/^aktywne$/i.test(t)) return 'active';
    return null;
  }

  function parseProgress(text) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(String(text ?? ''));
    return m ? { current: +m[1], total: +m[2] } : null;
  }

  /**
   * Główny parser — tekst innerText kontenera questów → struktura.
   *
   * @param {string} text surowy tekst (innerText) z sekcji questów
   * @returns {{title: string|null, goals: Array, unknownCount: number}}
   */
  function parseQuestText(text) {
    const lines = String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Markery celów: "#1Gotowe", "#2Aktywne"… — kotwica struktury.
    const markers = [];
    lines.forEach((l, i) => { if (/^#\d+/.test(l)) markers.push(i); });

    const goals = [];
    const consumed = new Set(); // indeksy linii już przypisanych jako opis celu

    for (const mi of markers) {
      const marker = lines[mi];
      const index = parseInt(marker.match(/^#(\d+)/)[1], 10);

      // 1) Szukamy opisu celu wstecz (max 6 linii) — do najbliższego
      //    wiersza zaczynającego się od czasownika.
      let textIdx = -1;
      for (let j = mi - 1; j >= 0 && j >= mi - 6; j--) {
        if (consumed.has(j)) continue;
        if (GOAL_VERBS.test(normalize(lines[j]))) { textIdx = j; break; }
      }

      const goalText = textIdx >= 0 ? normalize(lines[textIdx]) : null;
      const parsed = goalText
        ? classify(goalText)
        : { ok: false, type: 'UNKNOWN_GOAL', raw: marker, flag: 'no_text' };

      // 2) Status z markera ("#1Gotowe" → "Gotowe"), uzupełniony z przodu.
      let status = parseStatus(marker.replace(/^#\d+/, '')) || 'unknown';
      let progress = null;
      const notes = [];

      // 3) Linie po markerze aż do następnego markera / sekcji nagród.
      for (let k = mi + 1; k < lines.length; k++) {
        if (/^#\d+/.test(lines[k])) break;
        if (STOP_LINES.test(lines[k])) break;
        // Linia z czasownikiem = opis KOLEJNEGO celu (stoi przed swoim
        // markerem) — nie jest notatką bieżącego celu.
        if (GOAL_VERBS.test(normalize(lines[k]))) break;

        const line = lines[k];
        if (line === 'x' || line === '×') continue;

        const st = parseStatus(line);
        if (st) { status = st; continue; }

        const pr = parseProgress(line);
        if (pr) { progress = pr; continue; }

        notes.push(pgText(line, 300)); // np. "Masz w plecaku: 28", podpowiedzi
      }

      goals.push({
        index,
        text: goalText,          // null, gdy nie znaleziono opisu (flag: no_text)
        parsed,
        status,                  // 'active' | 'done' | 'unknown'
        progress,                // { current, total } | null
        notes,
      });
      if (textIdx >= 0) consumed.add(textIdx);
    }

    const unknownCount = goals.filter((g) => !g.parsed.ok).length;

    return {
      title: lines[0] ? pgText(lines[0], 200) : null,
      goals,
      unknownCount,
    };
  }

  // ───────────────────────── warstwa DOM (eskstrakcja) ──────────────────────

  /** Ostatni wynik skanu — panel to renderuje. */
  let last = null;

  /**
   * Skanuj stronę w poszukiwaniu questów.
   * @returns {object|null} ostatni wynik albo null, gdy nie ma kontenera
   *                        (wtedy leci selector_miss → telemetria).
   */
  function scan() {
    const el = PG.selectors.resolve('quest-container');
    if (!el) return null;

    const raw = el.innerText || el.textContent || '';
    const parsed = parseQuestText(raw);
    last = { ts: new Date().toISOString(), ...parsed };

    PG.logger.push('quest_scan', {
      quests: parsed.goals.length,
      unknown: parsed.unknownCount,
      title: parsed.title,
    });
    // Nieznane cele — surowy tekst do telemetrii (klucz pętli uczenia).
    for (const g of parsed.goals) {
      if (!g.parsed.ok) {
        PG.logger.push('unknown_goal', { text: g.text || g.parsed.raw, index: g.index });
      }
    }
    if (PG.panel) PG.panel.render();
    return last;
  }

  return { normalize, classify, parseQuestText, parseStatus, parseProgress, scan, PATTERNS,
    get last() { return last; } };
})();

/* ===== src/js/40-state-machine.js ===== */
/**
 * 40-state-machine.js — maszyna stanów bota.
 *
 * Stany:
 *   STOPPED          — bot wyłączony
 *   SCANNING         — analiza: gdzie jesteśmy, co robić dalej
 *   WANDER           — wędrówka ("Wędruj ponownie")
 *   CATCH            — ekran spotkania / łapanie
 *   BATTLE           — walka
 *   QUEST_TURNIN     — odbiór ukończonego questa
 *   HEAL             — picie drinków (odnowa punktów akcji)
 *   INVENTORY        — ewolucja / sprzedaż
 *   SPECIAL_ENCOUNTER— shiny, tutor itp. → przepuszcza do NEEDS_REVIEW
 *   NEEDS_REVIEW     — bot nie rozpoznaje sytuacji → CZEKA na człowieka
 *
 * Złota zasada: gdy bot nie wie, co robić → NEEDS_REVIEW + pełny log.
 * Nikdy nie „zgaduje” w ciemno.
 */

PG.sm = (() => {
  let state = 'STOPPED';
  let paused = false;
  let reason = '';
  const history = []; // { ts, from, to, reason } — ostatnie 50 wpisów
  const handlers = {}; // state -> funkcja wywoływana w ticku

  function set(next, why = '') {
    if (next === state) return;
    const from = state;
    state = next;
    reason = why;
    history.unshift({ ts: Date.now(), from, to: next, reason: pgText(why, 200) });
    if (history.length > 50) history.pop();
    PG.logger.stateChange(from, next, why);
    if (PG.panel) PG.panel.render();
  }

  /** Zarejestruj handler stanu (wykonywany co tick). */
  function register(name, fn) {
    handlers[name] = fn;
  }

  /** Pojedynczy tick maszyny. Bezpieczny: wyjątek = NEEDS_REVIEW, nie crash. */
  function tick() {
    if (document.hidden) return;     // oszczędzamy zasoby w tle zakładki
    if (paused || state === 'STOPPED') return;

    const h = handlers[state];
    if (!h) {
      set('NEEDS_REVIEW', `brak handlera dla stanu ${state}`);
      return;
    }
    try {
      h();
    } catch (err) {
      PG.logger.push('exception', {
        state,
        message: String((err && err.message) || err),
        stack: String((err && err.stack) || '').slice(0, 500),
      });
      set('NEEDS_REVIEW', `wyjątek: ${(err && err.message) || err}`);
    }
  }

  function start() {
    paused = false;
    set('SCANNING', 'start przez użytkownika');
  }

  function pause() {
    paused = true;
    PG.logger.push('paused', { state });
    if (PG.panel) PG.panel.render();
  }

  function resume() {
    paused = false;
    PG.logger.push('resumed', { state });
    if (PG.panel) PG.panel.render();
  }

  function stop() {
    paused = false;
    set('STOPPED', 'stop przez użytkownika');
  }

  /** Wywoływane z panelu, gdy użytkownik uzna, że NEEDS_REVIEW rozpoznane. */
  function acknowledge() {
    if (state === 'NEEDS_REVIEW') set('SCANNING', 'użytkownik potwierdził → ponowny skan');
  }

  return {
    STATES: ['STOPPED', 'SCANNING', 'WANDER', 'CATCH', 'BATTLE',
      'QUEST_TURNIN', 'HEAL', 'INVENTORY', 'SPECIAL_ENCOUNTER', 'NEEDS_REVIEW'],
    get state() { return state; },
    get paused() { return paused; },
    get reason() { return reason; },
    history,
    register, set, tick,
    start, pause, resume, stop, acknowledge,
  };
})();

/* ===== src/js/50-actions.js ===== */
/**
 * 50-actions.js — akcje bota (interakcje z DOM-em gry).
 *
 * Zasady:
 *  - wyłącznie odczyt + click(); nigdy nie modyfikujemy atrybutów gry,
 *  - brak elementu = selector_miss + przejście do NEEDS_REVIEW,
 *  - akcje nieznane (brak DOM) = action_stub w telemetrii — po to,
 *    żeby wiedzieć, których ekranów jeszcze nie IMPLEMENTOWALIŚMY.
 */

PG.actions = (() => {
  /** Klik w element znaleziony po nazwie logicznej. */
  function click(name) {
    const el = PG.selectors.resolve(name);
    if (!el) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      PG.logger.push('action_disabled', { name });
      return false;
    }
    el.click();
    return true;
  }

  /** „Wędruj ponownie” — jedyne known-known na dziś. */
  function walkAgain() {
    const ok = click('walk-again-button');
    if (!ok) {
      PG.sm.set('NEEDS_REVIEW', 'brak przycisku „Wędruj ponownie”');
      return false;
    }
    PG.logger.action('walk_again', true);
    return true;
  }

  /** Tymczasowy stub — dopóki nie poznamy DOM-u danego ekranu. */
  function stub(name) {
    PG.logger.action(name, false, { stub: true, hint: 'ekran jeszcze niezaimplementowany' });
    return false;
  }

  return {
    walkAgain,
    click,
    // stuby do wypełnienia po pierwszych logach ze strony:
    catchEncounter: () => stub('catch'),
    fleeEncounter: () => stub('flee'),
    heal: () => stub('heal'),
    evolveTeam: () => stub('evolve'),
    sellPokemon: () => stub('sell'),
    turnInQuest: () => stub('turn_in'),
    claimRewards: () => stub('claim_rewards'),
    /** Zgłoś specjalne spotkanie (shiny/tutor) → NEEDS_REVIEW, jeśli włączone. */
    specialEncounter(kind, extra = {}) {
      PG.logger.push('special_encounter', { kind, ...extra });
      PG.sm.set('SPECIAL_ENCOUNTER', `specjalne spotkanie: ${kind}`);
    },
  };
})();

/* ===== src/js/60-panel.js ===== */
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
      .map((b) => ({
        tag: b.tagName.toLowerCase(),
        text: pgText(b.textContent, 60),
        id: b.id || null,
        role: b.getAttribute('data-pokeglory-integrity-role'),
        cls: pgText(b.className, 100),
      }));
    return {
      url: location.href,
      title: document.title,
      integrityRoles: PG.selectors.integrityRoles(),
      buttons,
      bodyText: pgText(document.body ? document.body.innerText : '', 4000),
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

/* ===== src/js/70-main.js ===== */
/**
 * 70-main.js — start bota, pętla ticków i handlery stanów.
 *
 * SCANNING decyduje: skan questów → detekcja ekranu → przejście
 * do znanego stanu albo NEEDS_REVIEW (nieznany ekran).
 *
 * Detekcja ekranu jest na razie minimalna (v1) — każdy nowy typ
 * ekranu dopisujemy po analizie snapshotu/selector_miss z telemetrii.
 */

PG.main = (() => {
  let timer = null;

  // ── detekcja ekranu (v1 — rozszerzamy po logach) ─────────────────────────

  function detectScreen() {
    if (PG.selectors.resolve('walk-again-button', { reportMiss: false })) return 'walk_ready';
    // TODO: ekran spotkania (catch), walka, centrum heal, ekwipunek…
    return 'unknown';
  }

  // ── handlery stanów ───────────────────────────────────────────────────────

  function registerStates() {
    const sm = PG.sm;

    sm.register('SCANNING', () => {
      if (PG.config.autoQuests) PG.quest.scan();

      const screen = detectScreen();
      PG.logger.push('screen_detected', { screen });

      if (screen === 'walk_ready') {
        sm.set('WANDER', 'rozpoznany ekran: wędrówka');
        return;
      }
      // Nieznany ekran: pełny snapshot do telemetrii + czekamy na człowieka.
      if (PG.panel) PG.logger.push('screen_unknown_snapshot', {
        integrityRoles: PG.selectors.integrityRoles(),
        url: location.href,
      });
      sm.set('NEEDS_REVIEW', `nieznany ekran (${screen}) — prześlij log do agenta`);
    });

    sm.register('WANDER', () => {
      if (detectScreen() !== 'walk_ready') {
        sm.set('SCANNING', 'ekran się zmienił po wędrówce');
        return;
      }
      if (PG.config.autoWalk) PG.actions.walkAgain();
      // TODO: gdy autoCatch i wykryty ekran spotkania → CATCH
    });

    sm.register('CATCH', () => {
      if (!PG.config.autoCatch) {
        sm.set('NEEDS_REVIEW', 'spotkanie wymaga łapania, a autoCatch jest wyłączone');
        return;
      }
      PG.actions.catchEncounter();
    });

    sm.register('BATTLE', () => {
      // TODO: automatyczna walka — na razie tylko zgłaszamy.
      PG.logger.action('battle_round', false, { stub: true });
    });

    sm.register('QUEST_TURNIN', () => {
      PG.actions.turnInQuest();
      PG.actions.claimRewards();
    });

    sm.register('HEAL', () => {
      if (PG.config.autoHeal) PG.actions.heal();
      else sm.set('NEEDS_REVIEW', 'brak punktów akcji, autoHeal wyłączone');
    });

    sm.register('INVENTORY', () => {
      if (!PG.config.autoManage) {
        sm.set('NEEDS_REVIEW', 'zarządzanie ekwipunkiem, autoManage wyłączone');
        return;
      }
      PG.actions.evolveTeam();
      PG.actions.sellPokemon();
    });

    sm.register('SPECIAL_ENCOUNTER', () => {
      // Shiny / tutor: jeżeli użytkownik chce pauzy — czekamy na niego.
      if (PG.config.pauseOnSpecial) {
        sm.set('NEEDS_REVIEW', 'specjalne spotkanie (shiny/tutor) — decyzja człowieka');
      } else {
        sm.set('SCANNING', 'specjalne spotkanie pominięte (pauseOnSpecial=false)');
      }
    });

    // STOPPED i NEEDS_REVIEW celowo bez handlera — bot ma stać bezczynnie.
  }

  // ── pętla ─────────────────────────────────────────────────────────────────

  function startLoop() {
    stopLoop();
    timer = setInterval(() => PG.sm.tick(), PG.config.tickMs);
  }

  function stopLoop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function start() {
    PG.logger.push('bot_started', { version: PG.version });
    PG.sm.start();
    startLoop();
  }

  function stop() {
    PG.logger.push('bot_stopped', {});
    PG.sm.stop();
    stopLoop();
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  function boot() {
    if (window.__PG_BOT_BOOTED) {
      console.warn('[PG] Bot już uruchomiony na tej stronie — pomijam ponowny boot.');
      return;
    }
    window.__PG_BOT_BOOTED = true;

    registerStates();
    PG.panel.build();

    PG.logger.push('bot_booted', {
      version: PG.version,
      url: location.href,
      integrityRoles: PG.selectors.integrityRoles(),
    });

    console.log(
      `%c[PG Edu Bot] v${PG.version} załadowany — otwórz panel po prawej, kliknij ▶ Start.`,
      'color:#facc15;font-weight:bold'
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  return { start, stop, detectScreen, registerStates };
})();

})();
