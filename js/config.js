// ---------------------------------------------------------------------------
// Central configuration. Everything tunable lives here so balancing the game
// is a matter of editing one file. Distances are in CSS pixels, time in
// seconds, angles in radians unless a name ends in "Deg".
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- World layout -------------------------------------------------------
  // Fixed virtual resolution the simulation always runs at. The window can be
  // any size/shape; the camera scales this to fit (so balance never changes).
  // Large field => everything is relatively small and spread out (lots of air).
  // Tall field: threats appear well above the CIWS's comfortable envelope —
  // you SEE them early, but up high only interceptors reach reliably.
  world: { width: 1400, height: 1350 },
  groundHeight: 70, // height of the ground strip at the bottom

  // --- Physics ------------------------------------------------------------
  // Air is thin up high and dense near the ground; drag scales with density and
  // speed (quadratic). Sim +y points DOWN, so gravity is a positive vy term.
  physics: {
    gravity: 400, // px/s^2 pulling everything toward the ground
    bulletGravityMul: 1.0, // CIWS rounds could feel extra gravity if > 1.0 (more visible drop)
    scaleHeight: 0.5, // density e-folds over this fraction of the play height
    densityFloor: 0.1, // minimum air density (way up high)
    bulletDrag: 0.00033, // quadratic drag coeff for CIWS rounds — tuned (with
    // bullet.fadeSpeed) so a straight-up burst just kisses the top of the field
    missileDrag: 0.0011, // drag coeff for enemy missiles (slows them down low)
    // Tuned so a clean (low-turn) flight can reach the far top corners of the
    // field before bleeding to self-destruct speed; hard maneuvering against
    // crossing/jinking targets still scrubs enough energy to cause misses.
    interceptorDrag: 0.0008, // drag coeff for coasting interceptors (long glide)
  },
  cityCount: 6,
  turretCount: 1, // a single central CIWS — one hit on it loses the game
  edgePadding: 215, // horizontal padding before the first / after the last slot

  // --- CIWS turret --------------------------------------------------------
  turret: {
    barrelLength: 28,
    baseRadius: 18,
    pivotHeight: 21, // height of the gun trunnion above the ground (sim px)
    startAmmo: Infinity, // the belt feed is endless — the gun never runs dry
    fireInterval: 0.038, // seconds between rounds while firing (~26 rounds/s)
    dispersionDeg: 0.8, // half-angle of the random firing cone (tight)
    twinSpacing: 8, // px between the two barrels once the twin upgrade is bought
  },

  // --- Bullets (tracer rounds) -------------------------------------------
  bullet: {
    speed: 1120, // px/s muzzle velocity
    damage: 1, // HP one CIWS round strips from whatever it hits
    lifetime: 3.5, // seconds before the round self-destructs
    // A round burns out once it slows to this speed — a vertical shot still
    // dies near the top of the field, but a flat shot keeps flying its full
    // arc instead of vanishing the moment it noses over.
    fadeSpeed: 150,
    radius: 2,
    tracerLength: 18, // visual length of the tracer streak
  },

  // --- Enemy missiles -----------------------------------------------------
  missile: {
    radius: 4,
    baseSpeed: 190, // px/s — constant across waves
    speedPerWave: 0, // no per-wave speed ramp; difficulty comes from count/mix
    speedJitter: 0.18, // +/- fraction of random speed variation
    hitPadding: 5, // extra hit radius added to bullet+missile radii
    blastRadius: 30, // ground-impact blast radius (damages structures)
    // Aiming: most missiles aim near a structure (alive or rubble) with scatter;
    // some aim at a random ground point, so plenty miss into the gaps.
    aimJitter: 36, // +/- px scatter around the chosen structure
    randomAimChance: 0.33, // chance to instead miss into a random ground point
    trailMaxPoints: 16, // length of the stored trail polyline
    trailMinStep: 7, // min px between stored trail points

    // CIWS rounds needed to destroy each variant (tunable per type). A MIRV
    // carrier is armoured; once it splits, the children are regular 1-hit RVs.
    hp: {
      normal: 1,
      evasive: 1,
      hypersonic: 1,
      mirv: 3,
      cruise: 2,
      stealth: 2,
      drone: 1,
      bomber: 3,
      glidebomb: 1,
      nuke: 30,
    },
    hitFlashTime: 0.12, // seconds the body flashes white on a non-killing hit

    // MIRV splitting. The carrier "bus" is larger and a distinct colour until
    // it splits, at which point it (and its children) become regular red RVs.
    splitFromWave: 3,
    splitChance: 0.18,
    splitChildren: [2, 3], // min/max children when a missile splits
    splitAltitude: [0.32, 0.55], // fraction of play height where splits occur
    mirvScale: 1.8, // size multiplier for an unsplit MIRV carrier

    // Hypersonic variant: comes in very fast and barely slows (it punches
    // through the dense air), so it's hard to track. Fragile (1 hit) but scary.
    hypersonic: {
      fromWave: 4,
      chance: 0.16,
      speedFactor: 2.5, // multiple of the base missile speed
      dragFactor: 0.35, // fraction of normal drag (stays fast low down)
    },

    // Cruise missile: enters from a screen edge at low altitude, runs flat at
    // the deck, then pops up short of its target and dives onto it.
    cruise: {
      fromWave: 3,
      chance: 0.13,
      speedFactor: 1.3,
      altFrac: [0.55, 0.72], // spawn altitude (fraction of play height)
      popupDist: 270, // horizontal px before the target where the pop-up starts
      popupHeight: 230, // px it climbs above its cruise altitude
      turnRate: 2.8, // rad/s steering limit between flight legs
    },

    // Bomber: cruises straight across the upper sky dropping glide bombs on
    // the structures it passes. Killing it pays well but isn't mandatory —
    // it exits the far side without counting as a leak. The bombs glide in
    // unpowered and CAN be shot down (as real glide bombs can).
    bomber: {
      fromWave: 4,
      chance: 0.12,
      speedFactor: 1.1, // a genuinely fast combat pass
      altFrac: [0.3, 0.45], // mid-altitude transit band (fraction of play height)
      bombs: [2, 3], // glide bombs dropped per pass
      dropGap: [1.2, 2.6], // seconds between drops
      reach: 420, // max horizontal px a dropped bomb can glide
      // When a homing round is inbound — at the bomber OR at a flare it just
      // dropped (the pilot can't know whether the decoy took) — the pilot
      // weaves; when the round gets CLOSE he commits to one hard pull, which
      // is what actually generates the miss: the displacement outruns the
      // interceptor's turn-rate-limited correction and it overshoots.
      // Maneuvering CONSERVES energy: total speed is capped near cruise, so
      // a hard pull pitches the flight path (horizontal speed pays for the
      // climb) rather than conjuring free vertical velocity. Defending also
      // costs the mission: once forced to jink, the bombing run is ABORTED —
      // the remaining rack never drops.
      evadeRange: 560, // starts weaving when a homing interceptor is this close
      evadeAmp: 150, // px/s of vertical weave velocity
      evadeFreq: 1.6, // rad/s — slow enough that the weave really displaces
      breakRange: 300, // the last-ditch hard pull starts at this distance
      breakAmp: 330, // px/s the pull steers vy toward (the speed cap pitches it)
      breakRamp: 3.5, // 1/s — how sharply vy ramps onto the pull (~4g, not a snap)
      breakFlip: 0.6, // s — the pull reverses (a high-g S) on this cadence
      maxSpeedFactor: 1.15, // combat-thrust ceiling on TOTAL speed while evading
      thrustRecover: 1.5, // 1/s — engines pull vx back to cruise after a pull
      bandFrac: [0.1, 0.72], // hard altitude band (fraction of groundY)
      // The pilot also dodges CIWS fire: any round on a near-collision course
      // inside this envelope sends him weaving out of the stream.
      bulletDodge: { range: 460, missDist: 70, time: 0.9 },
      // While evading, the pilot also punches out flares: hot decoys that can
      // seduce an inbound interceptor's seeker off the airframe. The roll is
      // per BURST per interceptor — keep decoyChance modest, since a typical
      // attack run eats 1-2 bursts and a seduced round is usually a write-off.
      flares: {
        bursts: 3, // bursts carried per pass
        perBurst: 3, // flares ejected per burst
        cooldown: 1.5, // seconds between bursts
        decoyChance: 0.3, // odds each inbound interceptor takes the bait
        life: 1.1, // seconds a flare burns (short — seekers often reacquire)
        ejectSpeed: 190, // px/s ejection velocity (down and back, with spread)
      },
    },
    glidebomb: {
      speedFactor: 0.85,
    },

    // Stealth cruise missile: flies the same profile as the regular cruise
    // missile but is cloaked until its pop-up — invisible, silent, and
    // untargetable by the lock-on/laser (a blind CIWS sweep can still clip it).
    stealth: {
      fromWave: 6,
      chance: 0.1,
      speedFactor: 1.35,
    },

    // Drone: slow, cheap, comes from the side in a swarm — each picks its own
    // (often overlapping) target, glides level, then tips into a shallow dive.
    drone: {
      fromWave: 2,
      chance: 0.1,
      speedFactor: 0.55,
      groupSize: 5,
      altFrac: [0.5, 0.75], // per-drone spawn altitude band (low entry)
      diveDist: 200, // horizontal px before the target where the dive starts
      turnRate: 2.0,
    },

    // Nuke: a slow, heavily-armoured ballistic warhead that only ever targets
    // cities. If it reaches the ground it vaporizes every city on that half of
    // the map. Shoot it down or eat the loss.
    nuke: {
      fromWave: 5,
      chance: 0.07,
      // Cap = maxPerWave at fromWave, +1 every wavesPerExtra after that — it
      // keeps climbing forever (wave 5: one, wave 8: two, wave 11: three...).
      maxPerWave: 1,
      wavesPerExtra: 3,
      speedFactor: 1.0, // comes in at full ballistic speed
      scale: 2.4, // visual size multiplier
      warningTime: 3, // seconds between the launch warning and it appearing
      burstHeight: 120, // air-burst altitude above the ground
      // Ground effect: levels the target city AND its immediate neighbours
      // (one slot ≈ 162px) — including the CIWS if it's next door. It never
      // reaches two slots away.
      blastRadius: 230,
    },

    // Evasive (weaving) variant. The weave is a sum of several sine components
    // with randomized frequencies/phases per missile, so each one jinks on its
    // own irregular rhythm rather than a predictable wobble.
    evasive: {
      fromWave: 2,
      chance: 0.28, // probability a given missile is evasive
      speedFactor: 1.12, // a touch faster than a normal missile
      weaveAmp: 54, // px of lateral sway
      weaveComponents: 3, // number of summed sine terms
      weaveFreqMin: 2.2, // rad/s
      weaveFreqMax: 7.5, // rad/s
    },
  },

  // --- Interceptors (autonomous homing anti-missiles) ---------------------
  interceptor: {
    // Unlimited stock, gated by a reload cooldown; the launcher starts every
    // wave UNLOADED (first shot comes one full reload in). Index = upgrade
    // level; buy levels in the shop to launch more often.
    cooldowns: [6, 4.75, 3.75, 3, 2.4, 1.8, 1.4, 1],
    // Auto-targeting: the launcher fires itself at the highest-value threat,
    // biased toward distant ones. It never engages drones, and anything
    // inside the minimum engagement distance is the gun's/laser's business.
    minTargetDist: 240,
    launcherOffsetX: 46, // launcher emplacement sits right of the CIWS mount
    launcherHeight: 34, // top of the erected launch pod (missiles leave vertically)
    smokeRate: 50, // boost-phase exhaust puffs per second (white solid-motor smoke)
    // Two-phase flight, like a real missile: a powered boost then a coast.
    launchSpeed: 170, // px/s off the rail
    // A long, gentle burn into a long glide: peak acceleration and top speed
    // are modest, but the round keeps its energy much further into the coast.
    // Balance-tested vs the sandbox scenarios — slightly weaker against
    // hypersonics (intended), roughly flat everywhere else.
    boostTime: 1.05, // seconds of powered flight
    thrust: 1100, // px/s^2 acceleration during boost
    maxSpeed: 880, // speed cap (outpaces fast threats, but not by much)
    turnRate: 3.8, // rad/s homing turn rate (tighter turns, can still overshoot)
    steerAfterClimb: 100, // px of straight vertical climb before it may steer
    turnBleed: 0.45, // fraction of speed scrubbed per radian of post-boost turning
    minSpeed: 200, // below this it lacks maneuvering energy and self-destructs
    detonateRadius: 24, // must pass this close to detonate (tighter => can miss)
    blastRadius: 72, // area damage radius on detonation
    blastDamage: 7, // HP one blast strips from everything in radius — a 40-HP
    // nuke shrugs off interceptors alone; the gun has to help or it lands
    lifetime: 6.0, // seconds before self-destruct (slower top speed, longer legs)
    trailMaxPoints: 20,
    trailMinStep: 6,
  },

  // --- Laser (purchasable autonomous point-defense beam) ------------------
  laser: {
    cost: 85, // one-time purchase
    upgradeCosts: [50, 80, 115, 170, 240], // recharge upgrades after it's owned
    cooldowns: [6, 4.5, 3.2, 2.2, 1.5, 1], // recharge between burns, by upgrade level
    dps: 2.6, // HP/s burned at point-blank; falls off with distance
    fullPowerDist: 280, // beam burns at full dps inside this distance
    range: 720, // beyond this the laser can't latch on at all
    turnRate: 4.0, // rad/s the emitter head can slew (it must aim before burning)
    aimToleranceDeg: 4, // burns only once aimed within this of the target
    minElevationDeg: 15, // can't depress below this above the horizon
    barrelLength: 13, // emitter barrel length (beam originates at its tip)
    beamTime: 0.22, // seconds the beam visual lingers after the burn ends
    offsetX: -46, // emplacement sits left of the CIWS mount
    emitterHeight: 26, // beam origin height above the ground
    // It only engages cheap, predictable targets: drones and plain RVs
    // (post-split MIRV children included; armoured carriers excluded).
  },

  // --- Gun shield (a shop upgrade ladder; cities can't be shielded) -------
  shield: {
    // First purchase fits the dome on the CIWS; later ones speed its recharge.
    costs: [65, 45, 70, 100, 150, 210],
    rechargeTimes: [10, 7, 4.5, 2.5, 1.6, 1], // seconds to come back, by upgrade level
    maxPerStructure: 1, // one shield at a time (no stacking)
    radius: 72, // dome radius (world units) — also the interception range
    flashTime: 0.4, // seconds the dome flares/collapses when it fails
  },

  // --- Waves --------------------------------------------------------------
  wave: {
    baseMissiles: 19, // missiles on wave 1
    missilesPerWave: 6, // additional missiles each wave
    baseSpawnGap: 0.95, // seconds between spawns on wave 1
    spawnGapPerWave: 0.12, // spawn gap reduction per wave
    minSpawnGap: 0.3,
    endDelay: 1.0, // beat after the last threat dies before the wave clears
    intermissionTime: 4.0, // seconds of breather between waves
  },

  // --- Scoring ------------------------------------------------------------
  score: {
    perKill: 25,
    citySurvivalBonus: 100, // per surviving city, end of wave
  },

  // --- Economy (credits = the shop currency, separate from score) ---------
  economy: {
    startCredits: 4,
    // Per-type kill bounty. A MIRV carrier pays its big bounty only while
    // unsplit; its children (and a post-split body) pay the normal rate.
    bounty: {
      normal: 1,
      evasive: 2,
      hypersonic: 3,
      mirv: 4,
      cruise: 3,
      stealth: 4,
      drone: 1,
      bomber: 4,
      glidebomb: 1,
      nuke: 12,
    },
    clearBonus: 5, // destroyed every enemy this wave (nothing leaked)
    perCitySurvived: 2, // credits per surviving city, end of wave
  },

  // --- Between-wave shop --------------------------------------------------
  shop: {
    // Interceptor stock is unlimited; you buy down the reload cooldown.
    // Length = max upgrade levels (matches interceptor.cooldowns - 1).
    interceptorCost: 12, // buy the battery itself — cheap, the natural first purchase
    interceptorCooldownCosts: [30, 55, 85, 130, 190, 260, 350],
    fireRateCosts: [30, 50, 75, 110, 160, 220],
    fireRateFactor: 0.82, // fire interval multiplier per level
    twinBarrelCost: 100, // one-time: a second barrel firing side by side
    dropPerWave: 2, // omit this many random offers each visit, for run-to-run variety
  },

  // --- 3D render / bloom --------------------------------------------------
  render: {
    fov: 34,
    // Camera frames the full play column: it fits a vertical half-extent of
    // coverFrac * playHeight around the centre, with a gentle downward tilt
    // (tiltFrac * playHeight) for depth. Distance is derived from the FOV.
    // 0.52 ≈ edge-to-edge vertically (the HUD lives in the side columns).
    coverFrac: 0.52,
    widthMargin: 1.02, // horizontal fit margin (so edge cities aren't clipped)
    tiltFrac: 0.05,
    cityDepth: 18, // building extrusion depth (z)
    bloom: { strength: 0.55, radius: 0.6, threshold: 0.3 },
    maxParticles: 900,
    maxSmoke: 800, // headroom for mushroom clouds on top of battle smoke
    maxMissiles: 220,
    maxBullets: 700, // headroom for a max-fire-rate twin-barrel stream
    maxInterceptors: 16,
    maxExplosions: 24, // pooled fireball/shockwave effects
    exposure: 1.05,
  },

  // --- Explosion visuals (fireball flash + overpressure shockwave) ---------
  // radius is the PEAK reach of the visible shockwave; for area-effect bursts
  // the game passes an explicit radius so the wave matches the kill radius.
  explosion: {
    small: { radius: 34, dur: 0.4 }, // bullet kill
    medium: { radius: 58, dur: 0.55 }, // ground impact / interceptor burst
    large: { radius: 105, dur: 0.8 }, // structure destroyed
    nuke: { radius: 320, dur: 1.8 }, // a nuke reached the ground
    smokePer: { small: 4, medium: 8, large: 16, nuke: 40 }, // lingering smoke puffs
  },

  // --- Audio --------------------------------------------------------------
  audio: {
    masterVolume: 1.5, // pushed hard; a limiter on the master tames the peaks
    panWidth: 0.75, // how far x position maps into the stereo field (0..1)
    reverbSeconds: 1.8, // generated impulse-response tail length
    reverbDecay: 3.5, // exponential decay power of the tail
  },

  // --- UI -----------------------------------------------------------------
  ui: {
    floatTextLife: 0.95, // seconds a floating "+credits" label lasts
    floatTextRise: 56, // px it drifts upward over its life
    tagHoverRadius: 120, // sim px — threat ID boxes show near the pointer only
    // Touch devices get a radar-repeater pad docked BELOW the play field:
    // you aim by dragging on the pad, so your thumb never covers the action.
    // The field is letterboxed upward to make room (renderer bottom inset).
    touchPad: {
      heightFrac: 0.26, // pad height as a fraction of the screen
      maxHeight: 230, // px cap on large phones / tablets
      margin: 12, // px side margin
      bottomMargin: 10, // px gap to the screen's bottom edge
    },
  },

  // --- Visual / palette (CSS color strings; THREE.Color accepts these) ----
  colors: {
    sky: ['#0a1428', '#05070d'],
    ground: '#0d1320',
    groundLine: '#2c5a8f',
    city: '#37e0d8',
    cityDead: '#2a3340',
    turret: '#8893a4',
    turretActive: '#ffb347',
    barrel: '#c2ccda',
    missile: '#ff5a4d',
    missileEvasive: '#c264ff',
    missileHypersonic: '#ff7a1f',
    missileMirv: '#9bff42',
    missileCruise: '#ffd84d',
    missileStealth: '#b9c8ff',
    missileBomber: '#c08552',
    missileGlidebomb: '#cbb878',
    missileDrone: '#c9d4df',
    missileNuke: '#ff2438',
    flare: '#ffce6e',
    missileTrail: '#ff5a4d',
    laser: '#ff4df0',
    bullet: '#ffe98a',
    hitSpark: '#ffffff',
    smoke: '#3a4252',
    rocketSmoke: '#e6ebf2',
    fireball: '#ffd9a0',
    interceptor: '#7cc6ff',
    interceptorTrail: '#7cc6ff',
    interceptorBlast: '#9be7ff',
    lock: '#86f7ff',
    shield: '#6cf0ff',
    explosion: '#ff5a4d', // standard-RV warhead pop — reads red, like the missile
    groundExplosion: '#ff5a4d',
    crosshair: '#ffe98a',
    crosshairEmpty: '#ff5a4d',
    credits: '#ffd86b',
    shopPanel: 'rgba(14,22,38,0.92)',
    shopRow: 'rgba(40,58,86,0.55)',
    shopRowHover: 'rgba(80,120,170,0.7)',
    hud: '#bcd2e6',
    hudDim: '#5a6b7d',
  },
};
