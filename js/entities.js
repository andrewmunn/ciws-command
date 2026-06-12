// ---------------------------------------------------------------------------
// Game entities. Each owns its own state plus an update(dt) method. Rendering
// is handled entirely by the WebGL renderer (renderer3d.js), which reads these
// fields directly — entities carry no draw code of their own.
//
// Coordinates are in simulation space: x in [0, W], y from 0 (top) down to the
// ground. The renderer maps that to 3D world space.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { rand, randInt, dist } from './utils.js';
import { airDensity, applyDrag } from './physics.js';

// ---------------------------------------------------------------------------
// City — a cluster of buildings to defend. Static; just alive/dead state plus
// a stable skyline the renderer turns into extruded boxes.
// ---------------------------------------------------------------------------
export class City {
  constructor(x, groundY) {
    this.x = x;
    this.groundY = groundY;
    this.alive = true;
    this.shields = 0; // active bubbles (absorptions available)
    this.shieldMax = 0; // purchased capacity
    this.shieldTimer = CONFIG.shield.rechargeTimes[0]; // regen countdown
    this.shieldFlash = 0; // collapse-effect timer when the shield fails
    this.width = 116;
    this.buildings = [];
    // Two staggered rows of towers: a taller foreground row and a shorter,
    // pushed-back row peeking between them — a proper little skyline. Each
    // entry carries a depth offset (z) and flags the renderer uses for
    // detailing (spire on the tallest, rooftop plant on the chunky ones).
    let tallest = null;
    for (const [row, z, n, hLo, hHi] of [
      [0, 6, 6, 14, 30],
      [1, -7, 7, 22, 48],
    ]) {
      const slot = this.width / n;
      for (let i = 0; i < n; i++) {
        const b = {
          x: -this.width / 2 + i * slot + slot / 2 + rand(-2, 2),
          w: slot - rand(3, 6),
          h: rand(hLo, hHi),
          z,
          spire: false,
          roof: row === 0 && Math.random() < 0.5,
        };
        this.buildings.push(b);
        if (!tallest || b.h > tallest.h) tallest = b;
      }
    }
    tallest.spire = true;
    tallest.roof = false;
  }
}

// ---------------------------------------------------------------------------
// Turret — a CIWS mount. Aims at a target point and fires a rapid bullet
// stream. Holds its own ammo belt and fire-rate cooldown.
// ---------------------------------------------------------------------------
export class Turret {
  constructor(x, groundY) {
    this.x = x;
    this.groundY = groundY;
    this.y = groundY - CONFIG.turret.pivotHeight; // gun trunnion atop the mount
    this.alive = true;
    this.shields = 0; // active bubbles (absorptions available)
    this.shieldMax = 0; // purchased capacity
    this.shieldTimer = CONFIG.shield.rechargeTimes[0]; // regen countdown
    this.shieldFlash = 0; // collapse-effect timer when the shield fails
    this.ammo = CONFIG.turret.startAmmo;
    this.angle = -Math.PI / 2; // pointing straight up
    this.cooldown = 0;
    this.recoil = 0; // visual barrel kickback, decays to 0
    this.muzzleFlash = 0; // brief flash intensity, decays to 0
  }

  get usable() {
    return this.alive && this.ammo > 0;
  }

  aimAt(tx, ty) {
    this.angle = Math.atan2(ty - this.y, tx - this.x);
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 60);
    if (this.muzzleFlash > 0) this.muzzleFlash = Math.max(0, this.muzzleFlash - dt * 8);
  }

  /** Muzzle position for the current aim (used by the CIWS weapon). */
  muzzle() {
    return {
      x: this.x + Math.cos(this.angle) * CONFIG.turret.barrelLength,
      y: this.y + Math.sin(this.angle) * CONFIG.turret.barrelLength,
    };
  }
}

