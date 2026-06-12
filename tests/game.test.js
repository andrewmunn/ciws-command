import { describe, it, expect } from 'bun:test';
import { newGame, withRandom } from './helpers.js';
import { EnemyMissile, Bullet } from '../js/entities.js';
import { CONFIG } from '../js/config.js';
import { STRINGS } from '../js/strings.js';

// Shop rows are located by their STRINGS label, so copy edits never break tests.
const SL = STRINGS.shop.items;

describe('Game setup', () => {
  it('starts on the menu with a laid-out board', () => {
    const g = newGame();
    expect(g.state).toBe('menu');
    expect(g.cities).toHaveLength(CONFIG.cityCount);
    expect(g.turrets).toHaveLength(CONFIG.turretCount);
    expect(g.W).toBe(CONFIG.world.width); // fixed sim resolution
    expect(g.H).toBe(CONFIG.world.height);
  });

  it('places the single gun near the centre', () => {
    const g = newGame();
    expect(g.turrets).toHaveLength(1);
    expect(Math.abs(g.turrets[0].x - g.W / 2)).toBeLessThan(g.W * 0.12);
  });

  it('startGame resets economy/weapons and begins wave 1', () => {
    const g = newGame();
    g.startGame();
    expect(g.state).toBe('playing');
    expect(g.wave).toBe(1);
    expect(g.score).toBe(0);
    expect(g.credits).toBe(CONFIG.economy.startCredits);
    expect(g.interceptorWeapon.owned).toBe(false); // a shop purchase now
    expect(g.laser.owned).toBe(false);
    expect(g.toSpawn).toBe(CONFIG.wave.baseMissiles);
  });
});

describe('Wave flow', () => {
  it('startWave scales the missile count, reloads guns, clears ordnance', () => {
    const g = newGame();
    g.startGame();
    g.bullets = [1, 2, 3];
    g.interceptorList = [1];
    g.interceptorWeapon.timer = 99; // mid-reload from last wave
    g.startWave(4);
    expect(g.wave).toBe(4);
    expect(g.toSpawn).toBe(
      CONFIG.wave.baseMissiles + 3 * CONFIG.wave.missilesPerWave
    );
    expect(g.bullets).toHaveLength(0);
    expect(g.interceptorList).toHaveLength(0);
    expect(g.interceptorWeapon.timer).toBe(0); // pod comes back loaded
    expect(g.waveLeaks).toBe(0);
  });

  it('a cleared wave (no spawns left, sky empty) goes to the shop after a beat', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    // It holds for a short grace beat, then clears.
    g.update(1 / 60);
    expect(g.state).toBe('playing');
    g.update(CONFIG.wave.endDelay);
    expect(g.state).toBe('intermission');
  });

  it('a fresh missile during the end beat keeps the wave going', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    g.update(CONFIG.wave.endDelay * 0.6); // partway through the beat
    g.missiles = [{ dead: false, update: () => null, x: 100, y: 10 }];
    g.update(1 / 60); // timer resets while a threat is up
    expect(g.state).toBe('playing');
    expect(g.waveEndTimer).toBe(0);
  });

  it('proceedToNextWave starts the next wave with the pod loaded', () => {
    const g = newGame();
    g.startGame();
    g.endWave();
    g.interceptorWeapon.timer = 99; // mid-reload at wave end
    g.proceedToNextWave();
    expect(g.state).toBe('playing');
    expect(g.wave).toBe(2);
    expect(g.interceptorWeapon.timer).toBe(0); // loaded and ready
  });
});

describe('Loss conditions', () => {
  it('losing every city ends the game', () => {
    const g = newGame();
    g.startGame();
    g.cities.forEach((c) => (c.alive = false));
    g.toSpawn = 0;
    g.missiles = [];
    g.update(1 / 60);
    expect(g.state).toBe('gameover');
    expect(g.lossReason).toBe('Cities lost');
  });

  it('a hit on the gun is an instant loss', () => {
    const g = newGame();
    g.startGame();
    g.turrets[0].alive = false; // a warhead destroyed the central gun
    g.toSpawn = 0;
    g.missiles = [];
    g.update(1 / 60);
    expect(g.state).toBe('gameover');
    expect(g.lossReason).toBe('Gun destroyed');
  });
});

describe('Threat selection (chooseThreat)', () => {
  it('gates variants by wave', () => {
    const g = newGame();
    withRandom(0, () => {
      g.wave = 1;
      expect(g.chooseThreat()).toEqual({ type: 'normal', children: 0 });
    });
    withRandom(0, () => {
      g.wave = 2;
      expect(g.chooseThreat().type).toBe('drone'); // first roll unlocked at 2
    });
    withRandom(0, () => {
      g.wave = 3;
      expect(g.chooseThreat().type).toBe('cruise'); // outranks drone once unlocked
    });
    withRandom([0.5, 0.5, 0], () => {
      g.wave = 4; // cruise/drone miss; bomber unlocks at 4, outranks hypersonic
      expect(g.chooseThreat().type).toBe('bomber');
    });
    withRandom([0.5, 0.5, 0.5, 0], () => {
      g.wave = 4; // cruise/drone/bomber miss (0.5s), hypersonic (0) hits
      expect(g.chooseThreat().type).toBe('hypersonic');
    });
    withRandom(0, () => {
      g.wave = CONFIG.missile.nuke.fromWave;
      g.nukesSpawned = 0;
      g.waveSpawnTotal = 20;
      g.toSpawn = 10; // mid-wave: not the first or last spawn
      expect(g.chooseThreat().type).toBe('nuke'); // top of the precedence order
    });
  });

  it('high rolls produce a plain missile', () => {
    const g = newGame();
    withRandom(0.99, () => {
      g.wave = 6;
      expect(g.chooseThreat()).toEqual({ type: 'normal', children: 0 });
    });
  });

  it('produces a MIRV carrier when evasive misses but split hits', () => {
    const g = newGame();
    withRandom([0.5, 0.5, 0.5, 0.0], () => {
      g.wave = 3; // cruise/drone/evasive skipped (0.5s), split hits (0.0)
      const r = g.chooseThreat();
      expect(r.type).toBe('normal');
      expect(r.children).toBeGreaterThanOrEqual(CONFIG.missile.splitChildren[0]);
    });
  });
});

