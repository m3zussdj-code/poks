# PG Edu Bot — skompaktowany stan ( czytaj TO zamiast full memory )

Repo `/home/user/poks`, branch `arena/01a0ec56-poks`, HEAD **c8fa261 = v0.9.0**, testy **74/74**.
Serwer dist: port **8377** (statyczny `python3 -m http.server` → `dist/`); przed podaniem URL → `curl -sf localhost:8377/pokeglory-bot.user.js | head -4`, restart = `start_process`.

## Konwencje (twarde)
- Wszystko po polsku z użytkownikiem; push TYLKO na `arena/01a0ec56-poks`.
- Panel NIE modyfikuje DOM gry (read/click); selektory preferują `data-pokeglory-integrity-role`.
- Telemetria lokalna, eksport przez panel.
- `git commit -F .git/COMMIT_MSG_TMP` (nigdy `-m` z polskimi znakami); `cwd` zawsze `/home/user/poks`.
- `edit_file` bywa nietrafiony → po każdej edycji: `grep -n` weryfikacyjny; `build.sh` + testy DOPÓO ostatniej edycji.
- NIE czytać całych plików bez potrzeby → najpierw `grep -n <anchor>`, potem `read_file` z `offset/limit`.
- `read_file /home/user/uploads/image-1.png` → NIE ISTNIEJE (nie szukać); snapshoty tylko z JSON w memory.

## Architektura `src/js/` (kolejność = build, IIFE)
- `00` PG + config (version, `autoHealTeam`, `healHpBelow=50`, `cooldowns.teamHeal=1500`), `pgText`
- `10` logger (ring 500, `action()`, `selectorMiss()` throttle)
- `20` selektory: `walk-again`, `encounter-preview`, `team-selection`, **`team-heal-button`** (`/^Ulecz wszystkie$/` → fallback `Leczenie wszystkich pokemonów`), `battle-result` PRZED `battle-skip`, `berry`, `ball-card`
- `30` quest-parser (wisia na `PG.quest`; testy ładują 00+30+50)
- `40` state machine: STATES, `tick()` re-dispatch (depth 5), NEEDS_REVIEW bez handlera
- `50` actions: **`parseTeamHpText` (HP = zawsze `pairs[1]`! para[0] bez spacji zlewa poziom+EXP)**, `teamHpList`/`teamLowHp` (filtr `/Lv\./`, liczy „Niezdolny…"), `healTeam` (prefer widoczny), `teamButtons`/`peekTeam` (`/^Lv\./` = bez Niezdolnych), `click()`/`isVisible`, `throwBall`
- `60` panel: BADGE, TOGGLES (pętla `wire()`), inputy `inThrows/inTick/inJitter/inHealHp` (wzór: clamp + `cfgSet`), `render()` → `syncAutomationUI()` fill
- `70` main: `detectScreen` encounter→berry→ball→**fossil**→battle_result→battle→walk_ready→kokpit→unknown; SCANNING sekcja 1 ekrany akcji (FOSSIL←fossil), 3 walk_ready|battle_result→WANDER; `sess` + `resetSessionForScreen`; **ENCOUNTER: autoHealTeam → `teamLowHp` → `healTeam` (cooldown, `teamHealTries>5`→NEEDS_REVIEW) → dopiero `selectTeamMember`**

## v0.6.0 — ZROBIONE (heal <50%)
Toggle „Leczenie HP (< próg)" + input % (10–90). Hook w ENCOUNTER przed selekcją; reset `teamHealTries` gdy HP ok.

## v0.7.0 — ZROBIONE (`ee1f0a5`, sprzedaż przy pełnej rezerwie)
`parseEvolveCount`/`parseReserve`, `reserveFull`, `manageDialogKind()` (tytuły dialogów), `confirmManageDialog`
(pgText × N regex w dialogu; `data-slot="dialog-close"` NIE). INVENTORY: dialog → evolve → reserveFull → sell
→ SCANNING; `manage*Tries>6` → NEEDS_REVIEW. Trigger: SCANNING 2b i WANDER (`autoManage && reserveFull()`).
Migracja loadConfig: `preManageSave` → `autoManage=true`.

## v0.8.0 — ZROBIONE (`d5319b8`, dialog regeneracji PA)
HEAL klika `heal-ap-button` → dialog „Zregenerować punkty akcji?" → HEAL jako PIERWSZE sprawdza
`manageDialogKind()==='ap'`: cooldown `lastHeal`, `healTries++` (≥5 → NEEDS_REVIEW), `confirmManageDialog('ap')`
→ PA 155/155 → `ap ≥ healBelow` → SCANNING. Inny dialog w HEAL → ciche czekanie. `dialogConfirmText(kind)`
czysty (ap→`Regeneruj`, evolve→`Ewoluuj wszystkie`, sell→`Sprzedaj`), testy 72/72. Dialog NIE w detectScreen
(wpada w battle_result) — obsługa w HEAL, nie w INVENTORY.

## v0.9.0 — ZROBIONE (`c8fa261`, poszukiwacz skamielin — „zawsze odkopuj")
Ekran fossil = walk-again + result-actions + „Odkop nagrodę (10 PA)"; detectScreen: `fossil-dig-button`
PRZED battle-result. Stan FOSSIL (wzór BERRY): cooldown `fossil` 900, `fossilTries` >5 → NEEDS_REVIEW,
dlg `other` → NEEDS_REVIEW snapshot. PA < koszt: autoHeal → `sess.healNeed=cost` → HEAL z progiem
`max(healBelow, healNeed)` (reset przy sukcesie i w resetSessionForScreen) → powrót → kopanie;
autoHeal off → `walkAgain()` (pomijamy, bez pętli FOSSIL↔WANDER). `parseDigCost` z tekstu przycisku (10).

## Otwarte (nie zapomnieć)
1. v0.5.0: co się pojawia PO „Zbierz jagody" (jeśli NEEDS_REVIEW → snapshot).
2. Snapshot „🗺 Pełny widok" (`openQuestTab`).
3. Shiny w `throwBall` — potwierdzić detekcję.
4. Auto-przejście questu po 540/540.
5. Czy „Ulecz wszystkie" kosztuje (PA/jeny)? Jeśli HP nie rośnie → NEEDS_REVIEW, wtedy snapshot + log.

## Pętle debugowania, które się sprawdzają
- Brak nowego stanu → BADGE w `60` + STATES w `40`.
- Nowy parser testowalny = funkcja na `PG` w pliku ładowanym przez test (00/30/50).
- Użyte vs zdefiniowane: `grep -rhoE "resolve(All)?\('[^']+'" src/js/` ↔ rejestr `20`.
