/**
 * Tests: parser questów (czyste funkcje, bez DOM).
 * Uruchomienie:  node tests/quest-parser.test.js
 *
 * Ładuje prawdziwe pliki src/js/00 i src/js/30 i sprawdza je
 * na przykładowych questach przekazanych przez użytkownika.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── mini framework ──────────────────────────────────────────────────────────
let passed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed += 1; }
  else { failures.push(msg); console.error(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}\n      oczekiwano: ${JSON.stringify(expected)}\n      otrzymano:  ${JSON.stringify(actual)}`
  );
}

// ── ładowanie modułów bota (te same pliki, co w build.sh) ───────────────────
function loadPG() {
  // 50-actions: ładujemy dla czystego parseTeamHpText (bez DOM w load time).
  const files = ['00-namespace.js', '30-quest-parser.js', '50-actions.js'];
  const code = files
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'js', f), 'utf8'))
    .join('\n');
  return new Function(`${code}\nreturn PG;`)();
}

const PG = loadPG();
const { classify, normalize, parseQuestText } = PG.quest;

// ── Quest 1: „Rozliczający raport wyzwań" (5 celów, 4 gotowe) ─────────────
const quest1 = `
Rozliczający raport wyzwań
Bill przygotował zadanie badawcze dla obszaru Trakt Prizmański. Wykonaj wszystkie 5 celów, aby zamknąć raport terenowy.
Cele
Spotkaj 71 dwutypowych Pokémonów
#1Gotowe
Gotowe
x
Wykonaj 470 wędrówek
#2Gotowe
Gotowe
x
Zdobądź 1011 doświadczenia
#3Gotowe
Gotowe
x
Wygraj 75 walk
#4Gotowe
Gotowe
x
Wykonaj 540 wędrówek w lokacji Mroczne Miasto
#5Aktywne
`.trim();

// ── Quest 2: „Raport z Żaru" (Poziom IV, 5 celów aktywnych) ───────────────
const quest2 = `
Raport z Żaru: ekspercki etap długotrwałej obserwacji, raportowania i zabezpieczania rzadkich materiałów z najbardziej niebezpiecznych, rozgrzanych rejonów.
Poziom IVEksperckieRaport #48 pkt sezonowych
Złap 400 Pokémonów typuFire
#1Aktywne
64/400
x
Spotkaj 80x pokemonów trzymających przedmiot Czerwony odłamek
#2Aktywne
2/80
x
Przeprowadź 8000 badań terenowych w tym obszarze
#3Aktywne
4431/8000
x
Oddaj 40x Czerwony odłamek
#4Aktywne
0/40
x
Masz w plecaku: 28
Oddaj 1xShiny Growlithe
#5Aktywne
0/1
x
Pokémona do zadania możesz oddać wyłącznie z rezerwy.
Brakuje wymaganego Pokémona w rezerwie.
Nagrody za ukończenie
72,000,000 ¥80x Power Drink8x Bilet do Rezerwatu8x Klucz Codzienny8x Skrzynia Codzienna
`.trim();

console.log('1. normalize() — pułapki składniowe');
eq(normalize('Złap 400 Pokémonów typuFire'), 'Złap 400 Pokémonów typu Fire', 'typuFire → typu Fire');
eq(normalize('Oddaj 1xShiny Growlithe'), 'Oddaj 1x Shiny Growlithe', '1xShiny → 1x Shiny');
eq(normalize('  Zdobądź   1011  doświadczenia '), 'Zdobądź 1011 doświadczenia', 'zścieśnienie spacji');

console.log('2. classify() — każdy wzorzec ze słownika');
eq(classify('Złap 400 Pokémonów typu Fire').type, 'CATCH_TYPE', 'CATCH_TYPE typ');
eq(classify('Złap 400 Pokémonów typu Fire').pokemonType, 'Fire', 'CATCH_TYPE wartość typu');
eq(classify('Spotkaj 71 dwutypowych Pokémonów'), { ok: true, raw: 'Spotkaj 71 dwutypowych Pokémonów', type: 'ENCOUNTER_DUALTYPE', count: 71 }, 'ENCOUNTER_DUALTYPE');
eq(classify('Spotkaj 80x pokemonów trzymających przedmiot Czerwony odłamek').type, 'ENCOUNTER_HELD_ITEM', 'ENCOUNTER_HELD_ITEM');
eq(classify('Wykonaj 470 wędrówek').type, 'WALK', 'WALK');
eq(classify('Wykonaj 540 wędrówek w lokacji Mroczne Miasto'), { ok: true, raw: 'Wykonaj 540 wędrówek w lokacji Mroczne Miasto', type: 'WALK_IN', count: 540, location: 'Mroczne Miasto' }, 'WALK_IN z lokacją');
eq(classify('Zdobądź 1011 doświadczenia').type, 'GAIN_XP', 'GAIN_XP');
eq(classify('Wygraj 75 walk').type, 'WIN_BATTLE', 'WIN_BATTLE');
eq(classify('Przeprowadź 8000 badań terenowych w tym obszarze').type, 'FIELD_RESEARCH', 'FIELD_RESEARCH');
eq(classify('Oddaj 40x Czerwony odłamek'), { ok: true, raw: 'Oddaj 40x Czerwony odłamek', type: 'DELIVER', count: 40, target: 'Czerwony odłamek' }, 'DELIVER przedmiot');

console.log('3. classify() — nieznany cel → UNKNOWN_GOAL');
const unknown = classify('Zbuduj nową bazę na szczycie góry');
eq(unknown, { ok: false, type: 'UNKNOWN_GOAL', raw: 'Zbuduj nową bazę na szczycie góry' }, 'nieznany cel flagowany');

console.log('4. parseQuestText() — quest 1 „Rozliczający raport wyzwań”');
const p1 = parseQuestText(quest1);
eq(p1.title, 'Rozliczający raport wyzwań', ' tytuł');
eq(p1.goals.length, 5, ' liczba celów');
eq(p1.unknownCount, 0, ' brak nieznanych celów');
eq(p1.goals.map((g) => g.parsed.type), ['ENCOUNTER_DUALTYPE', 'WALK', 'GAIN_XP', 'WIN_BATTLE', 'WALK_IN'], ' typy celów');
eq(p1.goals.map((g) => g.status), ['done', 'done', 'done', 'done', 'active'], ' statusy');
eq(p1.goals[0].parsed.count, 71, ' count celu #1');
eq(p1.goals[4].parsed.location, 'Mroczne Miasto', ' lokacja celu #5');
eq(p1.goals[4].progress, null, ' cel #5 bez licznika');
// opis z czasownikiem „Wykonaj” NIE może zostać złapany jako cel:
assert(!p1.goals.some((g) => (g.text || '').includes('wszystkie 5 celów')), ' opis questu nie udaje celu');

console.log('5. parseQuestText() — quest 2 „Raport z Żaru”');
const p2 = parseQuestText(quest2);
eq(p2.goals.length, 5, ' liczba celów');
eq(p2.unknownCount, 0, ' brak nieznanych celów');
eq(p2.goals.map((g) => g.parsed.type),
  ['CATCH_TYPE', 'ENCOUNTER_HELD_ITEM', 'FIELD_RESEARCH', 'DELIVER', 'DELIVER'],
  ' typy celów');
eq(p2.goals.map((g) => g.status), ['active', 'active', 'active', 'active', 'active'], ' statusy');
eq(p2.goals[0].progress, { current: 64, total: 400 }, ' postęp #1');
eq(p2.goals[1].progress, { current: 2, total: 80 }, ' postęp #2');
eq(p2.goals[2].progress, { current: 4431, total: 8000 }, ' postęp #3');
eq(p2.goals[3].progress, { current: 0, total: 40 }, ' postęp #4');
eq(p2.goals[4].progress, { current: 0, total: 1 }, ' postęp #5');
eq(p2.goals[3].notes, ['Masz w plecaku: 28'], ' notatka „Masz w plecaku” przy celu #4');
eq(p2.goals[4].notes, [
  'Pokémona do zadania możesz oddać wyłącznie z rezerwy.',
  'Brakuje wymaganego Pokémona w rezerwie.',
], ' notatki rezerwy przy celu #5');
eq(p2.goals[4].parsed.target, 'Shiny Growlithe', ' target celu #5');
// linia nagród nie może trafić do notatek:
assert(!JSON.stringify(p2.goals).includes('Power Drink'), ' nagrody poza celami');

// ── Quest 3: widget sidebar („Zadania Billa”) ─────────────────────────────
const sidebarWidget = `
Zadania Billa
Aktywne zadanie i jego nagrody
Eksperckie Trakt Prizmański
Rozliczający raport wyzwań
Nagrody -10%
Wykonaj 540 wędrówek w lokacji Mroczne Miasto
Aktywne
74/540
x
Nagrody 51x Power Drink 2,630,790 ¥
`.trim();

console.log('6. parseSidebarQuest() — widget „Zadania Billa”');
const sq = PG.quest.parseSidebarQuest(sidebarWidget, [
  { done: true, active: false },
  { done: true, active: false },
  { done: true, active: false },
  { done: true, active: false },
  { done: false, active: true },
]);
assert(sq.active, ' quest aktywny');
eq(sq.title, 'Rozliczający raport wyzwań', ' tytuł questu');
eq(sq.tierArea, 'Eksperckie Trakt Prizmański', ' tier + obszar');
eq(sq.goal.text, 'Wykonaj 540 wędrówek w lokacji Mroczne Miasto', ' tekst celu');
eq(sq.goal.parsed.type, 'WALK_IN', ' typ kanoniczny celu');
eq(sq.goal.parsed.location, 'Mroczne Miasto', ' lokalizacja z questa');
eq(sq.goal.parsed.count, 540, ' limit');
eq(sq.goal.status, 'active', ' status');
eq(sq.goal.progress, { current: 74, total: 540 }, ' postęp');
eq(sq.steps, { total: 5, done: 4, active: 5 }, ' kroki');
assert(/^Nagrody 51x Power Drink/.test(sq.rewards), ' nagrody');
assert(!/Nagrody -10%/.test(sq.rewards || ''), ' „Nagrody -10%” nie udaje nagród');
eq(PG.quest.parseSidebarQuest('Brak tu żadnego celu.'), { active: false }, ' brak celu → active:false');

// ── 7. parseTeamHpText() — HP kaflu = DRUGA para liczb (snapshot ekranu) ───
// Kafel: „Lv. 64 1082/1930 x 3023/3205 x 100/100” → para[0]=poziom/EXP,
// para[1]=HP, para[2]=trzecia para. textContent bez spacji zlewa
// poziom z EXP („641082/1930”) — HP musi brać ZAWSZE indeks 1.
console.log('7. parseTeamHpText() — druga para = HP (6 próbek snapshotu)');
const hp = PG.actions.parseTeamHpText;
eq(hp('Lv. 64 1082/1930 x 3023/3205 x 100/100'), { hp: 3023, max: 3205, ratio: 3023 / 3205 }, 'spacing: normalny');
eq(hp('Lv. 641082/1930x3023/3205x100/100x'), { hp: 3023, max: 3205, ratio: 3023 / 3205 }, 'bez spacji (textContent)');
eq(hp('Niezdolny Lv. 130 3910/3910 x 0/3050 x 100/100'), { hp: 0, max: 3050, ratio: 0 }, 'spacing: fainted');
eq(hp('NiezdolnyLv. 1303910/3910x0/3050x100/100x'), { hp: 0, max: 3050, ratio: 0 }, 'bez spacji: fainted');
eq(hp('Lv. 130 206/3910 x 1788/2233 x 48/100'), { hp: 1788, max: 2233, ratio: 1788 / 2233 }, 'spacing: 80% HP');
eq(hp('Lv. 130206/3910x1788/2233x48/100x'), { hp: 1788, max: 2233, ratio: 1788 / 2233 }, 'bez spacji: 80% HP');
eq(hp('Lv. 33 781/1000 x 1452/1452 x 100/100'), { hp: 1452, max: 1452, ratio: 1 }, 'spacing: pełne HP');
eq(hp('Ulecz wszystkie'), null, ' tekst bez par → null');
eq(hp('Lv. 64 1082/1930'), null, ' jedna para (bez HP) → null');
// Próg <50%: kwalifikuje fainted (0/3050) i wszystko poniżej połowy:
assert(hp('Niezdolny Lv. 130 3910/3910 x 0/3050 x 100/100').ratio * 100 < 50, ' 0/3050 < 50%');
assert(!(hp('Lv. 130 206/3910 x 1788/2233 x 48/100').ratio * 100 < 50), ' 1788/2233 ≥ 50%');
assert(!(hp('Lv. 64 1082/1930 x 3023/3205 x 100/100').ratio * 100 < 50), ' 3023/3205 ≥ 50%');

console.log('8. parseEvolveCount() / parseReserve() — liczniki szybkich akcji');
const { parseEvolveCount, parseReserve } = PG.actions;
eq(parseEvolveCount('38Ewoluuj wszystkie gotowe Pokemony'), 38, ' licznik ewolucji 38');
eq(parseEvolveCount('105Ewoluuj wszystkie gotowe Pokemony'), 105, ' licznik 3-cyfrowy');
eq(parseEvolveCount('Ewoluuj wszystkie gotowe Pokemony'), 0, ' brak liczby → 0');
eq(parseReserve('60/60Szybka sprzedaż pokemonów'), { current: 60, max: 60 }, ' rezerwa 60/60');
eq(parseReserve('43/60Szybka sprzedaż pokemonów'), { current: 43, max: 60 }, ' rezerwa 43/60');
eq(parseReserve('Szybka sprzedaż pokemonów'), null, ' bez licznika → null');
eq(PG.actions.dialogConfirmText('ap'), 'Regeneruj', ' dialog PA → „Regeneruj”');
eq(PG.actions.dialogConfirmText('evolve'), 'Ewoluuj wszystkie', ' dialog ewolucji');
eq(PG.actions.dialogConfirmText('sell'), 'Sprzedaj', ' dialog sprzedaży');
assert(
  parseReserve('60/60Szybka sprzedaż pokemonów').current
    >= parseReserve('60/60Szybka sprzedaż pokemonów').max,
  ' 60/60 = rezerwa pełna'
);
assert(
  !(parseReserve('43/60Szybka sprzedaż pokemonów').current
    >= parseReserve('43/60Szybka sprzedaż pokemonów').max),
  ' 43/60 = rezerwa niepełna'
);

// ── podsumowanie ────────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? '✅' : '❌'} Wszystkie testy: ${passed} OK, ${failures.length} błędów`);
process.exit(failures.length === 0 ? 0 : 1);