describe('Spawning', () => {
  it('spawns within the field and respects wave gating', () => {
    const g = newGame();
    g.startGame();

    g.wave = 1;
    g.missiles = [];
    for (let i = 0; i < 200; i++) g.spawnMissile();
    expect(g.missiles.every((m) => m.startX >= 20 && m.startX <= g.W - 20)).toBe(true);
    expect(g.missiles.every((m) => m.type === 'normal' && m.childCount === 0)).toBe(true);

    g.wave = 2;
    g.missiles = [];
    for (let i = 0; i < 200; i++) g.spawnMissile();
    expect(g.missiles.every((m) => m.type !== 'hypersonic' && m.childCount === 0)).toBe(true);

    g.wave = 3;
    g.missiles = [];
    for (let i = 0; i < 200; i++) g.spawnMissile();
    expect(g.missiles.every((m) => m.type !== 'hypersonic')).toBe(true);
  });

  it('forces a hypersonic with low rolls at wave 4', () => {
    const g = newGame();
    g.startGame();
    withRandom([0.5, 0.5, 0.5, 0], () => {
      g.wave = 4; // cruise/drone/bomber miss, hypersonic hits
      g.missiles = [];
      g.spawnMissile();
    });
    const m = g.missiles[g.missiles.length - 1];
    expect(m.type).toBe('hypersonic');
    expect(m.dragMul).toBe(CONFIG.missile.hypersonic.dragFactor);
  });
});

describe('Bounties', () => {
  it('pays per threat type, with the MIRV bounty only before it splits', () => {
    const g = newGame();
    const b = CONFIG.economy.bounty;
    expect(g.missileBounty({ type: 'normal', splitsRemaining: 0 })).toBe(b.normal);
    expect(g.missileBounty({ type: 'evasive', splitsRemaining: 0 })).toBe(b.evasive);
    expect(g.missileBounty({ type: 'hypersonic', splitsRemaining: 0 })).toBe(b.hypersonic);
    expect(g.missileBounty({ type: 'normal', splitsRemaining: 3 })).toBe(b.mirv);
    expect(g.missileBounty({ type: 'normal', splitsRemaining: 0 })).toBe(b.normal);
  });
});

describe('CIWS collisions', () => {
  it('one bullet kills a 1-HP missile, awarding score and credits', () => {
    const g = newGame();
    g.startGame();
    const credits0 = g.credits;
    const score0 = g.score;
    const m = new EnemyMissile(700, 300, 700, g.groundY, 150, 0, g.groundY, 'normal');
    g.missiles = [m];
    g.bullets = [new Bullet(700, 300, 0)];
    g.checkCollisions();
    expect(m.dead).toBe(true);
    expect(g.bullets[0].dead).toBe(true);
    expect(g.score - score0).toBe(CONFIG.score.perKill);
    expect(g.credits - credits0).toBe(CONFIG.economy.bounty.normal);
  });

  it('a MIRV carrier takes three hits; only the kill scores', () => {
    const g = newGame();
    g.startGame();
    const credits0 = g.credits;
    const m = new EnemyMissile(700, 300, 700, g.groundY, 150, 3, g.groundY, 'normal');
    g.missiles = [m];
    for (let hit = 1; hit <= 3; hit++) {
      g.bullets = [new Bullet(700, 300, 0)];
      g.checkCollisions();
      if (hit < 3) {
        expect(m.dead).toBe(false);
        expect(m.hp).toBe(3 - hit);
        expect(m.hitFlash).toBeGreaterThan(0);
        expect(g.credits).toBe(credits0); // no bounty for a non-kill
      }
    }
    expect(m.dead).toBe(true);
    expect(g.credits - credits0).toBe(CONFIG.economy.bounty.mirv);
  });
});

describe('Ground impact', () => {
  it('destroys structures in the blast and counts as a leak', () => {
    const g = newGame();
    g.startGame();
    const city = g.cities[0];
    const leaks0 = g.waveLeaks;
    g.impact({ x: city.x, y: g.groundY });
    expect(city.alive).toBe(false);
    expect(g.waveLeaks).toBe(leaks0 + 1);
  });

  it('spares structures outside the blast radius', () => {
    const g = newGame();
    g.startGame();
    const far = g.cities[g.cities.length - 1];
    // Land outboard of the rightmost city, past its footprint + blast reach.
    g.impact({
      x: far.x + far.width / 2 + CONFIG.missile.blastRadius + 10,
      y: g.groundY,
    });
    expect(far.alive).toBe(true);
  });
});

describe('MIRV split spawning', () => {
  it('spawns the carrier\'s children as plain RVs', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    const parent = new EnemyMissile(700, 300, 700, g.groundY, 150, 3, g.groundY, 'normal');
    g.splitMissile(parent);
    expect(g.missiles).toHaveLength(parent.childCount);
    expect(g.missiles.every((c) => c.type === 'normal' && c.childCount === 0)).toBe(true);
  });
});

describe('Interceptors (autonomous launcher)', () => {
  it('auto-launches at the highest-value distant threat, skipping drones', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const cheap = new EnemyMissile(300, 200, 300, g.groundY, 150, 0, g.groundY, 'normal');
    const bus = new EnemyMissile(900, 150, 900, g.groundY, 150, 3, g.groundY, 'normal'); // MIRV
    const drone = new EnemyMissile(-30, 500, 900, g.groundY, 100, 0, 0, 'drone');
    g.missiles = [cheap, bus, drone];
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0; // initial reload finished
    g.updateInterceptorLauncher(1 / 60);
    expect(g.interceptorList).toHaveLength(1);
    expect(g.interceptorList[0].target).toBe(bus); // high value beats cheap
    expect(g.interceptorWeapon.canLaunch).toBe(false); // reload started
    g.updateInterceptorLauncher(1 / 60);
    expect(g.interceptorList).toHaveLength(1); // still reloading -> nothing
  });

  it('never launches at drones, cloaked stealth, or point-blank targets', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const launcherX = g.turrets[0].x + CONFIG.interceptor.launcherOffsetX;
    const drone = new EnemyMissile(-30, 500, 900, g.groundY, 100, 0, 0, 'drone');
    const stealth = new EnemyMissile(-30, 500, 900, g.groundY, 250, 0, 0, 'stealth');
    const near = new EnemyMissile(launcherX, 100, launcherX, g.groundY, 150, 0, g.groundY, 'normal');
    near.y = g.groundY - CONFIG.interceptor.launcherHeight - 50; // inside min dist
    g.missiles = [drone, stealth, near];
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0; // loaded — it must CHOOSE not to fire
    g.updateInterceptorLauncher(1 / 60);
    expect(g.interceptorList).toHaveLength(0);
    expect(g.interceptorWeapon.canLaunch).toBe(true); // held its fire
  });

  it('detonation instakills everything in the blast and pays per kill', () => {
    const g = newGame();
    g.startGame();
    const credits0 = g.credits;
    const a = new EnemyMissile(700, 300, 700, g.groundY, 150, 3, g.groundY, 'normal'); // MIRV
    const b = new EnemyMissile(720, 310, 700, g.groundY, 150, 0, g.groundY, 'normal');
    const far = new EnemyMissile(
      700 + CONFIG.interceptor.blastRadius + 80, 300, 700, g.groundY, 150, 0, g.groundY, 'normal'
    );
    g.missiles = [a, b, far];
    g.detonateInterceptor({ x: 700, y: 300 });
    expect(a.dead).toBe(true); // armoured MIRV dies outright to the warhead
    expect(b.dead).toBe(true);
    expect(far.dead).toBe(false);
    expect(g.credits - credits0).toBe(
      CONFIG.economy.bounty.mirv + CONFIG.economy.bounty.normal
    );
  });
});

