import { describe, it, expect } from 'bun:test';
import {
  City,
  Turret,
  Bullet,
  EnemyMissile,
  Interceptor,
  Particle,
  explode,
} from '../js/entities.js';
import { CONFIG } from '../js/config.js';

const G = CONFIG.world.height - CONFIG.groundHeight; // groundY

describe('City', () => {
  it('starts alive with a generated skyline', () => {
    const c = new City(200, G);
    expect(c.alive).toBe(true);
    expect(c.buildings.length).toBeGreaterThan(0);
    for (const b of c.buildings) {
      expect(b.w).toBeGreaterThan(0);
      expect(b.h).toBeGreaterThan(0);
    }
  });
});

describe('Turret', () => {
  it('is usable only when alive with ammo', () => {
    const t = new Turret(100, G);
    expect(t.usable).toBe(true);
    t.ammo = 0;
    expect(t.usable).toBe(false);
    t.ammo = 10;
    t.alive = false;
    expect(t.usable).toBe(false);
  });

  it('decays cooldown / recoil / muzzle flash over time', () => {
    const t = new Turret(100, G);
    t.cooldown = 1;
    t.recoil = 6;
    t.muzzleFlash = 1;
    t.update(0.1);
    expect(t.cooldown).toBeCloseTo(0.9, 6);
    expect(t.recoil).toBeLessThan(6);
    expect(t.muzzleFlash).toBeLessThan(1);
  });

  it('reports the muzzle position at the barrel tip', () => {
    const t = new Turret(100, G);
    t.angle = -Math.PI / 2; // straight up
    const m = t.muzzle();
    expect(m.x).toBeCloseTo(100, 6);
    expect(m.y).toBeCloseTo(t.y - CONFIG.turret.barrelLength, 6);
  });
});

describe('Bullet', () => {
  it('launches at muzzle velocity in the aimed direction', () => {
    const b = new Bullet(0, 500, 0); // +x
    expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(CONFIG.bullet.speed, 6);
    expect(b.vx).toBeGreaterThan(0);
    expect(b.vy).toBeCloseTo(0, 6);
  });

  it('feels gravity (a horizontal shot starts to drop) and drag (vx falls)', () => {
    const b = new Bullet(0, 500, 0);
    const vx0 = b.vx;
    b.update(1 / 60, G);
    expect(b.vy).toBeGreaterThan(0); // gravity pulled it down
    expect(b.vx).toBeLessThan(vx0); // drag slowed it
    expect(b.x).toBeGreaterThan(0); // moved forward
  });

  it('an upward shot decelerates', () => {
    const b = new Bullet(0, 500, -Math.PI / 2); // straight up (vy negative)
    const vy0 = b.vy;
    b.update(1 / 60, G);
    expect(b.vy).toBeGreaterThan(vy0); // less negative => slowing
    expect(b.y).toBeLessThan(500); // still moved up this frame
  });

  it('dies after its lifetime', () => {
    const b = new Bullet(0, 500, 0);
    b.update(CONFIG.bullet.lifetime + 0.1, G);
    expect(b.dead).toBe(true);
  });

  it('burns out on speed, not on nosing over', () => {
    // A vertical shot still dies near its apogee (it runs out of speed)...
    const up = new Bullet(700, G - 21, -Math.PI / 2);
    let t = 0;
    while (!up.dead && t < 5) {
      up.update(1 / 60, G);
      t += 1 / 60;
    }
    expect(up.dead).toBe(true);
    expect(Math.hypot(up.vx, up.vy)).toBeLessThan(CONFIG.bullet.fadeSpeed + 1);
    expect(t).toBeLessThan(CONFIG.bullet.lifetime); // not just the life timer

    // ...but a shallow shot survives its apex and keeps flying as it falls.
    const flat = new Bullet(0, G - 600, (-20 * Math.PI) / 180);
    let fell = false;
    for (let i = 0; i < 90 && !flat.dead; i++) {
      flat.update(1 / 60, G);
      if (flat.vy > 0) fell = true; // past apex, descending
    }
    expect(fell).toBe(true);
    expect(flat.dead).toBe(false); // still alive and lethal on the way down
  });
});

