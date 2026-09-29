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