describe('Active turret selection', () => {
  it('the single central gun is always active until destroyed', () => {
    const g = newGame();
    g.startGame();
    expect(g.turrets).toHaveLength(1);
    const gun = g.turrets[0];
    g.mouseX = 0;
    expect(g.getActiveTurret()).toBe(gun);
    g.mouseX = g.W;
    expect(g.getActiveTurret()).toBe(gun);
    gun.ammo = 0; // empty but alive -> still the active gun (crosshair turns red)
    expect(g.getActiveTurret()).toBe(gun);
    gun.alive = false;
    expect(g.getActiveTurret()).toBeNull();
  });
});

describe('End-of-wave economy', () => {
  it('breaks credits into kills + all-clear + cities, and bumps score', () => {
    const g = newGame();
    g.startGame();
    g.waveEarned = 7; // kill bounties banked during the wave
    g.waveLeaks = 0; // perfect clear
    const credits0 = g.credits;
    const score0 = g.score;
    g.endWave();

    const cities = g.cities.filter((c) => c.alive).length;
    expect(g.state).toBe('intermission');
    expect(g.waveBreakdown.kills).toBe(7);
    expect(g.waveBreakdown.clear).toBe(CONFIG.economy.clearBonus);
    expect(g.waveBreakdown.city).toBe(cities * CONFIG.economy.perCitySurvived);
    expect(g.credits - credits0).toBe(
      CONFIG.economy.clearBonus + cities * CONFIG.economy.perCitySurvived
    );
    expect(g.score - score0).toBe(cities * CONFIG.score.citySurvivalBonus);
    expect(g.nextWave).toBe(g.wave + 1);
  });

  it('awards no all-clear bonus if anything leaked', () => {
    const g = newGame();
    g.startGame();
    g.waveLeaks = 2;
    g.endWave();
    expect(g.waveBreakdown.clear).toBe(0);
  });
});

describe('Shop', () => {
  const find = (g, prefix) => g.getShopItems().find((i) => i.label.startsWith(prefix));

  it('lists items and respects affordability', () => {
    const g = newGame();
    g.startGame();
    g.credits = 0;
    const items = g.getShopItems();
    expect(items).toHaveLength(5); // intcp, shield, laser, fire rate, twin
    const upgrade = items[0];
    expect(upgrade.enabled).toBe(false); // can't afford
    const cd0 = g.interceptorWeapon.cooldown;
    g.buyItem(upgrade);
    expect(g.interceptorWeapon.cooldown).toBe(cd0); // unchanged
    expect(g.credits).toBe(0);
  });

  it('sells the battery cheap, then reload upgrades', () => {
    const g = newGame();
    g.startGame();
    g.credits = 50;
    expect(g.interceptorWeapon.owned).toBe(false);
    g.buyItem(find(g, SL.interceptor.label));
    expect(g.interceptorWeapon.owned).toBe(true);
    expect(g.credits).toBe(50 - CONFIG.shop.interceptorCost);
    expect(find(g, SL.interceptor.label)).toBeUndefined(); // replaced by reload row
    g.credits = 50;
    const cd0 = g.interceptorWeapon.cooldown;
    g.buyItem(find(g, SL.interceptorReload.labelMax));
    expect(g.interceptorWeapon.cooldown).toBeLessThan(cd0);
    expect(g.credits).toBe(50 - CONFIG.shop.interceptorCooldownCosts[0]);
  });

  it('sells the laser once, then offers recharge upgrades', () => {
    const g = newGame();
    g.startGame();
    g.credits = 1000;
    expect(g.laser.owned).toBe(false);
    g.buyItem(find(g, SL.laser.label));
    expect(g.laser.owned).toBe(true);
    expect(find(g, SL.laser.label)).toBeUndefined(); // replaced by the upgrade
    const rt0 = g.laser.rechargeTime;
    g.buyItem(find(g, SL.laserRecharge.labelMax));
    expect(g.laser.rechargeTime).toBeLessThan(rt0);
  });

  it('upgrades fire rate, and reload caps at MAX', () => {
    const g = newGame();
    g.startGame();
    g.credits = 1000;
    const fi0 = g.ciws.fireInterval;
    g.buyItem(find(g, SL.fireRate.labelMax));
    expect(g.ciws.fireInterval).toBeLessThan(fi0);

    // Max out the interceptor reload ladder.
    g.interceptorWeapon.buy();
    for (let i = 0; i < CONFIG.shop.interceptorCooldownCosts.length; i++) {
      g.credits = 100000;
      const item = find(g, SL.interceptorReload.labelMax);
      if (item.cost != null) g.buyItem(item);
    }
    const maxed = find(g, SL.interceptorReload.labelMax);
    expect(maxed.cost).toBeNull();
    expect(maxed.enabled).toBe(false);
    const ladder = CONFIG.interceptor.cooldowns;
    expect(g.interceptorWeapon.cooldown).toBe(ladder[ladder.length - 1]);
  });

  it('buying Twin Barrels enables the second barrel and then sells out', () => {
    const g = newGame();
    g.startGame();
    g.credits = 1000;
    expect(g.ciws.twin).toBe(false);
    g.buyItem(find(g, SL.twin.label));
    expect(g.ciws.twin).toBe(true);
    const item = find(g, SL.twin.label);
    expect(item.soldOut).toBe(true);
    expect(item.cost).toBeNull();
  });
});