// ---------------------------------------------------------------------------
// Bullet — a CIWS tracer round. Straight line, self-destructs after a lifetime
// or when it leaves the world / hits a missile.
// ---------------------------------------------------------------------------
export class Bullet {
  constructor(x, y, angle) {
    const s = CONFIG.bullet.speed;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * s;
    this.vy = Math.sin(angle) * s;
    this.life = CONFIG.bullet.lifetime;
    this.dead = false;
  }

  update(dt, groundY) {
    // Drag (denser air lower down) then gravity, so rounds slow and arc.
    applyDrag(this, CONFIG.physics.bulletDrag, airDensity(this.y, groundY), dt);
    this.vy += CONFIG.physics.gravity * CONFIG.physics.bulletGravityMul * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // A round burns out once it's spent — slowed below fadeSpeed. A vertical
    // shot still dies near its apogee (speed -> 0 up there), but a flat shot
    // keeps flying its whole arc instead of vanishing as it noses over.
    const sp2 = this.vx * this.vx + this.vy * this.vy;
    if (sp2 < CONFIG.bullet.fadeSpeed * CONFIG.bullet.fadeSpeed) this.dead = true;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
}

// ---------------------------------------------------------------------------
// EnemyMissile — descends from the top toward a target structure. Variants:
//   'normal'  — straight line.
//   'evasive' — weaves side-to-side around its core path (harder to hit).
// May also MIRV-split into children at altitude. Keeps a trail polyline.
// ---------------------------------------------------------------------------
export class EnemyMissile {
  constructor(
    startX,
    startY,
    targetX,
    targetY,
    speed,
    splitsRemaining = 0,
    playHeight = 0,
    type = 'normal'
  ) {
    this.id = EnemyMissile._nextId++; // stable id (used to distribute auto-gun fire)
    this.type = type;
    this.startX = startX;
    this.startY = startY;
    // Core position advances along the straight aim line; the rendered/colliding
    // position adds the weave offset on top.
    this.cx = startX;
    this.cy = startY;
    this.x = startX;
    this.y = startY;
    this.targetX = targetX;
    this.targetY = targetY;
    this.speed = speed;
    this.radius = CONFIG.missile.radius;
    this.dead = false;
    this.reachedGround = false;
    this.age = 0;

    const dx = targetX - startX;
    const dy = targetY - startY;
    const len = Math.hypot(dx, dy) || 1;
    this.vx = (dx / len) * speed;
    this.vy = (dy / len) * speed;
    // Unit perpendicular to the direction of travel (for the weave).
    this.perpX = -this.vy / speed;
    this.perpY = this.vx / speed;
    // Instantaneous heading (core velocity + weave). Renderer points the
    // reentry cone along this so it banks as it jinks.
    this.hx = this.vx;
    this.hy = this.vy;

    // Evasive jink: a constant-magnitude lateral acceleration whose direction
    // reverses on an irregular timer — real maneuvering, integrated each
    // frame, rather than a scripted sine wobble. State: lateral offset from
    // the ballistic line, its velocity, and the current pull direction.
    this.jinking = type === 'evasive';
    this.jinkOff = 0;
    this.jinkVel = 0;
    this.jinkDir = Math.random() < 0.5 ? 1 : -1;
    this.jinkTimer = this.jinking ? rand(...CONFIG.missile.evasive.jinkHold) : 0;

    this.trail = [{ x: startX, y: startY }];

    // MIRV: `childCount` survives for the spawner; `splitsRemaining` is the
    // one-shot trigger flag that update() clears once the split fires.
    this.childCount = splitsRemaining;
    this.splitsRemaining = splitsRemaining;
    if (splitsRemaining > 0 && playHeight > 0) {
      const [lo, hi] = CONFIG.missile.splitAltitude;
      this.splitY = playHeight * rand(lo, hi);
    } else if (type === 'mirvnuke' && playHeight > 0) {
      // The MIRV-nuke bus splits on its own (lower) altitude band; the game
      // spawns its small-warhead children when update() reports 'split'.
      const [lo, hi] = CONFIG.missile.mirvNuke.splitAltitude;
      this.splitY = playHeight * rand(lo, hi);
    } else {
      this.splitY = Infinity;
    }

    // Hit points by variant (MIRV carriers and nukes are armoured).
    const hp = CONFIG.missile.hp;
    this.maxHp = splitsRemaining > 0 ? hp.mirv : hp[type] || hp.normal;
    this.hp = this.maxHp;
    this.subnuke = false; // set by the game on warheads a MIRV nuke releases
    this.hitFlash = 0; // brief white flash on a non-killing hit

    // Hypersonics barely feel drag, so they stay fast all the way down.
    this.dragMul = type === 'hypersonic' ? CONFIG.missile.hypersonic.dragFactor : 1;

    // Bomber: a powered, level pass across the sky (constructed with
    // targetY == startY, so the straight-line velocity is horizontal). It
    // carries a rack of glide bombs the game releases over the field.
    if (type === 'bomber') {
      const bc = CONFIG.missile.bomber;
      this.dragMul = 0; // engines hold its speed for the whole pass
      this.bombsLeft = randInt(bc.bombs[0], bc.bombs[1]);
      this.bombTimer = rand(bc.dropGap[0], bc.dropGap[1]);
      this.bombsAborted = false; // once forced to jink, the run never resumes
      this.evading = false; // set by the game while a threat is inbound
      this.breaking = false; // terminal hard pull (homing round in close)
      this.breakDir = 1; // committed pull direction, chosen at break start
      this.flareBursts = bc.flares.bursts; // decoy bursts left in the dispenser
      this.flareTimer = 0; // ready to punch flares the moment a threat appears
    }

    // Side-entry types (cruise / drone) fly a waypoint route instead of a
    // straight dive: in level at their spawn altitude, then (cruise only) a
    // pop-up climb, then a terminal dive onto the target. They steer between
    // legs with a capped turn rate, like a real terrain-hugging weapon.
    this.waypoints = null;
    // A stealth cruise missile is cloaked for its whole low-level run-in: no
    // render, no lock-on, no laser — only a blind CIWS sweep can touch it.
    // The cloak drops the moment the pop-up starts.
    this.stealthed = type === 'stealth';
    if (type === 'cruise' || type === 'drone' || type === 'stealth') {
      // Stealth flies the standard cruise profile.
      const cfg = CONFIG.missile[type === 'stealth' ? 'cruise' : type];
      const dir = targetX > startX ? 1 : -1;
      this.turnRate = cfg.turnRate;
      this.dragMul = 0; // powered flight: holds its speed all the way in
      this.waypoints = [];
      if (type !== 'drone') {
        this.waypoints.push({ x: targetX - dir * cfg.popupDist, y: startY });
        this.waypoints.push({
          x: targetX - dir * cfg.popupDist * 0.4,
          y: startY - cfg.popupHeight,
        });
      } else {
        this.waypoints.push({ x: targetX - dir * cfg.diveDist, y: startY });
      }
      this.waypoints.push({ x: targetX, y: targetY });
      this.wpIndex = 0;
      this.vx = dir * speed; // enters flying level
      this.vy = 0;
    }
  }

