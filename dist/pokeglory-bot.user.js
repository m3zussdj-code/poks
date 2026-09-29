// ==UserScript==
// @name         PokeGlory Edu Bot
// @namespace    https://github.com/m3zussdj-code/poks
// @version      0.7.0
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
  version: '0.7.0',

  /**
   * Konfiguracja bota. Panel steruje flagami auto* i pauseOnSpecial,
   * reszta to parametry techniczne. Całość zapisuje się w localStorage
   * (persistencja po odświeżeniu strony).
   */
  config: {
    tickMs: 500,           // BAZOWY interwał pętli (zmodyfikowany przez jitter)
    graceMs: 2500,         // po kliknięciu czekamy tyle na aktualizację ekranu
    jitter: 0.35,          // ±35% losowania wokół KAŻDEGO interwału i cooldownu
                           // (0 = sztywne, robotnicze odstępy — nie używaj!)
    logLimit: 500,         // rozmiar ring buffera telemetrii
    missThrottleMs: 15000, // nie spamuj logów powtarzającymi się selector_miss

    // minimalne odstępy między klikami (ms) — BAZA przed jitterem.
    // Chronią przed spamowaniem serwera; jitter robi z tego
    // nieprzewidywany (ludzki) rozrzut.
    cooldowns: {
      walk: 800,
      team: 600,
      throw: 800,
      skip: 700,
      heal: 1200,
      location: 1500,
      berry: 700,
      teamHeal: 1500,
      manage: 1500,       // ewolucja/sprzedaż rezerwy (klik ↔ dialog)
    },

    // przełączniki widoczne w panelu:
    autoWalk: true,        // wędrówki ("Wędruj ponownie")
    autoCatch: true,       // rzut piłką po wygranej walce
    autoBerries: true,     // „Zbierz jagody” przy krzewie podczas wędrówki
    autoSkipBattle: true,  // klikaj "Przejdź do końca walki"
    autoQuests: true,      // skan i rozliczanie questów
    autoHeal: true,        // picie drinków (odnowa punktów akcji)
    autoHealTeam: true,    // lecz HP pokemonów (< healHpBelow%) — ekran spotkania
    autoManage: true,     // rezerwa pełna → ewoluuj (dialogi) → sprzedaj (dialog)
    autoResume: true,      // wznowienie działania po odświeżeniu strony
    questLocation: true,   // cel z questa WALK_IN steruje wyborem lokacji
    pauseOnSpecial: true,  // shiny / tutor → zatrzymaj się i pokaż NEEDS_REVIEW
    debugConsole: true,    // lustrzane logi do konsoli przeglądarki

    // łapanie / walka:
    teamSlot: 1,           // który Pokémon z drużyny ma walczyć (1-based)
    walkLocation: '',      // start z kokpitu: '' = ręcznie, np. 'Mroczne Miasto'
    balls: {               // priorytet 1, priorytet 2 (zapasowy przy braku P1)
      normal: ['Level Ball', 'Poké Ball'],
      shiny: ['Shiny Ball', 'Master Ball'],
    },
    maxThrows: 3,          // maks. rzutów w jednej potyczce (potem NEEDS_REVIEW)
    healBelow: 6,          // pij drinki, gdy PA < tej wartości (max koszt karty = 5)
    healHpBelow: 50,       // lecz drużynę, gdy HP dowolnego mona < ten próg (%)
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
 * trafiony wygrywa. Kandydat to albo:
 *   - string  → zwykły CSS (np. '[data-pokeglory-integrity-role="…"]'),
 *   - { sel, re } → elementy pasujące do CSS `sel`, których tekst
 *     (skrócony do 200 znaków) pasuje do regex `re`.
 *
 * Priorytet: atrybuty data-pokeglory-integrity-role (stabilne haki gry,
 * obecne tylko na niektórych ekranach) → selektory tekstowe → CSS.
 *
 * ZASADA: bot TYLKO CZYTA atrybuty gry — nigdy ich nie modyfikuje.
 */

PG.selectors = (() => {
  /** @type {Record<string, Array<string|{sel: string, re: RegExp}>>} */
  const registry = {
    // ── znane z danych od użytkownika ──────────────────────────────────────
    // Rola obecna na ekranie wędrówki (NIE na kokpicie — weryfikowane).
    'walk-again-button': [
      '[data-pokeglory-integrity-role="walk-again-button"]',
    ],

    // ── szybkie akcje kokpitu (ze snapshotu 2026-09-29) ───────────────────
    // Teksty z gry: "360Regeneracja punktów akcji", "6Ewoluuj wszystkie…" itd.
    'heal-ap-button': [
      { sel: 'button', re: /Regeneracja punktów akcji/i },
    ],
    'evolve-all-button': [
      { sel: 'button', re: /Ewoluuj wszystkie gotowe/i },
    ],
    // „60/60Szybka sprzedaż pokemonów” — licznik rezerwy w etykiecie.
    'quick-sell-button': [
      { sel: 'button', re: /Szybka sprzedaż pokemonów/i },
    ],
    'heal-team-button': [
      { sel: 'button', re: /Leczenie wszystkich pokemonów/i },
    ],
    'convert-pz-button': [
      { sel: 'button', re: /Wymiana PZ na PA/i },
    ],

    // Karty „Wędrówki w dziczy": "4 PASafrania", "5 PAPrizmania"…
    // (klik = prawdopodobnie start wędrówki; zachowanie do potwierdzenia).
    'walk-location-card': [
      { sel: 'button', re: /^\d+\s*PA[A-ZŁŚŻŹĆĄĘÓŃ]/ },
    ],

    // ── ekran spotkania / walki / wyniku (snapshoty 2026-09-29, /mapa) ────
    'encounter-preview': [
      '[data-pokeglory-integrity-role="encounter-preview"]',
    ],
    'team-selection': [
      '[data-pokeglory-integrity-role="team-selection"]',
    ],
    // Leczenie drużyny: kandydat 1 „Ulecz wszystkie” w panelu drużyny
    // (bywa ukryta kopia w DOM — akcja preferuje widoczny element);
    // kandydat 2 globalne „Leczenie wszystkich pokemonów” jako fallback.
    'team-heal-button': [
      { sel: 'button', re: /^Ulecz wszystkie$/ },
      { sel: 'button', re: /Leczenie wszystkich pokemonów/ },
    ],
    'battle-skip-button': [
      { sel: 'button', re: /Przejdź do końca walki/ },
    ],
    // Podsumowanie PO walce (np. trener): rola result-actions + „Wróć do mapy".
    // UWAGA: „Przejdź do końca walki" z ekranu walki ZOSTAJE w DOM na wyniku,
    // dlatego detectScreen sprawdza battle-result PRZED battle-skip-button.
    'battle-result': [
      '[data-pokeglory-integrity-role="result-actions"]',
      { sel: 'button', re: /Wróć do mapy/ },
    ],
    'berry-button': [
      { sel: 'button', re: /Zbierz jagody/ },
    ],
    'ball-card': [
      { sel: 'button', re: /Szansa złapania/i },
    ],

    // ── kandydaci do doprecyzowania po snapshotach innych ekranów ─────────
    'quest-container': [
      '[data-pokeglory-integrity-role*="quest"]',
      '[data-pokeglory-integrity-role*="objective"]',
      '[data-pokeglory-integrity-role*="task"]',
      { sel: 'section', re: /Nagrody za ukończenie/i },
    ],
    'encounter-catch-button': [
      '[data-pokeglory-integrity-role*="catch"]',
      '[data-pokeglory-integrity-role*="capture"]',
    ],
    'quest-claim-button': [
      '[data-pokeglory-integrity-role*="claim"]',
      '[data-pokeglory-integrity-role*="reward"]',
      { sel: 'button', re: /^Odbierz/i },
    ],
  };

  /** Zarejestruj (lub podmień) kandydatów dla nazwy logicznej. */
  function register(name, candidates) {
    registry[name] = [...candidates];
  }

  /** Znajdź pierwszy element dla jednego kandydata (string albo {sel,re}). */
  function findFirst(desc) {
    if (typeof desc === 'string') return document.querySelector(desc);
    try {
      for (const el of document.querySelectorAll(desc.sel)) {
        if (desc.re.test(pgText(el.textContent, 200))) return el;
      }
    } catch (_) { /* nieprawidłowy selektor — ignoruj */ }
    return null;
  }

  /** Znajdź wszystkie elementy dla jednego kandydata. */
  function findAll(desc) {
    if (typeof desc === 'string') return [...document.querySelectorAll(desc)];
    const out = [];
    try {
      for (const el of document.querySelectorAll(desc.sel)) {
        if (desc.re.test(pgText(el.textContent, 200))) out.push(el);
      }
    } catch (_) { /* ignoruj */ }
    return out;
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
    for (const desc of candidates) {
      try {
        const el = findFirst(desc);
        if (el) return el;
      } catch (_) {
        PG.logger.push('selector_invalid', { name, sel: String(desc) });
      }
    }
    if (reportMiss) PG.logger.selectorMiss(name);
    return null;
  }

  /** resolve() zwracający wszystkie trafienia (np. karty lokacji). */
  function resolveAll(name) {
    const candidates = registry[name] || [];
    for (const desc of candidates) {
      const found = findAll(desc);
      if (found.length) return found;
    }
    return [];
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

  // ───────────────── sidebar questów („Zadania Billa”) ─────────────────────

  /**
   * Czysty parser widgetu questowego w sidebarze (bez DOM-u → testy).
   * Wejście: innerText widgetu + kroki z klas CSS (is-complete / is-active).
   *
   * Typowa struktura:
   *   Zadania Billa
   *   Aktywne zadanie i jego nagrody
   *   Eksperckie Trakt Prizmański      ← tier + obszar
   *   Rozliczający raport wyzwań       ← tytuł
   *   Nagrody -10%
   *   Wykonaj 540 wędrówek w lokacji Mroczne Miasto   ← cel (verb!)
   *   Aktywne / 74/540 / x
   *   Nagrody 51x Power Drink 2,630,790 ¥
   */
  function parseSidebarQuest(text, steps = []) {
    const lines = String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const goalIdx = lines.findIndex((l) => GOAL_VERBS.test(normalize(l)));
    if (goalIdx < 0) return { active: false };

    const anchor = lines.findIndex((l) => /^Aktywne zadanie/i.test(l));
    const goalText = normalize(lines[goalIdx]);
    const parsed = classify(goalText);

    let status = 'unknown';
    let progress = null;
    for (let i = goalIdx + 1; i < Math.min(lines.length, goalIdx + 6); i++) {
      const line = lines[i];
      if (/^Nagrody/i.test(line)) break;
      const st = parseStatus(line);
      if (st) { status = st; continue; }
      const pr = parseProgress(line);
      if (pr && !progress) { progress = pr; break; }
    }

    const rewards = lines.slice(goalIdx).find((l) => /^Nagrody\s+\d/.test(l)) || null;
    const title = (anchor >= 0 && lines[anchor + 2]) || lines[goalIdx - 2] || null;
    const tierArea = (anchor >= 0 && lines[anchor + 1]) || null;

    const activeIdx = steps.findIndex((s) => s.active);
    return {
      active: true,
      title,
      tierArea,
      goal: { text: goalText, parsed, status, progress },
      steps: {
        total: steps.length || null,
        done: steps.filter((s) => s.done).length,
        active: activeIdx >= 0 ? activeIdx + 1 : null,
      },
      rewards,
    };
  }

  /** Ostatni stan widgetu sidebar + odcisk (do logowania tylko przy zmianie). */
  let sidebar = null;
  let sidebarFp = null;

  /**
   * Odczytaj widget questów ze strony (kroki mają klasy CSS gry).
   * Wykrywany na KAŻDYM ekranie — sidebar jest globalny.
   */
  function scanSidebar() {
    const step = document.querySelector('.player-sidebar-quest-step');
    if (!step) {
      if (sidebar) {
        sidebar = null;
        sidebarFp = null;
        PG.logger.push('sidebar_quest_cleared', {});
        if (PG.panel) PG.panel.render();
      } else {
        PG.logger.selectorMiss('sidebar-quest-widget');
      }
      return null;
    }

    // Najmniejszy przodek zawierający nagłówek „Zadania …”:
    let cont = null;
    for (let el = step, i = 0; el && i < 8; el = el.parentElement, i += 1) {
      const t = el.innerText || '';
      if (/Zadania\s/.test(t) && t.length < 2500) { cont = el; break; }
    }
    if (!cont) {
      PG.logger.selectorMiss('sidebar-quest-widget', { hint: 'kroki znalezione, brak nadrzędnego z nagłówkiem' });
      return null;
    }

    const steps = [...cont.querySelectorAll('.player-sidebar-quest-step')].map((s) => ({
      done: s.classList.contains('is-complete'),
      active: s.classList.contains('is-active') || s.classList.contains('is-selected'),
    }));

    const parsed = parseSidebarQuest(cont.innerText, steps);
    sidebar = { ts: new Date().toISOString(), ...parsed };

    const fp = JSON.stringify([
      parsed.active, parsed.title,
      parsed.goal && parsed.goal.text,
      parsed.goal && parsed.goal.progress,
      parsed.steps,
    ]);
    if (fp !== sidebarFp) {
      sidebarFp = fp;
      if (parsed.active) {
        PG.logger.push('sidebar_quest', {
          title: parsed.title,
          tierArea: parsed.tierArea,
          goal: parsed.goal.text,
          type: parsed.goal.parsed.type,
          status: parsed.goal.status,
          progress: parsed.goal.progress,
          steps: parsed.steps,
          rewards: parsed.rewards,
        });
        if (PG.panel) PG.panel.render();
      }
    }
    return sidebar;
  }

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

  return { normalize, classify, parseQuestText, parseStatus, parseProgress,
    parseSidebarQuest, scanSidebar, scan, PATTERNS,
    get last() { return last; },
    get sidebar() { return sidebar; } };
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
 *   ENCOUNTER        — „Napotkano X!" → wybór Pokémona z drużyny
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
  let stateVersion = 0; // ++ przy każdej realnej zmianie stanu
  let depth = 0;        // zabezpieczenie przed nieskończoną rekurencją re-dispatch
  const history = []; // { ts, from, to, reason } — ostatnie 50 wpisów
  const handlers = {}; // state -> funkcja wywoływana w ticku

  function set(next, why = '') {
    if (next === state) return;
    const from = state;
    state = next;
    reason = why;
    stateVersion += 1;
    history.unshift({ ts: Date.now(), from, to: next, reason: pgText(why, 200) });
    if (history.length > 50) history.pop();
    PG.logger.stateChange(from, next, why);
    if (PG.panel) PG.panel.render();
  }

  /** Zarejestruj handler stanu (wykonywany co tick). */
  function register(name, fn) {
    handlers[name] = fn;
  }

  /**
   * Pojedynczy tick maszyny. Bezpieczny: wyjątek = NEEDS_REVIEW, nie crash.
   *
   * PRĘDKOŚĆ: jeżeli handler zmienił stan, kolejny handler odpala się
   * NATYCHMIAST (re-dispatch) — nie czekamy następnego ticka zegara.
   * Ścieżka SCANNING → ENCOUNTER → klik trwa wtedy milisekundy od
   * momentu, gdy gra zaktualizuje ekran (zamiast 2-3 ticków = wolno).
   */
  function tick() {
    if (document.hidden) return;     // oszczędzamy zasoby w tle zakładki
    if (paused || state === 'STOPPED') return;
    if (depth >= 5) return;          // twardy limit łańcucha re-dispatch

    const vBefore = stateVersion;
    const h = handlers[state];
    if (!h) {
      set('NEEDS_REVIEW', `brak handlera dla stanu ${state}`);
      return;
    }
    depth += 1;
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
    depth -= 1;

    // Stan zmienił się w trakcie handlera → przetocz łańcuch od razu.
    if (stateVersion !== vBefore && depth < 5) tick();
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
    STATES: ['STOPPED', 'SCANNING', 'WANDER', 'ENCOUNTER', 'CATCH', 'BATTLE',
      'BERRY', 'QUEST_TURNIN', 'HEAL', 'INVENTORY', 'SPECIAL_ENCOUNTER', 'NEEDS_REVIEW'],
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
 *  - brak elementu = false + log (state machine decyduje o NEEDS_REVIEW),
 *  - KAŻDY klik znakuje `lastActionAt` — maszyna stanów czeka z raportowaniem
 *    nieznanego ekranu, aż gra zdąży zaktualizować widok (asynchroniczne
 *    przejścia: wędrówka → spotkanie → walka → wynik).
 *
 * Znane ekrany (snapshoty z /mapa?areaId=2):
 *   encounter: role encounter-preview + team-selection → „Napotkano X!"
 *   battle:    „Przejdź do końca walki" (auto-rundy)
 *   result:    karty Pokéballi („Szansa złapania: N%") po wygranej
 *   walk:      walk-again-button (obecny NA KAŻDYM ekranie mapy!)
 */

PG.actions = (() => {
  let lastActionAt = 0;
  let lastFail = '';

  function noteAction() {
    lastActionAt = Date.now();
  }

  function sinceLastAction() {
    return Date.now() - lastActionAt;
  }

  /** Klik w element znaleziony po nazwie logicznej. */
  function click(name) {
    const el = PG.selectors.resolve(name);
    if (!el) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      PG.logger.push('action_disabled', { name });
      return false;
    }
    noteAction();
    el.click();
    return true;
  }

  // ── odczyt stanu ekranu ───────────────────────────────────────────────────

  /** PA z paska: „PUNKTY AKCJI 123/155". null, gdy nie ma tekstu. */
  function parseAP() {
    const body = document.body ? document.body.innerText : '';
    const m = /PUNKTY AKCJI\s*(\d+)\s*\/\s*(\d+)/i.exec(body);
    return m ? { current: +m[1], total: +m[2] } : null;
  }

  /**
   * Karty Pokéballi na ekranie wyniku:
   * "Level BallIlość: 2937Szansa złapania: 59,8%" → { name, qty, chance, el }.
   * Przy okazji uzupełnia katalog nazw dla panelu.
   */
  const ballCatalog = new Set([
    'Master Ball', 'Poké Ball', 'Dive Ball', 'Timer Ball', 'Level Ball', 'Shiny Ball',
  ]);

  function parseBalls() {
    const out = [];
    for (const b of document.querySelectorAll('button')) {
      const t = pgText(b.textContent, 160);
      const m = /^(.+?)Ilość:\s*(\d+)Szansa złapania:\s*([\d,.]+)%/.exec(t);
      if (m) {
        const name = m[1].trim();
        ballCatalog.add(name);
        out.push({
          name,
          qty: +m[2],
          chance: parseFloat(m[3].replace(',', '.')),
          el: b,
        });
      }
    }
    return out;
  }

  /**
   * Czy napotkany Pokémon jest shiny?
   * Szukamy w podglądzie spotkania / podsumowaniu walki; „Shiny Ball"
   * (nazwa piłki) wykluczamy, żeby nie było fałszywej detekcji.
   */
  function isShinyEncounter() {
    const el = document.querySelector(
      '[data-pokeglory-integrity-role="encounter-preview"],' +
      '[data-pokeglory-integrity-role="battle-summary"]'
    );
    const raw = el ? pgText(el.textContent, 600) : '';
    return /\bshiny\b/i.test(raw.replace(/Shiny Ball/gi, ''));
  }

  /** Przyciski drużyny na ekranie spotkania (tylko „Lv. …"). */
  function teamButtons() {
    const cont = document.querySelector('[data-pokeglory-integrity-role="team-selection"]');
    if (!cont) return [];
    return [...cont.querySelectorAll('button')]
      .filter((b) => /^Lv\./.test(pgText(b.textContent, 25)));
  }

  /** Podgląd drużyny dla panelu (etykiety slotów). */
  function peekTeam() {
    return teamButtons().map((b, i) => ({
      index: i + 1,
      text: pgText(b.textContent, 60),
    }));
  }

  /**
   * Parser HP kafla drużyny — CZYSTY (bez DOM), testowany w tests/.
   *
   * Kafel ma trzy pary „N/M”: [0] poziom+EXP, [1] HP, [2] trzecia para.
   * UWAGA: textContent bez spacji zlewa poziom z EXP („641082/1930"),
   * dlatego HP = ZAWSZE druga para (`pairs[1]`) — zweryfikowane na
   * 6 próbkach ze snapshotu (spacing i bez-spacing).
   *
   * @param {string} text  tekst kafla, np. „Lv. 64 1082/1930 x 3023/3205 x 100/100”
   * @returns {{hp: number, max: number, ratio: number}|null} null, gdy pary < 2
   */
  function parseTeamHpText(text) {
    const pairs = String(text).match(/\d+\s*\/\s*\d+/g);
    if (!pairs || pairs.length < 2) return null;
    const m = /(\d+)\s*\/\s*(\d+)/.exec(pairs[1]);
    if (!m) return null;
    const max = +m[2];
    if (!max) return null; // HP 0/0 → nie umiemy orzec, pomijamy
    const hp = +m[1];
    return { hp, max, ratio: hp / max };
  }

  /**
   * Kafle drużyny z odczytanym HP (razem z „Niezdolny…” — bez niego
   * nie zobaczylibyśmy mona do wyleczenia). Wymaga team-selection.
   * @returns {Array<{hp: number, max: number, ratio: number, raw: string}>}
   */
  function teamHpList() {
    const cont = document.querySelector('[data-pokeglory-integrity-role="team-selection"]');
    if (!cont) return [];
    const out = [];
    for (const b of cont.querySelectorAll('button')) {
      const raw = pgText(b.textContent, 80);
      if (!/Lv\./.test(raw)) continue; // nie-kafle (np. „Ulecz wszystkie”)
      const parsed = parseTeamHpText(raw);
      if (parsed) out.push({ ...parsed, raw });
    }
    return out;
  }

  /** Kafle z HP poniżej podanego progu (%). Fainted (0 HP) kwalifikuje się. */
  function teamLowHp(belowPct) {
    const pct = Number.isFinite(+belowPct) ? +belowPct : 50;
    return teamHpList().filter((t) => t.ratio * 100 < pct);
  }

  /** Karty lokacji „4 PA Mroczne Miasto" (widoczne też poza kokpitem). */
  function listLocations() {
    const out = [];
    for (const el of PG.selectors.resolveAll('walk-location-card')) {
      const m = /^(\d+)\s*PA\s*(.+)$/.exec(pgText(el.textContent, 60));
      if (m) out.push({ cost: +m[1], name: m[2].trim(), el });
    }
    return out;
  }

  // ── akcje ─────────────────────────────────────────────────────────────────

  /** „Wędruj ponownie" — kontynuacja wędrówki w bieżącej lokacji. */
  function walkAgain() {
    const ok = click('walk-again-button');
    if (!ok) return false;
    PG.logger.action('walk_again', true);
    return true;
  }

  /** Wybór Pokémona do walki (slot z konfiguracji panelu). */
  function selectTeamMember(slot) {
    const btns = teamButtons();
    const b = btns[(slot || 1) - 1];
    if (!b || b.disabled) {
      PG.logger.action('team_member_selected', false, { slot: slot || 1, teamSize: btns.length });
      return false;
    }
    noteAction();
    b.click();
    PG.logger.action('team_member_selected', true, {
      slot: slot || 1,
      teamSize: btns.length,
      picked: pgText(b.textContent, 60),
    });
    return true;
  }

  /** Pominięcie animacji walki. */
  function skipBattle() {
    const ok = click('battle-skip-button');
    if (ok) PG.logger.action('skip_battle', true);
    return ok;
  }

  /**
   * Rzut piłką zgodnie z priorytetami z konfiguracji.
   * P1 → P2 (P2 tylko gdy P1 np. się skończył). Shiny = lista shiny.
   */
  function throwBall(shiny, attempt = 0) {
    const balls = parseBalls();
    const pref = [...(PG.config.balls[shiny ? 'shiny' : 'normal'] || [])].filter(Boolean);
    for (const name of pref) {
      const b = balls.find((x) => x.name === name && x.qty > 0);
      if (!b) continue;
      if (b.el.disabled) {
        PG.logger.push('ball_disabled', { name });
        continue;
      }
      noteAction();
      b.el.click();
      PG.logger.action('throw_ball', true, {
        name, chance: b.chance, qty: b.qty, shiny: !!shiny, attempt,
        pref,
      });
      return true;
    }
    PG.logger.push('no_ball_available', {
      shiny: !!shiny,
      pref,
      available: balls.map((b) => ({ name: b.name, qty: b.qty, chance: b.chance })),
    });
    return false;
  }

  /** Picie drinka (odnowa PA) — przycisk „Regeneracja punktów akcji". */
  function heal() {
    const ok = click('heal-ap-button');
    PG.logger.action('heal_ap', ok);
    return ok;
  }

  /**
   * Leczenie drużyny — „Ulecz wszystkie” (preferowany widoczny element,
   * bo w DOM bywa też ukryta kopia a11y) z fallbackiem na globalne
   * „Leczenie wszystkich pokemonów”.
   */
  function healTeam() {
    const cands = PG.selectors.resolveAll('team-heal-button');
    const el = cands.find((x) => isVisible(x)) || cands[0];
    if (!el) {
      PG.logger.selectorMiss('team-heal-button');
      PG.logger.action('team_heal', false, { reason: 'no_button' });
      return false;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      PG.logger.push('action_disabled', { name: 'team-heal-button' });
      return false;
    }
    noteAction();
    el.click();
    PG.logger.action('team_heal', true, {
      via: pgText(el.textContent, 40),
      wasVisible: isVisible(el),
    });
    return true;
  }

  // ── ewolucja / sprzedaż rezerwy (szybkie akcje + dialogi potwierdzania) ──

  /** Czysty: „38Ewoluuj wszystkie gotowe…” → 38; brak liczby → 0. */
  function parseEvolveCount(text) {
    const m = /^(\d+)/.exec(pgText(text, 60));
    return m ? +m[1] : 0;
  }

  /** Czysty: „60/60Szybka sprzedaż…” → {current, max}; brak pary → null. */
  function parseReserve(text) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(pgText(text, 40));
    return m ? { current: +m[1], max: +m[2] } : null;
  }

  /** Ile Pokémonów gotowych do ewolucji (licznik na przycisku szybkiej akcji). */
  function evolveReadyCount() {
    const el = PG.selectors.resolve('evolve-all-button', { reportMiss: false });
    return el ? parseEvolveCount(el.textContent) : 0;
  }

  /** Zapełnienie rezerwy z etykiety „X/Y Szybka sprzedaż pokemonów”. */
  function reserveInfo() {
    const el = PG.selectors.resolve('quick-sell-button', { reportMiss: false });
    return el ? parseReserve(el.textContent) : null;
  }

  function reserveFull() {
    const r = reserveInfo();
    return !!r && r.max > 0 && r.current >= r.max;
  }

  /**
   * Jaki dialog zarządzania jest otwarty: 'evolve' | 'sell' | 'other' | null.
   * Rozróżniamy po tytule z snapshotu: „Ewoluować wszystkie?” /
   * „Sprzedać Pokemony z rezerwy?”. Inny widoczny dialog → 'other'.
   */
  function manageDialogKind() {
    let other = false;
    for (const d of document.querySelectorAll('[role="dialog"][data-open]')) {
      if (!isVisible(d)) continue;
      const t = pgText(d.textContent, 400);
      if (/Ewoluować wszystkie/i.test(t)) return 'evolve';
      if (/Sprzedać Pokemony z rezerwy/i.test(t)) return 'sell';
      other = true;
    }
    return other ? 'other' : null;
  }

  /**
   * Klik w potwierdzenie OTWARTEGO dialogu — szukamy TYLKO w jego
   * obrębie („Ewoluuj wszystkie” z dialogu ≠ przycisk szybkiej akcji
   * „38Ewoluuj wszystkie gotowe…”; „Sprzedaj” ≠ „Szybka sprzedaż…”).
   */
  function confirmManageDialog(kind) {
    const label = kind === 'evolve' ? /^Ewoluuj wszystkie$/ : /^Sprzedaj$/;
    for (const d of document.querySelectorAll('[role="dialog"][data-open]')) {
      if (!isVisible(d)) continue;
      const btn = [...d.querySelectorAll('button')]
        .find((b) => label.test(pgText(b.textContent, 60)));
      if (!btn) continue;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        PG.logger.push('action_disabled', { name: `dialog_${kind}` });
        return false;
      }
      noteAction();
      btn.click();
      PG.logger.action('dialog_confirm', true, { kind });
      return true;
    }
    PG.logger.action('dialog_confirm', false, { kind, reason: 'no_button' });
    return false;
  }

  /** Szybka akcja „38Ewoluuj wszystkie gotowe Pokemony”. */
  function evolveTeam() {
    const ready = evolveReadyCount();
    const ok = click('evolve-all-button');
    PG.logger.action('evolve_all', ok, { ready });
    return ok;
  }

  /** Szybka akcja „60/60Szybka sprzedaż pokemonów”. */
  function sellPokemon() {
    const r = reserveInfo();
    const ok = click('quick-sell-button');
    PG.logger.action('quick_sell', ok, r || {});
    return ok;
  }

  /** Zebranie jagód z krzewu podczas wędrówki. */
  function collectBerries() {
    const ok = click('berry-button');
    if (ok) PG.logger.action('collect_berries', true);
    return ok;
  }

  /** Start wędrówki z kokpitu przez kartę lokacji. */
  function walkLocation(name) {
    const loc = listLocations().find(
      (x) => x.name.localeCompare(name, 'pl', { sensitivity: 'base' }) === 0
    );
    if (!loc || loc.el.disabled) {
      if (lastFail !== name) {
        lastFail = name;
        PG.logger.push('location_not_found', {
          wanted: name,
          have: listLocations().map((x) => x.name),
        });
      }
      return false;
    }
    lastFail = '';
    noteAction();
    loc.el.click();
    PG.logger.action('location_walk_started', true, { name: loc.name, cost: loc.cost });
    return true;
  }

  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  /**
   * Otwórz pełny widok questów (zakładka Billa w sidebarze).
   * Eksperymentalne: nie wiemy jeszcze, czy to nawigacja, czy panel —
   * dlatego klik jest logowany, a następnie użytkownik robi snapshot.
   */
  function openQuestTab() {
    const candidates = [
      document.getElementById('collapsed-player-sidebar-bill-tab'),
      ...document.querySelectorAll('[id$="-bill-tab"]'),
      ...document.querySelectorAll('[aria-label*="bill" i], [title*="bill" i]'),
      ...document.querySelectorAll('[aria-label*="Zadania" i], [title*="Zadania" i]'),
    ].filter(Boolean);
    const el = candidates.find(isVisible) || candidates[0];
    if (!el) {
      PG.logger.push('quest_tab_not_found', {});
      return false;
    }
    noteAction();
    el.click();
    PG.logger.action('open_quest_view', true, {
      via: el.id || el.getAttribute('aria-label') || el.getAttribute('title') || el.tagName,
      wasVisible: isVisible(el),
    });
    return true;
  }

  return {
    noteAction, sinceLastAction, click,
    parseAP, parseBalls, isShinyEncounter, ballCatalog,
    teamButtons, peekTeam, listLocations,
    parseTeamHpText, teamHpList, teamLowHp,
    parseEvolveCount, parseReserve, evolveReadyCount, reserveInfo, reserveFull,
    manageDialogKind, confirmManageDialog,
    walkAgain, selectTeamMember, skipBattle, throwBall, heal, healTeam,
    evolveTeam, sellPokemon,
    walkLocation,
    collectBerries, openQuestTab, isVisible,
    // questy — stuby do dalszej implementacji:
    turnInQuest: () => { PG.logger.action('turn_in', false, { stub: true }); return false; },
    claimRewards: () => { PG.logger.action('claim_rewards', false, { stub: true }); return false; },
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
    ENCOUNTER: ['orange', 'ENCOUNTER'],
    CATCH: ['orange', 'CATCH'],
    BATTLE: ['orange', 'BATTLE'],
    BERRY: ['orange', 'BERRY'],
    QUEST_TURNIN: ['teal', 'QUEST_TURNIN'],
    HEAL: ['teal', 'HEAL'],
    INVENTORY: ['teal', 'INVENTORY'],
    SPECIAL_ENCOUNTER: ['purple', 'SPECIAL'],
    NEEDS_REVIEW: ['red', 'NEEDS REVIEW'],
  };

  const TOGGLES = [
    ['autoWalk', 'Wędrówki'],
    ['autoCatch', 'Łapanie po walce'],
    ['autoBerries', 'Zbieranie jagód'],
    ['autoSkipBattle', 'Pomiń animację walki'],
    ['autoQuests', 'Questy'],
    ['autoHeal', 'Picie drinków'],
    ['autoHealTeam', 'Leczenie HP (< próg)'],
    ['autoManage', 'Ewolucja/sprzedaż'],
    ['autoResume', 'Wznów po odświeżeniu'],
    ['questLocation', 'Cel z questa → lokacja'],
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
    .field { font-size: 11px; color: #aab1c0; display: flex; flex-direction: column; gap: 3px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
    select, input[type="number"] {
      background: #232936; color: #e5e9f0; border: 1px solid #394152;
      border-radius: 6px; padding: 4px 6px; font-size: 12px; width: 100%;
      font-family: inherit;
    }
    select:focus, input:focus { outline: 1px solid #3b82f6; }
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
            <button class="act" id="btnQuestView">🗺 Pełny widok</button>
          </div>

          <div class="toggles" id="toggles"></div>

          <div>
            <div class="sec-title">Automatyzacja</div>
            <div class="grid2">
              <label class="field">Pokémon do walki
                <select id="selTeam"></select>
              </label>
              <label class="field">Lokacja startowa (kokpit)
                <select id="selLoc"></select>
              </label>
            </div>
            <div class="grid2" style="margin-top:6px">
              <label class="field">Normalny — priorytet 1
                <select id="selN1"></select>
              </label>
              <label class="field">Normalny — priorytet 2
                <select id="selN2"></select>
              </label>
              <label class="field">Shiny — priorytet 1
                <select id="selS1"></select>
              </label>
              <label class="field">Shiny — priorytet 2
                <select id="selS2"></select>
              </label>
            </div>
            <div class="grid2" style="margin-top:6px">
              <label class="field">Max rzutów / potyczkę
                <input type="number" id="inThrows" min="1" max="10" />
              </label>
              <label class="field">Tick pętli (ms)
                <input type="number" id="inTick" min="150" max="5000" step="50" />
              </label>
              <label class="field">Jitter interwałów (%)
                <input type="number" id="inJitter" min="0" max="80" step="5" />
              </label>
              <label class="field">Lecz HP poniżej (%)
                <input type="number" id="inHealHp" min="10" max="90" step="5" />
              </label>
            </div>
          </div>

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

    el('btnQuestView').onclick = () => {
      const ok = PG.actions.openQuestTab();
      flash(el('btnQuestView'), ok ? '🗺 Otwieram…' : '🗺 Nie znaleziono zakładki');
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
      cb.onchange = () => cfgSet(key, cb.checked, label);
      lab.append(cb, document.createTextNode(label));
      tg.appendChild(lab);
    }

    // Selecty / inputy sekcji „Automatyzacja”:
    el('selTeam').onchange = (e) => cfgSet('teamSlot', +e.target.value, 'teamSlot');
    el('selLoc').onchange = (e) => cfgSet('walkLocation', e.target.value, 'walkLocation');
    el('selN1').onchange = (e) => ballSet('normal', 0, e.target.value);
    el('selN2').onchange = (e) => ballSet('normal', 1, e.target.value);
    el('selS1').onchange = (e) => ballSet('shiny', 0, e.target.value);
    el('selS2').onchange = (e) => ballSet('shiny', 1, e.target.value);
    el('inThrows').onchange = (e) => {
      const v = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3));
      cfgSet('maxThrows', v, 'maxThrows');
    };
    el('inTick').onchange = (e) => {
      const v = Math.max(150, Math.min(5000, parseInt(e.target.value, 10) || 500));
      cfgSet('tickMs', v, 'tickMs');
      // nowy interwał działa od razu, bez restartu bota:
      if (PG.main && typeof PG.main.restartLoop === 'function') PG.main.restartLoop();
    };
    el('inJitter').onchange = (e) => {
      const pct = Math.max(0, Math.min(80, parseInt(e.target.value, 10) || 0));
      cfgSet('jitter', pct / 100, 'jitter');
      if (PG.main && typeof PG.main.restartLoop === 'function') PG.main.restartLoop();
    };
    el('inHealHp').onchange = (e) => {
      const pct = Math.max(10, Math.min(90, parseInt(e.target.value, 10) || 50));
      cfgSet('healHpBelow', pct, 'healHpBelow');
    };
  }

  /** Zapis wartości do konfiguracji + log (persistencja w main). */
  function cfgSet(key, value, label) {
    PG.config[key] = value;
    PG.logger.push('config_change', { key: label || key, value });
    render();
  }

  function ballSet(kind, idx, value) {
    PG.config.balls[kind][idx] = value;
    PG.logger.push('config_change', { key: `balls.${kind}[${idx}]`, value });
    render();
  }

  /** Wypełnij select opcjami (przebudowa tylko przy zmianie „sygnatury”). */
  function fillSelect(id, opts, value) {
    const s = el(id);
    if (!s) return;
    const sig = opts.map((o) => o.v).join('|');
    if (s.dataset.sig !== sig) {
      s.innerHTML = opts
        .map((o) => `<option value="${escapeHtml(o.v)}">${escapeHtml(o.l)}</option>`)
        .join('');
      s.dataset.sig = sig;
    }
    s.value = value;
    // Gdy zapisana wartość nie występuje w opcjach — dopisz ją (nie gubimy np. balli).
    if (s.value !== value && value) {
      s.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`);
      s.value = value;
    }
  }

  function syncAutomationUI() {
    // Pokémon do walki: żywe etykiety z ekranu spotkania albo Slot 1..6.
    const team = typeof PG.actions.peekTeam === 'function' ? PG.actions.peekTeam() : [];
    const teamOpts = team.length
      ? team.map((t) => ({ v: String(t.index), l: `Slot ${t.index} · ${t.text.slice(0, 30)}` }))
      : Array.from({ length: 6 }, (_, i) => ({ v: String(i + 1), l: `Slot ${i + 1}` }));
    fillSelect('selTeam', teamOpts, String(PG.config.teamSlot));

    // Lokacje z kart „N PA Nazwa”.
    const locs = typeof PG.actions.listLocations === 'function' ? PG.actions.listLocations() : [];
    fillSelect('selLoc',
      [{ v: '', l: '— ręcznie —' },
        ...locs.map((x) => ({ v: x.name, l: `${x.name} (${x.cost} PA)` }))],
      PG.config.walkLocation);

    // Piłki: katalog wykrytych + zapisane preferencje (nic nie gubimy).
    const balls = [...PG.actions.ballCatalog,
      ...(PG.config.balls.normal || []),
      ...(PG.config.balls.shiny || [])].filter(Boolean);
    const ballOpts = [...new Set(balls)].map((n) => ({ v: n, l: n }));
    fillSelect('selN1', ballOpts, (PG.config.balls.normal || [])[0] || '');
    fillSelect('selN2', ballOpts, (PG.config.balls.normal || [])[1] || '');
    fillSelect('selS1', ballOpts, (PG.config.balls.shiny || [])[0] || '');
    fillSelect('selS2', ballOpts, (PG.config.balls.shiny || [])[1] || '');

    el('inThrows').value = PG.config.maxThrows;
    el('inTick').value = PG.config.tickMs;
    el('inJitter').value = Math.round((PG.config.jitter || 0) * 100);
    el('inHealHp').value = PG.config.healHpBelow;
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
        const lab = b.getAttribute('aria-label') || b.getAttribute('title');
        if (lab) o.label = lab;
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

    syncAutomationUI();
  }

  function renderQuests() {
    const list = el('questList');
    const meta = el('questMeta');

    // Widget sidebar („Zadania Billa”) — widoczny na każdym ekranie.
    let sidebarHtml = '';
    const sq = PG.quest.sidebar;
    if (sq && sq.active) {
      const type = sq.goal.parsed.ok ? sq.goal.parsed.type : 'UNKNOWN_GOAL';
      const chip = sq.goal.status === 'done'
        ? '<span class="chip done">GOTOWE</span>'
        : sq.goal.parsed.ok
          ? '<span class="chip active">AKTYWNE</span>'
          : '<span class="chip unknown">NIEZNANY</span>';
      const prog = sq.goal.progress
        ? `<span class="prog">${sq.goal.progress.current}/${sq.goal.progress.total}</span>`
        : '';
      sidebarHtml = `<div class="quest">
        <div class="quest-title">📌 ${escapeHtml(sq.title || '?')}
          <span class="muted" style="font-weight:400"> · ${escapeHtml(sq.tierArea || '')}</span></div>
        <div class="goal">${chip} ${escapeHtml(sq.goal.text)}${prog}
          <span class="prog">kroki ${sq.steps.done}/${sq.steps.total ?? '?'}${sq.steps.active ? ` (aktywny #${sq.steps.active})` : ''}</span></div>
        <div class="goal muted" style="font-size:10.5px">typ: ${escapeHtml(type)}${sq.rewards ? ` · ${escapeHtml(sq.rewards)}` : ''}</div>
      </div>`;
    }

    const data = PG.quest.last;
    if (!data) {
      meta.textContent = sq && sq.active ? 'widget sidebar' : '';
      list.innerHTML = sidebarHtml ||
        '<div class="empty">Brak danych — kliknij „Skan questów”.</div>';
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

    list.innerHTML = sidebarHtml + `<div class="quest">
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
 * 70-main.js — start bota, pętla ticków, handlery stanów, persistencja.
 *
 * Detekcja ekranów (v3, oparta o snapshoty z /mapa):
 *   encounter  → ENCOUNTER (leczenie HP < próg → wybór drużyny)
 *   ball_select→ CATCH     (rzut po wygranej)
 *   battle_result→ WANDER  (podsumowanie po walce → „Wędruj ponownie")
 *   battle     → BATTLE    (skip animacji)
 *   walk_ready → WANDER
 *   kokpit     → SCANNING  (opcjonalny start z karty lokacji)
 *   unknown    → NEEDS_REVIEW (po grace period po ostatnim kliknięciu)
 *
 * Kolejność detekcji ma znaczenie: walk-again-button obecny jest NA WSZYSTKICH
 * ekranach mapy, więc encounter/piłki/walka muszą być sprawdzane przed nim.
 */

PG.main = (() => {
  let timer = null;

  // Sesyjne liczniki (reset przy zmianie ekranu, patrz SCANNING).
  const sess = {
    encounterTries: 0,
    battleTries: 0,
    berryTries: 0,
    throws: 0,
    healTries: 0,
    teamHealTries: 0,
    manageEvolveTries: 0,
    manageSellTries: 0,
    lastTeamClick: 0,
    lastTeamHeal: 0,
    lastManage: 0,
    lastThrow: 0,
    lastSkip: 0,
    lastHeal: 0,
    lastWalk: 0,
    lastLoc: 0,
    lastBerry: 0,
  };

  const lastScreen = { value: null };

  /**
   * Losowy rozrzut wokół wartości bazowej (jitter).
   * np. jrand(800) przy jitter=0.35 → 520..1080 ms.
   * Dzięki temu interwały NIE są sztywne — klikanie nie wygląda
   * jak sygnatura maszynowa (stały okres = łatwy wykrywalny wzorzec).
   */
  function jrand(base) {
    const j = PG.config.jitter || 0;
    return Math.round(base * (1 + (Math.random() * 2 - 1) * j));
  }

  function resetSessionForScreen() {
    sess.encounterTries = 0;
    sess.battleTries = 0;
    sess.berryTries = 0;
    sess.throws = 0;
    sess.teamHealTries = 0;
    sess.manageEvolveTries = 0;
    sess.manageSellTries = 0;
    // healTries NIE jest resetowany — resetuje go dopiero rosnący poziom PA.
  }

  // ── quest-driven location (WALK_IN z widgetu sidebar) ────────────────────

  const LOC_KEY = 'pg-bot-loc';

  function currentLoc() {
    try { return localStorage.getItem(LOC_KEY) || ''; } catch (_) { return ''; }
  }

  function setCurrentLoc(v) {
    try { localStorage.setItem(LOC_KEY, v); } catch (_) { /* ignore */ }
  }

  /** Lokacja wymagana przez aktywny cel questa (typ WALK_IN), albo null. */
  function questWalkTarget() {
    if (!PG.config.questLocation) return null;
    const sq = PG.quest.sidebar;
    if (!sq || !sq.active || !sq.goal || !sq.goal.parsed || !sq.goal.parsed.ok) return null;
    if (sq.goal.parsed.type !== 'WALK_IN') return null;
    if (sq.goal.status === 'done') return null;
    if (sq.goal.progress && sq.goal.progress.current >= sq.goal.progress.total) return null;
    return sq.goal.parsed.location;
  }

  // ── detekcja ekranu ───────────────────────────────────────────────────────

  function detectScreen() {
    if (PG.selectors.resolve('encounter-preview', { reportMiss: false })) return 'encounter';
    if (PG.selectors.resolve('team-selection', { reportMiss: false })) return 'encounter';
    if (PG.selectors.resolve('berry-button', { reportMiss: false })) return 'berry_select';
    if (PG.actions.parseBalls().length > 0) return 'ball_select';
    // Podsumowanie walki PRZED wykrywaniem walki: „Przejdź do końca walki"
    // zostaje w DOM także na ekranie wyniku (rola result-actions).
    if (PG.selectors.resolve('battle-result', { reportMiss: false })) return 'battle_result';
    if (PG.selectors.resolve('battle-skip-button', { reportMiss: false })) return 'battle';
    if (PG.selectors.resolve('walk-again-button', { reportMiss: false })) return 'walk_ready';
    if (location.pathname.startsWith('/kokpit') || /kokpit/i.test(document.title)) return 'kokpit';
    return 'unknown';
  }

  // ── persistencja konfiguracji i auto-wznowienie ──────────────────────────

  const CFG_KEY = 'pg-bot-config-v1';
  const RESUME_KEY = 'pg-bot-autostart';

  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        // shallow merge: nowe klucze z builda zostają, stare wartości wracają
        if (saved.balls && typeof saved.balls === 'object') {
          saved.balls = { ...PG.config.balls, ...saved.balls };
        }
        const isOldSave = !saved.cooldowns; // brak cooldownów = zapis z < v0.4.0
        // Zapis z < v0.7.0: autoManage był martwym stubem — szanowanie
        // zapisanego „false” zablokowałoby nową funkcję. Migracja: włącz.
        const preManageSave = !(saved.cooldowns && 'manage' in saved.cooldowns);
        if (saved.cooldowns) {
          saved.cooldowns = { ...PG.config.cooldowns, ...saved.cooldowns };
        }
        Object.assign(PG.config, saved);
        if (isOldSave) {
          // Stary zapis miał tickMs1500 — wymuszamy nowy, szybszy tick.
          PG.config.tickMs = 500;
        }
        if (preManageSave) PG.config.autoManage = true;
      }
    } catch (_) { /* uszkodzony JSON → domyślne */ }
  }

  function persistConfig() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(PG.config)); } catch (_) { /* quota */ }
  }

  // ── handlery stanów ───────────────────────────────────────────────────────

  function registerStates() {
    const sm = PG.sm;
    const cfg = PG.config;

    sm.register('SCANNING', () => {
      if (cfg.autoQuests) {
        PG.quest.scan();
        PG.quest.scanSidebar();
      }

      const screen = detectScreen();
      if (screen !== lastScreen.value) {
        lastScreen.value = screen;
        resetSessionForScreen();
        PG.logger.push('screen_detected', { screen, url: location.href });
      }

      // 1) Ekrany akcji — routowane natychmiast, bez przerwy na heal.
      if (screen === 'encounter') { sm.set('ENCOUNTER', 'spotkanie w dziczy'); return; }
      if (screen === 'berry_select') { sm.set('BERRY', 'krzew jagód'); return; }
      if (screen === 'ball_select') { sm.set('CATCH', 'wybór piłki po walce'); return; }
      if (screen === 'battle') { sm.set('BATTLE', 'walka w toku'); return; }

      // 2) Niskie PA → picie drinków (globalny przycisk „Regeneracja…”).
      const ap = PG.actions.parseAP();
      if (cfg.autoHeal && ap && ap.current < cfg.healBelow) {
        sm.set('HEAL', `PA ${ap.current}/${ap.total} < ${cfg.healBelow}`);
        return;
      }

      // 2b) Rezerwa pełna → ewoluuj (dialogi) i sprzedaj (dialog).
      //     Liczniki prób świeże przy każdym wejściu (ack = nowa szansa).
      if (cfg.autoManage && PG.actions.reserveFull()) {
        sess.manageEvolveTries = 0;
        sess.manageSellTries = 0;
        sm.set('INVENTORY', 'rezerwa pełna — ewolucja/sprzedaż');
        return;
      }

      // 3) Znane ekrany bez akcji (mapa albo podsumowanie po walce → oba = wędrówka).
      if (screen === 'walk_ready' || screen === 'battle_result') {
        sm.set('WANDER', `rozpoznany ekran: ${screen === 'battle_result' ? 'wynik walki' : 'wędrówka'}`);
        return;
      }

      if (screen === 'kokpit') {
        // Priorytet: cel questu WALK_IN > ręcznie ustawiona lokacja startowa.
        const target = questWalkTarget() || cfg.walkLocation || '';
        if (target && cfg.autoWalk) {
          const now = Date.now();
          if (now - sess.lastLoc > jrand(cfg.cooldowns.location)) {
            sess.lastLoc = now;
            if (PG.actions.walkLocation(target)) setCurrentLoc(target);
          }
        }
        return; // zostajemy w SCANNING — czekamy na nawigację / akcję
      }

      // 4) Nieznany ekran — grace period po kliknięciu (gra się jeszcze ładuje).
      if (PG.actions.sinceLastAction() < jrand(cfg.graceMs)) return;

      PG.logger.push('screen_unknown_snapshot', {
        integrityRoles: PG.selectors.integrityRoles(),
        url: location.href,
      });
      sm.set('NEEDS_REVIEW', `nieznany ekran — prześlij log do agenta`);
    });

    sm.register('WANDER', () => {
      const screen = detectScreen();
      // walk_ready = mapa; battle_result = podsumowanie po walce (trener) —
      // na obu działa „Wędruj ponownie" (rola walk-again-button).
      if (screen !== 'walk_ready' && screen !== 'battle_result') {
        sm.set('SCANNING', `ekran zmienił się po wędrówce (${screen})`);
        return;
      }
      const ap = PG.actions.parseAP();
      if (cfg.autoHeal && ap && ap.current < cfg.healBelow) {
        sm.set('HEAL', `PA ${ap.current}/${ap.total} < ${cfg.healBelow}`);
        return;
      }

      // Rezerwa pełna → przerwij wędrówkę na ewolucję/sprzedaż.
      if (cfg.autoManage && PG.actions.reserveFull()) {
        sess.manageEvolveTries = 0;
        sess.manageSellTries = 0;
        sm.set('INVENTORY', 'rezerwa pełna — ewolucja/sprzedaż');
        return;
      }

      // Quest wymaga innej lokacji niż bieżąca? Przełącz kartę lokacji.
      const target = questWalkTarget();
      if (target && currentLoc() !== target) {
        const now = Date.now();
        if (now - sess.lastLoc > jrand(cfg.cooldowns.location)) {
          sess.lastLoc = now;
          if (PG.actions.walkLocation(target)) {
            PG.logger.push('quest_location_sync', { target, previous: currentLoc() });
            setCurrentLoc(target);
            return; // klik startuje wędrówkę w nowej lokacji
          }
        }
        // klik nieudany — nie blokujemy pętli, spróbujemy za chwilę
      }

      const now2 = Date.now();
      if (now2 - sess.lastWalk < jrand(cfg.cooldowns.walk)) return; // min. odstęp między klikami
      if (cfg.autoWalk) {
        sess.lastWalk = now2;
        if (!PG.actions.walkAgain()) {
          sm.set('NEEDS_REVIEW', 'brak przycisku „Wędruj ponownie”');
        }
      }
    });

    sm.register('ENCOUNTER', () => {
      const screen = detectScreen();
      if (screen !== 'encounter') {
        sm.set('SCANNING', `ekran spotkania zmienił się (${screen})`);
        return;
      }

      // ── Leczenie < healHpBelow% HP — PRZED wyborem drużyny ─────────────
      // Kolejność: „Ulecz wszystkie” → czekamy na wzrost HP (cooldown,
      // kolejne ticki) → dopiero selekcja mona. Jeśli HP nie rośnie
      // po 5 kliknięciach → NEEDS_REVIEW.
      if (cfg.autoHealTeam) {
        const low = PG.actions.teamLowHp(cfg.healHpBelow);
        if (low.length) {
          const nowH = Date.now();
          if (nowH - sess.lastTeamHeal < jrand(cfg.cooldowns.teamHeal)) return; // czekamy na efekt
          sess.lastTeamHeal = nowH;
          sess.teamHealTries += 1;
          if (sess.teamHealTries > 5) {
            sm.set('NEEDS_REVIEW',
              `leczenie nie podnosi HP (5 prób) — mon poniżej ${cfg.healHpBelow}%: ` +
              low.map((t) => `${t.hp}/${t.max}`).join(', '));
            return;
          }
          if (!PG.actions.healTeam()) {
            sm.set('NEEDS_REVIEW', 'brak przycisku leczenia na ekranie spotkania');
            return;
          }
          return; // kliknięte — nie wybieramy mona, aż HP się podniesie
        }
        sess.teamHealTries = 0; // HP OK → licznik prób zresetowany
      }

      const now = Date.now();
      if (now - sess.lastTeamClick < jrand(cfg.cooldowns.team)) return;
      sess.lastTeamClick = now;

      const ok = PG.actions.selectTeamMember(cfg.teamSlot);
      if (ok) sess.encounterTries += 1;
      if (!ok || sess.encounterTries >= 3) {
        sm.set('NEEDS_REVIEW',
          ok ? 'wybór Pokémona nie startuje walki (3 próby)' : 'brak drużyny na ekranie spotkania');
      }
    });

    sm.register('BATTLE', () => {
      const screen = detectScreen();
      if (screen !== 'battle') {
        sm.set('SCANNING', `walka zakończona/zmieniona (${screen})`);
        return;
      }
      if (!cfg.autoSkipBattle) return; // gra sama dokończy rundy

      const now = Date.now();
      if (now - sess.lastSkip < jrand(cfg.cooldowns.skip)) return;
      sess.lastSkip = now;

      if (PG.actions.skipBattle()) {
        sess.battleTries += 1;
        if (sess.battleTries >= 4) {
          sm.set('NEEDS_REVIEW', '„Przejdź do końca walki” nie zmienia ekranu (4 próby)');
        }
      }
    });

    sm.register('CATCH', () => {
      const screen = detectScreen();
      if (screen !== 'ball_select') {
        sm.set('SCANNING', `ekran wyboru piłki zmienił się (${screen})`);
        return;
      }

      if (!cfg.autoCatch) {
        // Nie łapemy — idziemy dalej wędrówką.
        if (PG.actions.walkAgain()) sm.set('WANDER', 'autoCatch wyłączone — pomijam łapanie');
        else sm.set('NEEDS_REVIEW', 'brak przycisku „Wędruj ponownie” przy pominiętym łapaniu');
        return;
      }

      const now = Date.now();
      if (now - sess.lastThrow < jrand(cfg.cooldowns.throw)) return;

      if (sess.throws >= cfg.maxThrows) {
        sm.set('NEEDS_REVIEW', `max rzutów w potyczce (${cfg.maxThrows}) osiągnięty`);
        return;
      }

      sess.lastThrow = now;
      sess.throws += 1;
      const shiny = PG.actions.isShinyEncounter();
      const ok = PG.actions.throwBall(shiny, sess.throws);
      if (!ok) sm.set('NEEDS_REVIEW', 'brak piłki z konfiguracji (priorytety P1/P2 niedostępne)');
    });

    sm.register('BERRY', () => {
      const screen = detectScreen();
      if (screen !== 'berry_select') {
        sm.set('SCANNING', `ekran jagód zmienił się (${screen})`);
        return;
      }
      if (!cfg.autoBerries) {
        // Nie zbieramy — idziemy dalej wędrówką.
        if (PG.actions.walkAgain()) sm.set('WANDER', 'autoBerries wyłączone — pomijam jagody');
        else sm.set('NEEDS_REVIEW', 'brak przycisku przy pomijanych jagodach');
        return;
      }
      const now = Date.now();
      if (now - sess.lastBerry < jrand(cfg.cooldowns.berry)) return;
      sess.lastBerry = now;
      sess.berryTries += 1;
      if (sess.berryTries > 5) {
        sm.set('NEEDS_REVIEW', '„Zbierz jagody” nie zmienia ekranu (5 prób)');
        return;
      }
      if (!PG.actions.collectBerries()) {
        sm.set('NEEDS_REVIEW', 'brak przycisku „Zbierz jagody”');
      }
    });

    sm.register('HEAL', () => {
      const ap = PG.actions.parseAP();
      if (!ap) {
        sm.set('NEEDS_REVIEW', 'nie mogę odczytać poziomu PUNKTÓW AKCJI ze strony');
        return;
      }
      if (ap.current >= cfg.healBelow) {
        sess.healTries = 0;
        sm.set('SCANNING', `PA odnowione: ${ap.current}/${ap.total}`);
        return;
      }
      if (sess.healTries >= 5) {
        sm.set('NEEDS_REVIEW', `Regeneracja PA nie podnosi punktów (5 kliknięć, mam ${ap.current}/${ap.total})`);
        return;
      }
      const now = Date.now();
      if (now - sess.lastHeal < jrand(cfg.cooldowns.heal)) return;
      sess.lastHeal = now;
      if (cfg.autoHeal && PG.actions.heal()) {
        sess.healTries += 1;
      } else if (!cfg.autoHeal) {
        sm.set('NEEDS_REVIEW', 'za mało PA, a autoHeal wyłączone');
      } else {
        sm.set('NEEDS_REVIEW', 'brak przycisku „Regeneracja punktów akcji”');
      }
    });

    sm.register('QUEST_TURNIN', () => {
      PG.actions.turnInQuest();
      PG.actions.claimRewards();
    });

    sm.register('INVENTORY', () => {
      if (!cfg.autoManage) {
        sm.set('NEEDS_REVIEW', 'zarządzanie ekwipunkiem, autoManage wyłączone');
        return;
      }
      // Ekrany akcji (walka/łapanie/jagody) mają priorytet — oddajemy
      // sterowanie SCANNING, który je obsłuży i tu wróci.
      const scr = detectScreen();
      if (scr === 'encounter' || scr === 'berry_select'
          || scr === 'ball_select' || scr === 'battle') {
        sm.set('SCANNING', `ekran akcji podczas zarządzania (${scr})`);
        return;
      }
      const now = Date.now();
      const wait = () => {
        if (now - sess.lastManage < jrand(cfg.cooldowns.manage)) return true;
        sess.lastManage = now;
        return false;
      };

      // 1) Otwarty dialog → potwierdź (szukamy przycisku w jego obrębie).
      const dlg = PG.actions.manageDialogKind();
      if (dlg === 'other') {
        sm.set('NEEDS_REVIEW', 'nieznany dialog na ekranie — ewolucja/sprzedaż wstrzymane');
        return;
      }
      if (dlg) {
        if (wait()) return;
        const key = dlg === 'evolve' ? 'manageEvolveTries' : 'manageSellTries';
        sess[key] += 1;
        if (sess[key] > 6) {
          sm.set('NEEDS_REVIEW', `dialog ${dlg}: potwierdzenie nie zamyka okna (7 prób)`);
          return;
        }
        if (!PG.actions.confirmManageDialog(dlg)) {
          sm.set('NEEDS_REVIEW', `brak przycisku potwierdzenia w dialogu (${dlg})`);
        }
        return;
      }

      // 2) Jeszcze są gotowe ewolucje → „Ewoluuj wszystkie gotowe”
      //    (gra otworzy dialog → potwierdzenie w kroku 1). Kolejna runda
      //    dopiero gdy licznik znów > 0 — stąd max 7 kliknięć.
      const ready = PG.actions.evolveReadyCount();
      if (ready > 0) {
        if (sess.manageEvolveTries > 6) {
          sm.set('NEEDS_REVIEW', `ewolucja nie ubywa (7 prób, gotowe: ${ready})`);
          return;
        }
        if (wait()) return;
        sess.manageEvolveTries += 1;
        if (!PG.actions.evolveTeam()) {
          sm.set('NEEDS_REVIEW', 'brak przycisku „Ewoluuj wszystkie gotowe”');
        }
        return;
      }
      sess.manageEvolveTries = 0; // nic do ewolucji → licznik czysty

      // 3) Rezerwa pełna → „Szybka sprzedaż” → dialog „Sprzedaj” (krok 1).
      if (PG.actions.reserveFull()) {
        if (sess.manageSellTries > 6) {
          sm.set('NEEDS_REVIEW', 'sprzedaż nie zmniejsza rezerwy (7 prób)');
          return;
        }
        if (wait()) return;
        sess.manageSellTries += 1;
        if (!PG.actions.sellPokemon()) {
          sm.set('NEEDS_REVIEW', 'brak przycisku „Szybka sprzedaż pokemonów”');
        }
        return;
      }
      sess.manageSellTries = 0;

      // 4) Ewolucje gotowe, rezerwa niepełna → wszystko zrobione.
      sess.manageEvolveTries = 0;
      sm.set('SCANNING', 'ewolucja/sprzedaż zakończona');
    });

    sm.register('SPECIAL_ENCOUNTER', () => {
      if (cfg.pauseOnSpecial) {
        sm.set('NEEDS_REVIEW', 'specjalne spotkanie (shiny/tutor) — decyzja człowieka');
      } else {
        sm.set('SCANNING', 'specjalne spotkanie pominięte (pauseOnSpecial=false)');
      }
    });

    // STOPPED i NEEDS_REVIEW celowo bez handlera — bot ma stać bezczynnie.
  }

  // ── pętla ─────────────────────────────────────────────────────────────────

  let loopRunning = false;

  /**
   * Pętla SAMOPLANUJĄCA się (setTimeout): co tick losowany interwał
   * jrand(tickMs) — brak stałego okresu, które łatwo wykryć analizą czasu.
   */
  function startLoop() {
    stopLoop();
    loopRunning = true;
    const step = () => {
      if (!loopRunning) return;
      PG.sm.tick();
      if (loopRunning) timer = setTimeout(step, jrand(PG.config.tickMs));
    };
    timer = setTimeout(step, jrand(PG.config.tickMs));
  }

  function stopLoop() {
    loopRunning = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function start() {
    PG.logger.push('bot_started', { version: PG.version });
    try { localStorage.setItem(RESUME_KEY, '1'); } catch (_) { /* ignore */ }
    lastScreen.value = null;
    PG.sm.start();
    startLoop();
  }

  function stop() {
    PG.logger.push('bot_stopped', {});
    try { localStorage.removeItem(RESUME_KEY); } catch (_) { /* ignore */ }
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

    loadConfig(); // PRZED budową panelu — UI pokazuje zapisane preferencje
    registerStates();
    PG.panel.build();

    // Zapisuj konfigurację przy każdej zmianie z panelu.
    PG.logger.subscribe((entry) => {
      if (entry.event === 'config_change') persistConfig();
    });

    PG.logger.push('bot_booted', {
      version: PG.version,
      url: location.href,
      integrityRoles: PG.selectors.integrityRoles(),
    });

    console.log(
      `%c[PG Edu Bot] v${PG.version} załadowany — otwórz panel po prawej, kliknij ▶ Start.`,
      'color:#facc15;font-weight:bold'
    );

    // Auto-wznowienie po odświeżeniu/nawigacji (klawisz Start = „trzymaj włączone").
    let resume = false;
    try { resume = localStorage.getItem(RESUME_KEY) === '1'; } catch (_) { /* ignore */ }
    if (resume && PG.config.autoResume) {
      PG.logger.push('bot_auto_resumed', {});
      setTimeout(start, 400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /** Restart interwału (np. po zmianie tickMs w panelu). */
  function restartLoop() {
    if (loopRunning) startLoop();
  }

  return { start, stop, restartLoop, detectScreen, registerStates, persistConfig, loadConfig };
})();

})();
