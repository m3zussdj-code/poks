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
    fossilTries: 0,
    lastFossil: 0,
    healNeed: 0,
    pendingThrow: null,
    unverifiedTries: 0,
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
    sess.fossilTries = 0;
    sess.healNeed = 0;
    sess.pendingThrow = null;
    sess.unverifiedTries = 0;
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
    // Poszukiwacz skamielin MA rolę result-actions (jak wynik walki) —
    // sprawdzamy PRZED battle-result, żeby nie pomylić ekranów.
    if (PG.selectors.resolve('fossil-dig-button', { reportMiss: false })) return 'fossil';
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

    // „Wznowię sam” musi ZEROWAĆ liczniki rzutów — bez tego NEEDS_REVIEW
    // „max rzutów” wracał natychmiast (ekran się nie zmienił, sess.throws=3).
    if (!sm.__ackResetsCatch) {
      sm.__ackResetsCatch = true;
      const ack = sm.acknowledge;
      sm.acknowledge = function () {
        sess.throws = 0;
        sess.unverifiedTries = 0;
        sess.pendingThrow = null;
        return ack.apply(sm, arguments);
      };
    }

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
      if (screen === 'fossil') { sm.set('FOSSIL', 'poszukiwacz skamielin'); return; }
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

      // 1) Weryfikacja poprzedniego rzutu (po ≥1,2 s — serwer potrzebuje
      //    czasu na aktualizację qty). Qty na karty = jedyny sygnał, że rzut
      //    zarejestrował się u gry; qty bez zmian = klik nie przeszedł.
      if (sess.pendingThrow && now - sess.lastThrow >= 1200) {
        const ballsNow = PG.actions.parseBalls();
        const cur = ballsNow.find((x) => x.name === sess.pendingThrow.name);
        if (!cur && ballsNow.length) {
          // karta naszej piłki zniknęła przy pełnej liście → qty 0 = zużyta
          sess.throws += 1;
          sess.pendingThrow = null;
        } else if (cur) {
          if (cur.qty === sess.pendingThrow.qty) {
            sess.unverifiedTries += 1;
            PG.logger.push('throw_unverified', {
              name: sess.pendingThrow.name, qty: sess.pendingThrow.qty,
              attempt: sess.throws + sess.unverifiedTries + 1,
              unverified: sess.unverifiedTries,
            });
          } else {
            sess.throws += 1; // piłka zużyta → rzut przyjęty (liczy się do max)
          }
          sess.pendingThrow = null;
        }
        // pusta lista kart = ekran się buduje → czekamy
      }
      if (sess.pendingThrow) return; // czekamy na weryfikację poprzedniego rzutu

      if (sess.throws >= cfg.maxThrows) {
        sm.set('NEEDS_REVIEW', `max rzutów w potyczce (${cfg.maxThrows}) osiągnięty`);
        return;
      }
      if (sess.unverifiedTries >= cfg.maxThrows * 2) {
        sm.set('NEEDS_REVIEW',
          `rzuty nie rejestrują się (${sess.unverifiedTries}× bez zużycia piłek) — sprawdź driver CDP`);
        return;
      }

      // 2) Odstęp: pierwszy rzut po zmianie ekranu — krótki cooldown;
      //    kolejne — pełny grace (animacja + odpowiedź serwera).
      const gap = (sess.throws === 0 && sess.unverifiedTries === 0)
        ? jrand(cfg.cooldowns.throw)
        : jrand(cfg.graceMs);
      if (now - sess.lastThrow < gap) return;

      sess.lastThrow = now;
      const shiny = PG.actions.isShinyEncounter();
      const thrown = PG.actions.throwBall(shiny, sess.throws + sess.unverifiedTries + 1);
      if (!thrown) sm.set('NEEDS_REVIEW', 'brak piłki z konfiguracji (priorytety P1/P2 niedostępne)');
      else sess.pendingThrow = thrown;
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

    // ── Poszukiwacz skamielin — zawsze odkopuj nagrodę (10 PA) ────────────
    sm.register('FOSSIL', () => {
      const screen = detectScreen();
      if (screen !== 'fossil') {
        sm.set('SCANNING', `ekran skamielin zmienił się (${screen})`);
        return;
      }
      // Nieznany dialog po kliknięciu „Odkop” → snapshot od użytkownika.
      const dlg = PG.actions.manageDialogKind();
      if (dlg === 'other') {
        sm.set('NEEDS_REVIEW', 'nieznany dialog na ekranie skamielin — podeślij snapshot');
        return;
      }
      // PA < koszt → najpierw regeneracja (healNeed podnosi próg HEAL),
      // potem wracamy tutaj i kopiemy. autoHeal off → zostawiamy wydarzenie.
      const btn = PG.selectors.resolve('fossil-dig-button', { reportMiss: false });
      const cost = (btn && PG.actions.parseDigCost(btn.textContent)) || 10;
      const ap = PG.actions.parseAP();
      if (ap && ap.current < cost) {
        if (cfg.autoHeal) {
          sess.healNeed = cost;
          sm.set('HEAL', `PA ${ap.current}/${ap.total} < ${cost} (kopanie)`);
        } else if (PG.actions.walkAgain()) {
          sm.set('WANDER', 'za mało PA na kopanie, autoHeal off — pomijam skamieliny');
        } else {
          sm.set('NEEDS_REVIEW', 'brak „Wędruj ponownie” przy pomijanych skamielinach');
        }
        return;
      }
      const now = Date.now();
      if (now - sess.lastFossil < jrand(cfg.cooldowns.fossil)) return;
      sess.lastFossil = now;
      sess.fossilTries += 1;
      if (sess.fossilTries > 5) {
        sm.set('NEEDS_REVIEW', '„Odkop nagrodę” nie przechodzi (5 prób) — snapshot ekranu');
        return;
      }
      if (!PG.actions.digFossil()) {
        sm.set('NEEDS_REVIEW', 'brak przycisku „Odkop nagrodę”');
      }
    });

    sm.register('HEAL', () => {
      // 1) Otwarty dialog „Zregenerować punkty akcji?” → klik „Regeneruj”
      //    w jego obrębie; potem czekamy (cooldown + ticki), aż PA wzrośnie.
      //    Inny dialog (gracz go otworzył) → czekamy, aż go zamknie.
      const dlg = PG.actions.manageDialogKind();
      if (dlg && dlg !== 'ap') return;
      if (dlg === 'ap') {
        const nowD = Date.now();
        if (nowD - sess.lastHeal < jrand(cfg.cooldowns.heal)) return;
        if (sess.healTries >= 5) {
          sm.set('NEEDS_REVIEW', 'regeneracja PA: „Regeneruj” nie przechodzi (5 prób)');
          return;
        }
        sess.lastHeal = nowD;
        sess.healTries += 1;
        if (!PG.actions.confirmManageDialog('ap')) {
          sm.set('NEEDS_REVIEW', 'regeneracja PA: brak aktywnego „Regeneruj” w dialogu');
        }
        return;
      }

      const ap = PG.actions.parseAP();
      if (!ap) {
        sm.set('NEEDS_REVIEW', 'nie mogę odczytać poziomu PUNKTÓW AKCJI ze strony');
        return;
      }
      // Próg: domyślny healBelow lub podniesiony przez FOSSIL (healNeed = koszt kopania).
      const need = Math.max(cfg.healBelow, sess.healNeed || 0);
      if (ap.current >= need) {
        sess.healTries = 0;
        sess.healNeed = 0;
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
