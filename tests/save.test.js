import { describe, it, expect } from 'bun:test';
import { SaveSlot, SAVE_VERSION } from '../js/save.js';
import { CONFIG } from '../js/config.js';
import { newGame, withRandom } from './helpers.js';

/** Minimal in-memory localStorage stand-in. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** A headless game wired to an in-memory save slot. */
function newSavingGame(storage = fakeStorage()) {
  const game = newGame();
  game.saveSlot = new SaveSlot(storage);
  game.savedRun = game.saveSlot.load();
  return game;
}

/** Play a wave out: clear the spawn budget and let endWave run. */
function clearWave(game) {
  game.toSpawn = 0;
  game.missiles = [];
  game.pendingNukes = [];
  game.endWave();
}

describe('SaveSlot', () => {
  it('round-trips a snapshot and clears it', () => {
    const slot = new SaveSlot(fakeStorage());
    expect(slot.load()).toBeNull();
    const snap = { v: SAVE_VERSION, wave: 3, score: 10, credits: 4, cities: [], turrets: [] };
    slot.save(snap);
    expect(slot.load()).toEqual(snap);
    slot.clear();
    expect(slot.load()).toBeNull();
  });

  it('treats corrupt or alien payloads as absent', () => {
    const storage = fakeStorage();
    const slot = new SaveSlot(storage);
    const bad = [
      'not json',
      '42',
      'null',
      '[]',
      '{"v":99,"wave":3}', // future/foreign version
      '{"v":1,"wave":0}', // wave below 1
      '{"v":1,"wave":2.5,"score":0,"credits":0,"cities":[],"turrets":[]}', // fractional wave
      '{"v":1,"wave":3,"score":"lots","credits":0,"cities":[],"turrets":[]}', // NaN score
      '{"v":1,"wave":3,"score":0,"credits":0,"turrets":[]}', // missing cities
      '{"v":1,"wave":3,"score":0,"credits":0,"cities":{},"turrets":[]}', // cities not an array
    ];
    for (const raw of bad) {
      storage.setItem('ciws-command-save', raw);
      expect(slot.load()).toBeNull();
    }
  });

  it('is a safe no-op without storage (headless / blocked)', () => {
    const slot = new SaveSlot(null);
    expect(slot.load()).toBeNull();
    slot.save({ v: SAVE_VERSION, wave: 2 });
    slot.clear();
    expect(slot.load()).toBeNull();
  });

  it('swallows storage that throws (quota exceeded / access blocked)', () => {
    const boom = () => {
      throw new Error('blocked');
    };
    const slot = new SaveSlot({ getItem: boom, setItem: boom, removeItem: boom });
    expect(slot.load()).toBeNull();
    expect(() => slot.save({ v: SAVE_VERSION, wave: 2 })).not.toThrow();
    expect(() => slot.clear()).not.toThrow();
  });
});

