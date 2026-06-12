// ---------------------------------------------------------------------------
// STRINGS — every user-facing line of text in one place, for easy edit passes.
// Plain entries are literals; entries taking arguments are template functions
// (the value interpolated is named by the parameter). Shop `info` entries are
// single paragraphs — the renderer word-wraps them to fit the tooltip box.
// ---------------------------------------------------------------------------

export const STRINGS = {
  // --- Title / menu screen --------------------------------------------------
  title: 'CIWS COMMAND',
  subtitle: 'Defend your cities with close-in weapon systems.',
  howToPlayHeading: 'HOW TO PLAY',
  // [label, ...description lines] — lines are drawn as-is, one per row.
  howToPlay: [
    [
      'AIM',
      'Move the mouse to aim the CIWS gun.',
    ],
    [
      'AUTO DEFENSES',
      'Interceptors launch themselves at distant, high-value threats;',
      'the laser burns down what gets close.',
    ],
    [
      'AIRSTRIKE',
      'Buy an F-16 strike package in the armory, then press SPACE to scramble the flight when the sky gets crowded.',
    ],
    [
      'ARMORY',
      'Between waves, spend credits on upgrades to protect your cities.',
    ],
    [
      'SURVIVE',
      'Protect six cities. One hit on the CIWS gun ends the run.',
    ],
  ],
  keysHint: 'SPACE airstrike     P pause     R restart     M mute',
  deploy: 'CLICK OR PRESS SPACE TO DEPLOY',

  // --- Touch / mobile variants ----------------------------------------------
  touch: {
    deploy: 'TAP TO DEPLOY',
    // Replaces the AIM row of HOW TO PLAY on touch devices.
    howToAim: [
      'AIM',
      'Drag on the fire-control pad below the field to lay the gun — your thumb never covers the action.',
    ],
    // Replaces the AIRSTRIKE row of HOW TO PLAY on touch devices.
    howToStrike: [
      'AIRSTRIKE',
      'Buy an F-16 strike package in the armory, then tap the STRIKE button when the sky gets crowded.',
    ],
    padLabel: 'FIRE CONTROL',
    strike: '✈ F-16 STRIKE', // on-screen airstrike trigger (shown when armed)
  },
  // Shown instead of `deploy` when a saved run is waiting to be resumed.
  menu: {
    continueRun: (wave) => `CONTINUE — WAVE ${wave}`,
    newGame: 'NEW GAME',
    continueHint: 'SPACE continues the saved run — NEW GAME forfeits it',
  },

  // --- In-game HUD -----------------------------------------------------------
  hud: {
    score: 'SCORE',
    wave: 'WAVE',
    cities: 'CITIES',
    credits: 'CREDITS',
    creditsShort: 'CR', // compact corner HUD on narrow windows
    muted: 'MUTED (M)',
    intcpReady: 'INTCP READY',
    intcpReloading: 'INTCP RELOADING',
    laserFiring: 'LASER FIRING',
    laserCharged: 'LASER CHARGED',
    laserCharging: 'LASER CHARGING',
    strikeReady: 'F-16 STRIKE — SPACE',
    strikeReadyShort: 'STRIKE READY', // compact corner HUD
  },
  paused: 'PAUSED',
  pausedHint: 'press P to resume',

  // --- Spoken lines (Web Speech) ----------------------------------------------
  voice: {
    nukeWarning: 'Nuclear launch detected',
    mirvNukeWarning: 'Warning. MIRV nuclear launch detected',
    engaging: 'Engaging hostiles!', // the strike flight checks in
  },

  // --- Game over ---------------------------------------------------------------
  loss: {
    gunDestroyed: 'Gun destroyed',
    citiesLost: 'Cities lost',
    fallback: 'Defeat',
  },
  gameover: {
    newHighScore: (score) => `NEW HIGH SCORE  ${score}`,
    finalScore: (score) => `Final Score  ${score}`,
    reachedWave: (wave) => `You reached wave ${wave}`,
    highScoresHeading: 'HIGH SCORES',
    waveColumn: (wave) => `wave ${wave}`,
    retry: 'CLICK or press SPACE to try again',
  },

  // --- Between-wave armory -------------------------------------------------
  shop: {
    waveCleared: (wave) => `WAVE ${wave} CLEARED`,
    creditsLine: (credits, earned) => `CREDITS  ${credits}    (+${earned} this wave)`,
    breakdownKills: (n) => `Kills +${n}`,
    breakdownClear: (n) => `All-clear +${n}`,
    breakdownClearMissed: 'All-clear —',
    breakdownCities: (n) => `Cities +${n}`,
    heading: 'ARMORY — click an item or press its number',
    maxedOut: 'MAX',
    soldOut: '—',
    price: (cost) => `${cost} cr`,
    nextWave: 'NEXT WAVE ▸',
    nextWaveHint: 'or press SPACE',
    // Touch armory: tap a row to inspect it, then buy with an explicit button.
    touchHeading: 'ARMORY — tap an item for details',
    buy: (cost) => `BUY — ${cost} cr`,
    buyMaxed: 'MAXED OUT',
    buyOwned: 'OWNED',
    armed: 'ARMED', // a strike package is in the rack



    items: {
      interceptor: {
        label: 'Interceptor Battery',
        desc: 'Auto-launching homing missiles',
        info:
          'Deploy a THAAD-style launcher to the right of the gun. It fires itself ' +
          'at distant, high-value threats and blasts ' +
          'everything near the kill.',
      },
      interceptorReload: {
        label: (level) => `Interceptor Reload (Lv ${level})`,
        labelMax: 'Interceptor Reload',
        desc: (cooldown) => `Faster reload between launches  (now ${cooldown}s)`,
        info: (first, last) =>
          'Interceptors launch themselves at distant, high-value threats ' +
          'and blast everything near the kill. Each level ' +
          `shortens the reload between launches (${first}s down to ${last}s).`,
      },
      shield: {
        label: 'Energy Shield',
        desc: 'Dome over the CIWS — absorbs one warhead, then recharges',
        info:
          'An energy dome over the CIWS that absorbs one warhead, then ' +
          'recharges.',
      },
      shieldRecharge: {
        label: (level) => `Shield Recharge (Lv ${level})`,
        labelMax: 'Shield Recharge',
        desc: (seconds) => `Faster shield recharge  (now ${seconds}s)`,
        info: (last) =>
          'Shortens how long the dome takes to come back after absorbing a ' +
          `hit (down to ${last}s). It also returns fully charged each wave.`,
      },
      laser: {
        label: 'Laser Turret',
        desc: 'Autonomous beam — burns down whatever flies lowest',
        info:
          'An autonomous beam emplacement left of the gun. It tracks the ' +
          'lowest visible threat in range and burns it down — armoured ' +
          'targets take a longer, committed burn, output is weaker at long ' +
          'range, and it cannot depress below ~5°.',
      },
      laserRecharge: {
        label: (level) => `Laser Recharge (Lv ${level})`,
        labelMax: 'Laser Recharge',
        desc: (seconds) => `Faster recharge between shots  (now ${seconds}s)`,
        info: (first, last) =>
          `Shortens the recharge between laser burns (${first}s down to ` +
          `${last}s), so it clears swarms much faster.`,
      },
      fireRate: {
        label: (level) => `Upgrade Fire Rate (Lv ${level})`,
        labelMax: 'Upgrade Fire Rate',
        desc: 'Faster CIWS cycle rate',
        info:
          'Spins the CIWS barrel faster for a denser bullet stream — each level compounds on the last.',
      },
      airstrike: {
        label: 'F-16 Strike Package',
        desc: 'A wing of F-16s engages every threat in the sky',
        descArmed: 'In the rack — press SPACE mid-wave to scramble',
        info:
          'Racks an airstrike. Call it mid-wave and one F-16 per two threats ' +
          'sweeps in on its own intercept course, each firing two air-to-air ' +
          'missiles. One package at a time; an unused package ' +
          'carries to the next wave.',
      },
    },
  },

  // --- Threat ID tags (the flavor targeting boxes over enemies) ------------
  threatNames: {
    normal: 'RV',
    mirv: 'MIRV', // a carrier bus that hasn't split yet
    evasive: 'EVASIVE RV',
    hypersonic: 'HYPERSONIC',
    cruise: 'CRUISE MSL',
    stealth: 'STEALTH MSL', // only readable once it decloaks
    drone: 'UAV',
    bomber: 'BOMBER',
    glidebomb: 'GLIDE BOMB',
    nuke: 'NUKE',
    mirvnuke: 'MIRV NUKE',
  },

  // --- Secret dev console (backquote `) ------------------------------------
  dev: {
    title: 'DEV CONSOLE',
    hint: 'click a row or press its key — ` or ESC closes',
    badge: 'DEV', // on-screen tag while god mode / a sandbox is active
    godMode: 'God mode — cities & gun are invincible',
    loadout: 'Sandbox loadout — interceptor + laser + auto-rearming airstrike',
    touchControls: 'Touch controls — fire-control pad below the field',
    exitSandbox: 'Exit sandbox (back to menu)',
    on: 'ON',
    off: 'OFF',
    scenariosHeading: 'SCENARIOS — endless single-threat sandbox',
    scenarios: {
      bombers: 'Bomber parade — flares, jinks, glide bombs',
      drones: 'Drone swarms',
      cruise: 'Cruise missiles',
      stealth: 'Stealth cruise',
      hypersonics: 'Hypersonics',
      evasive: 'Evasive RVs',
      mirvs: 'MIRV buses',
      nukes: 'Nukes on a loop',
      mirvnukes: 'MIRV nukes — fast bus, triple warheads',
      rain: 'Normal RV rain',
    },
  },
};