  /** Returns 'split', 'impact', or null. */
  update(dt, groundY) {
    this.age += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    // Drag scaled by air density: applied equally to vx/vy so direction toward
    // the target is preserved — the missile just slows as it sinks into denser
    // air near the ground.
    applyDrag(this, CONFIG.physics.missileDrag * this.dragMul, airDensity(this.cy, groundY), dt);

    // Bomber defensive flying. Weave while a threat is out there; when a
    // homing round closes to the break range, commit to one hard vertical
    // pull — displacement faster than the round's turn-rate correction is
    // what actually generates a miss. Settles back to level flight after.
    if (this.type === 'bomber') {
      const bc = CONFIG.missile.bomber;
      if (this.breaking) {
        // High-g S-turns: the pull REVERSES every breakFlip seconds. Raw
        // displacement can't outrun the round, but every reversal forces it
        // to re-point — and its turn bleed scrubs speed per radian, so a
        // good S can drain it below self-destruct energy.
        this.breakAge = (this.breakAge || 0) + dt;
        if (this.breakAge >= bc.breakFlip) {
          this.breakAge = 0;
          this.breakDir = -this.breakDir;
        }
        this.vy += (bc.breakAmp * this.breakDir - this.vy) * Math.min(1, dt * bc.breakRamp);
      } else if (this.evading) {
        this.breakAge = 0;
        // Phase starts at the moment evasion begins, so vy ramps from zero
        // instead of snapping to mid-sine.
        this.evadeAge = (this.evadeAge || 0) + dt;
        this.vy = Math.sin(this.evadeAge * bc.evadeFreq) * bc.evadeAmp;
      } else {
        this.evadeAge = 0;
        this.vy *= 0.9; // damp back to a level cruise
      }
      // Energy is conserved: total speed is capped just above cruise, so a
      // hard pull PITCHES the flight path — horizontal speed pays for the
      // climb — instead of adding free vertical velocity...
      const maxSp = this.speed * bc.maxSpeedFactor;
      const sp = Math.hypot(this.vx, this.vy);
      if (sp > maxSp) {
        const k = maxSp / sp;
        this.vx *= k;
        this.vy *= k;
      }
      // ...and the engines then push the run back up to cruise speed.
      const cruise = (Math.sign(this.vx) || 1) * this.speed;
      this.vx += (cruise - this.vx) * Math.min(1, dt * bc.thrustRecover);
      // Hard altitude band: never into the dirt, never off the top. A pull
      // that pins against the band flips so the escape can continue.
      const minY = groundY * bc.bandFrac[0];
      const maxY = groundY * bc.bandFrac[1];
      if (this.y < minY && this.vy < 0) {
        this.vy = 0;
        if (this.breaking) this.breakDir = 1;
      } else if (this.y > maxY && this.vy > 0) {
        this.vy = 0;
        if (this.breaking) this.breakDir = -1;
      }
    }

    // Waypoint flyers (cruise / drone): steer the heading toward the current
    // waypoint at a capped turn rate; speed stays constant.
    if (this.waypoints) {
      const wp = this.waypoints[this.wpIndex];
      const curAng = Math.atan2(this.vy, this.vx);
      const desAng = Math.atan2(wp.y - this.cy, wp.x - this.cx);
      let diff = desAng - curAng;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = this.turnRate * dt;
      if (diff > maxTurn) diff = maxTurn;
      else if (diff < -maxTurn) diff = -maxTurn;
      const ang = curAng + diff;
      this.vx = Math.cos(ang) * this.speed;
      this.vy = Math.sin(ang) * this.speed;
      // Advance to the next leg when this waypoint is reached OR overshot.
      // "Reached" must be at least the turning radius — with a tighter
      // threshold a flyer that misses by a little can circle a mid-air
      // waypoint forever (which stalls the wave). "Overshot" = the waypoint
      // is behind the direction of travel. The last waypoint is the target
      // itself — ride it into the ground.
      if (this.wpIndex < this.waypoints.length - 1) {
        const toX = wp.x - this.cx;
        const toY = wp.y - this.cy;
        const turnRadius = this.speed / this.turnRate;
        const close = Math.hypot(toX, toY) < Math.max(34, turnRadius * 1.1);
        const passed = toX * this.vx + toY * this.vy < 0;
        if (close || passed) {
          this.wpIndex++;
          // Decloak at the pop-up: from here it's visible and targetable.
          if (this.type === 'stealth') this.stealthed = false;
        }
      }
    }

    this.cx += this.vx * dt;
    this.cy += this.vy * dt;

    if (this.jinking) {
      // Bang-bang lateral guidance. The pull direction flips either when the
      // random hold timer expires, or — the bounding rule — the moment the
      // current pull could no longer turn the offset around inside the leash
      // (stopDist = off + v|v|/2a, the kinematic turn-around point). That
      // keeps the jink inside jinkOffsetMax without any scripted waveform.
      const ev = CONFIG.missile.evasive;
      const stop = this.jinkOff + (this.jinkVel * Math.abs(this.jinkVel)) / (2 * ev.jinkAccel);
      if (stop > ev.jinkOffsetMax) this.jinkDir = -1;
      else if (stop < -ev.jinkOffsetMax) this.jinkDir = 1;
      else {
        this.jinkTimer -= dt;
        if (this.jinkTimer <= 0) {
          this.jinkDir = Math.random() < 0.5 ? 1 : -1;
          this.jinkTimer = rand(...ev.jinkHold);
        }
      }
      this.jinkVel += this.jinkDir * ev.jinkAccel * dt;
      this.jinkOff += this.jinkVel * dt;
      this.x = this.cx + this.perpX * this.jinkOff;
      this.y = this.cy + this.perpY * this.jinkOff;
      // True velocity = core velocity + lateral velocity: the airframe banks
      // along its real flight path instead of wagging around a straight one.
      this.hx = this.vx + this.perpX * this.jinkVel;
      this.hy = this.vy + this.perpY * this.jinkVel;
    } else {
      this.x = this.cx;
      this.y = this.cy;
      this.hx = this.vx;
      this.hy = this.vy;
    }

    // Record the trail, throttled by distance travelled.
    const last = this.trail[this.trail.length - 1];
    if (dist(last.x, last.y, this.x, this.y) >= CONFIG.missile.trailMinStep) {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > CONFIG.missile.trailMaxPoints) this.trail.shift();
    }

