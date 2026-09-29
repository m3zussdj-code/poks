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
