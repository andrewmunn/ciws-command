// ---------------------------------------------------------------------------
// Local high-score table, persisted in localStorage. Storage is injectable
// (and gracefully absent in headless tests or when the browser blocks it) —
// every operation is a safe no-op without it.
//
// Scores are stamped with the BALANCE_VERSION they were earned under. A
// rebalance bumps the version, which HIDES every older entry — scores from a
// different balance aren't comparable — without deleting them: stale entries
// stay in storage untouched, so reverting a rebalance brings them back.
// ---------------------------------------------------------------------------

const KEY = 'ciws-command-highscores';
export const MAX_SCORES = 10;

// Bump this whenever a balance change invalidates score comparability
// (weapon/enemy stats, economy, wave pacing...). Entries from the
// pre-versioning era count as version 1.
//   v2 — F-16 airstrike, MIRV nuke, laser buff, twin-barrel removal.
//   v3 — armory repricing: laser 85->30, interceptor 12->30, strike 60->30.
export const BALANCE_VERSION = 3;

function defaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch (e) {
    // storage blocked (private mode / permissions) — run without persistence
  }
  return null;
}

/** The balance version an entry was earned under (unstamped = era 1). */
function entryVersion(e) {
  return e && Number.isFinite(e.v) ? e.v : 1;
}

export class ScoreBoard {
  constructor(storage = defaultStorage()) {
    this.storage = storage;
  }

  /** Every stored entry, current balance or not (internal). */
  _loadAll() {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  /** Current-balance entries, best first: [{v, score, wave, date}]. */
  load() {
    return this._loadAll()
      .filter((e) => entryVersion(e) === BALANCE_VERSION)
      .sort((a, b) => b.score - a.score || b.wave - a.wave);
  }

  /**
   * Record a finished run. Returns { scores, rank } where rank is the new
   * entry's position in the current-balance table (0 = best ever) or -1 if
   * it didn't place. Hidden entries from other balance versions ride along
   * in storage untouched.
   */
  add(score, wave) {
    const entry = {
      v: BALANCE_VERSION,
      score,
      wave,
      date: new Date().toISOString().slice(0, 10),
    };
    const all = this._loadAll();
    all.push(entry);
    const current = all
      .filter((e) => entryVersion(e) === BALANCE_VERSION)
      .sort((a, b) => b.score - a.score || b.wave - a.wave);
    const rank = current.indexOf(entry);
    const scores = current.slice(0, MAX_SCORES);
    if (this.storage) {
      try {
        // Persist the trimmed current table plus every other-version entry.
        const keep = new Set(scores);
        this.storage.setItem(
          KEY,
          JSON.stringify(
            all.filter((e) => entryVersion(e) !== BALANCE_VERSION || keep.has(e))
          )
        );
      } catch (e) {
        // quota / blocked — the table just won't persist
      }
    }
    return { scores, rank: rank < MAX_SCORES ? rank : -1 };
  }
}

export const scoreboard = new ScoreBoard();
