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
    walkAgain, selectTeamMember, skipBattle, throwBall, heal, walkLocation,
    collectBerries, openQuestTab, isVisible,
    // stuby do wypełnienia (ekwipunek, questy):
    evolveTeam: () => { PG.logger.action('evolve', false, { stub: true }); return false; },
    sellPokemon: () => { PG.logger.action('sell', false, { stub: true }); return false; },
    turnInQuest: () => { PG.logger.action('turn_in', false, { stub: true }); return false; },
    claimRewards: () => { PG.logger.action('claim_rewards', false, { stub: true }); return false; },
    /** Zgłoś specjalne spotkanie (shiny/tutor) → NEEDS_REVIEW, jeśli włączone. */
    specialEncounter(kind, extra = {}) {
      PG.logger.push('special_encounter', { kind, ...extra });
      PG.sm.set('SPECIAL_ENCOUNTER', `specjalne spotkanie: ${kind}`);
    },
  };
})();
