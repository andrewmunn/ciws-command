import { describe, it, expect } from 'bun:test';
import { CIWSWeapon, InterceptorWeapon, LaserWeapon } from '../js/weapons.js';
import { Turret, Bullet, Interceptor } from '../js/entities.js';
import { deg2rad } from '../js/utils.js';
import { CONFIG } from '../js/config.js';

const G = CONFIG.world.height - CONFIG.groundHeight;

describe('CIWSWeapon', () => {
  it('fires a bullet and sets the cooldown (the belt is infinite)', () => {
    const w = new CIWSWeapon();
    const t = new Turret(100, G);
    const shots = w.fireFrom(t);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toBeInstanceOf(Bullet);
    expect(t.ammo).toBe(Infinity); // never runs dry
    expect(t.cooldown).toBeCloseTo(w.fireInterval, 9);
    expect(t.muzzleFlash).toBeGreaterThan(0);
  });

  it('refuses to fire while on cooldown, empty, or destroyed', () => {
    const w = new CIWSWeapon();
    const t = new Turret(100, G);
    w.fireFrom(t); // sets cooldown
    expect(w.fireFrom(t)).toHaveLength(0); // still cooling down
    t.cooldown = 0;
    t.ammo = 0;
    expect(w.fireFrom(t)).toHaveLength(0); // empty
    const dead = new Turret(100, G);
    dead.alive = false;
    expect(w.fireFrom(dead)).toHaveLength(0);
  });

  it('disperses shots within the configured cone', () => {
    const w = new CIWSWeapon();
    const t = new Turret(100, G);
    t.angle = -Math.PI / 2;
    const spread = deg2rad(w.dispersionDeg);
    for (let i = 0; i < 300; i++) {
      t.cooldown = 0;
      t.ammo = 10;
      const b = w.fireFrom(t)[0];
      const a = Math.atan2(b.vy, b.vx);
      expect(Math.abs(a - t.angle)).toBeLessThanOrEqual(spread + 1e-9);
    }
  });

  it('fire-rate upgrades shorten the interval, one factor per level', () => {
    const w = new CIWSWeapon();
    const base = w.fireInterval;
    for (let i = 0; i < CONFIG.shop.fireRateCosts.length; i++) w.upgradeFireRate();
    expect(w.fireInterval).toBeCloseTo(
      base * Math.pow(CONFIG.shop.fireRateFactor, CONFIG.shop.fireRateCosts.length),
      9
    );
  });

  it('reloads living turrets to capacity but not dead ones', () => {
    const w = new CIWSWeapon();
    const alive = new Turret(0, G);
    alive.ammo = 7;
    const dead = new Turret(0, G);
    dead.alive = false;
    dead.ammo = 7;
    w.reloadAll([alive, dead]);
    expect(alive.ammo).toBe(w.ammoCapacity);
    expect(dead.ammo).toBe(7);
  });

  it('fire-rate upgrade shortens the fire interval', () => {
    const w = new CIWSWeapon();
    const fi0 = w.fireInterval;
    w.upgradeFireRate();
    expect(w.fireInterval).toBeLessThan(fi0);
    expect(w.fireInterval).toBeCloseTo(w.baseInterval * CONFIG.shop.fireRateFactor, 9);
    expect(w.fireRateLevel).toBe(1);
  });
});

describe('InterceptorWeapon', () => {
  it('does nothing until bought; buying fields it fully loaded', () => {
    const w = new InterceptorWeapon();
    expect(w.owned).toBe(false);
    expect(w.canLaunch).toBe(false);
    expect(w.launch(0, 0, null)).toBeNull(); // not fielded yet
    w.buy();
    expect(w.owned).toBe(true);
    expect(w.canLaunch).toBe(true); // fresh from the factory: loaded
    expect(w.cooldown).toBe(CONFIG.interceptor.cooldowns[0]);
  });

  it('launching starts the reload; a second launch is refused until ready', () => {
    const w = new InterceptorWeapon();
    w.buy();
    w.timer = 0;
    const it = w.launch(0, 0, null);
    expect(it).toBeInstanceOf(Interceptor);
    expect(w.canLaunch).toBe(false);
    expect(w.launch(0, 0, null)).toBeNull(); // still reloading
    w.update(w.cooldown); // wait out the reload
    expect(w.canLaunch).toBe(true);
    expect(w.launch(0, 0, null)).toBeInstanceOf(Interceptor);
  });

  it('refill brings the pod back fully loaded at wave start', () => {
    const w = new InterceptorWeapon();
    w.buy();
    w.timer = 0;
    w.launch(0, 0, null); // mid-reload at wave end
    expect(w.canLaunch).toBe(false);
    w.refill();
    expect(w.canLaunch).toBe(true); // loaded and ready
  });

  it('cooldown upgrades shorten the reload down to the configured floor', () => {
    const w = new InterceptorWeapon();
    const ladder = CONFIG.interceptor.cooldowns;
    for (let i = 1; i < ladder.length; i++) {
      w.upgradeCooldown();
      expect(w.cooldown).toBe(ladder[i]);
    }
    w.upgradeCooldown(); // past max: clamped
    expect(w.cooldown).toBe(ladder[ladder.length - 1]);
  });
});

describe('LaserWeapon', () => {
  it('does nothing until bought, then starts charged', () => {
    const w = new LaserWeapon();
    expect(w.canFire).toBe(false);
    w.buy();
    expect(w.owned).toBe(true);
    expect(w.canFire).toBe(true);
  });

  it('firing starts the recharge; update() brings it back', () => {
    const w = new LaserWeapon();
    w.buy();
    w.fire();
    expect(w.canFire).toBe(false);
    w.update(w.rechargeTime);
    expect(w.canFire).toBe(true);
  });

  it('engages every live threat type (only the dead are off the menu)', () => {
    const w = new LaserWeapon();
    const mk = (type, splits = 0) => ({ dead: false, type, splitsRemaining: splits });
    for (const type of ['drone', 'normal', 'evasive', 'hypersonic', 'cruise', 'bomber', 'nuke', 'mirvnuke', 'glidebomb']) {
      expect(w.canTarget(mk(type))).toBe(true);
    }
    expect(w.canTarget(mk('normal', 3))).toBe(true); // MIRV carrier: a long burn
    expect(w.canTarget({ dead: true, type: 'drone', splitsRemaining: 0 })).toBe(false);
  });

  it('starts on a 5-second recharge', () => {
    const w = new LaserWeapon();
    w.buy();
    expect(w.rechargeTime).toBe(5);
  });

  it('recharge upgrades shorten the cycle and clamp at the floor', () => {
    const w = new LaserWeapon();
    w.buy();
    const ladder = CONFIG.laser.cooldowns;
    for (let i = 1; i < ladder.length; i++) {
      w.upgradeRecharge();
      expect(w.rechargeTime).toBe(ladder[i]);
    }
    w.upgradeRecharge();
    expect(w.rechargeTime).toBe(ladder[ladder.length - 1]);
  });
});