describe('Shop offer variety (random drops)', () => {
  const KEYS = ['interceptor', 'shield', 'laser', 'fireRate', 'twin'];

  // Opt back into the drop that setup.js disables for the deterministic tests.
  const withDrop = (n, fn) => {
    const orig = CONFIG.shop.dropPerWave;
    CONFIG.shop.dropPerWave = n;
    try {
      return fn();
    } finally {
      CONFIG.shop.dropPerWave = orig;
    }
  };

  it('withholds dropPerWave distinct offers, and the shop hides them', () => {
    const g = newGame();
    g.startGame();
    withDrop(2, () => {
      withRandom(0.5, () => g.rollShopOffer());
      expect(g.shopDropped).toHaveLength(2);
      expect(new Set(g.shopDropped).size).toBe(2); // distinct slots
      for (const k of g.shopDropped) expect(KEYS).toContain(k);

      const shown = g.getShopItems().map((i) => i.key);
      expect(shown).toHaveLength(KEYS.length - 2);
      for (const dropped of g.shopDropped) expect(shown).not.toContain(dropped);
    });
  });

  it('never drops more than the roster minus one, even if misconfigured', () => {
    const g = newGame();
    g.startGame();
    withDrop(99, () => {
      g.rollShopOffer();
      expect(g.shopDropped).toHaveLength(KEYS.length - 1);
      expect(g.getShopItems()).toHaveLength(1); // always at least one thing to buy
    });
  });

  it('a fresh run and disabled drop offer the full roster', () => {
    const g = newGame();
    g.startGame(); // dropPerWave is 0 under test
    g.rollShopOffer();
    expect(g.shopDropped).toHaveLength(0);
    expect(g.getShopItems()).toHaveLength(KEYS.length);
  });

  it('clearing a wave rerolls the withheld offers', () => {
    const g = newGame();
    g.startGame();
    withDrop(2, () => {
      // Two different RNG draws must be able to withhold different slots.
      withRandom(0.1, () => g.endWave());
      const first = g.shopDropped.slice().sort();
      withRandom(0.9, () => g.endWave());
      const second = g.shopDropped.slice().sort();
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(first).not.toEqual(second);
    });
  });
});

describe('update() guards', () => {
  it('is a no-op while paused', () => {
    const g = newGame();
    g.startGame();
    g.paused = true;
    const t0 = g.time;
    g.update(0.5);
    expect(g.time).toBe(t0);
  });

  it('advances the clock when running', () => {
    const g = newGame();
    g.startGame();
    const t0 = g.time;
    g.update(0.1);
    expect(g.time).toBeCloseTo(t0 + 0.1, 6);
  });
});

describe('Key routing (handleKey)', () => {
  it('Space deploys from the menu and after game over', () => {
    const g = newGame();
    g.handleKey(' ');
    expect(g.state).toBe('playing');
    g.state = 'gameover';
    g.handleKey(' ');
    expect(g.state).toBe('playing');
  });

  it('Space advances from the shop to the next wave', () => {
    const g = newGame();
    g.startGame();
    g.endWave();
    g.handleKey(' ');
    expect(g.state).toBe('playing');
    expect(g.wave).toBe(2);
  });

  it('Space does nothing during play (weapons are autonomous)', () => {
    const g = newGame();
    g.startGame();
    const wave0 = g.wave;
    g.handleKey(' ');
    expect(g.state).toBe('playing');
    expect(g.wave).toBe(wave0);
    expect(g.interceptorList).toHaveLength(0);
  });

  it('P toggles pause, and shop number keys buy items', () => {
    const g = newGame();
    g.startGame();
    g.handleKey('p');
    expect(g.paused).toBe(true);
    g.handleKey('p');
    expect(g.paused).toBe(false);

    g.endWave();
    g.credits = 100;
    g.handleKey('1'); // first shop row = Interceptor Battery (unowned)
    expect(g.interceptorWeapon.owned).toBe(true);
    const cd0 = g.interceptorWeapon.cooldown;
    g.handleKey('1'); // row becomes Interceptor Reload once owned
    expect(g.interceptorWeapon.cooldown).toBeLessThan(cd0);
  });
});

describe('Kill feedback (float text)', () => {
  it('pops a +credits label at the kill location', () => {
    const g = newGame();
    g.startGame();
    g.floatTexts = [];
    const m = new EnemyMissile(700, 300, 700, g.groundY, 150, 0, g.groundY, 'normal');
    g.missiles = [m];
    g.bullets = [new Bullet(700, 300, 0)];
    g.checkCollisions();
    expect(g.floatTexts).toHaveLength(1);
    expect(g.floatTexts[0].text).toBe(`+${CONFIG.economy.bounty.normal}`);
    expect(g.floatTexts[0].x).toBe(700);
  });

  it('labels the bigger MIRV bounty on the killing hit only', () => {
    const g = newGame();
    g.startGame();
    g.floatTexts = [];
    const m = new EnemyMissile(700, 300, 700, g.groundY, 150, 3, g.groundY, 'normal');
    g.missiles = [m];
    for (let i = 0; i < 3; i++) {
      g.bullets = [new Bullet(700, 300, 0)];
      g.checkCollisions();
    }
    expect(g.floatTexts).toHaveLength(1); // only the kill (3rd hit) pops a label
    expect(g.floatTexts[0].text).toBe(`+${CONFIG.economy.bounty.mirv}`);
  });

  it('float texts fade out over their lifetime', () => {
    const g = newGame();
    g.startGame();
    g.spawnFloatText(100, 100, '+1', '#fff');
    g.update(CONFIG.ui.floatTextLife + 0.1);
    expect(g.floatTexts).toHaveLength(0);
  });
});