    if (this.splitsRemaining > 0 && this.cy >= this.splitY) {
      this.splitsRemaining = 0;
      this.splitY = Infinity;
      // Post-split it's a regular red RV: shed the carrier's armour.
      this.maxHp = CONFIG.missile.hp.normal;
      this.hp = Math.min(this.hp, this.maxHp);
      return 'split';
    }
    // MIRV nuke bus: at the split the carrier is SPENT — the game replaces it
    // with three independent small warheads and the empty bus tumbles away.
    if (this.type === 'mirvnuke' && this.cy >= this.splitY) {
      this.splitY = Infinity;
      this.dead = true;
      return 'split';
    }
    // Nukes fuze for an AIR BURST above their target; everything else rides
    // into the dirt.
    const impactY =
      this.type === 'nuke' ? groundY - CONFIG.missile.nuke.burstHeight : groundY;
    if (this.cy >= impactY) {
      this.y = impactY;
      this.reachedGround = true;
      this.dead = true;
      return 'impact';
    }
    return null;
  }
}
EnemyMissile._nextId = 1;

// ---------------------------------------------------------------------------
// Interceptor — a homing anti-missile. Steers toward the target each frame
// (capped turn rate) and detonates with an area blast on arrival. Two flavours
// share the class and all of its guidance/energy mechanics:
//   - the ground-launched interceptor (default): cold-launched straight up,
//     steering locked until it clears the launch column.
//   - an F-16's air-to-air missile (kind 'aam'): smaller, born fast on the
//     carrier's heading with guidance live off the rail. Pass its config and
//     initial velocity via `opts`.
// ---------------------------------------------------------------------------
export class Interceptor {
  constructor(x, y, target, opts = {}) {
    const cfg = (this.cfg = opts.cfg || CONFIG.interceptor);
    this.kind = opts.kind || 'interceptor';
    this.x = x;
    this.y = y;
    this.target = target;
    this.age = 0;
    this.boosting = true;
    // Default: cold-launched straight up out of the pod — it has to turn onto
    // an intercept course in flight. An AAM instead inherits its carrier's
    // velocity (plus rail boost), already pointed roughly at the target.
    this.vx = opts.vx ?? 0;
    this.vy = opts.vy ?? -cfg.launchSpeed;
    this.launchY = y; // steering is locked until it clears the launch column
    this.life = cfg.lifetime;
    this.dead = false;
    this.trail = [{ x, y }];
  }

