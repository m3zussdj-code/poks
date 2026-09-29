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