describe('Gun shield (shop upgrade ladder)', () => {
  const find = (g, prefix) => g.getShopItems().find((i) => i.label.startsWith(prefix));

  it('first purchase fits the dome on the gun, immediately live', () => {
    const g = newGame();
    g.startGame();
    g.credits = 300;
    const gun = g.turrets[0];
    expect(gun.shieldMax).toBe(0);
    g.buyItem(find(g, SL.shield.label));
    expect(g.shieldLevel).toBe(1);
    expect(gun.shieldMax).toBe(1);
    expect(gun.shields).toBe(1);
    expect(g.credits).toBe(300 - CONFIG.shield.costs[0]);
  });

  it('later purchases shorten the recharge and cap at MAX', () => {
    const g = newGame();
    g.startGame();
    g.credits = 100000;
    g.buyItem(find(g, SL.shield.label));
    const rt0 = g.shieldRechargeTime();
    g.buyItem(find(g, SL.shieldRecharge.labelMax));
    expect(g.shieldRechargeTime()).toBeLessThan(rt0);
    for (let i = 0; i < 10; i++) {
      const item = find(g, SL.shieldRecharge.labelMax);
      if (item.cost != null) g.buyItem(item);
    }
    const ladder = CONFIG.shield.rechargeTimes;
    expect(g.shieldRechargeTime()).toBe(ladder[ladder.length - 1]);
    expect(find(g, SL.shieldRecharge.labelMax).cost).toBeNull();
  });

  it('cities can no longer be shielded (no click-to-shield)', () => {
    const g = newGame();
    g.startGame();
    g.credits = 1000;
    const city = g.cities[0];
    g.handleShopClick(city.x, g.groundY - 10); // stub renderer is identity
    expect(city.shieldMax).toBe(0);
    expect(city.shields).toBe(0);
  });

  it('the dome intercepts a missile on contact and then fails', () => {
    const g = newGame();
    g.startGame();
    const gun = g.turrets[0];
    gun.shieldMax = 1;
    gun.shields = 1;
    // a warhead inside the dome radius, above the ground
    const m = new EnemyMissile(gun.x, g.groundY - 30, gun.x, g.groundY, 240, 0, g.groundY, 'normal');
    g.missiles = [m];
    g.checkShieldCollisions();
    expect(m.dead).toBe(true); // detonated on the dome
    expect(gun.alive).toBe(true); // structure protected
    expect(gun.shields).toBe(0); // shield broke
    expect(gun.shieldFlash).toBeGreaterThan(0); // collapse effect armed
  });

  it('a shielded gun survives a hit (no instant loss)', () => {
    const g = newGame();
    g.startGame();
    const gun = g.turrets[0];
    gun.shieldMax = 1;
    gun.shields = 1;
    const m = new EnemyMissile(gun.x, g.groundY - 20, gun.x, g.groundY, 240, 0, g.groundY, 'normal');
    g.missiles = [m];
    g.checkShieldCollisions();
    g.toSpawn = 0;
    g.missiles = g.missiles.filter((x) => !x.dead);
    g.update(1 / 60);
    expect(gun.alive).toBe(true);
    expect(g.state).not.toBe('gameover');
  });

  it('a broken shield recharges after its (upgradeable) cooldown', () => {
    const g = newGame();
    g.startGame();
    g.shieldLevel = 1;
    const gun = g.turrets[0];
    gun.shieldMax = 1;
    gun.shields = 0;
    gun.shieldTimer = g.shieldRechargeTime();
    g.updateShields(g.shieldRechargeTime() - 0.1);
    expect(gun.shields).toBe(0);
    g.updateShields(0.2);
    expect(gun.shields).toBe(1);
    g.updateShields(g.shieldRechargeTime());
    expect(gun.shields).toBe(1); // capped at 1
  });

  it('the shield refills at the start of a wave', () => {
    const g = newGame();
    g.startGame();
    g.shieldLevel = 1;
    const gun = g.turrets[0];
    gun.shieldMax = 1;
    gun.shields = 0;
    g.startWave(2);
    expect(gun.shields).toBe(1);
  });
});