describe('EnemyMissile', () => {
  it('sets HP and drag by variant', () => {
    const norm = new EnemyMissile(0, 0, 0, G, 150, 0, G, 'normal');
    expect(norm.maxHp).toBe(CONFIG.missile.hp.normal);
    expect(norm.dragMul).toBe(1);

    const ev = new EnemyMissile(0, 0, 0, G, 150, 0, G, 'evasive');
    expect(ev.maxHp).toBe(CONFIG.missile.hp.evasive);
    expect(ev.jinking).toBe(true);

    const hyp = new EnemyMissile(0, 0, 0, G, 150, 0, G, 'hypersonic');
    expect(hyp.maxHp).toBe(CONFIG.missile.hp.hypersonic);
    expect(hyp.dragMul).toBe(CONFIG.missile.hypersonic.dragFactor);

    const mirv = new EnemyMissile(0, 0, 0, G, 150, 3, G, 'normal');
    expect(mirv.maxHp).toBe(CONFIG.missile.hp.mirv);
    expect(mirv.childCount).toBe(3);
  });

  it('slows down as it descends into denser air', () => {
    const m = new EnemyMissile(700, 0, 700, G, 150, 0, G, 'normal');
    const s0 = Math.hypot(m.vx, m.vy);
    for (let i = 0; i < 120; i++) m.update(1 / 60, G);
    expect(Math.hypot(m.vx, m.vy)).toBeLessThan(s0);
  });

  it('a hypersonic keeps more speed than a normal missile near the ground', () => {
    const h = new EnemyMissile(700, 0, 700, G, 150, 0, G, 'hypersonic');
    const n = new EnemyMissile(700, 0, 700, G, 150, 0, G, 'normal');
    while (h.cy < G * 0.85) h.update(1 / 60, G);
    while (n.cy < G * 0.85) n.update(1 / 60, G);
    expect(Math.hypot(h.vx, h.vy)).toBeGreaterThan(Math.hypot(n.vx, n.vy));
  });

  it('impacts when it reaches the ground', () => {
    const m = new EnemyMissile(100, G - 1, 100, G + 200, 120, 0, G, 'normal');
    const r = m.update(0.2, G);
    expect(r).toBe('impact');
    expect(m.dead).toBe(true);
    expect(m.reachedGround).toBe(true);
  });

  it('splits at altitude and sheds its armour afterwards', () => {
    const m = new EnemyMissile(100, 0, 100, G, 150, 3, G, 'normal');
    m.splitY = 50;
    let r = null;
    let guard = 0;
    while (r === null && guard++ < 2000) r = m.update(1 / 60, G);
    expect(r).toBe('split');
    expect(m.splitsRemaining).toBe(0);
    expect(m.maxHp).toBe(CONFIG.missile.hp.normal);
    expect(m.childCount).toBe(3); // preserved for the spawner
  });

  it('evasive jink stays inside its leash but is non-zero', () => {
    const m = new EnemyMissile(700, 0, 700, G, 150, 0, G, 'evasive');
    let maxOffset = 0;
    for (let i = 0; i < 240; i++) {
      m.update(1 / 60, G);
      maxOffset = Math.max(maxOffset, Math.hypot(m.x - m.cx, m.y - m.cy));
    }
    expect(maxOffset).toBeGreaterThan(0);
    // The predictive flip commits at the leash; one integration step of
    // overshoot (latVel * dt) is the worst case, so allow a small margin.
    const ev = CONFIG.missile.evasive;
    expect(maxOffset).toBeLessThanOrEqual(ev.jinkOffsetMax * 1.15);
  });

  it('evasive jink is real maneuvering: lateral acceleration is bounded', () => {
    const ev = CONFIG.missile.evasive;
    const m = new EnemyMissile(700, 0, 700, G, 150, 0, G, 'evasive');
    const dt = 1 / 60;
    let prevVel = m.jinkVel;
    for (let i = 0; i < 240; i++) {
      m.update(dt, G);
      // The lateral velocity can only change as fast as the configured
      // thruster authority allows — no teleporting offsets.
      expect(Math.abs(m.jinkVel - prevVel)).toBeLessThanOrEqual(ev.jinkAccel * dt + 1e-9);
      prevVel = m.jinkVel;
    }
  });

  it('reports heading: equal to velocity for normal, deflected for evasive', () => {
    const norm = new EnemyMissile(700, 0, 700, G, 150, 0, G, 'normal');
    norm.update(1 / 60, G);
    expect(norm.hx).toBeCloseTo(norm.vx, 6);
    expect(norm.hy).toBeCloseTo(norm.vy, 6);

    const ev = new EnemyMissile(700, 0, 700, G, 150, 0, G, 'evasive');
    let deflected = false;
    for (let i = 0; i < 60; i++) {
      ev.update(1 / 60, G);
      if (Math.abs(ev.hx - ev.vx) > 1) deflected = true;
    }
    expect(deflected).toBe(true);
  });

  it('records a trail capped at the configured length', () => {
    const m = new EnemyMissile(700, 0, 700, G, 300, 0, G, 'normal');
    for (let i = 0; i < 240; i++) m.update(1 / 60, G);
    expect(m.trail.length).toBeGreaterThan(1);
    expect(m.trail.length).toBeLessThanOrEqual(CONFIG.missile.trailMaxPoints);
  });
});

