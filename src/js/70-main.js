/**
 * 70-main.js — start bota, pętla ticków, handlery stanów, persistencja.
 *
 * Detekcja ekranów (v3, oparta o snapshoty z /mapa):
 *   encounter  → ENCOUNTER (wybór drużyny)
 *   ball_select→ CATCH     (rzut po wygranej)
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
    throws: 0,
    healTries: 0,
    lastTeamClick: 0,
    lastThrow: 0,
    lastSkip: 0,
    lastHeal: 0,
    lastWalk: 0,
    lastLoc: 0,
  };

  const lastScreen = { value: null };

  function resetSessionForScreen() {
    sess.encounterTries = 0;
    sess.battleTries = 0;
    sess.throws = 0;
    // healTries NIE jest resetowany — resetuje go dopiero rosnący poziom PA.
  }

  // ── detekcja ekranu ───────────────────────────────────────────────────────

  function detectScreen() {
    if (PG.selectors.resolve('encounter-preview', { reportMiss: false })) return 'encounter';
    if (PG.selectors.resolve('team-selection', { reportMiss: false })) return 'encounter';
    if (PG.actions.parseBalls().length > 0) return 'ball_select';
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
        Object.assign(PG.config, saved);
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
      if (cfg.autoQuests) PG.quest.scan();

      const screen = detectScreen();
      if (screen !== lastScreen.value) {
        lastScreen.value = screen;
        resetSessionForScreen();
        PG.logger.push('screen_detected', { screen, url: location.href });
      }

      // 1) Ekrany akcji — routowane natychmiast, bez przerwy na heal.
      if (screen === 'encounter') { sm.set('ENCOUNTER', 'spotkanie w dziczy'); return; }
      if (screen === 'ball_select') { sm.set('CATCH', 'wybór piłki po walce'); return; }
      if (screen === 'battle') { sm.set('BATTLE', 'walka w toku'); return; }

      // 2) Niskie PA → picie drinków (globalny przycisk „Regeneracja…”).
      const ap = PG.actions.parseAP();
      if (cfg.autoHeal && ap && ap.current < cfg.healBelow) {
        sm.set('HEAL', `PA ${ap.current}/${ap.total} < ${cfg.healBelow}`);
        return;
      }

      // 3) Znane ekrany bez akcji.
      if (screen === 'walk_ready') { sm.set('WANDER', 'rozpoznany ekran: wędrówka'); return; }

      if (screen === 'kokpit') {
        if (cfg.walkLocation && cfg.autoWalk) {
          const now = Date.now();
          if (now - sess.lastLoc > 4000) {
            sess.lastLoc = now;
            PG.actions.walkLocation(cfg.walkLocation);
          }
        }
        return; // zostajemy w SCANNING — czekamy na nawigację / akcję
      }

      // 4) Nieznany ekran — grace period po kliknięciu (gra się jeszcze ładuje).
      if (PG.actions.sinceLastAction() < 4000) return;

      PG.logger.push('screen_unknown_snapshot', {
        integrityRoles: PG.selectors.integrityRoles(),
        url: location.href,
      });
      sm.set('NEEDS_REVIEW', `nieznany ekran — prześlij log do agenta`);
    });

    sm.register('WANDER', () => {
      const screen = detectScreen();
      if (screen !== 'walk_ready') {
        sm.set('SCANNING', `ekran zmienił się po wędrówce (${screen})`);
        return;
      }
      const ap = PG.actions.parseAP();
      if (cfg.autoHeal && ap && ap.current < cfg.healBelow) {
        sm.set('HEAL', `PA ${ap.current}/${ap.total} < ${cfg.healBelow}`);
        return;
      }
      const now = Date.now();
      if (now - sess.lastWalk < 2000) return; // nie klikaj szybciej niż co 2 s
      if (cfg.autoWalk) {
        sess.lastWalk = now;
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
      const now = Date.now();
      if (now - sess.lastTeamClick < 1500) return;
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
      if (now - sess.lastSkip < 2000) return;
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
      if (now - sess.lastThrow < 1500) return;

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
      if (now - sess.lastHeal < 2500) return;
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
      PG.actions.evolveTeam();
      PG.actions.sellPokemon();
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

  return { start, stop, detectScreen, registerStates, persistConfig, loadConfig };
})();