describe('Autonomous CIWS', () => {
  const inRange = (g) =>
    new EnemyMissile(g.turrets[0].x, g.groundY - 200, g.turrets[0].x, g.groundY, 180, 0, g.groundY, 'normal');

  it('fires on its own while visible threats are up', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [inRange(g)];
    g.update(1 / 60);
    expect(g.bullets.length).toBeGreaterThan(0);
  });

  it('holds fire when the sky is clear or only cloaked threats remain', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    g.update(1 / 60);
    expect(g.bullets.length).toBe(0); // empty sky

    g.missiles = [new EnemyMissile(-30, 500, 900, g.groundY, 250, 0, 0, 'stealth')];
    g.update(1 / 60);
    expect(g.bullets.length).toBe(0); // a cloaked stealth doesn't count
  });

  it('aims wherever the cursor points', () => {
    const g = newGame();
    g.startGame();
    g.mouseX = 100;
    g.mouseY = 100;
    g.update(1 / 60);
    const t = g.turrets[0];
    const want = Math.atan2(100 - t.y, 100 - t.x);
    expect(Math.abs(t.angle - want)).toBeLessThan(1e-9);
  });
})
describe('New threats', () => {
  it('cruise missiles fly level, pop up, then dive onto the target', () => {
    const g = newGame();
    g.startGame();
    const alt = g.groundY * 0.6;
    const m = new EnemyMissile(-30, alt, 1000, g.groundY, 240, 0, 0, 'cruise');
    expect(m.waypoints.length).toBe(3);
    let minY = alt;
    let popped = false;
    let guard = 0;
    while (!m.dead && guard++ < 4000) {
      const r = m.update(1 / 60, g.groundY);
      minY = Math.min(minY, m.y);
      if (m.wpIndex >= 2) popped = true;
      if (r === 'impact') break;
    }
    expect(popped).toBe(true); // reached the terminal-dive leg
    expect(minY).toBeLessThan(alt - 100); // actually climbed during the pop-up
    expect(m.reachedGround).toBe(true);
    expect(Math.abs(m.x - 1000)).toBeLessThan(220); // came down near the target
  });

  it('a drone roll spawns a whole group from one side as a single wave slot', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.toSpawn = 20;
    g.spawnDroneGroup();
    expect(g.missiles).toHaveLength(CONFIG.missile.drone.groupSize);
    expect(g.toSpawn).toBe(20); // the swarm counts as ONE enemy of the budget
    const left = g.missiles.every((m) => m.x < 0);
    const right = g.missiles.every((m) => m.x > g.W);
    expect(left || right).toBe(true); // one shared entry side
    for (const m of g.missiles) expect(m.type).toBe('drone');
  });

  it('stealth cruise is cloaked until the pop-up, then targetable', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.spawnCruise('stealth');
    const m = g.missiles[0];
    expect(m.type).toBe('stealth');
    expect(m.stealthed).toBe(true);

    // Cloaked: the autonomous launcher can't see it.
    g.toSpawn = 0;
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60);
    expect(g.interceptorList).toHaveLength(0);

    // Fly it to the pop-up: the cloak drops and it becomes targetable.
    let guard = 0;
    while (m.wpIndex === 0 && !m.dead && guard++ < 6000) m.update(1 / 60, g.groundY);
    expect(m.stealthed).toBe(false);
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60);
    expect(g.interceptorList).toHaveLength(1);
    expect(g.interceptorList[0].target).toBe(m);
  });

  it('side-entry flyers always terminate (no orbiting a waypoint forever)', () => {
    // Regression: a flyer that overshot a mid-air waypoint used to circle it
    // endlessly, stalling the wave. Every spawn must reach the ground.
    const g = newGame();
    g.startGame();
    for (let trial = 0; trial < 60; trial++) {
      g.missiles = [];
      g.toSpawn = 20;
      if (trial % 2) g.spawnCruise();
      else g.spawnDroneGroup();
      for (const m of g.missiles) {
        let guard = 0;
        while (!m.dead && guard++ < 6000) m.update(1 / 60, g.groundY);
        expect(m.dead).toBe(true);
      }
    }
  });

  it('air-bursts above an inner city and levels the immediate neighbours', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.launchNuke();
    expect(g.missiles).toHaveLength(1);
    const nuke = g.missiles[0];
    expect(nuke.type).toBe('nuke');
    expect(nuke.maxHp).toBe(CONFIG.missile.hp.nuke); // armoured

    // It never aims at the outermost cities while inner ones stand.
    const innerXs = g.cities.slice(1, -1).map((c) => c.x);
    expect(innerXs).toContain(nuke.targetX);

    // Fly it in: it detonates ABOVE the ground (air burst).
    let r = null;
    let guard = 0;
    while (r === null && guard++ < 6000) r = nuke.update(1 / 60, g.groundY);
    expect(r).toBe('impact');
    expect(nuke.y).toBeLessThan(g.groundY - CONFIG.missile.nuke.burstHeight + 2);

    // Burst over city index 1: cities 0,1,2 die; the rest (and the gun,
    // two slots away) survive. A mushroom cloud starts billowing.
    nuke.x = g.cities[1].x;
    g.impact(nuke);
    expect(g.cities[0].alive).toBe(false);
    expect(g.cities[1].alive).toBe(false);
    expect(g.cities[2].alive).toBe(false);
    expect(g.cities[3].alive).toBe(true);
    expect(g.turrets[0].alive).toBe(true);
    expect(g.mushrooms).toHaveLength(1);
  });

  it('kills the CIWS when it bursts over the city next door', () => {
    const g = newGame();
    g.startGame();
    const cityByGun = g.cities[2]; // slot layout: c0 c1 c2 [gun] c3 c4 c5
    g.impact({ type: 'nuke', x: cityByGun.x, y: g.groundY - 120 });
    expect(cityByGun.alive).toBe(false);
    expect(g.turrets[0].alive).toBe(false); // the gun was one slot away
  });

  it('targets an outermost city only when nothing inner is left', () => {
    const g = newGame();
    g.startGame();
    for (const c of g.cities.slice(1, -1)) c.alive = false; // only c0/c5 stand
    g.missiles = [];
    g.launchNuke();
    const outerXs = [g.cities[0].x, g.cities[g.cities.length - 1].x];
    expect(outerXs).toContain(g.missiles[0].targetX);
  });

  it('a nuke shrugs off interceptor blasts, dying only to repeated hits', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.launchNuke();
    const nuke = g.missiles[0];
    nuke.x = 700;
    nuke.y = 300;
    g.detonateInterceptor({ x: 700, y: 300 });
    expect(nuke.dead).toBe(false); // shrugs off a blast
    expect(nuke.hp).toBe(CONFIG.missile.hp.nuke - CONFIG.interceptor.blastDamage);
    const needed = Math.ceil(CONFIG.missile.hp.nuke / CONFIG.interceptor.blastDamage);
    expect(needed).toBeGreaterThanOrEqual(3); // takes a salvo, not a lucky single
    for (let i = 1; i < needed; i++) g.detonateInterceptor({ x: 700, y: 300 });
    expect(nuke.dead).toBe(true);
  });

  it('never rolls a nuke as the first or last spawns of a wave', () => {
    const g = newGame();
    g.startGame();
    g.wave = CONFIG.missile.nuke.fromWave;
    g.nukesSpawned = 0;
    g.waveSpawnTotal = 20;
    for (const toSpawn of [20, 19, 1, 0]) {
      g.toSpawn = toSpawn; // wave opening (nothing spawned) or closing out
      for (let i = 0; i < 100; i++) expect(g.chooseThreat().type).not.toBe('nuke');
    }
  });

  it('the nuke cap keeps climbing with the waves', () => {
    const g = newGame();
    g.startGame();
    g.waveSpawnTotal = 30;
    g.toSpawn = 15; // mid-wave so the order gate passes
    const N = CONFIG.missile.nuke;

    g.wave = N.fromWave;
    g.nukesSpawned = N.maxPerWave; // cap reached at the unlock wave
    for (let i = 0; i < 200; i++) expect(g.chooseThreat().type).not.toBe('nuke');

    g.wave = N.fromWave + N.wavesPerExtra; // cap is now 2
    expect(withRandom(0, () => g.chooseThreat().type)).toBe('nuke');
    g.nukesSpawned = 2;
    for (let i = 0; i < 200; i++) expect(g.chooseThreat().type).not.toBe('nuke');

    g.wave = N.fromWave + 3 * N.wavesPerExtra; // cap is now 4
    g.nukesSpawned = 3;
    expect(withRandom(0, () => g.chooseThreat().type)).toBe('nuke');
  });
});

