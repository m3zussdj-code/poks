/**
 * 10-logger.js — lokalna telemetria.
 *
 * Ring buffer zdarzeń trzymany wyłącznie w pamięci przeglądarki.
 * Nic nie wychodzi na zewnątrz — użytkownik eksportuje log ręcznie
 * przyciskiem "📋 Kopiuj log" w panelu i wkleja agentowi.
 */

PG.logger = (() => {
  const buffer = [];
  const subscribers = []; // funkcje wywoływane przy każdym zdarzeniu
  const missSeen = new Map(); // throttling powtarzających się selector_miss

  /** Podstawowy zapis zdarzenia. */
  function push(event, data = {}) {
    const entry = { ts: new Date().toISOString(), event, ...data };
    buffer.push(entry);
    if (buffer.length > PG.config.logLimit) {
      buffer.splice(0, buffer.length - PG.config.logLimit);
    }
    if (PG.config.debugConsole) {
      try {
        console.log(`[PG ${pgTime()}]`, event, data);
      } catch (_) { /* console może być zablokowane */ }
    }
    for (const fn of subscribers) {
      try { fn(entry); } catch (_) { /* panel nie powinien łamać loggera */ }
    }
    return entry;
  }

  function subscribe(fn) {
    subscribers.push(fn);
  }

  function stateChange(from, to, reason) {
    return push('state_change', { from, to, reason: pgText(reason, 200) });
  }

  /**
   * Selektor nie trafił w DOM. Zapisujemy listę obecnych ról
   * data-pokeglory-integrity — to wystarczy agentowi, dobrać właściwy selektor.
   * Powtórzenia tego samego braku w ciągu missThrottleMs są liczone, nie logowane.
   */
  function selectorMiss(name, extra = {}) {
    const now = Date.now();
    const prev = missSeen.get(name);
    if (prev && now - prev.ts < PG.config.missThrottleMs) {
      prev.suppressed += 1;
      return null;
    }
    const suppressed = prev ? prev.suppressed : 0;
    missSeen.set(name, { ts: now, suppressed: 0 });

    let roles = [];
    try {
      roles = [...new Set(
        [...document.querySelectorAll('[data-pokeglory-integrity-role]')]
          .map((el) => el.getAttribute('data-pokeglory-integrity-role'))
      )];
    } catch (_) { /* brak document poza przeglądarką */ }

    return push('selector_miss', {
      name,
      suppressed,
      roles: roles.slice(0, 100),
      ...extra,
    });
  }

  function action(name, ok, extra = {}) {
    return push('action', { action: name, ok, ...extra });
  }

  /** Pełny eksport: konfiguracja, stan, historia, questy + wszystkie logi. */
  function exportPayload() {
    return {
      bot: { name: 'PokeGlory Edu Bot', version: PG.version },
      exportedAt: new Date().toISOString(),
      url: typeof location !== 'undefined' ? location.href : null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      config: { ...PG.config },
      state: PG.sm
        ? { state: PG.sm.state, paused: PG.sm.paused, reason: PG.sm.reason, history: PG.sm.history }
        : null,
      quests: PG.quest ? PG.quest.last : null,
      logs: [...buffer],
    };
  }

  function toJSON() {
    return JSON.stringify(exportPayload(), null, 2);
  }

  /** Kopiowanie do schowka z fallbackiem (bezpieczny kontekst vs. stary API). */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* spadamy do fallbacku */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  async function copyAll() {
    return copyToClipboard(toJSON());
  }

  function downloadAll() {
    const blob = new Blob([toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pg-bot-log-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function clear() {
    buffer.length = 0;
    missSeen.clear();
    push('log_cleared', {});
  }

  function all() {
    return [...buffer];
  }

  return {
    push, subscribe, stateChange, selectorMiss, action,
    exportPayload, toJSON, copyToClipboard, copyAll, downloadAll,
    clear, all,
  };
})();
