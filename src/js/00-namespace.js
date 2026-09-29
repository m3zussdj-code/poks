/**
 * 00-namespace.js — przestrzeń nazw bota.
 *
 * Wszystkie moduły wieszają się na obiekcie `PG`.
 * Kolejność plików w `src/js/` ma znaczenie (buduje je build.sh),
 * dlatego numery są celowo prepended do nazw plików.
 */

const PG = {
  version: '0.10.4',

  /**
   * Konfiguracja bota. Panel steruje flagami auto* i pauseOnSpecial,
   * reszta to parametry techniczne. Całość zapisuje się w localStorage
   * (persistencja po odświeżeniu strony).
   */
  config: {
    tickMs: 500,           // BAZOWY interwał pętli (zmodyfikowany przez jitter)
    graceMs: 2500,         // po kliknięciu czekamy tyle na aktualizację ekranu
    autoReviewMs: 6000,    // auto-rescan: tyle czeka NEEDS_REVIEW (znany ekran)
    jitter: 0.35,          // ±35% losowania wokół KAŻDEGO interwału i cooldownu
                           // (0 = sztywne, robotnicze odstępy — nie używaj!)
    logLimit: 500,         // rozmiar ring buffera telemetrii
    missThrottleMs: 15000, // nie spamuj logów powtarzającymi się selector_miss

    // minimalne odstępy między klikami (ms) — BAZA przed jitterem.
    // Chronią przed spamowaniem serwera; jitter robi z tego
    // nieprzewidywany (ludzki) rozrzut.
    cooldowns: {
      walk: 800,
      team: 600,
      throw: 800,
      skip: 700,
      heal: 1200,
      location: 1500,
      berry: 700,
      fossil: 900,
      teamHeal: 1500,
      manage: 1500,       // ewolucja/sprzedaż rezerwy (klik ↔ dialog)
    },

    // przełączniki widoczne w panelu:
    autoWalk: true,        // wędrówki ("Wędruj ponownie")
    autoCatch: true,       // rzut piłką po wygranej walce
    autoBerries: true,     // „Zbierz jagody” przy krzewie podczas wędrówki
    autoSkipBattle: true,  // klikaj "Przejdź do końca walki"
    autoQuests: true,      // skan i rozliczanie questów
    autoHeal: true,        // picie drinków (odnowa punktów akcji)
    autoHealTeam: true,    // lecz HP pokemonów (< healHpBelow%) — ekran spotkania
    autoManage: true,     // rezerwa pełna → ewoluuj (dialogi) → sprzedaj (dialog)
    autoResume: true,      // wznowienie działania po odświeżeniu strony
    cdpBridge: true,       // klik przez driver CDP (trusted events) zamiast el.click()
    autoReview: true,      // NEEDS_REVIEW z znanym ekranem wraca sam do SCANNING
    questLocation: true,   // cel z questa WALK_IN steruje wyborem lokacji
    pauseOnSpecial: true,  // shiny / tutor → zatrzymaj się i pokaż NEEDS_REVIEW
    debugConsole: true,    // lustrzane logi do konsoli przeglądarki

    // łapanie / walka:
    teamSlot: 1,           // który Pokémon z drużyny ma walczyć (1-based)
    walkLocation: '',      // start z kokpitu: '' = ręcznie, np. 'Mroczne Miasto'
    balls: {               // priorytet 1, priorytet 2 (zapasowy przy braku P1)
      normal: ['Level Ball', 'Poké Ball'],
      shiny: ['Shiny Ball', 'Master Ball'],
    },
    maxThrows: 3,          // maks. rzutów w jednej potyczce (potem NEEDS_REVIEW)
    healBelow: 6,          // pij drinki, gdy PA < tej wartości (max koszt karty = 5)
    healHpBelow: 50,       // lecz drużynę, gdy HP dowolnego mona < ten próg (%)
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
