import { describe, it, expect } from 'bun:test';
import { ScoreBoard, MAX_SCORES, BALANCE_VERSION } from '../js/scores.js';

/** Minimal in-memory localStorage stand-in. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

describe('ScoreBoard', () => {
  it('records runs sorted best-first and reports the new rank', () => {
    const sb = new ScoreBoard(fakeStorage());
    expect(sb.load()).toEqual([]);
    expect(sb.add(100, 3).rank).toBe(0);
    expect(sb.add(50, 2).rank).toBe(1);
    const r = sb.add(200, 5);
    expect(r.rank).toBe(0);
    expect(r.scores.map((s) => s.score)).toEqual([200, 100, 50]);
    expect(sb.load()[0].wave).toBe(5);
  });

  it('keeps only the top entries and ranks off-table runs as -1', () => {
    const sb = new ScoreBoard(fakeStorage());
    for (let i = 1; i <= MAX_SCORES; i++) sb.add(i * 100, i);
    expect(sb.load()).toHaveLength(MAX_SCORES);
    const dud = sb.add(1, 1); // worse than everything on a full table
    expect(dud.rank).toBe(-1);
    expect(sb.load()).toHaveLength(MAX_SCORES);
    expect(sb.load()[MAX_SCORES - 1].score).toBe(100);
  });

  it('is a safe no-op without storage (headless / blocked)', () => {
    const sb = new ScoreBoard(null);
    expect(sb.load()).toEqual([]);
    const r = sb.add(500, 4);
    expect(r.rank).toBe(0); // still ranks the in-memory result
    expect(sb.load()).toEqual([]); // nothing persisted
  });

  it('hides scores from older balance versions (rebalance = fresh table)', () => {
    const storage = fakeStorage();
    // A table from before the rebalance: one pre-versioning entry (no `v`)
    // and one explicitly stamped with an older version.
    storage.setItem(
      'ciws-command-highscores',
      JSON.stringify([
        { score: 9000, wave: 12, date: '2026-01-01' }, // unstamped era-1
        { v: BALANCE_VERSION - 1, score: 7000, wave: 10, date: '2026-03-01' },
      ])
    );
    const sb = new ScoreBoard(storage);
    expect(sb.load()).toEqual([]); // the old champions are hidden

    // A new run ranks against the EMPTY current-version table, not the
    // hidden 9000 — it's the best of the new balance.
    const r = sb.add(300, 4);
    expect(r.rank).toBe(0);
    expect(r.scores.map((s) => s.score)).toEqual([300]);
    expect(sb.load().map((s) => s.score)).toEqual([300]);
  });

  it('keeps hidden entries in storage — a version revert would restore them', () => {
    const storage = fakeStorage();
    const stale = { v: BALANCE_VERSION - 1, score: 7000, wave: 10, date: '2026-03-01' };
    storage.setItem('ciws-command-highscores', JSON.stringify([stale]));
    const sb = new ScoreBoard(storage);
    sb.add(300, 4); // persisting the new table must not delete the stale entry
    const all = JSON.parse(storage.getItem('ciws-command-highscores'));
    expect(all).toContainEqual(stale);
    expect(all.find((e) => e.score === 300).v).toBe(BALANCE_VERSION);
  });

  it('trims only the current-version table at the cap', () => {
    const storage = fakeStorage();
    const stale = { v: BALANCE_VERSION - 1, score: 7000, wave: 10, date: '2026-03-01' };
    storage.setItem('ciws-command-highscores', JSON.stringify([stale]));
    const sb = new ScoreBoard(storage);
    for (let i = 1; i <= MAX_SCORES + 3; i++) sb.add(i * 100, i);
    expect(sb.load()).toHaveLength(MAX_SCORES);
    const all = JSON.parse(storage.getItem('ciws-command-highscores'));
    expect(all).toHaveLength(MAX_SCORES + 1); // cap + the untouched stale entry
    expect(all).toContainEqual(stale);
  });
});
