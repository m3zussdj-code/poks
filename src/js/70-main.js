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
