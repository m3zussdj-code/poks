/**
 * 00-namespace.js — przestrzeń nazw bota.
 *
 * Wszystkie moduły wieszają się na obiekcie `PG`.
 * Kolejność plików w `src/js/` ma znaczenie (buduje je build.sh),
 * dlatego numery są celowo prepended do nazw plików.
 */

const PG = {
  version: '0.1.1',

  /**
   * Konfiguracja bota. Panel steruje flagami auto* i pauseOnSpecial,
   * reszta to parametry techniczne.
   */
  config: {
    tickMs: 1500,          // jak często maszyna stanów wykonuje tick
    logLimit: 500,         // rozmiar ring buffera telemetrii
    missThrottleMs: 15000, // nie spamuj logów powtarzającymi się selector_miss

    // przełączniki widoczne w panelu:
    autoWalk: true,        // wędrówki ("Wędruj ponownie")
    autoCatch: false,      // łapanie — włączymy, gdy poznamy DOM ekranu spotkania
    autoQuests: true,      // skan i rozliczanie questów
    autoHeal: true,        // picie drinków (odnowa punktów akcji)
    autoManage: false,     // ewolucja + sprzedaż — wymaga DOM ekwipunku
    pauseOnSpecial: true,  // shiny / tutor → zatrzymaj się i pokaż NEEDS_REVIEW
    debugConsole: true,    // lustrzane logi do konsoli przeglądarki
  },
};

/** Normalizacja tekstu: usuwa podwójne spacje, NBSP, przycina. */
function pgText(value, max = 300) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Znacznik czasu do logów: HH:MM:SS */
function pgTime(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