describe('Interceptor', () => {
  it('accelerates during boost then coasts (decelerates)', () => {
    const it = new Interceptor(700, G, null); // no target -> flies straight up
    expect(it.boosting).toBe(true);
    const s0 = Math.hypot(it.vx, it.vy);
    let guard = 0;
    while (it.age < CONFIG.interceptor.boostTime && guard++ < 500) it.update(1 / 60, G);
    const sBoost = Math.hypot(it.vx, it.vy);
    expect(it.boosting).toBe(false);
    expect(sBoost).toBeGreaterThan(s0);
    expect(sBoost).toBeGreaterThanOrEqual(CONFIG.interceptor.maxSpeed * 0.9);

    // Coast: gravity + drag bleed energy from an upward-moving interceptor.
    const coast = new Interceptor(700, G, null);
    coast.age = CONFIG.interceptor.boostTime + 1;
    coast.vx = 0;
    coast.vy = -500;
    const before = Math.hypot(coast.vx, coast.vy);
    coast.update(1 / 60, G);
    expect(Math.hypot(coast.vx, coast.vy)).toBeLessThan(before);
  });

  it('climbs straight up first, then homes toward its target', () => {
    const target = { x: 200, y: G, dead: false };
    const it = new Interceptor(700, G, target);
    while (it.launchY - it.y < CONFIG.interceptor.steerAfterClimb) {
      it.update(1 / 60, G);
      expect(it.x).toBe(700); // guidance locked during the launch climb
    }
    for (let i = 0; i < 40; i++) it.update(1 / 60, G);
    expect(it.x).toBeLessThan(700); // now turning out toward the target
  });

  it('detonates within range of the target', () => {
    const target = { x: 715, y: G, dead: false }; // 15px < detonateRadius
    const it = new Interceptor(700, G, target);
    expect(it.update(1 / 60, G)).toBe('detonate');
    expect(it.dead).toBe(true);
  });

  it('turning during coast scrubs extra speed (maneuvering costs energy)', () => {
    const behind = { x: 0, y: 800, dead: false };
    const turner = new Interceptor(700, 800, behind);
    turner.launchY = 2000; // well past the launch climb: free to steer
    turner.age = CONFIG.interceptor.boostTime + 1; // coasting
    turner.vx = 800;
    turner.vy = 0; // flying away from the target: max-rate turn required
    turner.update(1 / 60, G);

    const ahead = { x: 5000, y: 800, dead: false };
    const straight = new Interceptor(700, 800, ahead);
    straight.launchY = 2000;
    straight.age = CONFIG.interceptor.boostTime + 1;
    straight.vx = 800;
    straight.vy = 0; // already aligned: no turn
    straight.update(1 / 60, G);

    expect(Math.hypot(turner.vx, turner.vy)).toBeLessThan(
      Math.hypot(straight.vx, straight.vy)
    );
  });

  it('self-destructs once maneuvering energy drops below the floor', () => {
    const target = { x: 100, y: 100, dead: false };
    const it = new Interceptor(700, 800, target);
    it.age = CONFIG.interceptor.boostTime + 1; // coasting
    it.vx = CONFIG.interceptor.minSpeed - 60;
    it.vy = 0;
    const r = it.update(1 / 60, G);
    expect(it.dead).toBe(true);
    expect(r).toBe('detonate'); // pops its warhead rather than wallowing
  });

  it('drops a dead target and fizzles with none left', () => {
    const target = { x: 700, y: 400, dead: false };
    const it = new Interceptor(700, G, target);
    target.dead = true;
    it.update(1 / 60, G);
    expect(it.target).toBeNull();
    let r = null;
    let guard = 0;
    while (r === null && guard++ < 4000) r = it.update(1 / 60, G);
    expect(r).toBe('fizzle');
  });
});

describe('Particle / explode', () => {
  it('a particle drifts, drags, and dies', () => {
    const p = new Particle(10, 10, '#fff');
    const s0 = Math.hypot(p.vx, p.vy);
    p.update(1 / 60);
    expect(Math.hypot(p.vx, p.vy)).toBeLessThan(s0);
    let guard = 0;
    while (!p.dead && guard++ < 1000) p.update(1 / 60);
    expect(p.dead).toBe(true);
  });

  it('explode pushes the requested number of particles', () => {
    const out = [];
    explode(out, 0, 0, '#fff', 12);
    expect(out).toHaveLength(12);
  });
});