  /** Returns 'detonate' (warhead burst), 'fizzle' (dud), or null. */
  update(dt, groundY) {
    const cfg = this.cfg;
    this.age += dt;
    if (this.target && this.target.dead) this.target = null;

    // Steer the velocity heading toward the target, capped by the turn rate.
    // A cold-launched round flies STRAIGHT UP for its first stretch of climb
    // (clearing the launch column) before guidance kicks in; a rail-fired
    // AAM (steerAfterClimb 0) is live immediately — the climb test would
    // otherwise never pass for a round diving on a target BELOW its rail.
    const canSteer =
      cfg.steerAfterClimb <= 0 || this.launchY - this.y >= cfg.steerAfterClimb;
    let dirX = this.vx;
    let dirY = this.vy;
    if (this.target && canSteer) {
      dirX = this.target.x - this.x;
      dirY = this.target.y - this.y;
    }
    const curAng = Math.atan2(this.vy, this.vx);
    const desAng = Math.atan2(dirY, dirX);
    let diff = desAng - curAng;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = cfg.turnRate * dt;
    if (diff > maxTurn) diff = maxTurn;
    else if (diff < -maxTurn) diff = -maxTurn;
    const ang = curAng + diff;
    let speed = Math.hypot(this.vx, this.vy);
    this.vx = Math.cos(ang) * speed;
    this.vy = Math.sin(ang) * speed;

    // Boost phase: thrust along the heading. Coast phase: gravity + drag,
    // plus extra energy scrubbed off by every radian of turning — hard
    // maneuvering against a crossing target genuinely costs speed.
    this.boosting = this.age < cfg.boostTime;
    if (this.boosting) {
      speed = Math.min(cfg.maxSpeed, speed + cfg.thrust * dt);
      this.vx = Math.cos(ang) * speed;
      this.vy = Math.sin(ang) * speed;
    } else {
      const bleed = 1 - Math.min(0.9, cfg.turnBleed * Math.abs(diff));
      this.vx *= bleed;
      this.vy *= bleed;
      this.vy += CONFIG.physics.gravity * dt;
      applyDrag(this, CONFIG.physics.interceptorDrag, airDensity(this.y, groundY), dt);
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const last = this.trail[this.trail.length - 1];
    if (dist(last.x, last.y, this.x, this.y) >= cfg.trailMinStep) {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > cfg.trailMaxPoints) this.trail.shift();
    }

    this.life -= dt;

    if (this.target && dist(this.x, this.y, this.target.x, this.target.y) <= cfg.detonateRadius) {
      this.dead = true;
      return 'detonate';
    }
    // Out of maneuvering energy: too slow to chase anything down, so the
    // round destroys itself rather than wallowing across the sky.
    if (!this.boosting && Math.hypot(this.vx, this.vy) < cfg.minSpeed) {
      this.dead = true;
      return this.target ? 'detonate' : 'fizzle';
    }
    // Ground contact ends the flight — no skimming through the dirt for
    // another pass. With a live target the warhead fuzes on impact; without
    // one the dud just buries itself.
    if (this.y >= groundY) {
      this.y = groundY;
      this.dead = true;
      return this.target ? 'detonate' : 'fizzle';
    }
    if (this.life <= 0 || this.y < -40) {
      this.dead = true;
      return this.target ? 'detonate' : 'fizzle';
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flare — a burning IR decoy punched out by a bomber under attack. It falls
// away from the airframe and burns hot for a couple of seconds; a seduced
// interceptor homes on it like any other target (x / y / dead is all the
// seeker reads), then has to reacquire — or self-destruct — when it burns out.
// ---------------------------------------------------------------------------
export class Flare {
  constructor(x, y, vx, vy, owner = null) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.owner = owner; // the bomber that dropped it (its pilot keeps evading
    // while a round chases this decoy — he can't know whether it took)
    this.age = 0;
    this.life = CONFIG.missile.bomber.flares.life;
    this.dead = false;
  }

  update(dt) {
    this.age += dt;
    // Ejected hard, then quickly dominated by gravity — it tumbles away and
    // down while the bomber flies on, dragging the seeker off the airframe.
    this.vx *= 0.97;
    this.vy = this.vy * 0.97 + CONFIG.physics.gravity * 0.55 * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.age >= this.life) this.dead = true;
  }
}

// ---------------------------------------------------------------------------
// FriendlyJet — an F-16 scrambled by the airstrike. It dashes across the sky
// POINTING ITS NOSE at the current racked target (pitch authority and turn
// rate limited, so it banks onto the line rather than snapping), and fires
// each AAM straight off the nose once the target is in range and the nose is
// on the line (the Game owns the actual missile spawning; the jet just says
// "fire now at this target"). It can't be hit and exits the far side.
// ---------------------------------------------------------------------------
export class FriendlyJet {
  constructor(x, y, dir, targets, fieldW) {
    const cfg = CONFIG.airstrike;
    this.x = x;
    this.y = y;
    this.dir = dir; // +1 flying right, -1 flying left
    this.vx = dir * cfg.jetSpeed;
    this.vy = 0;
    this.dead = false;
    this.age = 0;
    this.rack = targets.slice(); // targets to engage, in encounter order
    this.fireTimer = 0;
    this.exitX = dir > 0 ? fieldW + 200 : -200;
  }

