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
      'BERRY', 'FOSSIL', 'QUEST_TURNIN', 'HEAL', 'INVENTORY', 'SPECIAL_ENCOUNTER', 'NEEDS_REVIEW'],
    get state() { return state; },
    get paused() { return paused; },
    get reason() { return reason; },
    history,
    register, set, tick,
    start, pause, resume, stop, acknowledge,
  };
})();
