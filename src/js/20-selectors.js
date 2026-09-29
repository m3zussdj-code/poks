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
