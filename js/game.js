// ---------------------------------------------------------------------------
// Game — owns all simulation state, the wave/score logic, input and the HUD.
// The 3D world is drawn by the WebGL Renderer; this class draws the 2D HUD /
// menus on an overlay canvas and feeds the renderer each frame.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { clamp, rand, randInt, dist2, removeWhere, pick, TAU } from './utils.js';
import {
  City,
  Turret,
  EnemyMissile,
  Flare,
  Particle,
  explode,
  explodeRing,
  explodeCone,
  smokePuff,
} from './entities.js';
import { CIWSWeapon, InterceptorWeapon, LaserWeapon } from './weapons.js';
import { sfx } from './audio.js';
import { scoreboard } from './scores.js';
import { saveSlot, SAVE_VERSION } from './save.js';
import { STRINGS } from './strings.js';

const C = CONFIG.colors;
const T = STRINGS; // every user-facing line lives in strings.js

// Dev-console sandbox scenarios: each loops one threat type forever. The
// spawner fires whenever the live count drops below `maxLive` and `gap`
// seconds have passed (a drone swarm counts one per airframe).
export const DEV_SCENARIOS = [
  { key: 'bombers', type: 'bomber', maxLive: 2, gap: 4 },
  { key: 'drones', type: 'drone', maxLive: 6, gap: 5 },
  { key: 'cruise', type: 'cruise', maxLive: 3, gap: 2.5 },
  { key: 'stealth', type: 'stealth', maxLive: 3, gap: 2.5 },
  { key: 'hypersonics', type: 'hypersonic', maxLive: 3, gap: 2 },
  { key: 'evasive', type: 'evasive', maxLive: 4, gap: 1.5 },
  { key: 'mirvs', type: 'mirv', maxLive: 3, gap: 3 },
  { key: 'nukes', type: 'nuke', maxLive: 1, gap: 5 },
  { key: 'rain', type: 'normal', maxLive: 6, gap: 1 },
];

export class Game {
  // The renderer is injected (not imported) so the simulation has no hard
  // dependency on WebGL/Three.js — that keeps the game logic headless-testable.
  constructor(hudCanvas, renderer) {
    this.hudCanvas = hudCanvas;
    this.hctx = hudCanvas.getContext('2d');
    this.renderer = renderer;

    this.cities = [];
    this.turrets = [];
    this.missiles = [];
    this.bullets = [];
    this.particles = [];
    this.explosions = []; // transient fireball/shockwave visual events
    this.interceptorList = []; // in-flight interceptors
    this.flares = []; // burning decoys punched out by bombers under attack
    this.floatTexts = []; // floating "+credits" labels on kills

    // Weapon systems + economy.
    this.ciws = new CIWSWeapon();
    this.interceptorWeapon = new InterceptorWeapon();
    this.laser = new LaserWeapon();
    this.laserBeams = []; // fading beam visuals {x1,y1,x2,y2,life,maxLife}
    this.laserBeamLive = null; // the sustained beam while a burn is in progress
    this.shieldLevel = 0; // gun-shield upgrades bought (0 = no shield)
    this.nukesSpawned = 0; // nukes rolled this wave (capped per wave)
    this.pendingNukes = []; // countdowns between launch warning and spawn
    this.credits = 0;
    this.waveEarned = 0; // credits earned during the current wave (shop display)
    this.waveLeaks = 0; // missiles that reached the ground this wave
    this.waveBreakdown = null; // credit sources for the shop summary
    this._shopRects = []; // hit-test rects, rebuilt each shop frame

    this.state = 'menu'; // menu | playing | intermission | gameover
    this.scoreboard = scoreboard; // injectable for tests
    this.saveSlot = saveSlot; // injectable for tests
    this.savedRun = this.saveSlot.load(); // checkpoint offered on the menu
    this.lastRun = null; // { scores, rank } from the most recent game over
    this.paused = false;
    this.time = 0; // accumulates for HUD animations
    this.lossReason = null; // why the last game ended (for the game-over screen)

    // pointer* = raw screen pixels (crosshair); mouse* = simulation coords (aim)
    this.pointerX = window.innerWidth / 2;
    this.pointerY = window.innerHeight / 3;
    this.mouseX = this.pointerX;
    this.mouseY = this.pointerY;
    this.activeTurret = null;

    this.score = 0;
    this.wave = 0;
    this.toSpawn = 0;
    this.waveSpawnTotal = 0;
    this.mushrooms = []; // active mushroom-cloud emitters {x, y, groundY, age}
    this.spawnTimer = 0;
    this.spawnGap = CONFIG.wave.baseSpawnGap;
    this.waveEndTimer = 0; // grace beat after the last threat before clearing
    this.nextWave = 1;

    this.shakeTime = 0;
    this.shakeMag = 0;

    // Touch devices aim from a fire-control pad docked below the field, so a
    // thumb never covers the action. Detected up front; the dev console can
    // toggle it for desktop testing.
    this.touchMode =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches) ||
      'ontouchstart' in window;
    this.padRect = null; // screen rect of the pad (touch mode only)
    this.shopSelected = 0; // touch armory: which row the detail panel shows

    // Secret dev console (backquote). Scenario sandboxes loop one threat type
    // for observation; the toggles survive restarts so a whole test session
    // can run invincible.
    this.devMenuOpen = false;
    this.devScenario = null; // entry from DEV_SCENARIOS while sandboxing
    this.devSpawnTimer = 0;
    this.devInvincible = false; // cities + gun cannot be destroyed
    this.devLoadout = true; // sandbox starts with interceptor + laser fitted

