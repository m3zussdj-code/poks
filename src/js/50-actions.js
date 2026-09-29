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

  // ── mostek CDP: klik przez driver (trusted event z przeglądarki) ─────────
  // Samodzielne el.click() ma isTrusted=false → antycheat gry dostaje +80 pkt
  // (próg 70) i loguje „Mocny sygnał automatyzacji”. Zamiast tego piszemy
  // żądanie do window.__pgClick; driver (driver/pg-cdp-driver.mjs, Chrome
  // z --remote-debugging-port) odczytuje je przez CDP i klika przez
  // Input.dispatchMouseEvent — przeglądarka generuje ZAUFAŁY event z pełną
  // trajektorią myszy. Status drivera: heartbeat window.__pgBridge.

  /** Czy driver żyje (heartbeat < 5 s)? Odczyt stanu — bezsidefektowy. */
  function bridgeFresh() {
    const b = window.__pgBridge;
    return !!(b && b.ok && Number.isFinite(b.ts) && Date.now() - b.ts < 5000);
  }

  /**
   * Punkt kliknięcia wewnątrz prostokąta elementu (15% margines) — czysty
   * (testowany): nigdy na krawędzi, lekko poza środkiem jak u człowieka.
   */
  function bridgePoint(rect) {
    const w = Math.max(0, rect.width || 0);
    const h = Math.max(0, rect.height || 0);
    const mx = Math.min(w / 2, Math.max(1, w * 0.15));
    const my = Math.min(h / 2, Math.max(1, h * 0.15));
    const x = (rect.left || 0) + mx + Math.random() * Math.max(0, w - 2 * mx);
    const y = (rect.top || 0) + my + Math.random() * Math.max(0, h - 2 * my);
    return { x: Math.round(x), y: Math.round(y) };
  }

  let bridgeSeq = 0;
  let lastBridgeFallback = 0;

  /**
   * Jedno miejsce klikania gry: CDP (trusted) → window.__pgClick;
   * bez drivera / bez konfiguracji → zwykły el.click() (fallback).
   * Zwraca 'cdp' | 'local'.
   */
  function fire(el) {
    if (PG.config.cdpBridge && bridgeFresh()) {
      try {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          bridgeSeq += 1;
          const p = bridgePoint(r);
          window.__pgClick = { id: bridgeSeq, x: p.x, y: p.y, ts: Date.now() };
          return 'cdp';
        }
      } catch (_) { /* rect niedostępny → fallback */ }
    }
    if (!bridgeFresh()) window.__pgClick = null; // nie zostawiamy ducha żądania
    if (PG.config.cdpBridge && Date.now() - lastBridgeFallback > 60000) {
      lastBridgeFallback = Date.now();
      PG.logger.push('bridge_fallback', { reason: bridgeFresh() ? 'rect' : 'no_driver' });
    }
    el.click();
    return 'local';
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
    fire(el);
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
    fire(b);
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
      fire(b.el);
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
    fire(el);
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
   * „Sprzedać Pokemony z rezerwy?” / „Zregenerować punkty akcji?”.
   * Inny widoczny dialog → 'other'.
   */
  function manageDialogKind() {
    let other = false;
    for (const d of document.querySelectorAll('[role="dialog"][data-open]')) {
      if (!isVisible(d)) continue;
      const t = pgText(d.textContent, 400);
      if (/Ewoluować wszystkie/i.test(t)) return 'evolve';
      if (/Sprzedać Pokemony z rezerwy/i.test(t)) return 'sell';
      if (/Zregenerować punkty akcji/i.test(t)) return 'ap';
      other = true;
    }
    return other ? 'other' : null;
  }

  /**
   * Tekst przycisku potwierdzenia w dialogu — czysty (testowany).
   * Dokładne napisy ze snapshotów gry; porównanie przez pgText, bez regexa.
   */
  function dialogConfirmText(kind) {
    if (kind === 'evolve') return 'Ewoluuj wszystkie';
    if (kind === 'ap') return 'Regeneruj';
    return 'Sprzedaj';
  }

  /**
   * Klik w potwierdzenie OTWARTEGO dialogu — szukamy TYLKO w jego
   * obrębie („Ewoluuj wszystkie” z dialogu ≠ przycisk szybkiej akcji
   * „38Ewoluuj wszystkie gotowe…”; „Sprzedaj” ≠ „Szybka sprzedaż…”).
   */
  function confirmManageDialog(kind) {
    const want = dialogConfirmText(kind);
    for (const d of document.querySelectorAll('[role="dialog"][data-open]')) {
      if (!isVisible(d)) continue;
      const btn = [...d.querySelectorAll('button')]
        .find((b) => pgText(b.textContent, 60) === want);
      if (!btn) continue;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
        PG.logger.push('action_disabled', { name: `dialog_${kind}` });
        return false;
      }
      noteAction();
      fire(btn);
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
  /**
   * Koszt kopania z tekstu przycisku „Odkop nagrodę (10 PA)”.
   * Czysta (testowana); null, gdy brak liczby PA w tekście.
   */
  function parseDigCost(text) {
    const m = /(\d+)\s*PA\b/i.exec(pgText(String(text || ''), 60));
    return m ? parseInt(m[1], 10) : null;
  }

  /** „Odkop nagrodę (10 PA)” — poszukiwacz skamielin; zawsze kopiemy. */
  function digFossil() {
    const ok = click('fossil-dig-button');
    if (ok) PG.logger.action('fossil_dig', true);
    return ok;
  }

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
    fire(loc.el);
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
    fire(el);
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
    manageDialogKind, confirmManageDialog, dialogConfirmText, parseDigCost,
    bridgeFresh, bridgePoint,
    walkAgain, selectTeamMember, skipBattle, throwBall, heal, healTeam,
    evolveTeam, sellPokemon,
    walkLocation,
    digFossil, collectBerries, openQuestTab, isVisible,
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