describe('Laser', () => {
  /** Burn with the laser until the target dies; returns frames spent. */
  const burnFrames = (g, max = 600) => {
    let frames = 0;
    while (g.laser.target === null && frames < max) {
      g.updateLaser(1 / 60); // acquire
      frames++;
      if (g.laser.target) break;
    }
    while (g.laser.target && frames++ < max) g.updateLaser(1 / 60);
    return frames;
  };

  it('latches the lowest eligible target and burns it down over time', () => {
    const g = newGame();
    g.startGame();
    g.laser.buy();
    const high = new EnemyMissile(300, 100, 300, g.groundY, 150, 0, g.groundY, 'normal');
    const low = new EnemyMissile(900, 100, 900, g.groundY, 150, 0, g.groundY, 'normal');
    low.y = g.groundY - 380; // low in the sky, inside the laser's reach
    g.missiles = [high, low];
    const credits0 = g.credits;

    g.updateLaser(1 / 60); // acquires and starts traversing onto it
    expect(g.laser.target).toBe(low); // lowest eligible wins
    expect(low.dead).toBe(false); // no instant kill — it must aim, then burn
    expect(low.hp).toBe(low.maxHp); // still slewing, no damage yet

    // Let it finish the traverse and start burning.
    let burned = false;
    for (let i = 0; i < 60 && !burned; i++) {
      g.updateLaser(1 / 60);
      burned = low.hp < low.maxHp;
    }
    expect(burned).toBe(true);
    expect(g.laserBeamLive).not.toBeNull(); // sustained beam while burning

    for (let i = 0; i < 200 && !low.dead; i++) g.updateLaser(1 / 60);
    expect(low.dead).toBe(true);
    expect(high.dead).toBe(false);
    expect(g.laser.canFire).toBe(false); // recharging after the kill
    expect(g.laserBeamLive).toBeNull();
    expect(g.laserBeams).toHaveLength(1); // fading after-beam
    expect(g.credits - credits0).toBe(CONFIG.economy.bounty.normal);
  });

  it('bigger targets take proportionally longer to burn', () => {
    const g = newGame();
    g.startGame();
    g.laser.buy();
    const drone = new EnemyMissile(560, 600, 900, g.groundY, 100, 0, 0, 'drone');
    drone.update = () => null; // hold still for a clean measurement
    drone.y = 600;
    g.missiles = [drone];
    const droneFrames = burnFrames(g);
    expect(drone.dead).toBe(true);

    g.laser.timer = 0; // recharge instantly for the second measurement
    const bus = new EnemyMissile(560, 300, 560, g.groundY, 150, 3, g.groundY, 'normal');
    bus.update = () => null;
    bus.y = 600; // same distance as the drone — only HP differs
    g.missiles = [bus];
    const busFrames = burnFrames(g);
    expect(bus.dead).toBe(true);
    expect(busFrames).toBeGreaterThan(droneFrames * 2); // 3 HP vs 1 HP
  });

  it('burns weaker at distance and cannot latch beyond its range', () => {
    const g = newGame();
    g.startGame();
    g.laser.buy();
    // Two identical 1-HP targets at different distances: the close one burns
    // down measurably faster.
    const near = new EnemyMissile(560, 100, 560, g.groundY, 150, 0, g.groundY, 'normal');
    near.update = () => null;
    near.y = 800;
    g.missiles = [near];
    const nearFrames = burnFrames(g);

    g.laser.timer = 0;
    const far = new EnemyMissile(560, 100, 560, g.groundY, 150, 0, g.groundY, 'normal');
    far.update = () => null;
    far.y = 350;
    g.missiles = [far];
    const farFrames = burnFrames(g);
    expect(nearFrames).toBeLessThan(farFrames);

    // A target beyond max range is never latched at all.
    g.laser.timer = 0;
    const distant = new EnemyMissile(560, 100, 560, g.groundY, 150, 0, g.groundY, 'normal');
    distant.update = () => null;
    distant.y = 60; // ~850 px from the emitter — outside CONFIG.laser.range
    g.missiles = [distant];
    for (let i = 0; i < 120; i++) g.updateLaser(1 / 60);
    expect(g.laser.target).toBeNull();
    expect(distant.hp).toBe(distant.maxHp);
  });

  it('holds fire with no eligible targets and stays charged', () => {
    const g = newGame();
    g.startGame();
    g.laser.buy();
    const hyper = new EnemyMissile(500, 300, 500, g.groundY, 450, 0, g.groundY, 'hypersonic');
    g.missiles = [hyper];
    g.updateLaser(1 / 60);
    expect(hyper.dead).toBe(false);
    expect(g.laser.canFire).toBe(true);
    expect(g.laserBeams).toHaveLength(0);
    expect(g.laserBeamLive).toBeNull();
  });
});

describe('City hitbox & targeting memory', () => {
  it('a blast anywhere on a city footprint destroys it (not just dead centre)', () => {
    const g = newGame();
    g.startGame();
    // Work on the outboard edge of the leftmost city so no neighbour is in
    // reach. Just past the footprint+blast: a miss; just inside: a kill.
    const c = g.cities[0];
    const reach = c.width / 2 + CONFIG.missile.blastRadius;
    g.impact({ type: 'normal', x: c.x - reach - 10 });
    expect(c.alive).toBe(true); // clear miss past the footprint

    g.impact({ type: 'normal', x: c.x - reach + 1 });
    expect(c.alive).toBe(false); // clipping the outermost building counts
  });

  it('rubble made this wave still draws fire; older rubble does not', () => {
    const g = newGame();
    g.startGame();
    const c = g.cities[0];
    g.impact({ type: 'normal', x: c.x }); // destroyed THIS wave
    expect(c.alive).toBe(false);
    expect(g.aimableStructures()).toContain(c); // preprogrammed salvos still come

    g.startWave(g.wave + 1);
    expect(g.aimableStructures()).not.toContain(c); // known dead next wave
    expect(g.aimableStructures().length).toBeGreaterThan(0);
  });
});

describe('Nuclear launch warning', () => {
  it('a nuke roll warns first; the warhead appears after the countdown', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.toSpawn = 0;
    g.spawnNuke();
    expect(g.missiles).toHaveLength(0); // detected, not yet on screen
    expect(g.pendingNukes).toHaveLength(1);

    // The wave must NOT end while a detected launch is still inbound.
    g.update(CONFIG.wave.endDelay + 0.1);
    expect(g.state).toBe('playing');

    // Run out the rest of the warning: the nuke spawns.
    g.update(CONFIG.missile.nuke.warningTime);
    expect(g.pendingNukes).toHaveLength(0);
    expect(g.missiles.some((m) => m.type === 'nuke')).toBe(true);
  });
});

describe('Interceptor retasking', () => {
  it('retargets onto the nearest live threat when its target dies', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const a = new EnemyMissile(700, 200, 700, g.groundY, 150, 0, g.groundY, 'normal');
    const b = new EnemyMissile(760, 320, 760, g.groundY, 150, 0, g.groundY, 'normal');
    g.missiles = [a, b];
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60); // auto-launches at the farther threat
    const it = g.interceptorList[0];
    expect(it.target).toBe(a);
    a.dead = true; // gunned down mid-flight
    g.update(1 / 60);
    expect(it.target).toBe(b); // retasked, not wasted
    expect(it.dead).toBe(false);
  });

  it('self-destructs when nothing is left to chase', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const a = new EnemyMissile(700, 300, 700, g.groundY, 150, 0, g.groundY, 'normal');
    g.missiles = [a];
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60);
    const it = g.interceptorList[0];
    a.dead = true;
    g.missiles = [];
    g.update(1 / 60);
    expect(it.dead).toBe(true); // detonated itself rather than flying off
  });

  it('launches straight up out of the pod', () => {
    const g = newGame();
    g.startGame();
    const m = new EnemyMissile(100, 800, 100, g.groundY, 150, 0, g.groundY, 'normal');
    g.missiles = [m];
    g.toSpawn = 0;
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60);
    const it = g.interceptorList[0];
    expect(it.vx).toBe(0); // vertical cold launch
    expect(it.vy).toBeLessThan(0); // (sim +y is down)
  });
});

