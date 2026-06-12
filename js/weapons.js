// ---------------------------------------------------------------------------
// Weapon systems. Each weapon owns its own stats, inventory and upgrade state
// plus the logic to produce projectiles. The Game owns the projectile lists and
// their world simulation/collision; weapons just answer "what do I have and how
// do I fire". Adding a new weapon = one new class here + a projectile type.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { deg2rad, rand } from './utils.js';
import { Bullet, Interceptor } from './entities.js';

/**
 * CIWS — the primary rapid-fire guns. Stats (fire interval, dispersion, ammo
 * capacity) live here and are mutated by shop upgrades. The turret is just a
 * mount: this drives the firing and writes back its cooldown/ammo.
 */
export class CIWSWeapon {
  constructor() {
    this.name = 'CIWS';
    this.baseInterval = CONFIG.turret.fireInterval;
    this.baseDispersion = CONFIG.turret.dispersionDeg;
    this.ammoCapacity = CONFIG.turret.startAmmo; // Infinity — the belt never runs dry
    this.fireRateLevel = 0;
  }

  get fireInterval() {
    return this.baseInterval * Math.pow(CONFIG.shop.fireRateFactor, this.fireRateLevel);
  }

  get dispersionDeg() {
    return this.baseDispersion;
  }

  /** Refill every operational gun to the current capacity. */
  reloadAll(turrets) {
    for (const t of turrets) if (t.alive) t.ammo = this.ammoCapacity;
  }

  /**
   * Fire one round from a turret. Returns an array with the Bullet, or [] if
   * it can't fire.
   */
  fireFrom(turret) {
    if (!turret.usable || turret.cooldown > 0) return [];
    turret.cooldown = this.fireInterval;
    turret.ammo -= 1;
    turret.recoil = 6;
    turret.muzzleFlash = 1;
    const spread = deg2rad(this.dispersionDeg);
    const m = turret.muzzle();
    return [new Bullet(m.x, m.y, turret.angle + rand(-spread, spread))];
  }

  upgradeFireRate() {
    this.fireRateLevel++;
  }
}

/**
 * Interceptor launcher — a cheap shop purchase that then fires itself:
 * unlimited stock, gated by a reload cooldown that shop upgrades buy down
 * (6s -> 1s). Does nothing until bought.
 */
export class InterceptorWeapon {
  constructor() {
    this.name = 'Interceptor';
    this.owned = false;
    this.cooldownLevel = 0;
    this.timer = 0; // seconds until the next launch is ready
  }

  /** Field the battery; fresh from the factory it arrives fully loaded. */
  buy() {
    this.owned = true;
    this.timer = 0;
  }

  /** Current reload time between launches, by upgrade level. */
  get cooldown() {
    return CONFIG.interceptor.cooldowns[this.cooldownLevel];
  }

  get canLaunch() {
    return this.owned && this.timer <= 0;
  }

  /** Fraction of the reload remaining (1 = just fired, 0 = ready). */
  get reloadFrac() {
    return Math.max(0, this.timer / this.cooldown);
  }

  update(dt) {
    if (this.timer > 0) this.timer -= dt;
  }

  /** Wave start: the pod comes back fully loaded and ready. */
  refill() {
    this.timer = 0;
  }

  /** Launch a homing Interceptor and start the reload, or null if reloading. */
  launch(x, y, target) {
    if (!this.canLaunch) return null;
    this.timer = this.cooldown;
    return new Interceptor(x, y, target);
  }

  upgradeCooldown() {
    if (this.cooldownLevel < CONFIG.interceptor.cooldowns.length - 1) this.cooldownLevel++;
  }
}

/**
 * Airstrike — the once-per-wave panic button. Buying it in the armory racks
 * ONE strike package; calling it (SPACE / the touch STRIKE button) scrambles
 * a flight of F-16s that ripple-fire AAMs at everything in the sky. At most
 * one package is held at a time, and an unused package carries over to the
 * next wave. The Game owns the jets and missiles; this just tracks the stock.
 */
export class AirstrikeWeapon {
  constructor() {
    this.name = 'Airstrike';
    this.charges = 0; // 0 or 1: packages in the rack
  }

  get ready() {
    return this.charges > 0;
  }

  buy() {
    this.charges = 1;
  }

  /** Spend the package. Returns false if the rack is empty. */
  call() {
    if (this.charges <= 0) return false;
    this.charges = 0;
    return true;
  }
}

/**
 * Laser — a purchasable, fully autonomous point-defense beam left of the
 * CIWS mount. It latches onto one target and burns it down over time (dps),
 * so a drone dies in a blink while an armoured bus takes a long, committed
 * burn. It engages ANY visible threat in its envelope (cloaked stealth is
 * immune); after each kill it recharges, and upgrades buy a faster recharge.
 */
export class LaserWeapon {
  constructor() {
    this.name = 'Laser';
    this.owned = false;
    this.level = 0; // recharge upgrade level
    this.timer = 0; // seconds until the next burn is ready
    this.target = null; // missile currently being burned
    this.angle = -Math.PI / 2; // emitter aim (sim angle; starts straight up)
  }

  get rechargeTime() {
    return CONFIG.laser.cooldowns[this.level];
  }

  /** HP burned off the latched target per second. */
  get dps() {
    return CONFIG.laser.dps;
  }

  get canFire() {
    return this.owned && this.timer <= 0;
  }

  get burning() {
    return this.target != null;
  }

  /** Fraction of the recharge remaining (1 = just fired, 0 = ready). */
  get chargeFrac() {
    return this.owned ? 1 - Math.max(0, this.timer / this.rechargeTime) : 0;
  }

  update(dt) {
    if (this.timer > 0) this.timer -= dt;
  }

  /** Whether the laser will engage this missile (anything still flying). */
  canTarget(m) {
    return !m.dead;
  }

  fire() {
    this.timer = this.rechargeTime;
  }

  buy() {
    this.owned = true;
    this.timer = 0;
  }

  upgradeRecharge() {
    if (this.level < CONFIG.laser.cooldowns.length - 1) this.level++;
  }
}
