// ---------------------------------------------------------------------------
// STRINGS — every user-facing line of text in one place, for easy edit passes.
// Plain entries are literals; entries taking arguments are template functions
// (the value interpolated is named by the parameter). Shop `info` entries are
// single paragraphs — the renderer word-wraps them to fit the tooltip box.
// ---------------------------------------------------------------------------

export const STRINGS = {
  // --- Title / menu screen --------------------------------------------------
  title: 'CERVIX COMMAND',
  subtitle: 'Defend your ova against the incoming swarm.',
  howToPlayHeading: 'HOW TO PLAY',
  // [label, ...description lines] — lines are drawn as-is, one per row.
  howToPlay: [
    [
      'AIM',
      'Move the mouse to aim the mucus cannon.',
    ],
    [
      'AUTO DEFENSES',
      'Antibodies home in on distant, high-value swimmers;',
      'the acid gland dissolves what gets close.',
    ],
    [
      'BIOLAB',
      'Between waves, spend ATP on upgrades to protect your ova.',
    ],
    [
      'SURVIVE',
      'Protect six ova. One sperm through the cervix ends the run.',
    ],
  ],
  keysHint: 'P pause     R restart     M mute',
  deploy: 'CLICK OR PRESS SPACE TO DEFEND',

  // --- Touch / mobile variants ----------------------------------------------
  touch: {
    deploy: 'TAP TO DEFEND',
    // Replaces the AIM row of HOW TO PLAY on touch devices.
    howToAim: [
      'AIM',
      'Drag on the aim pad below the field to lay the cannon — your thumb never covers the action.',
    ],
    padLabel: 'AIM CONTROL',
  },
  // Shown instead of `deploy` when a saved run is waiting to be resumed.
  menu: {
    continueRun: (wave) => `CONTINUE — WAVE ${wave}`,
    newGame: 'NEW CYCLE',
    continueHint: 'SPACE continues the saved run — NEW CYCLE forfeits it',
  },

  // --- In-game HUD -----------------------------------------------------------
  hud: {
    score: 'SCORE',
    wave: 'WAVE',
    cities: 'OVA',
    credits: 'ATP',
    creditsShort: 'ATP', // compact corner HUD on narrow windows
    muted: 'MUTED (M)',
    intcpReady: 'ANTIBODY READY',
    intcpReloading: 'ANTIBODY SYNTH',
    laserFiring: 'ACID BURN',
    laserCharged: 'ACID READY',
    laserCharging: 'ACID BUILDING',
  },
  paused: 'PAUSED',
  pausedHint: 'press P to resume',

  // --- Spoken lines (Web Speech) ----------------------------------------------
  voice: {
    nukeWarning: 'Mutant swimmer detected',
  },

  // --- Game over ---------------------------------------------------------------
  loss: {
    gunDestroyed: 'Cervix breached',
    citiesLost: 'Ova lost',
    fallback: 'Fertilized',
  },
  gameover: {
    newHighScore: (score) => `NEW HIGH SCORE  ${score}`,
    finalScore: (score) => `Final Score  ${score}`,
    reachedWave: (wave) => `You reached wave ${wave}`,
    highScoresHeading: 'HIGH SCORES',
    waveColumn: (wave) => `wave ${wave}`,
    retry: 'CLICK or press SPACE to try again',
  },

  // --- Between-wave biolab -------------------------------------------------
  shop: {
    waveCleared: (wave) => `WAVE ${wave} REPELLED`,
    creditsLine: (credits, earned) => `ATP  ${credits}    (+${earned} this wave)`,
    breakdownKills: (n) => `Kills +${n}`,
    breakdownClear: (n) => `All-clear +${n}`,
    breakdownClearMissed: 'All-clear —',
    breakdownCities: (n) => `Ova +${n}`,
    heading: 'BIOLAB — click an item or press its number',
    maxedOut: 'MAX',
    soldOut: '—',
    price: (cost) => `${cost} atp`,
    nextWave: 'NEXT WAVE ▸',
    nextWaveHint: 'or press SPACE',
    // Touch biolab: tap a row to inspect it, then buy with an explicit button.
    touchHeading: 'BIOLAB — tap an item for details',
    buy: (cost) => `SYNTH — ${cost} atp`,
    buyMaxed: 'MAXED OUT',
    buyOwned: 'ACTIVE',

    items: {
      interceptor: {
        label: 'Antibody Gland',
        desc: 'Auto-launching homing antibodies',
        info:
          'Deploy an antibody gland to the right of the cervix. It fires itself ' +
          'at distant, high-value swimmers and neutralizes ' +
          'everything near the kill.',
      },
      interceptorReload: {
        label: (level) => `Antibody Synthesis (Lv ${level})`,
        labelMax: 'Antibody Synthesis',
        desc: (cooldown) => `Faster synthesis between launches  (now ${cooldown}s)`,
        info: (first, last) =>
          'Antibodies home in on distant, high-value swimmers ' +
          'and neutralize everything near the kill. Each level ' +
          `shortens the synthesis between launches (${first}s down to ${last}s).`,
      },
      shield: {
        label: 'Mucus Plug',
        desc: 'Plug over the cervix — absorbs one sperm, then regrows',
        info:
          'A cervical mucus plug over the cervix that absorbs one sperm, then ' +
          'regrows.',
      },
      shieldRecharge: {
        label: (level) => `Mucus Regrowth (Lv ${level})`,
        labelMax: 'Mucus Regrowth',
        desc: (seconds) => `Faster plug regrowth  (now ${seconds}s)`,
        info: (last) =>
          'Shortens how long the plug takes to regrow after absorbing a ' +
          `hit (down to ${last}s). It also regrows fully each wave.`,
      },
      laser: {
        label: 'Acid Gland',
        desc: 'Autonomous pH beam — dissolves swarmers & plain sperm',
        info:
          'An autonomous acid emitter left of the cervix. It tracks ' +
          'the lowest swarmer or sperm in range and dissolves it — weaker at ' +
          'long range, and it cannot depress below ~15°.',
      },
      laserRecharge: {
        label: (level) => `Acid Buildup (Lv ${level})`,
        labelMax: 'Acid Buildup',
        desc: (seconds) => `Faster buildup between burns  (now ${seconds}s)`,
        info: (first, last) =>
          `Shortens the buildup between acid burns (${first}s down to ` +
          `${last}s), so it clears swarms much faster.`,
      },
      fireRate: {
        label: (level) => `Upgrade Spray Rate (Lv ${level})`,
        labelMax: 'Upgrade Spray Rate',
        desc: 'Faster mucus cannon cycle rate',
        info:
          'Pumps the gland faster for a denser spray stream — compounds with Twin Glands.',
      },
      twin: {
        label: 'Twin Glands',
        desc: 'Add a 2nd nozzle — double the globs',
        descOwned: 'Dual side-by-side nozzles',
        info:
          'Mounts a second secretory gland. ' +
          'Sends two globs flying side by side — double the spray density.',
      },
    },
  },

  // --- Threat ID tags (the flavor targeting boxes over enemies) ------------
  threatNames: {
    normal: 'SPERM',
    mirv: 'CLUMP', // a clump that hasn't split into single sperm yet
    evasive: 'WRIGGLER',
    hypersonic: 'SPRINTER',
    cruise: 'WALL-HUGGER',
    stealth: 'GHOST SPERM', // only readable once it decloaks
    drone: 'SWARMER',
    bomber: 'ENZYME BOMBER',
    glidebomb: 'ACROSOME',
    nuke: 'MUTANT',
  },

  // --- Secret dev console (backquote `) ------------------------------------
  dev: {
    title: 'DEV CONSOLE',
    hint: 'click a row or press its key — ` or ESC closes',
    badge: 'DEV', // on-screen tag while god mode / a sandbox is active
    godMode: 'God mode — ova & cervix are invincible',
    loadout: 'Sandbox loadout — start with antibody + acid gland',
    touchControls: 'Touch controls — aim pad below the field',
    exitSandbox: 'Exit sandbox (back to menu)',
    on: 'ON',
    off: 'OFF',
    scenariosHeading: 'SCENARIOS — endless single-threat sandbox',
    scenarios: {
      bombers: 'Enzyme bomber parade — decoys, jinks, acrosome bombs',
      drones: 'Swarmer swarms',
      cruise: 'Wall-huggers',
      stealth: 'Ghost sperm',
      hypersonics: 'Sprinters',
      evasive: 'Wrigglers',
      mirvs: 'Sperm clumps',
      nukes: 'Mutants on a loop',
      rain: 'Normal sperm rain',
    },
  },
};