describe('Laser firing arc', () => {
  it('will not engage targets below its minimum elevation', () => {
    const g = newGame();
    g.startGame();
    g.laser.buy();
    // A drone skimming at emitter height far to the side: inside range but
    // below the minimum firing arc.
    const ex = g.turrets[0].x + CONFIG.laser.offsetX;
    const ey = g.groundY - CONFIG.laser.emitterHeight;
    const skimmer = new EnemyMissile(ex - 400, 100, ex, g.groundY, 100, 0, 0, 'drone');
    skimmer.update = () => null;
    skimmer.x = ex - 400;
    skimmer.y = ey; // dead level with the emitter -> 0 elevation
    g.missiles = [skimmer];
    for (let i = 0; i < 120; i++) g.updateLaser(1 / 60);
    expect(g.laser.target).toBeNull();
    expect(skimmer.hp).toBe(skimmer.maxHp);
  });
});

describe('Bombers & glide bombs', () => {
  it('crosses the sky level, drops bombs over the field, exits without leaking', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.toSpawn = 0;
    g.spawnBomber();
    const bomber = g.missiles[0];
    expect(bomber.type).toBe('bomber');
    expect(Math.abs(bomber.vy)).toBeLessThan(1e-9); // level flight
    expect(bomber.bombsLeft).toBeGreaterThanOrEqual(CONFIG.missile.bomber.bombs[0]);
    // Determinism: shield the gun (a bomb could kill it and end the game
    // mid-test) and armour the bomber (the auto-gun could down it before it
    // finishes dropping, which is the behaviour under test). Park the aim in
    // a low corner so the stream never threatens the bomber — a threatened
    // pilot aborts his bombing run, and this test is about an unmolested one.
    g.turrets[0].shieldMax = 99;
    g.turrets[0].shields = 99;
    bomber.hp = 99999;
    g.mouseX = 0;
    g.mouseY = g.groundY;
    // Pin a leisurely cruise: at full combat speed a worst-case pair of
    // dropGap rolls (2.6s + 2.6s) can outlast the crossing, leaving a bomb
    // racked — this test is about the unhurried baseline behaviour.
    bomber.speed = 150;
    bomber.vx = Math.sign(bomber.vx) * 150;

    const leaks0 = g.waveLeaks;
    let guard = 0;
    while (!bomber.dead && guard++ < 4000) g.update(1 / 60);
    expect(bomber.dead).toBe(true); // exited and was culled
    expect(g.waveLeaks - leaks0).toBeLessThanOrEqual(
      CONFIG.missile.bomber.bombs[1] // only its BOMBS may have leaked
    );
    expect(bomber.bombsLeft).toBe(0); // emptied the rack on the way
  });

  it('glide bombs can be shot down like any other threat', () => {
    const g = newGame();
    g.startGame();
    const bomb = new EnemyMissile(700, 300, 800, g.groundY, 160, 0, 0, 'glidebomb');
    g.missiles = [bomb];
    g.bullets = [new Bullet(700, 300, 0)];
    const credits0 = g.credits;
    g.checkCollisions();
    expect(bomb.dead).toBe(true);
    expect(g.credits - credits0).toBe(CONFIG.economy.bounty.glidebomb);
  });

  it('the interceptor will engage bombers; the laser takes the bombs', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const bomber = new EnemyMissile(-40, 200, 1500, 200, 130, 0, 0, 'bomber');
    bomber.x = bomber.cx = 400;
    const bomb = new EnemyMissile(700, 300, 800, g.groundY, 160, 0, 0, 'glidebomb');
    g.missiles = [bomber, bomb];
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60);
    expect(g.interceptorList[0].target).toBe(bomber); // value 4 beats bomb's 1
    expect(g.laser.canTarget(bomb)).toBe(true);
  });

  it('a bomber that clears the field is gone at once — and is not a leak', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const bomber = new EnemyMissile(-40, 200, 1500, 200, 130, 0, 0, 'bomber');
    bomber.x = bomber.cx = g.W + 90; // outbound, just past the right edge
    g.missiles = [bomber];
    const leaks0 = g.waveLeaks;
    g.update(1 / 60);
    expect(bomber.dead).toBe(true);
    expect(g.waveLeaks).toBe(leaks0);
  });
});

describe('Threat ID tags', () => {
  it('maps every type to a STRINGS name, hides cloaked, flags MIRV buses', () => {
    const g = newGame();
    expect(g.threatLabel({ type: 'normal', splitsRemaining: 0 })).toBe(STRINGS.threatNames.normal);
    expect(g.threatLabel({ type: 'normal', splitsRemaining: 3 })).toBe(STRINGS.threatNames.mirv);
    expect(g.threatLabel({ type: 'stealth', stealthed: true })).toBeNull();
    expect(g.threatLabel({ type: 'stealth', stealthed: false })).toBe(STRINGS.threatNames.stealth);
    for (const t of ['evasive', 'hypersonic', 'cruise', 'drone', 'bomber', 'glidebomb', 'nuke']) {
      expect(g.threatLabel({ type: t })).toBe(STRINGS.threatNames[t]);
    }
  });
});

describe('Score recording', () => {
  it('banks the run on game over and surfaces the rank', () => {
    const g = newGame();
    const calls = [];
    g.scoreboard = {
      add: (score, wave) => {
        calls.push([score, wave]);
        return { scores: [{ score, wave, date: 'x' }], rank: 0 };
      },
    };
    g.startGame();
    g.score = 4321;
    g.wave = 7;
    g.gameOver('Cities lost');
    expect(calls).toEqual([[4321, 7]]);
    expect(g.lastRun.rank).toBe(0);
  });
});

describe('Bomber evasion', () => {
  it('jinks while a homing interceptor closes, settles when clear', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    g.spawnBomber();
    const bomber = g.missiles[0];
    bomber.x = bomber.cx = 700; // park it mid-field
    g.update(1 / 60);
    expect(bomber.evading).toBe(false);
    expect(Math.abs(bomber.vy)).toBeLessThan(1); // level cruise

    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60);
    const it = g.interceptorList[0];
    expect(it.target).toBe(bomber);
    it.x = bomber.x + 100; // inside evade range
    it.y = bomber.y + 100;
    bomber.flareBursts = 0; // this test is about the jink, not the decoys
    let sawJink = false;
    for (let i = 0; i < 30; i++) {
      it.update = () => null; // freeze the threat in place
      g.update(1 / 60);
      if (Math.abs(bomber.vy) > 40) sawJink = true;
    }
    expect(bomber.evading).toBe(true);
    expect(sawJink).toBe(true); // pilot is maneuvering

    it.dead = true; // threat gone
    for (let i = 0; i < 40; i++) g.update(1 / 60);
    if (!bomber.dead) {
      expect(bomber.evading).toBe(false);
      expect(Math.abs(bomber.vy)).toBeLessThan(10); // settled back to level
    }
  });
});
