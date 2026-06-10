// ---------------------------------------------------------------------------
// Save slot — one checkpoint of run progress, persisted in localStorage. The
// Game writes it whenever a wave is cleared (before any armory spending, so
// a reload refunds purchases made since) and clears it on game over, so a
// reload can offer "continue at the armory before the current wave". Storage
// is injectable (and gracefully absent in headless tests or when the browser
// blocks it) — every operation is a safe no-op without it.
// ---------------------------------------------------------------------------

const KEY = 'ciws-command-save';
export const SAVE_VERSION = 1;

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

export class SaveSlot {
  constructor(storage = defaultStorage()) {
    this.storage = storage;
  }

  /**
   * The saved checkpoint, or null if there is none (or it is unreadable /
   * from an incompatible version — anything suspect is treated as absent).
   */
  load() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      const valid =
        s &&
        typeof s === 'object' &&
        s.v === SAVE_VERSION &&
        Number.isInteger(s.wave) &&
        s.wave >= 1 &&
        Number.isFinite(s.score) &&
        Number.isFinite(s.credits) &&
        Array.isArray(s.cities) &&
        Array.isArray(s.turrets);
      return valid ? s : null;
    } catch (e) {
      return null;
    }
  }

  /** Persist a checkpoint (the caller builds the snapshot object). */
  save(snapshot) {
    if (!this.storage) return;
    try {
      this.storage.setItem(KEY, JSON.stringify(snapshot));
    } catch (e) {
      // quota / blocked — the run just won't survive a reload
    }
  }

  /** Drop the checkpoint (game over, or the player chose a fresh start). */
  clear() {
    if (!this.storage) return;
    try {
      this.storage.removeItem(KEY);
    } catch (e) {
      // ignore — worst case a stale save lingers
    }
  }
}

export const saveSlot = new SaveSlot();