  /** Smallest signed angle from `from` to `to`. */
  static _angDiff(to, from) {
    let d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /** Returns a target to fire at right now, or null. */
  update(dt) {
    const cfg = CONFIG.airstrike;
    this.age += dt;

    // Nose-aim: pitch toward the current target, clamped to the airframe's
    // pitch limit around level flight; ease back level once the rack is dry.
    const level = this.dir > 0 ? 0 : Math.PI;
    const t = this.rack[0];
    let desired = level;
    if (t && !t.dead) {
      const maxPitch = (cfg.maxPitchDeg * Math.PI) / 180;
      const rel = FriendlyJet._angDiff(Math.atan2(t.y - this.y, t.x - this.x), level);
      desired = level + Math.max(-maxPitch, Math.min(maxPitch, rel));
    }
    const cur = Math.atan2(this.vy, this.vx);
    const maxTurn = cfg.turnRate * dt;
    const diff = FriendlyJet._angDiff(desired, cur);
    let ang = cur + Math.max(-maxTurn, Math.min(maxTurn, diff));
    // Terrain guard: never dive below the deck chasing a low target.
    const floor = (CONFIG.world.height - CONFIG.groundHeight) * 0.88;
    if (this.y > floor && Math.sin(ang) > 0) ang = level;
    this.vx = Math.cos(ang) * cfg.jetSpeed;
    this.vy = Math.sin(ang) * cfg.jetSpeed;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if ((this.dir > 0 && this.x > this.exitX) || (this.dir < 0 && this.x < this.exitX)) {
      this.dead = true;
      return null;
    }
    if (!t) return null;
    this.fireTimer -= dt;
    if (this.fireTimer > 0) return null;
    // The rail fires when the target is inside the window ahead AND the nose
    // is on the line — or the target is dead / slipping behind (last chance:
    // loose the round now and let it correct rather than waste the pass).
    const ahead = (t.x - this.x) * this.dir;
    if (!t.dead && ahead > cfg.fireRange) return null;
    if (!t.dead && ahead > 0) {
      const noseErr = Math.abs(
        FriendlyJet._angDiff(Math.atan2(t.y - this.y, t.x - this.x), ang)
      );
      if (noseErr > (cfg.aimToleranceDeg * Math.PI) / 180) return null;
    }
    this.rack.shift();
    this.fireTimer = rand(cfg.fireGap[0], cfg.fireGap[1]);
    return t;
  }
}

// ---------------------------------------------------------------------------
// Particle — a single spark in an explosion. Cheap; spawned in bursts and
// rendered as additive points.
// ---------------------------------------------------------------------------
export class Particle {
  constructor(x, y, color, kind = 'spark') {
    const a = rand(0, Math.PI * 2);
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.color = color;
    this.dead = false;
    if (kind === 'smoke') {
      // Slow drifting puff that rises (sim +y is down), grows and thins out.
      const sp = rand(8, 40);
      this.vx = Math.cos(a) * sp;
      this.vy = Math.sin(a) * sp * 0.5 - rand(18, 46);
      this.life = rand(1.2, 2.4);
      this.size = rand(14, 30);
      this.grav = -12; // gentle buoyancy
      this.dragK = 0.985;
    } else if (kind === 'ember') {
      // Hot debris chunk: thrown hard, falls under gravity, burns out slow.
      const sp = rand(90, 380);
      this.vx = Math.cos(a) * sp;
      this.vy = Math.sin(a) * sp - rand(20, 120);
      this.life = rand(0.5, 1.1);
      this.size = rand(5, 10);
      this.grav = CONFIG.physics.gravity * 0.55;
      this.dragK = 0.985;
    } else {
      // Spark: fast, bright, short-lived.
      const sp = rand(40, 280);
      this.vx = Math.cos(a) * sp;
      this.vy = Math.sin(a) * sp;
      this.life = rand(0.3, 0.7);
      this.size = rand(4, 9);
      this.grav = CONFIG.physics.gravity * 0.25;
      this.dragK = 0.92;
    }
    this.maxLife = this.life;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= this.dragK;
    this.vy = this.vy * this.dragK + this.grav * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
}

/** Spawn a burst of particles into `out` (a mix of sparks and hot embers). */
export function explode(out, x, y, color, count = 16) {
  for (let i = 0; i < count; i++) {
    out.push(new Particle(x, y, color, i % 3 === 0 ? 'ember' : 'spark'));
  }
}

/** Spawn lingering smoke puffs into `out` (rendered as soft non-glowing cloud). */
export function smokePuff(out, x, y, count = 6, color = CONFIG.colors.smoke) {
  for (let i = 0; i < count; i++) out.push(new Particle(x, y, color, 'smoke'));
}

/**
 * Expanding ring burst: sparks thrown outward at a uniform speed with a
 * tangential swirl, so the debris whirls apart (evasive-kill signature).
 */
export function explodeRing(out, x, y, color, count = 16) {
  for (let i = 0; i < count; i++) {
    const p = new Particle(x, y, color, 'spark');
    const a = (i / count) * Math.PI * 2;
    const sp = rand(150, 210);
    const swirl = sp * 0.6;
    p.vx = Math.cos(a) * sp - Math.sin(a) * swirl;
    p.vy = Math.sin(a) * sp + Math.cos(a) * swirl;
    p.life = p.maxLife = rand(0.45, 0.7);
    out.push(p);
  }
}

/**
 * Directional debris cone along (dirX, dirY): the wreck keeps most of its
 * momentum and streaks on past the kill point (hypersonic-kill signature).
 */
export function explodeCone(out, x, y, dirX, dirY, color, count = 16) {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len;
  const uy = dirY / len;
  for (let i = 0; i < count; i++) {
    const p = new Particle(x, y, color, i % 2 === 0 ? 'ember' : 'spark');
    const sp = rand(180, 460);
    const spread = rand(-0.45, 0.45); // radians off the travel axis
    const cs = Math.cos(spread);
    const sn = Math.sin(spread);
    p.vx = (ux * cs - uy * sn) * sp;
    p.vy = (ux * sn + uy * cs) * sp;
    out.push(p);
  }
}

export { randInt };