    this.resize();
    // Default aim at the centre of the (now fixed) simulation space.
    this.mouseX = this.W / 2;
    this.mouseY = this.H / 3;
    this.bindInput();
  }

  // -------------------------------------------------------------------------
  // Layout & sizing
  // -------------------------------------------------------------------------
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.screenW = window.innerWidth;
    this.screenH = window.innerHeight;

    // Fixed simulation space — gameplay always runs at this virtual resolution
    // so distances, speeds and spacing (i.e. balance) never depend on the
    // window size. The camera scales it to fit the screen.
    this.W = CONFIG.world.width;
    this.H = CONFIG.world.height;
    this.groundY = this.H - CONFIG.groundHeight;

    // HUD overlay canvas is sized to the actual window (screen-space UI).
    // The CSS size is pinned to the same innerWidth/innerHeight the drawing
    // buffer uses: on mobile, `100vh` is the LARGE viewport (behind the
    // collapsed URL bar) and is taller than innerHeight, which stretched the
    // canvas and drew the crosshair below the finger.
    this.hudCanvas.width = Math.floor(this.screenW * dpr);
    this.hudCanvas.height = Math.floor(this.screenH * dpr);
    if (this.hudCanvas.style) {
      this.hudCanvas.style.width = `${this.screenW}px`;
      this.hudCanvas.style.height = `${this.screenH}px`;
    }
    this.hctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Touch: dock the fire-control pad below the field and letterbox the
    // scene upward to clear it (the renderer reserves a bottom inset).
    let inset = 0;
    if (this.touchMode) {
      const P = CONFIG.ui.touchPad;
      const padH = Math.min(P.maxHeight, Math.round(this.screenH * P.heightFrac));
      const padW = this.screenW - P.margin * 2;
      this.padRect = {
        x: P.margin,
        y: this.screenH - P.bottomMargin - padH,
        w: padW,
        h: padH,
      };
      inset = padH + P.bottomMargin + 8;
    } else {
      this.padRect = null;
    }
    if (typeof this.renderer.setBottomInset === 'function') {
      this.renderer.setBottomInset(inset);
    }
    // The credit link lives in the bottom-right corner — squarely under the
    // touch pad. Hide it rather than let it eat taps mid-fight.
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      const credit = document.getElementById('credit');
      if (credit && credit.style) credit.style.display = this.touchMode ? 'none' : '';
    }

    this.renderer.setSize(this.screenW, this.screenH);
    this.layout();
  }

  /** Flip touch controls on/off (dev-console testing hook). */
  setTouchMode(on) {
    this.touchMode = on;
    this.resize();
  }

  /** Map a screen point on the fire-control pad to a sim-space aim point. */
  aimFromPad(px, py) {
    const r = this.padRect;
    if (!r) return;
    this.mouseX = clamp(((px - r.x) / r.w) * this.W, 0, this.W);
    this.mouseY = clamp(((py - r.y) / r.h) * this.groundY, 0, this.groundY);
  }

  computeSlots() {
    const total = CONFIG.cityCount + CONFIG.turretCount;
    const turretIdx = new Set();
    if (CONFIG.turretCount === 1) {
      turretIdx.add(Math.round((total - 1) / 2)); // single gun sits dead centre
    } else {
      const denom = CONFIG.turretCount - 1;
      for (let i = 0; i < CONFIG.turretCount; i++) {
        turretIdx.add(Math.round((i * (total - 1)) / denom));
      }
    }
    const usable = this.W - CONFIG.edgePadding * 2;
    const slots = [];
    for (let i = 0; i < total; i++) {
      const x =
        total > 1 ? CONFIG.edgePadding + (usable * i) / (total - 1) : this.W / 2;
      slots.push({ x, type: turretIdx.has(i) ? 'turret' : 'city' });
    }
    return slots;
  }

  layout() {
    const slots = this.computeSlots();
    const fresh = this.cities.length === 0 && this.turrets.length === 0;
    if (fresh) {
      for (const s of slots) {
        if (s.type === 'turret') this.turrets.push(new Turret(s.x, this.groundY));
        else this.cities.push(new City(s.x, this.groundY));
      }
    } else {
      let ci = 0;
      let ti = 0;
      for (const s of slots) {
        if (s.type === 'turret') {
          const t = this.turrets[ti++];
          if (t) {
            t.x = s.x;
            t.groundY = this.groundY;
            t.y = this.groundY - CONFIG.turret.pivotHeight;
          }
        } else {
          const c = this.cities[ci++];
          if (c) {
            c.x = s.x;
            c.groundY = this.groundY;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Game flow
  // -------------------------------------------------------------------------
  startGame() {
    // A fresh deployment abandons any saved checkpoint.
    this.saveSlot.clear();
    this.savedRun = null;
    this.resetRun();
    this.startWave(1);
  }

  /**
   * Resume the saved checkpoint: a clean reset, then the snapshot on top.
   * The run picks back up at the armory before the saved wave — checkpoints
   * are taken between waves, so the shop is exactly where a reload landed
   * (and an extra visit costs nothing: credits and stock are in the save).
   */
  continueGame() {
    const s = this.savedRun;
    if (!s) {
      this.startGame();
      return;
    }
    this.resetRun();
    this.applyRun(s);
    this.wave = s.wave - 1;
    this.nextWave = s.wave;
    this.waveEarned = s.waveEarned ?? 0;
    this.waveBreakdown = s.waveBreakdown ?? null;
    this.state = 'intermission';
  }

  /** Wipe every piece of run state back to a brand-new game. */
  resetRun() {
    this.cities = [];
    this.turrets = [];
    this.missiles = [];
    this.bullets = [];
    this.particles = [];
    this.explosions = [];
    this.interceptorList = [];
    this.flares = [];
    this.floatTexts = [];
    this.score = 0;
    this.credits = CONFIG.economy.startCredits;
    this.ciws = new CIWSWeapon();
    this.interceptorWeapon = new InterceptorWeapon();
    this.laser = new LaserWeapon();
    this.laserBeams = [];
    this.laserBeamLive = null;
    this.shieldLevel = 0;
    this.pendingNukes = [];
    this.mushrooms = [];
    this.paused = false; // restarting (R) always unpauses
    this.devScenario = null; // a fresh game exits any dev sandbox
    this.devSpawnTimer = 0;
    this.layout();
    this.renderer.syncStructures(this); // rebuild meshes for the fresh skyline
  }

  /**
   * Push a saved checkpoint into freshly reset state. Levels are clamped to
   * the current config so a stale or hand-edited save can't index past an
   * upgrade table.
   */
  applyRun(s) {
    const level = (n, max) => clamp(Math.trunc(n) || 0, 0, max);
    this.score = s.score;
    this.credits = s.credits;
    this.ciws.fireRateLevel = level(
      s.ciws?.fireRateLevel,
      CONFIG.shop.fireRateCosts.length
    );
    this.ciws.twin = !!s.ciws?.twin;
    if (s.interceptor?.owned) this.interceptorWeapon.buy();
    this.interceptorWeapon.cooldownLevel = level(
      s.interceptor?.cooldownLevel,
      CONFIG.interceptor.cooldowns.length - 1
    );
    if (s.laser?.owned) this.laser.buy();
    this.laser.level = level(s.laser?.level, CONFIG.laser.cooldowns.length - 1);

    // Cities lost in earlier waves stay lost — that's the run's scar tissue.
    const markDead = (saved, live) => {
      for (let i = 0; i < live.length && i < saved.length; i++) {
        if (saved[i] && saved[i].alive === false) {
          live[i].alive = false;
          live[i].destroyedWave = saved[i].destroyedWave ?? 0;
        }
      }
    };
    markDead(s.cities, this.cities);
    markDead(s.turrets, this.turrets);

    // Re-buy the shield levels so the dome lands on the (alive) gun exactly
    // as the shop would have fitted it.
    for (let i = 0; i < level(s.shieldLevel, CONFIG.shield.costs.length); i++) {
      this.buyGunShield();
    }
  }

  /**
   * The checkpoint snapshot, taken on wave clear. `wave` is the upcoming
   * wave; the waveEarned / waveBreakdown fields redraw the armory's credit
   * summary on resume.
   */
  serializeRun() {
    return {
      v: SAVE_VERSION,
      wave: this.nextWave,
      score: this.score,
      credits: this.credits,
      waveEarned: this.waveEarned,
      waveBreakdown: this.waveBreakdown,
      shieldLevel: this.shieldLevel,
      ciws: { fireRateLevel: this.ciws.fireRateLevel, twin: this.ciws.twin },
      interceptor: {
        owned: this.interceptorWeapon.owned,
        cooldownLevel: this.interceptorWeapon.cooldownLevel,
      },
      laser: { owned: this.laser.owned, level: this.laser.level },
      cities: this.cities.map((c) => ({
        alive: c.alive,
        destroyedWave: c.destroyedWave ?? null,
      })),
      turrets: this.turrets.map((t) => ({
        alive: t.alive,
        destroyedWave: t.destroyedWave ?? null,
      })),
    };
  }

  /**
   * Dev sandbox: a fresh run that loops one scenario forever — no wave end,
   * just the chosen threat respawning so its behaviour (and the autonomous
   * weapons' response) can be watched in isolation. It never touches the
   * saved checkpoint — a real run can be resumed after sandboxing.
   */
  startSandbox(scenario) {
    this.resetRun();
    this.startWave(1);
    this.devScenario = scenario;
    this.devSpawnTimer = 0;
    this.devMenuOpen = false;
    this.toSpawn = 0; // the sandbox spawner replaces the wave budget
    this.wave = scenario.wave ?? 9; // past every fromWave gate
    this.credits = 9999;
    if (this.devLoadout) {
      this.interceptorWeapon.buy();
      this.laser.buy();
    }
  }

  startWave(n) {
    this.wave = n;
    // No ordnance carries over between waves. Guns reload to their (possibly
    // upgraded) capacity, and interceptors refill to their per-wave capacity.
    this.bullets = [];
    this.interceptorList = [];
    this.laserBeams = [];
    this.laserBeamLive = null;
    this.laser.target = null;
    this.waveEarned = 0;
    this.waveLeaks = 0;
    this.nukesSpawned = 0;
    this.pendingNukes = [];
    this.ciws.reloadAll(this.turrets);
    this.interceptorWeapon.refill();
    this.laser.timer = 0; // laser comes back charged each wave
    for (const t of this.turrets) {
      if (t.alive) {
        t.shields = t.shieldMax; // the gun shield comes back fully each wave
        t.shieldTimer = this.shieldRechargeTime();
      }
    }
    this.toSpawn =
      CONFIG.wave.baseMissiles + (n - 1) * CONFIG.wave.missilesPerWave;
    this.waveSpawnTotal = this.toSpawn; // for "how far into the wave are we"
    this.spawnGap = Math.max(
      CONFIG.wave.minSpawnGap,
      CONFIG.wave.baseSpawnGap - (n - 1) * CONFIG.wave.spawnGapPerWave
    );
    this.spawnTimer = rand(0.3, this.spawnGap);
    this.waveEndTimer = 0;
    this.state = 'playing';
  }

  endWave() {
    const E = CONFIG.economy;
    const survivingCities = this.cities.filter((c) => c.alive).length;

    // Score bonuses (cumulative bragging metric).
    this.score += survivingCities * CONFIG.score.citySurvivalBonus;

    // Credit breakdown. Kill bounties were banked during the wave (waveEarned
    // holds them so far); the end-of-wave bonuses are added on top.
    const kills = this.waveEarned;
    const clear = this.waveLeaks === 0 ? E.clearBonus : 0;
    const city = survivingCities * E.perCitySurvived;
    this.earnCredits(clear + city);
    this.waveBreakdown = { kills, clear, city };

    // Clear in-flight ordnance; the shop holds until the player proceeds.
    this.bullets = [];
    this.interceptorList = [];
    this.nextWave = this.wave + 1;
    this.state = 'intermission';
    this.shopSelected = 0; // touch armory: detail panel opens on the top item
    this.laserBeamLive = null;
    this.laser.target = null;
    // A cleared wave is a checkpoint — closing the tab at the armory (or any
    // time after) must not lose the run.
    this.checkpoint();
    sfx.waveClear();
  }

  /** Award credits and track what was earned this wave (for the shop display). */
  earnCredits(n) {
    this.credits += n;
    this.waveEarned += n;
  }

  /** Credit bounty for destroying a given missile, by its current variant. */
  missileBounty(m) {
    const b = CONFIG.economy.bounty;
    if (m.splitsRemaining > 0) return b.mirv; // unsplit MIRV carrier
    return b[m.type] || b.normal;
  }

  /** Score + credits for a kill, with a floating "+N" credit label at the spot. */
  rewardKill(m) {
    const bounty = this.missileBounty(m);
    this.score += CONFIG.score.perKill;
    this.earnCredits(bounty);
    this.spawnFloatText(m.x, m.y, `+${bounty}`, C.credits);
  }

  spawnFloatText(x, y, text, color) {
    this.floatTexts.push({
      x,
      y,
      text,
      color,
      life: CONFIG.ui.floatTextLife,
      maxLife: CONFIG.ui.floatTextLife,
    });
  }

  proceedToNextWave() {
    if (this.state === 'intermission') this.startWave(this.nextWave);
  }

  /**
   * Persist the run checkpoint. Taken once per wave, on wave clear — before
   * any armory spending, so a reload simply refunds purchases made since
   * (the next clear banks them). Doctored runs — a dev sandbox or god mode —
   * are never saved, same rule as the high-score table.
   */
  checkpoint() {
    if (this.devScenario || this.devInvincible) return;
    this.savedRun = this.serializeRun();
    this.saveSlot.save(this.savedRun);
  }

  gameOver(reason = T.loss.fallback) {
    this.state = 'gameover';
    this.lossReason = reason;
    this.laserBeamLive = null;
    // Bank the run on the local high-score table (no-op without storage).
    // Doctored runs — a dev sandbox or god mode — never touch the table.
    this.lastRun =
      this.devScenario || this.devInvincible
        ? null
        : this.scoreboard.add(this.score, this.wave);
    // Defeat is final: the checkpoint dies with the run (a doctored run never
    // saved one, and mustn't wipe a real run's save either).
    if (!this.devScenario && !this.devInvincible) {
      this.saveSlot.clear();
      this.savedRun = null;
    }
    sfx.gameOver();
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------
  aliveStructures() {
    const out = [];
    for (const c of this.cities) if (c.alive) out.push(c);
    for (const t of this.turrets) if (t.alive) out.push(t);
    return out;
  }

  /**
   * Structures enemies may be programmed against: anything alive, plus rubble
   * made THIS wave (the salvo was targeted before the city fell). Cities lost
   * in earlier waves are known dead and don't draw fire.
   */
  aimableStructures() {
    const out = [];
    for (const s of [...this.cities, ...this.turrets]) {
      if (s.alive || s.destroyedWave === this.wave) out.push(s);
    }
    return out.length ? out : this.aliveStructures();
  }

  /** Half-width of a structure's footprint (for ground-blast hit tests). */
  structureHalfWidth(s) {
    return s.width ? s.width / 2 : CONFIG.turret.baseRadius;
  }

  /** Base missile speed for this wave, with per-missile jitter. */
  rollSpeed() {
    const M = CONFIG.missile;
    return (
      (M.baseSpeed + (this.wave - 1) * M.speedPerWave) *
      rand(1 - M.speedJitter, 1 + M.speedJitter)
    );
  }

  spawnMissile() {
    const { type, children } = this.chooseThreat();

    if (type === 'drone') {
      this.spawnDroneGroup();
      return;
    }
    if (type === 'cruise' || type === 'stealth') {
      this.spawnCruise(type);
      return;
    }
    if (type === 'bomber') {
      this.spawnBomber();
      return;
    }
    if (type === 'nuke') {
      this.spawnNuke();
      return;
    }
    this.spawnBallistic(type, children);
  }

  /** Dev sandbox: spawn one forced threat type, bypassing chooseThreat. */
  devSpawn(type) {
    const M = CONFIG.missile;
    if (type === 'bomber') this.spawnBomber();
    else if (type === 'drone') this.spawnDroneGroup();
    else if (type === 'cruise' || type === 'stealth') this.spawnCruise(type);
    else if (type === 'nuke') this.spawnNuke();
    else if (type === 'mirv') {
      this.spawnBallistic('normal', randInt(M.splitChildren[0], M.splitChildren[1]));
    } else this.spawnBallistic(type);
  }

  /** Top-entry ballistic threat: normal / evasive / hypersonic / MIRV bus. */
  spawnBallistic(type, children = 0) {
    const M = CONFIG.missile;
    const startX = rand(20, this.W - 20);
    // Aim near a structure (alive OR rubble) with scatter, or — sometimes — at a
    // random ground point. Plenty land in the gaps and miss everything.
    let targetX;
    if (Math.random() < M.randomAimChance) {
      targetX = rand(CONFIG.edgePadding * 0.5, this.W - CONFIG.edgePadding * 0.5);
    } else {
      const target = pick(this.aimableStructures());
      targetX = target.x + rand(-M.aimJitter, M.aimJitter);
    }

    let speed = this.rollSpeed();
    if (type === 'hypersonic') speed *= M.hypersonic.speedFactor;
    else if (type === 'evasive') speed *= M.evasive.speedFactor;

    this.missiles.push(
      new EnemyMissile(startX, -10, targetX, this.groundY, speed, children, this.groundY, type)
    );
    // Only the hypersonic gets an audible cue (its incoming scream) — ordinary
    // spawns are silent so the soundscape stays clean.
    if (type === 'hypersonic') sfx.hypersonicLaunch(this.pan(startX));
  }

  /**
   * Cruise missile: enters from a screen edge low, pops up, dives on a target.
   * The stealth variant flies the same profile, cloaked until the pop-up.
   */
  spawnCruise(type = 'cruise') {
    const cfg = CONFIG.missile.cruise;
    const target = pick(this.aimableStructures());
    const targetX = target.x + rand(-CONFIG.missile.aimJitter, CONFIG.missile.aimJitter);
    // Enter from whichever edge gives it a longer run-in.
    const fromLeft = targetX > this.W / 2 ? true : false;
    const startX = fromLeft ? -30 : this.W + 30;
    const startY = this.groundY * rand(cfg.altFrac[0], cfg.altFrac[1]);
    const speed = this.rollSpeed() * CONFIG.missile[type].speedFactor;
    this.missiles.push(
      new EnemyMissile(startX, startY, targetX, this.groundY, speed, 0, 0, type)
    );
  }

  /** Drone swarm: a group from one edge, each with its own (overlapping) target. */
  spawnDroneGroup() {
    const cfg = CONFIG.missile.drone;
    const fromLeft = Math.random() < 0.5;
    // The whole group counts as ONE enemy of the wave budget.
    const structures = this.aimableStructures();
    const n = cfg.groupSize;
    for (let i = 0; i < n; i++) {
      const target = pick(structures);
      const targetX = target.x + rand(-CONFIG.missile.aimJitter, CONFIG.missile.aimJitter);
      const startX = fromLeft ? -30 - i * 26 : this.W + 30 + i * 26;
      const startY = this.groundY * rand(cfg.altFrac[0], cfg.altFrac[1]);
      const speed = this.rollSpeed() * cfg.speedFactor;
      this.missiles.push(
        new EnemyMissile(startX, startY, targetX, this.groundY, speed, 0, 0, 'drone')
      );
    }
  }

  /** Bomber: a level pass across the upper sky, dropping bombs on the way. */
  spawnBomber() {
    const bc = CONFIG.missile.bomber;
    const fromLeft = Math.random() < 0.5;
    const startX = fromLeft ? -40 : this.W + 40;
    const exitX = fromLeft ? this.W + 100 : -100;
    const startY = this.groundY * rand(bc.altFrac[0], bc.altFrac[1]);
    const speed = this.rollSpeed() * bc.speedFactor;
    this.missiles.push(
      new EnemyMissile(startX, startY, exitX, startY, speed, 0, 0, 'bomber')
    );
  }

  /** Release one glide bomb from a bomber onto something in glide reach. */
  dropGlideBomb(bomber) {
    const bc = CONFIG.missile.bomber;
    const dir = Math.sign(bomber.vx) || 1;
    // Prefer a structure ahead and within glide reach; sometimes (or with
    // nothing in reach) the bomb just falls long into the dirt.
    const inReach = this.aimableStructures().filter(
      (s) => (s.x - bomber.x) * dir > 40 && Math.abs(s.x - bomber.x) < bc.reach
    );
    let tx;
    if (inReach.length && Math.random() >= CONFIG.missile.randomAimChance) {
      const target = pick(inReach);
      tx = target.x + rand(-CONFIG.missile.aimJitter, CONFIG.missile.aimJitter);
    } else {
      tx = bomber.x + dir * rand(80, bc.reach);
    }
    const speed = this.rollSpeed() * CONFIG.missile.glidebomb.speedFactor;
    this.missiles.push(
      new EnemyMissile(bomber.x, bomber.y + 14, tx, this.groundY, speed, 0, 0, 'glidebomb')
    );
    sfx.bombDrop(this.pan(bomber.x));
  }

  /**
   * Is any live CIWS round on a near-collision course with this missile?
   * Closest-approach test in relative coordinates over a short horizon.
   */
  bulletThreatens(m) {
    const cfg = CONFIG.missile.bomber.bulletDodge;
    const r2 = cfg.range * cfg.range;
    const miss2 = cfg.missDist * cfg.missDist;
    for (const b of this.bullets) {
      if (b.dead) continue;
      const rx = m.x - b.x;
      const ry = m.y - b.y;
      if (rx * rx + ry * ry > r2) continue;
      const vx = b.vx - m.vx;
      const vy = b.vy - m.vy;
      const vv = vx * vx + vy * vy;
      if (vv < 1) continue;
      const t = (rx * vx + ry * vy) / vv; // time of closest approach
      if (t < 0 || t > cfg.time) continue;
      const cx = rx - vx * t;
      const cy = ry - vy * t;
      if (cx * cx + cy * cy < miss2) return true;
    }
    return false;
  }

  /**
   * Punch a burst of flares out of a bomber under attack. Each interceptor
   * homing on that airframe rolls against decoyChance — a seduced seeker
   * silently retargets onto one of the burning decoys, chases it as it falls
   * away, and is left to reacquire (or self-destruct) when it gutters out.
   */
  dispenseFlares(bomber) {
    const F = CONFIG.missile.bomber.flares;
    bomber.flareBursts--;
    bomber.flareTimer = F.cooldown;
    const burst = [];
    for (let i = 0; i < F.perBurst; i++) {
      // Ejected down and behind the airframe, fanned out across the burst.
      const back = -(Math.sign(bomber.vx) || 1);
      const ang = Math.PI / 2 + back * rand(0.25, 0.95); // down, raked aft
      const sp = F.ejectSpeed * rand(0.7, 1.15);
      burst.push(
        new Flare(
          bomber.x,
          bomber.y + 6,
          bomber.vx * 0.35 + Math.cos(ang) * sp,
          Math.sin(ang) * sp,
          bomber
        )
      );
    }
    this.flares.push(...burst);
    sfx.flare(this.pan(bomber.x));
    for (const it of this.interceptorList) {
      if (it.dead || it.target !== bomber) continue;
      if (Math.random() < F.decoyChance) it.target = pick(burst);
    }
  }

  /**
   * Mutant: the threat is DETECTED a few seconds before it appears —
   * klaxon plus a synthetic "Mutant swimmer detected" voice — then it spawns.
   */
  spawnNuke() {
    this.nukesSpawned++;
    this.pendingNukes.push(CONFIG.missile.nuke.warningTime);
    sfx.alarm(0);
    sfx.say(T.voice.nukeWarning);
  }

  /**
   * The warned-of nuke actually enters: armoured, full ballistic speed, and
   * aimed at an INNER city — its blast levels the neighbours too, so an
   * outer-city shot would waste half its yield off the map. It only targets
   * the outermost cities when nothing inner is left standing.
   */
  launchNuke() {
    const alive = this.cities.filter((c) => c.alive);
    const outerA = this.cities[0];
    const outerB = this.cities[this.cities.length - 1];
    const inner = alive.filter((c) => c !== outerA && c !== outerB);
    const pool = inner.length ? inner : alive.length ? alive : this.cities;
    const target = pick(pool);
    const startX = rand(60, this.W - 60);
    const speed = this.rollSpeed() * CONFIG.missile.nuke.speedFactor;
    this.missiles.push(
      new EnemyMissile(startX, -10, target.x, this.groundY, speed, 0, 0, 'nuke')
    );
  }

  /**
   * Roll this wave's threat variant (mutually exclusive, so each stays
   * readable). Precedence: nuke > cruise > drone > hypersonic > evasive >
   * MIRV > plain. Returned as `{ type, children }` where children>0 marks a
   * (type 'normal') MIRV carrier.
   */
  chooseThreat() {
    const M = CONFIG.missile;
    // Nukes never open or close a wave — they arrive while you're already
    // busy. The per-wave cap keeps climbing: one at first, +1 every few waves.
    const nukeCap =
      M.nuke.maxPerWave +
      Math.max(0, Math.floor((this.wave - M.nuke.fromWave) / M.nuke.wavesPerExtra));
    const spawnedSoFar = this.waveSpawnTotal - this.toSpawn;
    if (
      this.wave >= M.nuke.fromWave &&
      this.nukesSpawned < nukeCap &&
      spawnedSoFar >= 2 && // not among the first two
      this.toSpawn >= 2 && // and at least one more follows it
      Math.random() < M.nuke.chance
    ) {
      return { type: 'nuke', children: 0 };
    }
    if (this.wave >= M.stealth.fromWave && Math.random() < M.stealth.chance) {
      return { type: 'stealth', children: 0 };
    }
    if (this.wave >= M.cruise.fromWave && Math.random() < M.cruise.chance) {
      return { type: 'cruise', children: 0 };
    }
    if (this.wave >= M.drone.fromWave && Math.random() < M.drone.chance) {
      return { type: 'drone', children: 0 };
    }
    if (this.wave >= M.bomber.fromWave && Math.random() < M.bomber.chance) {
      return { type: 'bomber', children: 0 };
    }
    if (this.wave >= M.hypersonic.fromWave && Math.random() < M.hypersonic.chance) {
      return { type: 'hypersonic', children: 0 };
    }
    if (this.wave >= M.evasive.fromWave && Math.random() < M.evasive.chance) {
      return { type: 'evasive', children: 0 };
    }
    if (this.wave >= M.splitFromWave && Math.random() < M.splitChance) {
      return { type: 'normal', children: randInt(M.splitChildren[0], M.splitChildren[1]) };
    }
    return { type: 'normal', children: 0 };
  }

  splitMissile(parent) {
    explode(this.particles, parent.x, parent.y, C.missile, 6);
    const targets = this.aliveStructures();
    if (targets.length === 0) return;
    for (let i = 0; i < parent.childCount; i++) {
      const target = pick(targets);
      this.missiles.push(
        new EnemyMissile(
          parent.x,
          parent.y,
          target.x + rand(-12, 12),
          this.groundY,
          parent.speed * rand(0.95, 1.2),
          0,
          0,
          'normal'
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------
  getActiveTurret() {
    let usable = null;
    let usableD = Infinity;
    let anyAlive = null;
    let aliveD = Infinity;
    for (const t of this.turrets) {
      if (!t.alive) continue;
      const d = Math.abs(t.x - this.mouseX);
      if (d < aliveD) {
        aliveD = d;
        anyAlive = t;
      }
      if (t.ammo > 0 && d < usableD) {
        usableD = d;
        usable = t;
      }
    }
    return usable || anyAlive;
  }

  update(dt) {
    if (this.paused || this.devMenuOpen) return; // dev console freezes the sim
    this.time += dt;

    for (const p of this.particles) p.update(dt);
    removeWhere(this.particles, (p) => p.dead);
    for (const e of this.explosions) e.age += dt;
    removeWhere(this.explosions, (e) => e.age >= e.dur);
    for (const b of this.laserBeams) b.life -= dt;
    removeWhere(this.laserBeams, (b) => b.life <= 0);

    // Mushroom clouds: after a nuke burst, keep feeding smoke into a rising
    // stem and a spreading cap for a few seconds. The hot dust glows warm
    // early, then cools to ash gray as it climbs.
    for (const mc of this.mushrooms) {
      mc.age += dt;
      const capY = mc.y - Math.min(300, mc.age * 110); // cap climbs, then slows
      if (Math.random() < dt * 30) {
        // Stem: a narrow column boiling up from the ground to the cap.
        smokePuff(
          this.particles,
          mc.x + rand(-24, 24),
          rand(capY + 40, mc.groundY - 6),
          1,
          mc.age < 1.2 ? '#c89a6e' : '#6e6258'
        );
      }
      if (mc.age > 0.4 && Math.random() < dt * 26) {
        // Cap: a broad, flattened head spreading at the top.
        smokePuff(
          this.particles,
          mc.x + rand(-95, 95),
          capY + rand(-24, 18),
          1,
          mc.age < 1.6 ? '#caa57e' : '#7a6e62'
        );
      }
    }
    removeWhere(this.mushrooms, (mc) => mc.age > 4.5);
    for (const ft of this.floatTexts) ft.life -= dt;
    removeWhere(this.floatTexts, (ft) => ft.life <= 0);
    if (this.shakeTime > 0) this.shakeTime -= dt;

    // Active turret tracks the cursor in every state (looks alive on menus).
    const active = this.getActiveTurret();
    this.activeTurret = active;
    if (active && this.state !== 'gameover') {
      active.aimAt(this.mouseX, this.mouseY);
    }
    for (const t of this.turrets) t.update(dt);

    if (this.state === 'playing') this.updatePlaying(dt);
    // 'intermission' just waits in the shop for the player to proceed.
  }

  /**
   * Autonomous laser: when charged, it latches onto the most urgent target it
   * can track (drones and normal-type missiles — fast movers are beyond it)
   * and burns it down over time, so bigger targets take a longer, committed
   * burn. After the kill it recharges. The beam originates from the laser
   * emplacement left of the gun mount.
   */
  updateLaser(dt) {
    const L = this.laser;
    const cfg = CONFIG.laser;
    if (!L.owned) return;
    const mount = this.turrets.find((t) => t.alive);
    if (!mount) {
      L.target = null;
      this.laserBeamLive = null;
      return;
    }
    const ex = mount.x + cfg.offsetX;
    const ey = this.groundY - cfg.emitterHeight;
    const beamDist = (m) => Math.hypot(m.x - ex, m.y - ey);
    // Elevation above the horizon (sim +y is down). The head can't depress
    // below its minimum firing arc, so deck-skimmers right on the horizon are
    // outside its envelope.
    const minElev = (cfg.minElevationDeg * Math.PI) / 180;
    const inArc = (m) => Math.atan2(ey - m.y, Math.abs(m.x - ex)) >= minElev;

    // Drop a target that died under gunfire, split away, flew out of range,
    // or dipped below the firing arc.
    if (
      L.target &&
      (L.target.dead ||
        !L.canTarget(L.target) ||
        beamDist(L.target) > cfg.range ||
        !inArc(L.target))
    ) {
      L.target = null;
    }

    if (!L.target) {
      this.laserBeamLive = null;
      L.update(dt); // recharge only while idle
      if (L.canFire) {
        let best = null;
        for (const m of this.missiles) {
          if (!L.canTarget(m) || m.stealthed) continue;
          if (beamDist(m) > cfg.range || !inArc(m)) continue; // outside envelope
          if (!best || m.y > best.y) best = m; // closest to the ground = most urgent
        }
        L.target = best;
      }
      if (!L.target) {
        // Idle: ease the head back to vertical.
        this.slewLaser(-Math.PI / 2, dt);
        return;
      }
    }

    // Slew the emitter head onto the target; it only burns once aligned.
    const m = L.target;
    const desired = Math.atan2(m.y - ey, m.x - ex);
    const err = this.slewLaser(desired, dt);
    if (err > (cfg.aimToleranceDeg * Math.PI) / 180) {
      this.laserBeamLive = null; // still traversing
      return;
    }

    // Burn. Output falls off with distance: full power inside fullPowerDist,
    // proportionally weaker out toward max range.
    if (this.laserBeamLive == null) sfx.laser(this.pan(m.x)); // burn just began
    const falloff = Math.min(1, cfg.fullPowerDist / beamDist(m));
    m.hp -= L.dps * falloff * dt;
    m.hitFlash = Math.max(m.hitFlash, 0.05); // sizzling-under-the-beam feedback
    // Beam leaves from the tip of the aimed barrel.
    const x1 = ex + Math.cos(L.angle) * cfg.barrelLength;
    const y1 = ey + Math.sin(L.angle) * cfg.barrelLength;
    this.laserBeamLive = { x1, y1, x2: m.x, y2: m.y };
    if (m.hp <= 0) {
      this.rewardKill(m);
      m.dead = true;
      this.killEffect(m);
      L.target = null;
      L.fire(); // start the recharge
      // Leave a fading after-beam at the kill.
      this.laserBeams.push({
        x1,
        y1,
        x2: m.x,
        y2: m.y,
        life: cfg.beamTime,
        maxLife: cfg.beamTime,
      });
      this.laserBeamLive = null;
    }
  }

  /** Slew the laser head toward `desired`; returns the remaining error. */
  slewLaser(desired, dt) {
    const L = this.laser;
    let d = desired - L.angle;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const max = CONFIG.laser.turnRate * dt;
    if (Math.abs(d) <= max) {
      L.angle = desired;
      return 0;
    }
    L.angle += Math.sign(d) * max;
    return Math.abs(d) - max;
  }

  /** Current gun-shield recharge time, by upgrade level. */
  shieldRechargeTime() {
    const ladder = CONFIG.shield.rechargeTimes;
    return ladder[Math.min(Math.max(0, this.shieldLevel - 1), ladder.length - 1)];
  }

  /** Regenerate the gun's depleted shield bubble over time (cities have none). */
  updateShields(dt) {
    const rt = this.shieldRechargeTime();
    for (const s of this.turrets) {
      if (s.shieldFlash > 0) s.shieldFlash -= dt;
      if (!s.alive) continue;
      if (s.shields < s.shieldMax) {
        s.shieldTimer -= dt;
        if (s.shieldTimer <= 0) {
          s.shields++;
          s.shieldTimer = rt;
        }
      } else {
        s.shieldTimer = rt;
      }
    }
  }

  updatePlaying(dt) {
    const active = this.activeTurret;
    this.updateShields(dt);
    this.updateInterceptorLauncher(dt);
    this.updateLaser(dt);

    // The CIWS runs itself: you steer the stream with the cursor, and it
    // holds fire whenever the sky is clear of visible threats.
    const threatsUp = this.missiles.some((m) => !m.dead && !m.stealthed);
    if (threatsUp && active && active.usable) {
      const shots = this.ciws.fireFrom(active);
      if (shots.length) {
        this.bullets.push(...shots);
        sfx.fire(this.pan(active.x));
        // Powder smoke drifting off the muzzle while the gun runs.
        if (Math.random() < 0.25) {
          const mz = active.muzzle();
          smokePuff(this.particles, mz.x, mz.y, 1, '#9aa3ad');
        }
      }
    }

    // A detected nuclear launch arrives once its warning runs out.
    for (let i = this.pendingNukes.length - 1; i >= 0; i--) {
      this.pendingNukes[i] -= dt;
      if (this.pendingNukes[i] <= 0) {
        this.pendingNukes.splice(i, 1);
        this.launchNuke();
      }
    }

    // Spawn the wave over time. A dev sandbox replaces the wave budget with
    // an endless drip of its one scenario type.
    if (this.devScenario) {
      const sc = this.devScenario;
      this.devSpawnTimer -= dt;
      const live =
        this.missiles.filter((m) => !m.dead).length + this.pendingNukes.length;
      if (this.devSpawnTimer <= 0 && live < sc.maxLive) {
        this.devSpawn(sc.type);
        this.devSpawnTimer = sc.gap;
      }
    } else if (this.toSpawn > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnMissile();
        this.toSpawn--;
        this.spawnTimer = rand(this.spawnGap * 0.6, this.spawnGap * 1.4);
      }
    }

    // Advance missiles (skip children spawned this frame).
    const n = this.missiles.length;
    for (let i = 0; i < n; i++) {
      const m = this.missiles[i];
      const r = m.update(dt, this.groundY);
      if (r === 'split') this.splitMissile(m);
      else if (r === 'impact') this.impact(m);
      // A bomber that has cleared the field outbound is gone from the world
      // immediately — it does not loiter off-screen for an interceptor to
      // chase down. Direction-aware so it isn't culled on the way IN.
      else if (
        m.type === 'bomber' &&
        ((m.vx < 0 && m.x < -80) || (m.vx > 0 && m.x > this.W + 80))
      ) {
        m.dead = true;
      }
      // Insurance: anything that strays far outside the field (a side-entry
      // flyer that lost its way) dies as a leak rather than stalling the wave.
      else if (m.age > 3 && (m.x < -400 || m.x > this.W + 400 || m.y < -500)) {
        m.dead = true;
        this.waveLeaks++;
      }
    }

    // Bombers: release glide bombs over the field, and fly defensively. The
    // pilot weaves whenever a homing round is hunting him OR one of his own
    // flares (he can't know whether the decoy took), commits to a hard break
    // when the round gets close, and weaves out of CIWS streams too.
    const bc = CONFIG.missile.bomber;
    for (const m of this.missiles) {
      if (m.type !== 'bomber' || m.dead) continue;
      // Nearest homing round bound for this airframe or one of its decoys.
      let nearest = null;
      let nearestD = Infinity;
      for (const it of this.interceptorList) {
        if (it.dead) continue;
        if (it.target !== m && (!it.target || it.target.owner !== m)) continue;
        const d = Math.hypot(it.x - m.x, it.y - m.y);
        if (d < nearestD) {
          nearestD = d;
          nearest = it;
        }
      }
      const wasBreaking = m.breaking;
      m.breaking = nearestD < bc.breakRange;
      if (m.breaking && !wasBreaking) {
        // Commit the pull away from the round's approach side.
        m.breakDir = nearest.y > m.y ? -1 : 1;
      }
      m.evading = nearestD < bc.evadeRange || this.bulletThreatens(m);
      m.flareTimer -= dt;
      if (nearestD < bc.evadeRange && m.flareBursts > 0 && m.flareTimer <= 0) {
        this.dispenseFlares(m);
      }
      // Defending costs the mission: a pilot forced into the jink aborts the
      // bombing run for good — suppressing a bomber IS a kind of kill.
      if (m.evading) m.bombsAborted = true;
      if (m.bombsAborted || m.bombsLeft <= 0) continue;
      m.bombTimer -= dt;
      if (m.bombTimer > 0) continue;
      if (m.x < 80 || m.x > this.W - 80) continue; // hold until over the field
      m.bombsLeft--;
      m.bombTimer = rand(bc.dropGap[0], bc.dropGap[1]);
      this.dropGlideBomb(m);
    }

    // Burning flares: fall away from the bomber as small, tight points of
    // light — a dim ember trail, not a fireworks display. The sparks are
    // shrunk and mostly follow the flare so the effect stays compact.
    for (const f of this.flares) {
      f.update(dt);
      if (Math.random() < dt * 30) {
        const p = new Particle(f.x, f.y, C.flare, 'spark');
        p.vx = p.vx * 0.15 + f.vx * 0.3;
        p.vy = p.vy * 0.15 + f.vy * 0.3;
        p.size *= 0.5;
        this.particles.push(p);
      }
      if (Math.random() < dt * 5) {
        const s = new Particle(f.x, f.y, C.rocketSmoke, 'smoke');
        s.size *= 0.5; // a wisp, not a cloud
        this.particles.push(s);
      }
    }
    removeWhere(this.flares, (f) => f.dead);

    // Shields intercept missiles at the dome before they reach the ground.
    this.checkShieldCollisions();

    // Advance bullets, cull off-screen.
    for (const b of this.bullets) {
      b.update(dt, this.groundY);
      if (b.x < -20 || b.x > this.W + 20 || b.y < -20 || b.y > this.groundY + 5) {
        b.dead = true;
      }
    }

    // Advance interceptors (boost/coast homing) and handle their detonations.
    for (const it of this.interceptorList) {
      // If its target died en route, retask onto the nearest live threat —
      // or self-destruct rather than flying off uselessly.
      if (!it.dead && it.target && it.target.dead) {
        it.target = this.nearestInterceptTarget(it);
        if (!it.target) {
          it.dead = true;
          this.detonateInterceptor(it);
          continue;
        }
      }
      // Boost phase: pump out a billowing white solid-motor exhaust plume.
      if (it.boosting && Math.random() < dt * CONFIG.interceptor.smokeRate) {
        const sp = Math.hypot(it.vx, it.vy) || 1;
        smokePuff(
          this.particles,
          it.x - (it.vx / sp) * 10 + rand(-2, 2),
          it.y - (it.vy / sp) * 10 + rand(-2, 2),
          1,
          C.rocketSmoke
        );
      }
      const r = it.update(dt, this.groundY);
      if (r === 'detonate') this.detonateInterceptor(it);
      else if (r === 'fizzle') explode(this.particles, it.x, it.y, C.interceptorTrail, 6);
    }

    this.checkCollisions();

    removeWhere(this.missiles, (m) => m.dead);
    removeWhere(this.bullets, (b) => b.dead);
    removeWhere(this.interceptorList, (it) => it.dead);

    const aliveCities = this.cities.filter((c) => c.alive).length;
    const aliveTurrets = this.turrets.filter((t) => t.alive).length;
    if (aliveTurrets === 0) {
      this.gameOver(T.loss.gunDestroyed);
      return;
    }
    if (aliveCities === 0) {
      this.gameOver(T.loss.citiesLost);
      return;
    }

    // Hold a short beat after the last threat dies so the wave doesn't end
    // jarringly the instant the final missile pops. A dev sandbox never ends.
    if (
      !this.devScenario &&
      this.toSpawn === 0 &&
      this.missiles.length === 0 &&
      this.pendingNukes.length === 0
    ) {
      this.waveEndTimer += dt;
      if (this.waveEndTimer >= CONFIG.wave.endDelay) this.endWave();
    } else {
      this.waveEndTimer = 0;
    }
  }

  /** Map a sim x position into the stereo field (-1..1) for positional SFX. */
  pan(x) {
    return clamp((x / this.W) * 2 - 1, -1, 1);
  }

  /**
   * Spawn a transient explosion visual (fireball flash + overpressure
   * shockwave, drawn by the renderer) plus a few lingering smoke puffs.
   * `radius` overrides the size preset so area-effect bursts can draw their
   * wave at exactly the kill radius — the visual never oversells the weapon.
   */
  boom(x, y, size, color, radius) {
    if (this.explosions.length < CONFIG.render.maxExplosions) {
      const cfg = CONFIG.explosion[size];
      this.explosions.push({
        x, y, age: 0, dur: cfg.dur, maxR: radius ?? cfg.radius, color, size,
      });
    }
    smokePuff(this.particles, x, y, CONFIG.explosion.smokePer[size]);
  }

  /**
   * Per-type death effect: each threat dies with its own animation + sound.
   *   normal     — orange pop with mixed spark/ember debris.
   *   evasive    — purple whirling ring burst (its weave spinning apart).
   *   hypersonic — debris streaks on along its heading (momentum carries).
   *   mirv bus   — big green armoured blow-out with a heavy ember shower.
   */
  killEffect(m) {
    const pan = this.pan(m.x);
    if (m.splitsRemaining > 0) {
      explode(this.particles, m.x, m.y, C.missileMirv, 26);
      this.boom(m.x, m.y, 'medium', C.missileMirv);
      sfx.kill('mirv', pan);
    } else if (m.type === 'evasive') {
      explodeRing(this.particles, m.x, m.y, C.missileEvasive, 22);
      this.boom(m.x, m.y, 'small', C.missileEvasive);
      sfx.kill('evasive', pan);
    } else if (m.type === 'hypersonic') {
      explodeCone(this.particles, m.x, m.y, m.hx, m.hy, C.missileHypersonic, 20);
      this.boom(m.x, m.y, 'small', C.missileHypersonic);
      sfx.kill('hypersonic', pan);
    } else if (m.type === 'cruise' || m.type === 'stealth') {
      // The wreck keeps flying: debris streams on along its heading (a downed
      // stealth bird shatters pale, finally visible).
      const col = m.type === 'stealth' ? C.missileStealth : C.missileCruise;
      explodeCone(this.particles, m.x, m.y, m.hx, m.hy, col, 18);
      this.boom(m.x, m.y, 'medium', col);
      sfx.kill('cruise', pan);
    } else if (m.type === 'drone') {
      // Small machine sparking out — a fizzly pop, not a warhead blast.
      explodeRing(this.particles, m.x, m.y, C.missileDrone, 10);
      this.boom(m.x, m.y, 'small', C.missileDrone);
      sfx.kill('drone', pan);
    } else if (m.type === 'bomber') {
      // A big airframe coming apart: heavy burning debris carries forward.
      explodeCone(this.particles, m.x, m.y, m.hx, m.hy, C.missileBomber, 30);
      this.boom(m.x, m.y, 'large', C.missileBomber);
      sfx.kill('mirv', pan); // heavy double thump suits a dying airframe
    } else if (m.type === 'nuke') {
      // Killed before detonation: the carcass blows big, but no chain reaction.
      explode(this.particles, m.x, m.y, C.missileNuke, 32);
      this.boom(m.x, m.y, 'large', C.missileNuke);
      sfx.kill('nuke', pan);
    } else {
      explode(this.particles, m.x, m.y, C.explosion, 14);
      this.boom(m.x, m.y, 'small', C.explosion);
      sfx.kill('normal', pan);
    }
  }

  checkCollisions() {
    const hit = CONFIG.missile.radius + CONFIG.missile.hitPadding + CONFIG.bullet.radius;
    const hit2 = hit * hit;
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const m of this.missiles) {
        if (m.dead) continue;
        if (dist2(b.x, b.y, m.x, m.y) <= hit2) {
          b.dead = true;
          m.hp -= CONFIG.bullet.damage;
          if (m.hp <= 0) {
            this.rewardKill(m);
            m.dead = true;
            this.killEffect(m);
          } else {
            // Armoured target took a hit but survives — spark + ting, no kill.
            m.hitFlash = CONFIG.missile.hitFlashTime;
            explode(this.particles, b.x, b.y, C.hitSpark, 5);
            sfx.hit(this.pan(b.x));
          }
          break;
        }
      }
    }
  }

  impact(missile) {
    this.waveLeaks++; // a threat reached the ground (breaks the all-clear bonus)

    // A nuke AIR-BURSTS above its target and levels the target city plus its
    // immediate neighbours — including the CIWS if it's next door. Two slots
    // away is outside the lethal radius.
    if (missile.type === 'nuke') {
      const r = CONFIG.missile.nuke.blastRadius;
      for (const s of [...this.cities, ...this.turrets]) {
        if (this.devInvincible) break; // dev god mode: the blast is all show
        if (s.alive && Math.abs(s.x - missile.x) <= r + this.structureHalfWidth(s)) {
          s.alive = false;
          s.destroyedWave = this.wave;
          s.shieldMax = 0;
          s.shields = 0;
          s.shieldFlash = 0;
        }
      }
      explode(this.particles, missile.x, missile.y, C.groundExplosion, 70);
      this.boom(missile.x, missile.y, 'nuke', '#ffe6a8');
      this.mushrooms.push({ x: missile.x, y: missile.y, groundY: this.groundY, age: 0 });
      this.shakeTime = 1.0;
      this.shakeMag = 22;
      sfx.nukeBlast(this.pan(missile.x));
      return;
    }

    // Shielded structures are intercepted up at their dome (see
    // checkShieldCollisions), so anything reaching the ground hits unshielded.
    const r = CONFIG.missile.blastRadius;
    let destroyed = 0;
    for (const s of [...this.cities, ...this.turrets]) {
      if (this.devInvincible) break; // dev god mode: structures shrug it off
      // The blast harms a structure if it overlaps its footprint at all —
      // a hit on the outermost building counts, not just dead centre.
      if (s.alive && Math.abs(s.x - missile.x) <= r + this.structureHalfWidth(s)) {
        s.alive = false;
        s.destroyedWave = this.wave;
        // A destroyed structure loses its shield with it — you must repair AND
        // re-buy a shield to protect it again.
        s.shieldMax = 0;
        s.shields = 0;
        s.shieldFlash = 0;
        destroyed++;
      }
    }

    const big = destroyed > 0;
    explode(this.particles, missile.x, this.groundY, C.groundExplosion, big ? 38 : 22);
    this.boom(missile.x, this.groundY, big ? 'large' : 'medium', C.groundExplosion);
    this.shakeTime = big ? 0.35 : 0.22;
    this.shakeMag = big ? 9 : 6;
    if (big) sfx.targetHit(this.pan(missile.x));
    else sfx.groundImpact(this.pan(missile.x));
  }

  /** A missile entering the gun's shield dome detonates on contact. */
  checkShieldCollisions() {
    const rr = CONFIG.shield.radius * CONFIG.shield.radius;
    for (const m of this.missiles) {
      if (m.dead) continue;
      for (const s of this.turrets) {
        if (!s.alive || s.shields <= 0) continue;
        if (m.y <= this.groundY && dist2(m.x, m.y, s.x, this.groundY) <= rr) {
          this.shieldAbsorb(s, m);
          break;
        }
      }
    }
  }

  /** The dome eats a warhead, detonating it where it struck, then collapses. */
  shieldAbsorb(s, m) {
    s.shields--; // one shield, so this breaks it
    s.shieldFlash = CONFIG.shield.flashTime;
    m.dead = true;
    this.waveLeaks++; // it got past your guns to the shield
    explode(this.particles, m.x, m.y, C.explosion, 12); // warhead bursts on the dome
    explode(this.particles, m.x, m.y, C.shield, 26); // shield energy shatter
    this.boom(m.x, m.y, 'medium', C.shield);
    this.shakeTime = Math.max(this.shakeTime, 0.2);
    this.shakeMag = 6;
    sfx.shieldBreak(this.pan(m.x));
  }

  // -------------------------------------------------------------------------
  // Interceptors (secondary weapon)
  // -------------------------------------------------------------------------
  /**
   * The launcher fires itself: whenever it has finished reloading it picks
   * the highest-value threat, biased toward distant ones (the gun and laser
   * own the near sky). It never spends a missile on a drone, and it can't
   * see cloaked stealth missiles.
   */
  updateInterceptorLauncher(dt) {
    const iw = this.interceptorWeapon;
    iw.update(dt);
    if (!iw.canLaunch) return;
    const launcher = this.turrets.find((t) => t.alive);
    if (!launcher) return;
    const lx = launcher.x + CONFIG.interceptor.launcherOffsetX;
    const ly = this.groundY - CONFIG.interceptor.launcherHeight;
    let best = null;
    let bestScore = -Infinity;
    for (const m of this.missiles) {
      // Cheap clutter — drones and glide bombs — is never worth a round; the
      // laser and the gun handle it.
      if (m.dead || m.stealthed || m.type === 'drone' || m.type === 'glidebomb') continue;
      const d = Math.hypot(m.x - lx, m.y - ly);
      if (d < CONFIG.interceptor.minTargetDist) continue; // gun's business
      const score = this.missileBounty(m) * 2 + d / 400; // value first, then reach
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (!best) return;
    const it = iw.launch(lx, ly, best);
    if (it) {
      this.interceptorList.push(it);
      sfx.rocketBurn(CONFIG.interceptor.boostTime, this.pan(lx));
    }
  }

  /**
   * Nearest live (visible) missile to a given interceptor, for retasking.
   * Drones and glide bombs are never valid interceptor targets — not even
   * mid-flight — though either caught in a blast still dies.
   */
  nearestInterceptTarget(it) {
    let best = null;
    let bestD = Infinity;
    for (const m of this.missiles) {
      if (m.dead || m.stealthed || m.type === 'drone' || m.type === 'glidebomb') continue;
      const d = dist2(m.x, m.y, it.x, it.y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** Area warhead burst: instakills every missile within the blast radius. */
  detonateInterceptor(it) {
    explode(this.particles, it.x, it.y, C.interceptorBlast, 22);
    // The wave is drawn at the true blast radius, so what you see is exactly
    // what the warhead can kill.
    this.boom(it.x, it.y, 'medium', C.interceptorBlast, CONFIG.interceptor.blastRadius);
    this.shakeTime = Math.max(this.shakeTime, 0.18);
    this.shakeMag = 5;
    sfx.interceptorBoom(this.pan(it.x));
    const r = CONFIG.interceptor.blastRadius;
    const r2 = r * r;
    for (const m of this.missiles) {
      if (m.dead) continue;
      if (dist2(m.x, m.y, it.x, it.y) <= r2) {
        // The blast deals flat damage: anything ordinary dies outright, but a
        // heavily-built nuke shrugs it off and needs a second interceptor.
        m.hp -= CONFIG.interceptor.blastDamage;
        if (m.hp <= 0) {
          this.rewardKill(m);
          m.dead = true;
          this.killEffect(m);
        } else {
          m.hitFlash = CONFIG.missile.hitFlashTime;
          sfx.hit(this.pan(m.x));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rendering: 3D world via renderer, 2D HUD/overlay here.
  // -------------------------------------------------------------------------
  render() {
    this.renderer.render(this);

    const ctx = this.hctx;
    ctx.clearRect(0, 0, this.screenW, this.screenH);

    const aiming = this.state === 'playing' && !this.paused;

    // A subtle shake nudges the whole HUD too, keeping it married to the scene.
    ctx.save();
    if (this.shakeTime > 0) {
      const k = this.shakeTime / 0.25;
      ctx.translate(
        rand(-this.shakeMag, this.shakeMag) * k,
        rand(-this.shakeMag, this.shakeMag) * k
      );
    }

    if (aiming) {
      this.drawAimLine(ctx);
    }
    if (this.state === 'playing') this.drawThreatTags(ctx);
    this.drawFloatTexts(ctx);
    this.drawHUD(ctx);
    ctx.restore();

    // Touch: the fire-control pad sits below the field, outside the shake.
    if (this.touchMode && this.state === 'playing') this.drawTouchPad(ctx);

    // The dev console replaces whatever overlay would be up underneath it.
    if (this.devMenuOpen) this.drawDevMenu(ctx);
    else this.drawOverlay(ctx);
    // The crosshair stands in for the OS cursor, so draw it last (on top of
    // menus / the shop / game-over) in every state.
    this.drawCrosshair(ctx);
  }

  /** The ID tag shown in a threat's targeting box, or null for cloaked. */
  threatLabel(m) {
    if (m.stealthed) return null;
    if (m.splitsRemaining > 0) return T.threatNames.mirv;
    return T.threatNames[m.type] ?? null;
  }

  /**
   * Flavor targeting boxes: thin corner brackets + an ID tag, like a
   * fire-control display interrogating a track. Shown only for threats near
   * the pointer — point at something to ask "what is that?" — and fading
   * with distance so they never clutter the whole sky. No gameplay effect.
   */
  drawThreatTags(ctx) {
    // Per-type bracket half-size, roughly tracking the airframe's bulk.
    const half = { bomber: 26, nuke: 18, cruise: 13, stealth: 13, drone: 9, glidebomb: 8 };
    const hoverR2 = CONFIG.ui.tagHoverRadius * CONFIG.ui.tagHoverRadius;
    const drawn = []; // label anchor points already used this frame
    ctx.save();
    ctx.lineWidth = 1;
    for (const m of this.missiles) {
      if (m.dead) continue;
      const label = this.threatLabel(m);
      if (!label) continue;
      if (m.x < -20 || m.x > this.W + 20 || m.y < -20) continue; // off-field
      const d2 = dist2(m.x, m.y, this.mouseX, this.mouseY);
      if (d2 > hoverR2) continue; // only interrogate tracks near the pointer
      const fade = 1 - (d2 / hoverR2) ** 2; // soft edge instead of popping
      const p = this.renderer.worldToScreen(m.x, m.y);
      const h = half[m.type] ?? 11;
      const hot = m.type === 'nuke';
      const col = hot ? C.crosshairEmpty : C.lock;
      const tagAlpha = (hot ? 0.9 : 0.55) * fade;
      ctx.strokeStyle = col;
      ctx.lineWidth = hot ? 1.6 : 1.2;
      // Cell-membrane reticle: a softly wobbling amoeboid ring around the
      // track with a fainter inner iris — a microscope picking out a cell.
      const ph = this.time * 0.9 + (m.id || 0) * 0.7;
      ctx.globalAlpha = tagAlpha;
      this._membraneRing(ctx, p.x, p.y, h * 1.15, h * 0.14, 7, ph);
      ctx.globalAlpha = tagAlpha * 0.45;
      this._membraneRing(ctx, p.x, p.y, h * 0.6, h * 0.1, 6, -ph * 1.4);
      ctx.globalAlpha = tagAlpha;
      // De-clutter: a tag that would overprint one already on screen (e.g. a
      // glide bomb just off its bomber's rack) keeps its brackets but stays
      // silent — the display only labels what it can write legibly.
      const ly = p.y + h + 12;
      const clear = drawn.every((d) => Math.abs(d.x - p.x) > 64 || Math.abs(d.y - ly) > 12);
      if (clear) {
        drawn.push({ x: p.x, y: ly });
        this.text(label, p.x, ly, { size: 9, align: 'center', color: col });
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /**
   * Touch fire-control pad: a radar repeater of the whole field. Dragging on
   * it lays the gun — absolute mapping, pad position = field position — so
   * the player's thumb stays off the action. Blips mirror the tactical
   * picture: cities, the gun, threats by type, friendly interceptors.
   */
  drawTouchPad(ctx) {
    const r = this.padRect;
    if (!r) return;
    const sx = (x) => r.x + clamp(x / this.W, 0, 1) * r.w;
    const sy = (y) => r.y + clamp(y / this.groundY, 0, 1) * r.h;
    ctx.save();
    ctx.fillStyle = 'rgba(10,18,32,0.92)';
    this._roundRect(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(108,240,255,0.35)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.stroke();
    this.text(T.touch.padLabel, r.x + 10, r.y + 14, { size: 9, color: C.hudDim });

    // Ground strip with city / gun markers.
    ctx.strokeStyle = 'rgba(44,90,143,0.9)';
    ctx.beginPath();
    ctx.moveTo(r.x + 3, r.y + r.h - 4);
    ctx.lineTo(r.x + r.w - 3, r.y + r.h - 4);
    ctx.stroke();
    for (const c of this.cities) {
      ctx.fillStyle = c.alive ? C.city : C.cityDead;
      ctx.fillRect(sx(c.x) - 4, r.y + r.h - 8, 8, 4);
    }
    for (const t of this.turrets) {
      ctx.fillStyle = t.alive ? C.turretActive : C.cityDead;
      ctx.fillRect(sx(t.x) - 2, r.y + r.h - 10, 5, 6);
    }

    // Threat blips, colored by type (cloaked stealth stays invisible here
    // too); friendly interceptors as small cool dots.
    const blipCol = {
      normal: C.missile,
      evasive: C.missileEvasive,
      hypersonic: C.missileHypersonic,
      cruise: C.missileCruise,
      stealth: C.missileStealth,
      drone: C.missileDrone,
      bomber: C.missileBomber,
      glidebomb: C.missileGlidebomb,
      nuke: C.missileNuke,
    };
    for (const m of this.missiles) {
      if (m.dead || m.stealthed) continue;
      if (m.x < -40 || m.x > this.W + 40 || m.y < -40) continue;
      const hot = m.type === 'nuke';
      const s = hot ? 3.5 : 2;
      ctx.fillStyle = blipCol[m.type] ?? C.missile;
      ctx.fillRect(sx(m.x) - s / 2, sy(m.y) - s / 2, s, s);
    }
    ctx.fillStyle = C.interceptor;
    for (const it of this.interceptorList) {
      if (it.dead) continue;
      ctx.fillRect(sx(it.x) - 1, sy(it.y) - 1, 2, 2);
    }

    // Aim marker: a small reticle at the mapped aim point.
    const ax = sx(this.mouseX);
    const ay = sy(this.mouseY);
    ctx.strokeStyle = C.crosshair;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(ax, ay, 5, 0, TAU);
    ctx.moveTo(ax - 9, ay);
    ctx.lineTo(ax - 3, ay);
    ctx.moveTo(ax + 3, ay);
    ctx.lineTo(ax + 9, ay);
    ctx.moveTo(ax, ay - 9);
    ctx.lineTo(ax, ay - 3);
    ctx.moveTo(ax, ay + 3);
    ctx.lineTo(ax, ay + 9);
    ctx.stroke();
    ctx.restore();
  }

  drawAimLine(ctx) {
    const t = this.activeTurret;
    if (!t || !t.alive) return;
    const mx = t.x + Math.cos(t.angle) * CONFIG.turret.barrelLength;
    const my = t.y + Math.sin(t.angle) * CONFIG.turret.barrelLength;
    const s = this.renderer.worldToScreen(mx, my);

    ctx.save();
    ctx.strokeStyle =
      t.ammo > 0 ? 'rgba(255,179,71,0.22)' : 'rgba(255,90,77,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    const aim = this.renderer.worldToScreen(this.mouseX, this.mouseY);
    ctx.lineTo(aim.x, aim.y);
    ctx.stroke();
    ctx.restore();
  }

  /** A softly wobbling closed ring — an amoeboid cell-membrane outline. */
  _membraneRing(ctx, cx, cy, r, amp, lobes, phase) {
    const N = 40;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * TAU;
      const rr = r + amp * Math.sin(lobes * a + phase);
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  drawCrosshair(ctx) {
    const t = this.activeTurret;
    // Red only when the gun mount is gone (nothing left to aim) during play;
    // on menus / the shop / game-over it's just a neutral reticle.
    const aiming = this.state === 'playing' && !this.paused;
    const empty = aiming && (!t || !t.alive);
    const col = empty ? C.crosshairEmpty : C.crosshair;
    // In play the reticle marks the AIM POINT in the field (which, with the
    // touch pad, is not under the finger); on menus it stands in for the
    // hidden OS cursor, so it follows the pointer.
    let x = this.pointerX;
    let y = this.pointerY;
    if (this.state === 'playing') {
      const p = this.renderer.worldToScreen(this.mouseX, this.mouseY);
      x = p.x;
      y = p.y;
    }
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    // The aim marker is a living cell: a wobbling membrane ring, a few flagella
    // flicking outward, and a bright nucleus pinned to the exact aim point.
    const ph = this.time * 1.4;
    this._membraneRing(ctx, x, y, 10, 1.6, 6, ph);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + 0.15 * Math.sin(ph + k);
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const perpx = -uy;
      const perpy = ux;
      const r0 = 11;
      const r1 = 19;
      const bow = 3 * Math.sin(ph * 1.6 + k * 1.7); // the hair lashes
      ctx.beginPath();
      ctx.moveTo(x + ux * r0, y + uy * r0);
      ctx.quadraticCurveTo(
        x + ux * ((r0 + r1) / 2) + perpx * bow,
        y + uy * ((r0 + r1) / 2) + perpy * bow,
        x + ux * r1,
        y + uy * r1
      );
      ctx.stroke();
    }
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  text(str, x, y, opts = {}) {
    const ctx = this.hctx;
    const {
      size = 16,
      color = C.hud,
      align = 'left',
      baseline = 'alphabetic',
      weight = 'normal',
      glow = false,
    } = opts;
    ctx.font = `${weight} ${size}px "Trebuchet MS", "Avenir Next", "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.fillText(str, x, y);
    ctx.shadowBlur = 0;
  }

  /** Floating "+credits" labels that rise and fade from each kill. */
  drawFloatTexts(ctx) {
    for (const ft of this.floatTexts) {
      const frac = ft.life / ft.maxLife; // 1 -> 0 over its life
      const p = this.renderer.worldToScreen(ft.x, ft.y);
      const y = p.y - (1 - frac) * CONFIG.ui.floatTextRise;
      const size = 18 + (1 - frac) * 8; // a little pop as it rises
      ctx.globalAlpha = Math.min(1, frac * 1.5);
      this.text(ft.text, p.x, y, {
        size,
        weight: 'bold',
        align: 'center',
        color: ft.color,
        glow: true,
      });
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Screen x-extents of the play field, for docking the HUD in the dead
   * columns beside it (the camera fills the screen vertically, so on wide
   * monitors the side columns are the only spare real estate).
   */
  hudColumns() {
    const tl = this.renderer.worldToScreen(0, 0);
    const bl = this.renderer.worldToScreen(0, this.groundY);
    const tr = this.renderer.worldToScreen(this.W, 0);
    const br = this.renderer.worldToScreen(this.W, this.groundY);
    const left = Math.min(tl.x, bl.x);
    const right = Math.max(tr.x, br.x);
    return { left, right, width: Math.min(left, this.screenW - right) };
  }

  drawHUD(ctx) {
    if (this.state === 'menu') return;
    // The touch armory owns the whole screen (its header shows the credits);
    // the corner HUD would collide with it on a phone.
    if (this.state === 'intermission' && this.touchMode) return;
    // Make it impossible to mistake a doctored run for a real one.
    if (this.devScenario || this.devInvincible) {
      this.text(T.dev.badge, this.screenW / 2, 20, {
        size: 12,
        align: 'center',
        weight: 'bold',
        color: C.credits,
        glow: true,
      });
    }
    const cols = this.hudColumns();
    if (cols.width >= 120) this.drawSideHUD(ctx, cols);
    else this.drawCornerHUD(ctx);
  }

  /** A small label-over-value block; returns the y below it. */
  hudStat(label, value, x, y, color = C.hud, big = 22) {
    this.text(label, x, y, { size: 11, align: 'center', color: C.hudDim });
    this.text(`${value}`, x, y + big, {
      size: big,
      align: 'center',
      weight: 'bold',
      color,
    });
    return y + big + 26;
  }

  /** A status line + progress bar centred at x; returns the y below it. */
  hudBar(ctx, label, frac, on, color, x, y, barW = 110) {
    this.text(label, x, y, { size: 12, align: 'center', color: on ? color : C.hudDim });
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x - barW / 2, y + 7, barW, 4);
    ctx.fillStyle = on ? color : C.hudDim;
    ctx.fillRect(x - barW / 2, y + 7, barW * frac, 4);
    return y + 34;
  }

  /** The laser status line tracks its charge state. */
  laserHudLabel() {
    if (this.laser.burning) return T.hud.laserFiring;
    return this.laser.canFire ? T.hud.laserCharged : T.hud.laserCharging;
  }

  /** Wide windows: stats docked in the columns flanking the play field. */
  drawSideHUD(ctx, cols) {
    const lx = cols.left / 2;
    let y = this.screenH * 0.12;
    y = this.hudStat(T.hud.score, this.score, lx, y);
    y = this.hudStat(T.hud.wave, this.wave, lx, y);
    const aliveCities = this.cities.filter((c) => c.alive).length;
    y = this.hudStat(
      T.hud.cities,
      `${aliveCities}/${this.cities.length}`,
      lx,
      y,
      aliveCities <= 2 ? C.crosshairEmpty : C.hud
    );
    if (sfx.muted) {
      this.text(T.hud.muted, lx, y, { size: 11, align: 'center', color: C.hudDim });
    }

    const rx = (cols.right + this.screenW) / 2;
    const barW = Math.min(116, (this.screenW - cols.right) * 0.8);
    y = this.screenH * 0.12;
    y = this.hudStat(T.hud.credits, this.credits, rx, y, C.credits);
    const iw = this.interceptorWeapon;
    if (iw.owned) {
      const ready = iw.canLaunch;
      y = this.hudBar(
        ctx,
        ready ? T.hud.intcpReady : T.hud.intcpReloading,
        1 - iw.reloadFrac,
        ready,
        C.interceptor,
        rx,
        y,
        barW
      );
    }
    if (this.laser.owned) {
      const lReady = this.laser.canFire || this.laser.burning;
      this.hudBar(ctx, this.laserHudLabel(), this.laser.chargeFrac, lReady, C.laser, rx, y, barW);
    }
  }

  /** Narrow windows: compact overlay tucked into the field's top corners. */
  drawCornerHUD(ctx) {
    this.text(`${T.hud.score} ${this.score}`, 14, 26, { size: 15, weight: 'bold' });
    this.text(`${T.hud.wave} ${this.wave}`, 14, 46, { size: 13, color: C.hud });
    const aliveCities = this.cities.filter((c) => c.alive).length;
    this.text(`${T.hud.cities} ${aliveCities}/${this.cities.length}`, 14, 64, {
      size: 13,
      color: aliveCities <= 2 ? C.crosshairEmpty : C.hud,
    });
    if (sfx.muted) this.text(T.hud.muted, 14, 82, { size: 11, color: C.hudDim });

    const rx = this.screenW - 14;
    this.text(`${T.hud.creditsShort} ${this.credits}`, rx, 26, { size: 15, weight: 'bold', align: 'right', color: C.credits });
    const iw = this.interceptorWeapon;
    if (iw.owned) {
      this.text(iw.canLaunch ? T.hud.intcpReady : T.hud.intcpReloading, rx, 46, {
        size: 12,
        align: 'right',
        color: iw.canLaunch ? C.interceptor : C.hudDim,
      });
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(rx - 90, 52, 90, 4);
      ctx.fillStyle = iw.canLaunch ? C.interceptor : C.hudDim;
      ctx.fillRect(rx - 90, 52, 90 * (1 - iw.reloadFrac), 4);
    }
    if (this.laser.owned) {
      const lOn = this.laser.canFire || this.laser.burning;
      this.text(this.laserHudLabel(), rx, 74, { size: 12, align: 'right', color: lOn ? C.laser : C.hudDim });
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(rx - 90, 80, 90, 4);
      ctx.fillStyle = lOn ? C.laser : C.hudDim;
      ctx.fillRect(rx - 90, 80, 90 * this.laser.chargeFrac, 4);
    }
  }

  dim(ctx, alpha = 0.6) {
    ctx.fillStyle = `rgba(3,5,10,${alpha})`;
    ctx.fillRect(0, 0, this.screenW, this.screenH);
  }

  drawOverlay(ctx) {
    const cx = this.screenW / 2;
    if (this.state === 'menu') {
      this.dim(ctx, 0.55);
      const compact = this.screenW < 700; // phones: tighter type, no overflow
      this.text(T.title, cx, this.screenH * 0.16, {
        size: compact ? 36 : 54,
        align: 'center',
        weight: 'bold',
        color: C.turretActive,
        glow: true,
      });
      this.text(T.subtitle, cx, this.screenH * 0.16 + (compact ? 28 : 40), {
        size: compact ? 13 : 18,
        align: 'center',
        color: C.hud,
      });

      this.text(T.howToPlayHeading, cx, this.screenH * 0.3, {
        size: 16,
        align: 'center',
        weight: 'bold',
        color: C.hud,
      });
      // Label + description rows. The description is wrapped to the screen,
      // so narrow (phone) windows reflow instead of running off the edge.
      // On touch the AIM row teaches the fire-control pad instead of a mouse.
      const rows = T.howToPlay.map((row, i) =>
        i === 0 && this.touchMode ? T.touch.howToAim : row
      );
      const fs = compact ? 11.5 : 13;
      const lh = compact ? 16 : 18;
      const labelX = compact ? 110 : cx - 230;
      const lineX = labelX + (compact ? 12 : 20);
      const maxW = Math.min(this.screenW - lineX - 14, 480);
      let ry = this.screenH * 0.3 + 34;
      for (const [label, ...lines] of rows) {
        this.text(label, labelX, ry, {
          size: fs,
          align: 'right',
          weight: 'bold',
          color: C.turretActive,
        });
        const wrapped = this._wrapText(ctx, lines.join(' '), maxW, fs);
        wrapped.forEach((l, i) =>
          this.text(l, lineX, ry + i * lh, { size: fs, color: C.hud })
        );
        ry += wrapped.length * lh + 14;
      }

      if (!this.touchMode) {
        this.text(T.keysHint, cx, ry + 10, {
          size: 14,
          align: 'center',
          color: C.hudDim,
        });
      }
      if (this.savedRun) {
        this.drawMenuSaveButtons(ctx, cx);
      } else {
        this.text(this.touchMode ? T.touch.deploy : T.deploy, cx, this.screenH * 0.88, {
          size: 20,
          align: 'center',
          weight: 'bold',
          color: C.crosshair,
          glow: true,
        });
      }
    } else if (this.state === 'intermission') {
      this.drawShop(ctx);
    } else if (this.state === 'gameover') {
      this.dim(ctx, 0.65);
      this.text((this.lossReason || T.loss.fallback).toUpperCase(), cx, this.screenH * 0.18, {
        size: 54,
        align: 'center',
        weight: 'bold',
        color: C.missile,
        glow: true,
      });
      const isBest = this.lastRun && this.lastRun.rank === 0 && this.score > 0;
      this.text(
        isBest ? T.gameover.newHighScore(this.score) : T.gameover.finalScore(this.score),
        cx,
        this.screenH * 0.18 + 48,
        { size: 24, align: 'center', color: isBest ? C.credits : C.hud, glow: isBest }
      );
      this.text(T.gameover.reachedWave(this.wave), cx, this.screenH * 0.18 + 78, {
        size: 16,
        align: 'center',
        color: C.hudDim,
      });

      // High-score table (kept in localStorage; the current run glows).
      const scores = this.lastRun ? this.lastRun.scores : [];
      if (scores.length) {
        const top = this.screenH * 0.36;
        this.text(T.gameover.highScoresHeading, cx, top, {
          size: 16,
          align: 'center',
          weight: 'bold',
          color: C.hud,
        });
        scores.slice(0, 8).forEach((s, i) => {
          const mine = this.lastRun.rank === i;
          const y = top + 28 + i * 24;
          const col = mine ? C.credits : C.hudDim;
          this.text(`${i + 1}.`, cx - 170, y, { size: 14, align: 'right', color: col });
          this.text(`${s.score}`, cx - 60, y, {
            size: 14,
            align: 'right',
            weight: mine ? 'bold' : 'normal',
            color: col,
          });
          this.text(T.gameover.waveColumn(s.wave), cx + 20, y, { size: 13, color: col });
          this.text(s.date || '', cx + 170, y, { size: 12, align: 'right', color: col });
        });
      }

      this.text(T.gameover.retry, cx, this.screenH * 0.85, {
        size: 20,
        align: 'center',
        weight: 'bold',
        color: C.crosshair,
        glow: true,
      });
    }

    if (this.paused && this.state === 'playing') {
      this.dim(ctx, 0.5);
      this.text(T.paused, cx, this.screenH * 0.45, {
        size: 44,
        align: 'center',
        weight: 'bold',
        color: C.hud,
        glow: true,
      });
      this.text(T.pausedHint, cx, this.screenH * 0.45 + 36, {
        size: 16,
        align: 'center',
        color: C.hudDim,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Shop (between-wave armory)
  // -------------------------------------------------------------------------
  /** Build the current shop offer list (availability/cost reflect game state). */
  getShopItems() {
    const S = CONFIG.shop;
    const cr = this.credits;
    const iw = this.interceptorWeapon;
    const X = T.shop.items;
    const items = [];

    if (!iw.owned) {
      items.push({
        label: X.interceptor.label,
        desc: X.interceptor.desc,
        cost: S.interceptorCost,
        soldOut: false,
        enabled: cr >= S.interceptorCost,
        action: () => iw.buy(),
        info: X.interceptor.info,
      });
    } else {
      const il = iw.cooldownLevel;
      const ilMax = il >= S.interceptorCooldownCosts.length;
      const cds = CONFIG.interceptor.cooldowns;
      items.push({
        label: ilMax ? X.interceptorReload.labelMax : X.interceptorReload.label(il + 1),
        desc: X.interceptorReload.desc(iw.cooldown),
        cost: ilMax ? null : S.interceptorCooldownCosts[il],
        soldOut: false,
        enabled: !ilMax && cr >= S.interceptorCooldownCosts[il],
        action: () => iw.upgradeCooldown(),
        info: X.interceptorReload.info(cds[0], cds[cds.length - 1]),
      });
    }

    const sl = this.shieldLevel;
    const slMax = sl >= CONFIG.shield.costs.length;
    const rts = CONFIG.shield.rechargeTimes;
    items.push({
      label:
        sl === 0
          ? X.shield.label
          : slMax
          ? X.shieldRecharge.labelMax
          : X.shieldRecharge.label(sl),
      desc: sl === 0 ? X.shield.desc : X.shieldRecharge.desc(this.shieldRechargeTime()),
      cost: slMax ? null : CONFIG.shield.costs[sl],
      soldOut: false,
      enabled: !slMax && cr >= CONFIG.shield.costs[sl],
      action: () => this.buyGunShield(),
      info: sl === 0 ? X.shield.info : X.shieldRecharge.info(rts[rts.length - 1]),
    });

    const L = CONFIG.laser;
    if (!this.laser.owned) {
      items.push({
        label: X.laser.label,
        desc: X.laser.desc,
        cost: L.cost,
        soldOut: false,
        enabled: cr >= L.cost,
        action: () => this.laser.buy(),
        info: X.laser.info,
      });
    } else {
      const ll = this.laser.level;
      const llMax = ll >= L.upgradeCosts.length;
      items.push({
        label: llMax ? X.laserRecharge.labelMax : X.laserRecharge.label(ll + 1),
        desc: X.laserRecharge.desc(this.laser.rechargeTime),
        cost: llMax ? null : L.upgradeCosts[ll],
        soldOut: false,
        enabled: !llMax && cr >= L.upgradeCosts[ll],
        action: () => this.laser.upgradeRecharge(),
        info: X.laserRecharge.info(L.cooldowns[0], L.cooldowns[L.cooldowns.length - 1]),
      });
    }

    const fl = this.ciws.fireRateLevel;
    const frMax = fl >= S.fireRateCosts.length;
    items.push({
      label: frMax ? X.fireRate.labelMax : X.fireRate.label(fl + 1),
      desc: X.fireRate.desc,
      cost: frMax ? null : S.fireRateCosts[fl],
      soldOut: false,
      enabled: !frMax && cr >= S.fireRateCosts[fl],
      action: () => this.ciws.upgradeFireRate(),
      info: X.fireRate.info,
    });

    const hasTwin = this.ciws.twin;
    items.push({
      label: X.twin.label,
      desc: hasTwin ? X.twin.descOwned : X.twin.desc,
      cost: hasTwin ? null : S.twinBarrelCost,
      soldOut: hasTwin,
      enabled: !hasTwin && cr >= S.twinBarrelCost,
      action: () => this.ciws.upgradeTwin(),
      info: X.twin.info,
    });

    return items;
  }

  /** Deterministic layout for the shop rows + the proceed button. */
  shopLayout() {
    const items = this.getShopItems();

    // Touch armory: compact rows up top, a detail panel for the selected
    // item, and two big thumb buttons (BUY / NEXT WAVE) along the bottom —
    // hover doesn't exist, so inspection is tap-to-select + explicit buy.
    if (this.touchMode) {
      const panelW = Math.min(520, this.screenW - 24);
      const x = this.screenW / 2 - panelW / 2;
      const top = this.screenH * 0.19;
      const rowH = 44;
      const gap = 7;
      const rows = items.map((item, i) => ({
        item,
        x,
        y: top + i * (rowH + gap),
        w: panelW,
        h: rowH,
      }));
      const lastY = top + items.length * (rowH + gap);
      const btnH = 50;
      const btnY = this.screenH - btnH - 14;
      const btnW = (panelW - 12) / 2;
      const buyRect = { x, y: btnY, w: btnW, h: btnH };
      const nextRect = { x: x + btnW + 12, y: btnY, w: btnW, h: btnH };
      return { rows, nextRect, buyRect, detailTop: lastY + 10 };
    }

    const panelW = Math.min(480, this.screenW - 16);
    const x = this.screenW / 2 - panelW / 2;
    const top = this.screenH * 0.3;
    const rowH = 46;
    const gap = 8;
    const rows = items.map((item, i) => ({
      item,
      x,
      y: top + i * (rowH + gap),
      w: panelW,
      h: rowH,
    }));
    const lastY = top + items.length * (rowH + gap);
    const nextRect = { x: this.screenW / 2 - 120, y: lastY + 18, w: 240, h: 46 };
    return { rows, nextRect };
  }

  buyItem(item) {
    if (!item || !item.enabled || item.cost == null) {
      sfx.denied();
      return;
    }
    this.credits -= item.cost;
    item.action();
    sfx.buy();
  }

  /** First purchase fits the gun's dome; later ones speed its recharge. */
  buyGunShield() {
    this.shieldLevel++;
    for (const t of this.turrets) {
      if (t.alive && t.shieldMax === 0) {
        t.shieldMax = CONFIG.shield.maxPerStructure;
        t.shields = t.shieldMax; // live immediately
        t.shieldTimer = this.shieldRechargeTime();
      }
    }
  }

  handleShopClick(px, py) {
    const { rows, nextRect, buyRect } = this.shopLayout();
    if (this._inRect(px, py, nextRect)) {
      this.proceedToNextWave();
      return;
    }
    // Touch: a row tap SELECTS (shows the detail panel); the BUY button is
    // the only thing that spends — no accidental purchases under a thumb.
    if (buyRect && this._inRect(px, py, buyRect)) {
      this.buyItem(rows[this.shopSelected]?.item);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      if (this._inRect(px, py, rows[i])) {
        if (this.touchMode) this.shopSelected = i;
        else this.buyItem(rows[i].item);
        return;
      }
    }
  }

  /** Continue / new-game button rects for the menu (when a checkpoint exists). */
  menuLayout() {
    const gap = 18;
    const w = Math.min(240, (this.screenW - gap - 24) / 2);
    const h = 46;
    const y = this.screenH * 0.86 - h / 2;
    const cx = this.screenW / 2;
    return {
      continueRect: { x: cx - w - gap / 2, y, w, h },
      newRect: { x: cx + gap / 2, y, w, h },
    };
  }

  /** A saved run on the menu: resume it, or deploy fresh (forfeits the save). */
  drawMenuSaveButtons(ctx, cx) {
    const { continueRect, newRect } = this.menuLayout();

    const cr = continueRect;
    const hoverC = this._inRect(this.pointerX, this.pointerY, cr);
    ctx.fillStyle = hoverC ? 'rgba(255,179,71,0.9)' : 'rgba(255,179,71,0.55)';
    this._roundRect(ctx, cr.x, cr.y, cr.w, cr.h, 6);
    ctx.fill();
    this.text(T.menu.continueRun(this.savedRun.wave), cr.x + cr.w / 2, cr.y + cr.h / 2 + 6, {
      size: 17,
      align: 'center',
      weight: 'bold',
      color: '#161008',
    });

    const nr = newRect;
    const hoverN = this._inRect(this.pointerX, this.pointerY, nr);
    ctx.fillStyle = hoverN ? C.shopRowHover : C.shopRow;
    this._roundRect(ctx, nr.x, nr.y, nr.w, nr.h, 6);
    ctx.fill();
    this.text(T.menu.newGame, nr.x + nr.w / 2, nr.y + nr.h / 2 + 6, {
      size: 17,
      align: 'center',
      weight: 'bold',
      color: C.hud,
    });

    this.text(T.menu.continueHint, cx, cr.y + cr.h + 22, {
      size: 12,
      align: 'center',
      color: C.hudDim,
    });
  }

  /**
   * Clicks on the menu / game-over screens. With a checkpoint on the menu the
   * choice is explicit (continue vs new) and stray clicks do nothing — a
   * misclick must not silently forfeit the save.
   */
  handleMenuClick(px, py) {
    if (this.state === 'menu' && this.savedRun) {
      const { continueRect, newRect } = this.menuLayout();
      if (this._inRect(px, py, continueRect)) this.continueGame();
      else if (this._inRect(px, py, newRect)) this.startGame();
      return;
    }
    this.startGame();
  }

  _inRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  /** Greedy word-wrap using real text metrics at the given font size. */
  _wrapText(ctx, str, maxW, size) {
    ctx.font = `normal ${size}px "Trebuchet MS", "Avenir Next", "Segoe UI", system-ui, sans-serif`;
    const lines = [];
    let line = '';
    for (const word of str.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      // Headless contexts may not implement measureText — then never wrap.
      const w = ctx.measureText(candidate)?.width ?? 0;
      if (line && w > maxW) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  drawShop(ctx) {
    const cx = this.screenW / 2;
    const touch = this.touchMode;
    this.dim(ctx, 0.6);
    const headY = this.screenH * (touch ? 0.07 : 0.15);
    this.text(T.shop.waveCleared(this.wave), cx, headY, {
      size: touch ? 26 : 38,
      align: 'center',
      weight: 'bold',
      color: C.city,
      glow: true,
    });
    this.text(T.shop.creditsLine(this.credits, this.waveEarned), cx, headY + (touch ? 24 : 34), {
      size: touch ? 14 : 18,
      align: 'center',
      color: C.credits,
    });
    const b = this.waveBreakdown;
    if (b) {
      const parts = [
        T.shop.breakdownKills(b.kills),
        b.clear > 0 ? T.shop.breakdownClear(b.clear) : T.shop.breakdownClearMissed,
        T.shop.breakdownCities(b.city),
      ];
      this.text(parts.join('     '), cx, headY + (touch ? 42 : 58), {
        size: touch ? 11 : 13,
        align: 'center',
        color: C.hudDim,
      });
    }
    this.text(touch ? T.shop.touchHeading : T.shop.heading, cx, this.screenH * (touch ? 0.19 : 0.3) - 16, {
      size: touch ? 11 : 13,
      align: 'center',
      color: C.hudDim,
    });

    const { rows, nextRect, buyRect, detailTop } = this.shopLayout();
    this.shopSelected = clamp(this.shopSelected, 0, rows.length - 1);
    rows.forEach((r, i) => {
      const it = r.item;
      const selected = touch && i === this.shopSelected;
      const hover = !touch && it.enabled && this._inRect(this.pointerX, this.pointerY, r);
      ctx.fillStyle = it.enabled
        ? hover || selected
          ? C.shopRowHover
          : C.shopRow
        : selected
        ? 'rgba(60,80,110,0.45)'
        : 'rgba(40,58,86,0.22)';
      this._roundRect(ctx, r.x, r.y, r.w, r.h, 6);
      ctx.fill();
      if (selected) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = C.crosshair;
        this._roundRect(ctx, r.x, r.y, r.w, r.h, 6);
        ctx.stroke();
      }

      const labelCol = it.enabled ? C.hud : C.hudDim;
      if (!touch) {
        this.text(`${i + 1}`, r.x + 18, r.y + r.h / 2 + 5, {
          size: 15,
          align: 'center',
          color: it.enabled ? C.crosshair : C.hudDim,
        });
      }
      const tx0 = touch ? r.x + 14 : r.x + 40;
      if (touch) {
        // Compact row: just the name and the price; the desc + full info
        // live in the detail panel below.
        this.text(it.label, tx0, r.y + r.h / 2 + 5, { size: 14, color: labelCol, weight: 'bold' });
      } else {
        this.text(it.label, tx0, r.y + 20, { size: 16, color: labelCol, weight: 'bold' });
        this.text(it.desc, tx0, r.y + 38, { size: 12, color: C.hudDim });
      }

      let right;
      if (it.cost == null) right = T.shop.maxedOut;
      else if (it.soldOut) right = T.shop.soldOut;
      else right = T.shop.price(it.cost);
      this.text(right, r.x + r.w - 16, r.y + r.h / 2 + 5, {
        size: touch ? 14 : 16,
        align: 'right',
        color: it.enabled ? C.credits : C.hudDim,
      });
    });

    // Touch: detail panel for the selected item + a dedicated BUY button.
    if (touch) {
      this.drawShopDetail(ctx, rows[this.shopSelected], detailTop, buyRect, nextRect);
      return;
    }

    // Hover tooltip: a side panel with the full explanation of the item
    // under the cursor (hovering works whether or not you can afford it).
    // The info text is a single paragraph, word-wrapped to the box width.
    const hovered = rows.find((r) => this._inRect(this.pointerX, this.pointerY, r));
    if (hovered && hovered.item.info) {
      const tw = 318;
      const lines = this._wrapText(ctx, hovered.item.info, tw - 24, 12.5);
      const th = lines.length * 17 + 22;
      // Prefer the right side of the panel, then the left; on narrow windows
      // fall back to a strip tucked under the hovered row.
      let tx = hovered.x + hovered.w + 14;
      let ty = hovered.y;
      if (tx + tw > this.screenW - 8) tx = hovered.x - tw - 14;
      if (tx < 8) {
        tx = Math.min(Math.max(8, this.pointerX - tw / 2), this.screenW - tw - 8);
        ty = hovered.y + hovered.h + 6;
      }
      ty = Math.min(ty, this.screenH - th - 8);
      ctx.fillStyle = C.shopPanel;
      this._roundRect(ctx, tx, ty, tw, th, 6);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(120,150,190,0.5)';
      this._roundRect(ctx, tx, ty, tw, th, 6);
      ctx.stroke();
      lines.forEach((l, i) =>
        this.text(l, tx + 12, ty + 22 + i * 17, { size: 12.5, color: C.hud })
      );
    }

    const nr = nextRect;
    const hoverN = this._inRect(this.pointerX, this.pointerY, nr);
    ctx.fillStyle = hoverN ? 'rgba(255,179,71,0.9)' : 'rgba(255,179,71,0.55)';
    this._roundRect(ctx, nr.x, nr.y, nr.w, nr.h, 6);
    ctx.fill();
    this.text(T.shop.nextWave, cx, nr.y + nr.h / 2 + 6, {
      size: 18,
      align: 'center',
      weight: 'bold',
      color: '#161008',
    });
    this.text(T.shop.nextWaveHint, cx, nr.y + nr.h + 18, {
      size: 12,
      align: 'center',
      color: C.hudDim,
    });
  }

  /** Touch armory: the selected item's full story + BUY / NEXT WAVE buttons. */
  drawShopDetail(ctx, row, detailTop, buyRect, nextRect) {
    if (!row) return;
    const it = row.item;
    const x = row.x;
    const w = row.w;
    // Both text blocks wrap to the panel; the panel hugs its content rather
    // than stretching down to the buttons.
    const descLines = this._wrapText(ctx, it.desc, w - 24, 12.5);
    const infoLines = it.info ? this._wrapText(ctx, it.info, w - 24, 12) : [];
    const maxH = Math.max(40, buyRect.y - 12 - detailTop);
    const panelH = Math.min(maxH, 14 + descLines.length * 18 + infoLines.length * 16 + 10);
    ctx.fillStyle = C.shopPanel;
    this._roundRect(ctx, x, detailTop, w, panelH, 6);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,150,190,0.5)';
    this._roundRect(ctx, x, detailTop, w, panelH, 6);
    ctx.stroke();
    let ty = detailTop + 22;
    for (const l of descLines) {
      if (ty > detailTop + panelH - 6) break;
      this.text(l, x + 12, ty, { size: 12.5, weight: 'bold', color: C.hud });
      ty += 18;
    }
    for (const l of infoLines) {
      if (ty > detailTop + panelH - 6) break; // never overflow the panel
      this.text(l, x + 12, ty, { size: 12, color: C.hudDim });
      ty += 16;
    }

    // BUY: the only thing that spends money on touch. Label tracks state.
    let buyLabel;
    if (it.cost == null) buyLabel = T.shop.buyMaxed;
    else if (it.soldOut) buyLabel = T.shop.buyOwned;
    else buyLabel = T.shop.buy(it.cost);
    ctx.fillStyle = it.enabled ? 'rgba(108,240,255,0.85)' : 'rgba(80,100,125,0.35)';
    this._roundRect(ctx, buyRect.x, buyRect.y, buyRect.w, buyRect.h, 6);
    ctx.fill();
    this.text(buyLabel, buyRect.x + buyRect.w / 2, buyRect.y + buyRect.h / 2 + 5, {
      size: 15,
      align: 'center',
      weight: 'bold',
      color: it.enabled ? '#08222a' : C.hudDim,
    });

    ctx.fillStyle = 'rgba(255,179,71,0.85)';
    this._roundRect(ctx, nextRect.x, nextRect.y, nextRect.w, nextRect.h, 6);
    ctx.fill();
    this.text(T.shop.nextWave, nextRect.x + nextRect.w / 2, nextRect.y + nextRect.h / 2 + 5, {
      size: 15,
      align: 'center',
      weight: 'bold',
      color: '#161008',
    });
  }

  // -------------------------------------------------------------------------
  // Secret dev console (backquote) — scenario sandboxes + god-mode toggles.
  // -------------------------------------------------------------------------
  devMenuItems() {
    const D = T.dev;
    const items = [
      {
        hotkey: 'g',
        label: D.godMode,
        value: this.devInvincible ? D.on : D.off,
        action: () => (this.devInvincible = !this.devInvincible),
      },
      {
        hotkey: 'l',
        label: D.loadout,
        value: this.devLoadout ? D.on : D.off,
        action: () => (this.devLoadout = !this.devLoadout),
      },
      {
        hotkey: 't',
        label: D.touchControls,
        value: this.touchMode ? D.on : D.off,
        action: () => this.setTouchMode(!this.touchMode),
      },
    ];
    DEV_SCENARIOS.forEach((sc, i) => {
      items.push({
        hotkey: `${i + 1}`,
        label: D.scenarios[sc.key],
        active: this.devScenario === sc,
        // The scenarios group gets its own heading in the layout.
        headingBefore: i === 0 ? D.scenariosHeading : undefined,
        action: () => this.startSandbox(sc),
      });
    });
    if (this.devScenario) {
      items.push({
        hotkey: 'x',
        label: D.exitSandbox,
        action: () => {
          this.devScenario = null;
          this.devMenuOpen = false;
          this.state = 'menu';
        },
      });
    }
    return items;
  }

  devMenuLayout() {
    const items = this.devMenuItems();
    const panelW = Math.min(560, this.screenW - 24);
    const x = this.screenW / 2 - panelW / 2;
    const rowH = 36;
    const gap = 6;
    let y = this.screenH * 0.2;
    const rows = items.map((item) => {
      if (item.headingBefore) y += 28; // room for the group heading
      const r = { item, x, y, w: panelW, h: rowH };
      y += rowH + gap;
      return r;
    });
    return { rows };
  }

  drawDevMenu(ctx) {
    const cx = this.screenW / 2;
    this.dim(ctx, 0.72);
    this.text(T.dev.title, cx, this.screenH * 0.1, {
      size: 32,
      align: 'center',
      weight: 'bold',
      color: C.credits,
      glow: true,
    });
    this.text(T.dev.hint, cx, this.screenH * 0.1 + 26, {
      size: 13,
      align: 'center',
      color: C.hudDim,
    });

    const { rows } = this.devMenuLayout();
    rows.forEach((r) => {
      if (r.item.headingBefore) {
        this.text(r.item.headingBefore, r.x, r.y - 10, { size: 12, color: C.hudDim });
      }
      const hover = this._inRect(this.pointerX, this.pointerY, r);
      ctx.fillStyle = r.item.active ? 'rgba(255,216,107,0.25)' : hover ? C.shopRowHover : C.shopRow;
      this._roundRect(ctx, r.x, r.y, r.w, r.h, 6);
      ctx.fill();
      this.text(r.item.hotkey.toUpperCase(), r.x + 18, r.y + r.h / 2 + 5, {
        size: 14,
        align: 'center',
        color: C.crosshair,
      });
      this.text(r.item.label, r.x + 40, r.y + r.h / 2 + 5, { size: 14, color: C.hud });
      if (r.item.value) {
        this.text(r.item.value, r.x + r.w - 16, r.y + r.h / 2 + 5, {
          size: 14,
          align: 'right',
          weight: 'bold',
          color: r.item.value === T.dev.on ? C.credits : C.hudDim,
        });
      }
    });
  }

  handleDevClick(px, py) {
    const { rows } = this.devMenuLayout();
    const r = rows.find((r) => this._inRect(px, py, r));
    if (r) r.item.action();
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  bindInput() {
    const setPointer = (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      // Touch: a drag on the fire-control pad aims via the pad mapping; a
      // touch on the field itself still aims directly (both work).
      if (
        this.touchMode &&
        this.padRect &&
        this.state === 'playing' &&
        this._inRect(e.clientX, e.clientY, this.padRect)
      ) {
        this.aimFromPad(e.clientX, e.clientY);
        return;
      }
      const w = this.renderer.screenToWorld(e.clientX, e.clientY);
      this.mouseX = w.x;
      this.mouseY = w.y;
    };

    window.addEventListener('pointermove', setPointer);

    window.addEventListener('pointerdown', (e) => {
      sfx.unlock();
      setPointer(e);
      if (e.button !== 0) return;
      if (this.devMenuOpen) {
        this.handleDevClick(this.pointerX, this.pointerY);
        return;
      }
      // In play both weapons run themselves — clicks only drive the menus.
      if (this.state === 'menu' || this.state === 'gameover') {
        this.handleMenuClick(this.pointerX, this.pointerY);
      } else if (this.state === 'intermission') {
        this.handleShopClick(this.pointerX, this.pointerY);
      }
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      sfx.unlock();
      if (key === ' ' || key === 'spacebar') e.preventDefault(); // no page scroll
      this.handleKey(key, e);
    });

    window.addEventListener('resize', () => this.resize());
    // Mobile browsers resize the visual viewport (URL bar collapse, rotation)
    // without always firing a window resize — track it so the canvases never
    // drift out of alignment with the touch coordinates.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this.resize());
    }
  }

  /**
   * Route a (lowercased) key press. Space is context-sensitive: deploy on the
   * menu/game-over, advance in the shop.
   */
  handleKey(key, e = null) {
    // Browser shortcuts reach the page as keydowns too: Cmd/Ctrl+R (reload)
    // must not read as "R = restart", which forfeits the run's checkpoint
    // just before the page goes away. Any modifier means it's not for us.
    if (e && (e.metaKey || e.ctrlKey || e.altKey)) return;
    // Secret dev console: backquote toggles it from any state; while it is
    // up it swallows every key so hotkeys can't leak into the game below.
    if (key === '`') {
      this.devMenuOpen = !this.devMenuOpen;
      return;
    }
    if (this.devMenuOpen) {
      if (key === 'escape') {
        this.devMenuOpen = false;
        return;
      }
      const item = this.devMenuItems().find((i) => i.hotkey === key);
      if (item) item.action();
      return;
    }
    if (key === ' ' || key === 'spacebar') {
      // On the menu, space resumes the checkpoint if there is one.
      if (this.state === 'menu') {
        if (this.savedRun) this.continueGame();
        else this.startGame();
      } else if (this.state === 'gameover') {
        this.startGame();
      } else if (this.state === 'intermission') {
        this.proceedToNextWave();
      }
      return;
    }
    if (this.state === 'intermission' && key >= '1' && key <= '9') {
      const item = this.getShopItems()[parseInt(key, 10) - 1];
      if (item) this.buyItem(item);
      return;
    }
    if (key === 'p') {
      if (this.state === 'playing') {
        this.paused = !this.paused;
      }
    } else if (key === 'r') {
      this.startGame();
    } else if (key === 'm') {
      sfx.toggleMute();
    }
  }
}