describe('Game checkpointing', () => {
  it('checkpoints on wave clear — reloading from the armory resumes the run', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    game.score = 500;
    game.credits = 7;
    game.laser.buy();
    game.ciws.upgradeTwin();
    game.cities[1].alive = false;
    game.cities[1].destroyedWave = 1;
    clearWave(game); // the save lands here — before NEXT WAVE is ever clicked
    expect(game.state).toBe('intermission');

    // A second Game over the same storage = a page reload at the armory.
    const reborn = newSavingGame(storage);
    expect(reborn.savedRun.wave).toBe(2);
    reborn.continueGame();
    // The run resumes at the armory before the saved wave, summary intact.
    expect(reborn.state).toBe('intermission');
    expect(reborn.nextWave).toBe(2);
    expect(reborn.waveEarned).toBe(game.waveEarned);
    expect(reborn.waveBreakdown).toEqual(game.waveBreakdown);
    expect(reborn.score).toBe(game.score);
    expect(reborn.credits).toBe(game.credits);
    expect(reborn.laser.owned).toBe(true);
    expect(reborn.ciws.twin).toBe(true);
    expect(reborn.cities[1].alive).toBe(false);
    expect(reborn.cities[1].destroyedWave).toBe(1);
    expect(reborn.cities[0].alive).toBe(true);

    reborn.proceedToNextWave();
    expect(reborn.state).toBe('playing');
    expect(reborn.wave).toBe(2);
  });

  it('the checkpoint predates armory spending — a reload refunds purchases', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    game.credits = 50;
    clearWave(game); // the only save: credits intact, nothing bought yet
    const saved = game.saveSlot.load();

    // Shop, then deploy — neither writes a new checkpoint.
    game.buyItem(game.getShopItems()[0]); // interceptor battery
    expect(game.interceptorWeapon.owned).toBe(true);
    game.proceedToNextWave();
    expect(game.saveSlot.load()).toEqual(saved);

    // A reload rolls the purchase back but refunds every credit it cost, so
    // nothing is lost — the player just shops again on the resumed screen.
    const reborn = newSavingGame(storage);
    reborn.continueGame();
    expect(reborn.interceptorWeapon.owned).toBe(false);
    expect(reborn.credits).toBe(saved.credits);
    expect(reborn.nextWave).toBe(2);

    // The next wave clear banks the re-made purchases as live state.
    reborn.buyItem(reborn.getShopItems()[0]);
    reborn.proceedToNextWave();
    clearWave(reborn);
    expect(reborn.saveSlot.load().interceptor.owned).toBe(true);
  });

  it('saves the armory reroll, so a reload shows the same withheld stock', () => {
    const orig = CONFIG.shop.dropPerWave;
    CONFIG.shop.dropPerWave = 2;
    try {
      const storage = fakeStorage();
      const game = newSavingGame(storage);
      game.startGame();
      withRandom(0.3, () => clearWave(game)); // rolls the drop, then checkpoints it
      expect(game.shopDropped).toHaveLength(2);

      // Reloading must replay the saved offer rather than re-rolling a new one,
      // so a player can't reroll the shop by closing and reopening the tab.
      const reborn = newSavingGame(storage);
      reborn.continueGame();
      expect(reborn.shopDropped).toEqual(game.shopDropped);
      expect(reborn.getShopItems().map((i) => i.key)).toEqual(
        game.getShopItems().map((i) => i.key)
      );
    } finally {
      CONFIG.shop.dropPerWave = orig;
    }
  });

  it('round-trips every upgrade ladder, not just ownership flags', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    game.ciws.upgradeFireRate();
    game.ciws.upgradeFireRate();
    game.ciws.upgradeTwin();
    game.interceptorWeapon.buy();
    game.interceptorWeapon.upgradeCooldown();
    game.interceptorWeapon.upgradeCooldown();
    game.interceptorWeapon.upgradeCooldown();
    game.laser.buy();
    game.laser.upgradeRecharge();
    game.buyGunShield();
    clearWave(game);
    game.proceedToNextWave();

    const reborn = newSavingGame(storage);
    reborn.continueGame();
    expect(reborn.ciws.fireRateLevel).toBe(2);
    expect(reborn.ciws.twin).toBe(true);
    expect(reborn.interceptorWeapon.owned).toBe(true);
    expect(reborn.interceptorWeapon.cooldownLevel).toBe(3);
    expect(reborn.laser.owned).toBe(true);
    expect(reborn.laser.level).toBe(1);
    expect(reborn.shieldLevel).toBe(1);
  });

  it('checkpoints the upcoming wave and overwrites it as the run advances', () => {
    const game = newSavingGame();
    game.startGame();
    clearWave(game);
    expect(game.saveSlot.load().wave).toBe(2); // saved before proceeding
    game.proceedToNextWave();
    expect(game.saveSlot.load().wave).toBe(2);
    clearWave(game);
    expect(game.saveSlot.load().wave).toBe(3);
  });

  it('mid-wave progress is not checkpointed — a reload rolls back to the wave start', () => {
    const game = newSavingGame();
    game.startGame();
    game.credits = 10;
    game.score = 100;
    clearWave(game); // end-of-wave bonuses land on top of the 10
    game.proceedToNextWave();
    const atWaveStart = game.saveSlot.load();
    expect(atWaveStart.credits).toBe(game.credits);

    // Earnings and losses during wave 2 must not touch the stored snapshot.
    game.earnCredits(5);
    game.score += 50;
    game.cities[0].alive = false;
    expect(game.saveSlot.load()).toEqual(atWaveStart);
  });

  it('a continued wave is set up exactly like a freshly started one', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    game.interceptorWeapon.buy();
    game.laser.buy();
    clearWave(game);
    game.proceedToNextWave();
    expect(game.wave).toBe(2);

    const reborn = newSavingGame(storage);
    reborn.continueGame();
    reborn.proceedToNextWave();
    // Same spawn budget/cadence as the live game got when it entered wave 2,
    // and the autonomous weapons come back ready, per the wave-start rules.
    expect(reborn.toSpawn).toBe(game.waveSpawnTotal);
    expect(reborn.spawnGap).toBe(game.spawnGap);
    expect(reborn.interceptorWeapon.canLaunch).toBe(true);
    expect(reborn.laser.canFire).toBe(true);
    expect(reborn.turrets[0].ammo).toBe(reborn.ciws.ammoCapacity);
    expect(reborn.waveEarned).toBe(0);
  });

  it('continueGame without a checkpoint falls back to a fresh game', () => {
    const game = newSavingGame();
    expect(game.savedRun).toBeNull();
    game.continueGame();
    expect(game.state).toBe('playing');
    expect(game.wave).toBe(1);
    expect(game.score).toBe(0);
    expect(game.credits).toBe(CONFIG.economy.startCredits);
  });

  it('restores shield levels onto the gun', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    game.buyGunShield();
    game.buyGunShield();
    clearWave(game);
    game.proceedToNextWave();

    const reborn = newSavingGame(storage);
    reborn.continueGame();
    expect(reborn.shieldLevel).toBe(2);
    expect(reborn.turrets[0].shieldMax).toBe(CONFIG.shield.maxPerStructure);
    expect(reborn.turrets[0].shields).toBe(CONFIG.shield.maxPerStructure);
  });

  it('clamps doctored upgrade levels to the config tables', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    clearWave(game);
    game.proceedToNextWave();
    const snap = game.saveSlot.load();
    snap.laser = { owned: true, level: 99 };
    snap.interceptor = { owned: true, cooldownLevel: -5 };
    snap.ciws = { fireRateLevel: 99, twin: 1 };
    snap.shieldLevel = 99;
    game.saveSlot.save(snap);

    const reborn = newSavingGame(storage);
    reborn.continueGame();
    expect(reborn.laser.level).toBe(CONFIG.laser.cooldowns.length - 1);
    expect(reborn.interceptorWeapon.cooldownLevel).toBe(0);
    expect(reborn.ciws.fireRateLevel).toBe(CONFIG.shop.fireRateCosts.length);
    expect(reborn.ciws.twin).toBe(true); // truthy junk coerces to a real bool
    expect(reborn.shieldLevel).toBe(CONFIG.shield.costs.length);
    expect(Number.isFinite(reborn.laser.rechargeTime)).toBe(true);
    expect(Number.isFinite(reborn.ciws.fireInterval)).toBe(true);
  });

  it('a sparse snapshot (older save shape) resumes with safe defaults', () => {
    const storage = fakeStorage();
    const slot = new SaveSlot(storage);
    // Valid per load(), but missing the weapon objects and armory summary —
    // the shape a future field rename or an older version could leave behind.
    slot.save({ v: 1, wave: 3, score: 50, credits: 9, cities: [], turrets: [] });

    const game = newSavingGame(storage);
    game.continueGame();
    expect(game.state).toBe('intermission');
    expect(game.nextWave).toBe(3);
    expect(game.score).toBe(50);
    expect(game.credits).toBe(9);
    expect(game.interceptorWeapon.owned).toBe(false);
    expect(game.laser.owned).toBe(false);
    expect(game.ciws.fireRateLevel).toBe(0);
    expect(game.shieldLevel).toBe(0);
    expect(game.waveEarned).toBe(0);
    expect(game.waveBreakdown).toBeNull();
    game.proceedToNextWave();
    expect(game.state).toBe('playing');
    expect(game.wave).toBe(3);
  });

  it('tolerates a structure-count mismatch with the current config', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    clearWave(game);

    // A save from a hypothetical layout with MORE cities than today's config:
    // extras are ignored, matching indices still restore.
    const snap = game.saveSlot.load();
    const cityCount = game.cities.length;
    snap.cities = Array.from({ length: cityCount + 4 }, () => ({
      alive: false,
      destroyedWave: 1,
    }));
    game.saveSlot.save(snap);
    const reborn = newSavingGame(storage);
    expect(() => reborn.continueGame()).not.toThrow();
    expect(reborn.cities).toHaveLength(cityCount);
    expect(reborn.cities.every((c) => !c.alive)).toBe(true);

    // And with FEWER: only the matching prefix is touched.
    snap.cities = [{ alive: false, destroyedWave: 1 }];
    game.saveSlot.save(snap);
    const reborn2 = newSavingGame(storage);
    expect(() => reborn2.continueGame()).not.toThrow();
    expect(reborn2.cities[0].alive).toBe(false);
    expect(reborn2.cities.slice(1).every((c) => c.alive)).toBe(true);
  });

  it('a resumed run banks its restored score on death and clears the save', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    game.score = 700;
    clearWave(game);

    const reborn = newSavingGame(storage);
    reborn.continueGame();
    reborn.proceedToNextWave();
    reborn.gameOver();
    // The restored score reaches the high-score table at the saved wave...
    expect(reborn.lastRun.scores[reborn.lastRun.rank].score).toBe(reborn.score);
    expect(reborn.score).toBeGreaterThanOrEqual(700);
    expect(reborn.lastRun.scores[reborn.lastRun.rank].wave).toBe(2);
    // ...and the checkpoint dies with the run.
    expect(reborn.saveSlot.load()).toBeNull();
    expect(reborn.savedRun).toBeNull();
  });

  it('game over deletes the checkpoint — defeat is final', () => {
    const game = newSavingGame();
    game.startGame();
    clearWave(game);
    game.proceedToNextWave();
    expect(game.saveSlot.load()).not.toBeNull();
    game.gameOver();
    expect(game.saveSlot.load()).toBeNull();
    expect(game.savedRun).toBeNull();
  });

  it('starting a new game forfeits the checkpoint', () => {
    const game = newSavingGame();
    game.startGame();
    clearWave(game);
    game.proceedToNextWave();
    expect(game.saveSlot.load()).not.toBeNull();
    game.startGame();
    expect(game.saveSlot.load()).toBeNull();
  });

  it('doctored runs neither write nor wipe the checkpoint', () => {
    const game = newSavingGame();
    game.startGame();
    clearWave(game);
    game.proceedToNextWave();
    const saved = game.saveSlot.load();
    expect(saved).not.toBeNull();

    game.devInvincible = true;
    clearWave(game);
    game.proceedToNextWave();
    expect(game.saveSlot.load()).toEqual(saved); // no overwrite
    game.gameOver();
    expect(game.saveSlot.load()).toEqual(saved); // no wipe

    // Entering a sandbox keeps the real run resumable too — both the stored
    // checkpoint and the in-session menu offer must survive.
    game.devInvincible = false;
    game.savedRun = game.saveSlot.load();
    game.startSandbox({ key: 'rain', type: 'normal', maxLive: 6, gap: 1 });
    expect(game.saveSlot.load()).toEqual(saved);
    expect(game.savedRun).toEqual(saved);

    // Leave the sandbox the way the dev menu does, then resume with space.
    game.devScenario = null;
    game.state = 'menu';
    game.handleKey(' ');
    expect(game.state).toBe('intermission');
    expect(game.nextWave).toBe(saved.wave);
    expect(game.devScenario).toBeNull();
    game.proceedToNextWave();
    expect(game.state).toBe('playing');
    expect(game.wave).toBe(saved.wave);
  });

  it('menu clicks resolve the continue / new-game choice explicitly', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    clearWave(game);
    game.proceedToNextWave();

    const resumer = newSavingGame(storage);
    const { continueRect, newRect } = resumer.menuLayout();
    // A stray click outside both buttons must not start anything.
    resumer.handleMenuClick(0, 0);
    expect(resumer.state).toBe('menu');
    // Clicking CONTINUE resumes at the armory before the saved wave (so the
    // purchase step is never skipped) and keeps the checkpoint.
    resumer.handleMenuClick(continueRect.x + 5, continueRect.y + 5);
    expect(resumer.state).toBe('intermission');
    expect(resumer.nextWave).toBe(2);
    expect(resumer.saveSlot.load()).not.toBeNull();

    // Clicking NEW GAME deploys fresh and forfeits the checkpoint.
    const restarter = newSavingGame(storage);
    restarter.handleMenuClick(newRect.x + 5, newRect.y + 5);
    expect(restarter.state).toBe('playing');
    expect(restarter.wave).toBe(1);
    expect(restarter.saveSlot.load()).toBeNull();

    // And with no save, the same rects aren't offered — continueRect would
    // have resumed; instead any click deploys fresh.
    const fresh = newSavingGame();
    fresh.handleMenuClick(continueRect.x + 5, continueRect.y + 5);
    expect(fresh.state).toBe('playing');
    expect(fresh.wave).toBe(1);
  });

  it('renders the menu with the continue / new-game buttons without throwing', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    clearWave(game);
    game.proceedToNextWave();

    const reborn = newSavingGame(storage);
    expect(reborn.state).toBe('menu');
    expect(() => reborn.render()).not.toThrow();

    // And the resumed armory screen (restored credit summary) renders too.
    reborn.continueGame();
    reborn.pointerX = 0; // park the pointer off the shop rows — the fake 2D
    reborn.pointerY = 0; // ctx can't service the hover tooltip's measureText
    expect(reborn.state).toBe('intermission');
    expect(() => reborn.render()).not.toThrow();
  });

  it('a reload shortcut (Cmd/Ctrl+R) is not the restart key', () => {
    const game = newSavingGame();
    game.startGame();
    clearWave(game);
    const saved = game.saveSlot.load();
    expect(saved).not.toBeNull();

    // Cmd+R / Ctrl+R land as an 'r' keydown just before the page unloads —
    // they must not trigger the in-game restart (which wipes the checkpoint).
    game.handleKey('r', { metaKey: true });
    game.handleKey('r', { ctrlKey: true });
    expect(game.state).toBe('intermission');
    expect(game.saveSlot.load()).toEqual(saved);

    // A bare R is still the restart key, and restarting forfeits the save.
    game.handleKey('r');
    expect(game.state).toBe('playing');
    expect(game.wave).toBe(1);
    expect(game.saveSlot.load()).toBeNull();
  });

  it('space on the menu resumes the checkpoint', () => {
    const storage = fakeStorage();
    const game = newSavingGame(storage);
    game.startGame();
    clearWave(game);
    game.proceedToNextWave();

    const reborn = newSavingGame(storage);
    reborn.handleKey(' '); // resume to the armory...
    expect(reborn.state).toBe('intermission');
    expect(reborn.nextWave).toBe(2);
    reborn.handleKey(' '); // ...and space again deploys into the wave
    expect(reborn.state).toBe('playing');
    expect(reborn.wave).toBe(2);
  });
});
