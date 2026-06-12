// ---------------------------------------------------------------------------
// The F-16 airstrike (once-per-wave panic button) and the MIRV nuke — the two
// headline mechanics added together: scramble logic, AAM guidance plumbing,
// package persistence, and the carrier/split/small-warhead pipeline.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'bun:test';
import { newGame, withRandom } from './helpers.js';
import { CONFIG } from '../js/config.js';
import { EnemyMissile, FriendlyJet, Interceptor } from '../js/entities.js';

const G = CONFIG.world.height - CONFIG.groundHeight;

/** A slow target parked high in the sky (won't impact during a short test). */
function parkTarget(g, x = 700, y = 300) {
  const m = new EnemyMissile(x, y, x, g.groundY, 10, 0, 0, 'normal');
  m.y = m.cy = y;
  g.missiles.push(m);
  return m;
}

describe('Airstrike', () => {
  it('does nothing without a purchased package', () => {
    const g = newGame();
    g.startGame();
    parkTarget(g);
    g.callAirstrike();
    expect(g.jets).toHaveLength(0);
  });

  it('keeps the package when the sky is empty', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.toSpawn = 0;
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets).toHaveLength(0);
    expect(g.airstrike.ready).toBe(true); // not wasted on a clear sky
  });

  it('scrambles one jet per two enemies and spends the package', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    for (let i = 0; i < 10; i++) parkTarget(g, 200 + i * 110, 250 + i * 30);
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets).toHaveLength(5); // 10 enemies -> 5 jets
    expect(g.airstrike.ready).toBe(false);
    // Two rails per jet: every enemy gets exactly one missile.
    expect(g.jets.flatMap((j) => j.rack)).toHaveLength(10);
    for (const j of g.jets) expect(j.rack.length).toBeLessThanOrEqual(2);
    // Calling again without re-buying is denied.
    const count = g.jets.length;
    g.callAirstrike();
    expect(g.jets).toHaveLength(count);
  });

  it('an odd enemy count rounds the flight up, last jet half-racked', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    for (let i = 0; i < 3; i++) parkTarget(g, 400 + i * 200, 300);
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets).toHaveLength(2); // ceil(3 / 2)
    const racks = g.jets.map((j) => j.rack.length).sort();
    expect(racks).toEqual([1, 2]);
  });

  it('runs in from the side FAR from its targets, never over-flying them', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;

    // Targets parked on the LEFT: the jet must enter from the right.
    g.missiles = [];
    parkTarget(g, 250, 300);
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets[0].dir).toBe(-1);
    expect(g.jets[0].x).toBeGreaterThan(g.W);

    // Targets parked on the RIGHT: enter from the left.
    g.missiles = [];
    g.jets = [];
    parkTarget(g, 1150, 300);
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets[0].dir).toBe(1);
    expect(g.jets[0].x).toBeLessThan(0);

    // Split picture: one pair per side — the flight swarms from both.
    g.missiles = [];
    g.jets = [];
    parkTarget(g, 200, 300);
    parkTarget(g, 300, 320);
    parkTarget(g, 1100, 300);
    parkTarget(g, 1200, 320);
    g.airstrike.buy();
    g.callAirstrike();
    expect(new Set(g.jets.map((j) => j.dir)).size).toBe(2);
  });

  it('enters at a plausible intercept altitude and holds fire until in range', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    const target = parkTarget(g, 300, 400);
    g.airstrike.buy();
    g.callAirstrike();
    const jet = g.jets[0];
    const [lo, hi] = CONFIG.airstrike.entryBand;
    expect(jet.y).toBeGreaterThanOrEqual(g.groundY * lo);
    expect(jet.y).toBeLessThanOrEqual(g.groundY * hi);
    // A slow target barely moves, so entry altitude tracks it closely.
    expect(Math.abs(jet.y - target.y)).toBeLessThan(220);
    // Far away on entry: the rail is NOT in parameters yet — no launch.
    g.update(1 / 60);
    expect(g.aamList).toHaveLength(0);
    // Once inside fireRange of the target, the launch comes.
    jet.x = target.x + jet.dir * (CONFIG.airstrike.fireRange - 10) * -1;
    for (let i = 0; i < 30 && g.aamList.length === 0; i++) g.update(1 / 60);
    expect(g.aamList.length).toBeGreaterThan(0);
  });

  it('SPACE triggers the strike in play (and only in play)', () => {
    const g = newGame();
    g.startGame();
    parkTarget(g);
    g.airstrike.buy();
    g.handleKey(' ');
    expect(g.jets.length).toBeGreaterThan(0);
  });

  it('a lone nuke draws two missiles — from two DIFFERENT jets', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    g.launchNuke();
    const nuke = g.missiles[0];
    nuke.y = nuke.cy = 300; // mid-sky
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets).toHaveLength(2); // a nuke counts as two enemies
    for (const j of g.jets) {
      expect(j.rack.filter((t) => t === nuke)).toHaveLength(1); // one rail each
    }
  });

  it('a MIRV-nuke bus counts as two enemies in the rack math', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    for (let i = 0; i < 3; i++) parkTarget(g, 300 + i * 150, 300);
    const bus = new EnemyMissile(900, -10, 900, g.groundY, 400, 0, g.groundY, 'mirvnuke');
    bus.y = bus.cy = 300;
    g.missiles.push(bus);
    g.airstrike.buy();
    g.callAirstrike();
    // 3 RVs + a double-counted bus = 5 slots -> 3 jets...
    expect(g.jets).toHaveLength(3);
    // ...and the bus sits on exactly two rails, never twice on one jet.
    const perJet = g.jets.map((j) => j.rack.filter((t) => t === bus).length);
    expect(perJet.reduce((a, b) => a + b, 0)).toBe(2);
    expect(Math.max(...perJet)).toBe(1);
    // Two AAM hits exactly crack the 10-HP bus.
    expect(CONFIG.airstrike.missile.blastDamage * 2).toBeGreaterThanOrEqual(
      CONFIG.missile.hp.mirvnuke
    );
  });

  it('a released small warhead is NOT double-counted (post-split)', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    const sub = parkTarget(g, 700, 300);
    sub.type = 'nuke';
    sub.subnuke = true; // a MIRV-nuke child: small, lightly armoured
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets).toHaveLength(1); // one enemy, one rail
    expect(g.jets[0].rack).toHaveLength(1);
  });

  it('AAM retasking never engages a cloaked stealth missile', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    g.spawnCruise('stealth');
    expect(g.missiles[0].stealthed).toBe(true);
    // The retasking picker — used when an AAM's target dies mid-flight —
    // sees nothing to engage while only the cloaked threat is up.
    expect(g.nearestAirTarget(700, 400, true)).toBeNull();
    expect(g.nearestAirTarget(700, 400)).toBeNull();
  });

  it('cloaked stealth missiles draw no AAMs', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.toSpawn = 0;
    g.spawnCruise('stealth');
    expect(g.missiles[0].stealthed).toBe(true);
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets).toHaveLength(0); // nothing visible to engage
    expect(g.airstrike.ready).toBe(true);
  });

  it('jets ripple-fire their racks once over the field', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    parkTarget(g, 700, 200);
    parkTarget(g, 900, 400);
    g.airstrike.buy();
    g.callAirstrike();
    // Fly the strike for a few seconds of sim time.
    for (let i = 0; i < 600 && g.aamList.length === 0; i++) g.update(1 / 60);
    expect(g.aamList.length).toBeGreaterThan(0);
    const aam = g.aamList[0];
    expect(aam.kind).toBe('aam');
    expect(aam.cfg).toBe(CONFIG.airstrike.missile);
    // Born fast: at least the rail speed off the carrier.
    expect(Math.hypot(aam.vx, aam.vy)).toBeGreaterThanOrEqual(
      CONFIG.airstrike.missile.launchSpeed - 1
    );
  });

  it('every visible enemy gets exactly one missile', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    const a = parkTarget(g, 700, 250);
    const b = parkTarget(g, 800, 350);
    g.airstrike.buy();
    g.callAirstrike();
    expect(g.jets).toHaveLength(1); // two neighbours share one jet
    const racked = g.jets.flatMap((j) => j.rack);
    expect(racked).toContain(a);
    expect(racked).toContain(b);
    expect(racked).toHaveLength(2); // one AAM per enemy, no carpet bombing
  });

  it('pitches its nose onto the target line, within the airframe limits', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    const target = parkTarget(g, 1000, 900); // well below the entry line
    const jet = new FriendlyJet(200, 300, 1, [target], g.W);
    const maxPitch = (CONFIG.airstrike.maxPitchDeg * Math.PI) / 180;
    let maxSeen = 0;
    let fired = null;
    for (let i = 0; i < 180 && !fired; i++) {
      fired = jet.update(1 / 60);
      maxSeen = Math.max(maxSeen, Math.abs(Math.atan2(jet.vy, jet.vx)));
    }
    expect(fired).toBe(target); // the nose-aim pass ends in a launch
    expect(maxSeen).toBeGreaterThan(0.1); // it genuinely pitched down...
    expect(maxSeen).toBeLessThanOrEqual(maxPitch + 1e-6); // ...within reason
  });

  it('fires the AAM straight off the nose, not at the target line', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    const target = parkTarget(g, 1000, 700);
    const jet = new FriendlyJet(600, 300, 1, [target], g.W);
    jet.vx = 500;
    jet.vy = 260; // mid-pitch: the round must inherit THIS heading
    g.fireAAM(jet, target);
    const aam = g.aamList[0];
    const jetAng = Math.atan2(jet.vy, jet.vx);
    const aamAng = Math.atan2(aam.vy, aam.vx);
    expect(aamAng).toBeCloseTo(jetAng, 6);
    expect(Math.hypot(aam.vx, aam.vy)).toBeCloseTo(CONFIG.airstrike.missile.launchSpeed, 6);
  });

  it('an AAM guides on a target BELOW its rail (regression: steering gate)', () => {
    // The interceptor's cold-launch climb gate must not apply to a rail shot:
    // with steerAfterClimb 0 a round diving on a lower target steers at once.
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    const target = parkTarget(g, 1000, 700); // well below the jet's altitude
    const jet = new FriendlyJet(600, 300, 1, [target], g.W);
    g.fireAAM(jet, target);
    const aam = g.aamList[0];
    let r = null;
    for (let i = 0; i < 300 && r === null; i++) r = aam.update(1 / 60, g.groundY);
    expect(r).toBe('detonate');
    expect(Math.hypot(aam.x - target.x, aam.y - target.y)).toBeLessThanOrEqual(
      CONFIG.airstrike.missile.detonateRadius + 1
    );
  });

  it('an AAM flies interceptor mechanics: homes, detonates, area-kills', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    g.missiles = [];
    const target = parkTarget(g, 1000, 300);
    const jet = new FriendlyJet(700, 300, 1, [target], g.W);
    g.fireAAM(jet, target);
    expect(g.aamList).toHaveLength(1);
    const aam = g.aamList[0];
    let r = null;
    for (let i = 0; i < 300 && r === null; i++) r = aam.update(1 / 60, g.groundY);
    expect(r).toBe('detonate');
    g.detonateInterceptor(aam);
    expect(target.dead).toBe(true); // 1-HP RV dies to the small warhead
  });

  it('an unused package carries over the wave boundary', () => {
    const g = newGame();
    g.startGame();
    g.airstrike.buy();
    g.toSpawn = 0;
    g.missiles = [];
    g.pendingNukes = [];
    g.endWave();
    expect(g.airstrike.ready).toBe(true);
    g.proceedToNextWave();
    expect(g.airstrike.ready).toBe(true);
  });

  it('the sandbox loadout grants and re-arms the package', () => {
    const g = newGame();
    g.devLoadout = true;
    g.startSandbox({ key: 'rain', type: 'normal', maxLive: 6, gap: 1 });
    expect(g.airstrike.ready).toBe(true);
    g.update(1 / 60); // let the sandbox put something in the sky
    g.callAirstrike();
    expect(g.airstrike.ready).toBe(false);
    for (let i = 0; i < 60 * 10; i++) g.update(1 / 60); // re-arm clock runs
    expect(g.airstrike.ready).toBe(true);
  });
});

