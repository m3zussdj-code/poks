# PokeGlory Edu Bot 🤖

Edukacyjny bot (userscript **Tampermonkey**) do gry przeglądarkowej [PokeGlory](https://pokeglory.pl/) — projekt do nauki programowania: maszyna stanów, parser questów, panel sterowania w Shadow DOM i lokalna telemetria.

> ⚠️ **Zastrzeżenie:** projekt edukacyjny do użytku na własnym koncie. Automatyzacja gry może naruszać regulamin — używasz na własną odpowiedzialność.

## Jak to działa (design)

```
┌────────────────────────────────────────────────────────────┐
│  Panel (Shadow DOM)                                        │
│  Start/Pauza/Stop · przełączniki · questy · logi · eksport │
└──────────────┬─────────────────────────────────────────────┘
               │ steruje
┌──────────────▼─────────────────────────────────────────────┐
│  Maszyna stanów (40-state-machine.js)                      │
│                                                            │
│  STOPPED → SCANNING ─┬→ WANDER (wędrówki)                  │
│                      ├→ CATCH / BATTLE / HEAL / …          │
│                      ├→ QUEST_TURNIN                       │
│                      └→ NEEDS_REVIEW ←── „nie rozpoznaję”  │
│                             │            (shiny, tutor,    │
│                             ▼             nowy ekran)      │
│                      czekam na człowieka + pełny log       │
└──────────────┬─────────────────────────────────────────────┘
               │ czyta DOM gry (nigdy nie modyfikuje atrybutów!)
┌──────────────▼─────────────────────────────────────────────┐
│  Selektory (20) · Parser questów (30) · Akcje (50)         │
│  Telemetria (10) → ring buffer → „📋 Kopiuj log”           │
└────────────────────────────────────────────────────────────┘
```

### Detekcja questów — hybryda, nie mapping

1. **Struktura** — kotwicą są markery `#1`, `#2`… statusy (`Aktywne`/`Gotowe`) i liczniki `64/400`.
2. **Słownik wzorców** (`PATTERNS` w `30-quest-parser.js`) — tekst celu → kanoniczny typ (`CATCH_TYPE`, `WALK_IN`, `DELIVER`, …).
3. **Fallback** — nierozpoznany cel = `UNKNOWN_GOAL` → bot czeka (`NEEDS_REVIEW`), surowy tekst leci do telemetrii, dopisujemy wzorzec. **Pętla uczenia:** log → analiza → nowy wzorzec/selektor.

### Telemetria (lokalna, nic nie wychodzi do sieci)

- ring buffer 500 zdarzeń: `state_change`, `selector_miss` (z listą ról `data-pokeglory-integrity` na stronie), `unknown_goal`, `snapshot` (url + inwentarz przycisków + fragment tekstu strony)…
- panel: **📋 Kopiuj log** / **💾 Pobierz JSON** / **📸 Snapshot ekranu** — wklejasz agentowi, on dopisuje kolejne selektory i stany.

## Struktura

```
src/meta.js              nagłówek Tampermonkeya (@match: *.pokeglory.pl)
src/js/00-namespace.js   PG + konfiguracja
src/js/10-logger.js      telemetria (ring buffer, eksport, throttling)
src/js/20-selectors.js   rejestr selektorów (priorytet: data-pokeglory-integrity-*)
src/js/30-quest-parser.js parser questów (czyste funkcje + ekstrakcja DOM)
src/js/40-state-machine.js maszyna stanów
src/js/50-actions.js     akcje (click) + stuby do wypełnienia
src/js/60-panel.js       panel UI (Shadow DOM)
src/js/70-main.js        pętla, detekcja ekranu, boot
tests/                   testy parsera (node, bez zależności)
build.sh                 składanie → dist/
dist/pokeglory-bot.user.js  gotowy plik do instalacji
```

## Build i testy

```bash
./build.sh                      # składanie + node --check
node tests/quest-parser.test.js # testy parsera (2 przykładowe questy)
```

## Instalacja

1. Zainstaluj **Tampermonkey** w przeglądarce.
2. `Tampermonkey → Nowy skrypt → wklej zawartość dist/pokeglory-bot.user.js`
   (albo otwórz plik — Tampermonkey złapie instalację).
3. Wejdź na `pokeglory.pl`, odśwież — po prawej pojawi się panel.
4. **▶ Start** → bot skanuje ekran; nieznany ekran = banner + log do przekazania.

## Zasady bezpieczeństwa (umówione)

- bot **tylko czyta** DOM i klika — nigdy nie modyfikuje atrybutów gry (w tym `data-pokeglory-integrity-*`),
- żaden request nie wychodzi z przeglądarki — telemetria jest lokalna,
- nieznana sytuacja = **stop i log**, nigdy „zgadywanie” w ciemno,
- tick co 1,5 s (konfigurowalny), brak akcji w ukrytej zakładce.

## Roadmap

- [x] szkielet: maszyna stanów, panel, telemetria, parser questów
- [x] akcja „Wędruj ponownie”
- [ ] pierwsze logi ze strony → prawdziwe selektory ekranów
- [ ] ekran spotkania: łapanie / walka
- [ ] heal (drinki), ewolucja, sprzedaż
- [ ] turn-in questów + odbiór nagród
- [ ] rozróżnienie `DELIVER` item vs. Pokémon (kontekst „plecak/rezerwa”)
- [ ] obsługa shiny/tutora (stan SPECIAL_ENCOUNTER jest gotowy)