describe('MIRV nuke', () => {
  it('arrives via the launch warning, hot and lightly armoured', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    g.pendingNukes = [];
    g.spawnNuke('mirvnuke');
    expect(g.pendingNukes).toHaveLength(1);
    expect(g.pendingNukes[0].type).toBe('mirvnuke');
    for (let i = 0; i < 4 * 60; i++) g.update(1 / 60);
    const bus = g.missiles.find((m) => m.type === 'mirvnuke');
    expect(bus).toBeDefined();
    expect(bus.maxHp).toBe(CONFIG.missile.hp.mirvnuke);
    expect(bus.maxHp).toBeLessThan(CONFIG.missile.hp.nuke); // less armour...
    expect(CONFIG.missile.mirvNuke.speedFactor).toBeGreaterThan(
      CONFIG.missile.nuke.speedFactor // ...but faster than the nuke
    );
  });

  it('splits into three small warheads aimed at different cities', () => {
    const g = newGame();
    g.startGame();
    g.missiles = [];
    const bus = new EnemyMissile(700, -10, 700, g.groundY, 400, 0, g.groundY, 'mirvnuke');
    g.missiles.push(bus);
    let r = null;
    let guard = 0;
    while (r === null && guard++ < 6000) r = bus.update(1 / 60, g.groundY);
    expect(r).toBe('split');
    expect(bus.dead).toBe(true); // the spent carrier is gone
    g.splitMissile(bus);
    const kids = g.missiles.filter((m) => m.subnuke);
    expect(kids).toHaveLength(CONFIG.missile.mirvNuke.children);
    for (const k of kids) {
      expect(k.type).toBe('nuke'); // behaves as a (small) air-bursting nuke
      expect(k.maxHp).toBe(CONFIG.missile.mirvNuke.childHp);
    }
    // Three warheads, three different cities (six stand, so no doubling).
    const aims = new Set(kids.map((k) => Math.round(k.targetX / 80)));
    expect(aims.size).toBe(kids.length);
  });

  it('a small warhead levels only the city under the burst', () => {
    const g = newGame();
    g.startGame();
    const target = g.cities[1];
    g.impact({
      type: 'nuke',
      subnuke: true,
      x: target.x,
      y: g.groundY - CONFIG.missile.nuke.burstHeight,
    });
    expect(target.alive).toBe(false);
    expect(g.cities[0].alive).toBe(true); // neighbours survive the small yield
    expect(g.cities[2].alive).toBe(true);
  });

  it('pays the carrier bounty unsplit and the small-warhead bounty after', () => {
    const g = newGame();
    g.startGame();
    const b = CONFIG.economy.bounty;
    expect(g.missileBounty({ type: 'mirvnuke', splitsRemaining: 0 })).toBe(b.mirvnuke);
    expect(g.missileBounty({ type: 'nuke', subnuke: true, splitsRemaining: 0 })).toBe(
      b.subnuke
    );
  });

  it('chooseThreat rolls it only in the very late game, under its cap', () => {
    const g = newGame();
    g.startGame();
    g.waveSpawnTotal = 30;
    g.toSpawn = 15;
    const MN = CONFIG.missile.mirvNuke;
    g.wave = MN.fromWave - 1;
    g.mirvNukesSpawned = 0;
    for (let i = 0; i < 200; i++) expect(g.chooseThreat().type).not.toBe('mirvnuke');
    g.wave = MN.fromWave;
    expect(withRandom(0, () => g.chooseThreat().type)).toBe('mirvnuke');
    g.mirvNukesSpawned = MN.maxPerWave;
    for (let i = 0; i < 200; i++) expect(g.chooseThreat().type).not.toBe('mirvnuke');
  });
});

describe('Evasive jink (rebalanced)', () => {
  it('is meaningfully faster than a plain RV', () => {
    expect(CONFIG.missile.evasive.speedFactor).toBeGreaterThanOrEqual(1.3);
  });

  it('an AAM can still miss a hard-jinking target (mechanics intact)', () => {
    // Not a flakiness trap — just proves the guidance returns SOMETHING other
    // than a guaranteed hit: fired away from the target, the round must turn,
    // and either detonates near it or runs out of energy (fizzle/detonate on
    // self-destruct). Both are legal outcomes of real guidance.
    const target = { x: 200, y: 900, dead: false };
    const aam = new Interceptor(700, 300, target, {
      cfg: CONFIG.airstrike.missile,
      kind: 'aam',
      vx: CONFIG.airstrike.missile.launchSpeed, // pointed the wrong way
      vy: 0,
    });
    let r = null;
    for (let i = 0; i < 600 && r === null; i++) r = aam.update(1 / 60, G);
    expect(['detonate', 'fizzle']).toContain(r);
  });
});
