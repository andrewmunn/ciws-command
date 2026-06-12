# CIWS Command

A Missile Command–style game where, instead of firing exploding interceptor
bursts, you defend your cities with **CIWS** (Close-In Weapon Systems) — rapid-fire
gun mounts that spray a stream of tracer rounds. The belt feed is endless, but
rounds arc and slow with distance, so you still have to lead your targets.

Rendered in **WebGL** (Three.js) with bloom for a neon look, while the gameplay
stays a flat 2D plane viewed nearly head-on.

## Play

**[▶ Play it in your browser](https://andrewmunn.github.io/ciws-command/)** —
hosted free on GitHub Pages (auto-deploys from `main`). To run locally:

```
python3 serve.py 8011      # or: bun run serve
# then open http://localhost:8011
```

`serve.py` is a tiny static server that sends no-cache headers (so edits always
show up). Or use the `ciws` config in `.claude/launch.json` with the preview
tooling.

## Tests

Game logic has a unit suite run with [Bun](https://bun.sh) (no dependencies):

```
bun test          # or: bun run test
```

It covers `utils`, `physics`, the entities (ballistics, drag, MIRV split,
interceptor boost/coast/energy), the weapon systems, the high-score table, the
save checkpoint, and the `Game` orchestration (waves, spawning/threat gating, collisions & HP,
bounties, impacts and nuke air-bursts, bombers, the autonomous launcher and
laser, the economy, the shop, and win/lose conditions).

The simulation is headless-testable because the WebGL renderer is **injected**
into `Game` rather than imported — see the architecture note below.

For hands-on testing there is also a hidden **dev console**: press `` ` ``
(backquote) in any state. It offers god mode (cities & gun invincible) and
endless single-threat sandboxes (loop bombers, drone swarms, nukes, etc.) for
observing enemy and autonomous-weapon behaviour in isolation. Dev runs are
marked with a DEV badge and never touch the high-score table.

### Controls

| Input | Action |
|-------|--------|
| Mouse move | Aim the CIWS — it fires on its own while threats are inbound |
| `Space` (in play) | **Call the F-16 airstrike** (when a strike package is racked) |
| Touch (mobile) | Drag on the **fire-control pad** below the field — a radar repeater with absolute aim mapping, so your thumb never covers the action (touching the field directly also aims). An on-screen **F-16 STRIKE** button appears above the pad while a package is racked |
| `P` | Pause / resume |
| `R` | Restart |
| `M` | Mute / unmute |
| `Space` / click | Deploy from the tutorial screen / restart after game over (with a saved run, `Space` continues it) |

You aim; everything fires itself. The CIWS shoots wherever you point it (and
holds fire when the sky is clear), interceptors launch themselves at distant
high-value threats, and the laser handles whatever gets close. A tutorial
screen at the start covers all of this in-game.

### Weapons

- **CIWS gun** — a single central rapid-fire gun with an **endless belt
  feed** that fires automatically while threats are inbound; you steer the
  stream with the mouse and must lead targets. One tracer kills a standard
  RV. **If a warhead ever hits the gun, you instantly lose** — so anything
  heading for the centre is top priority.
- **Interceptors (autonomous)** — a **cheap armory purchase** (the natural
  first buy) that fields homing anti-missiles with unlimited stock, gated by
  a **reload cooldown** (6s at the start; shop upgrades buy it down to 1s);
  the pod comes back fully loaded each wave. The launcher fires
  itself at the **highest-value, most distant threat** — it never engages
  cheap clutter (drones and glide bombs are the laser's and gun's business,
  though a blast can still catch one), can't see cloaked stealth, and won't
  shoot inside its minimum engagement distance. Missiles **cold-launch
  straight up** from a THAAD-style truck — guidance stays locked for the
  first ~100px of climb — then turn onto an intercept course —
  but coasting flight **bleeds energy**, hard turns scrub extra speed,
  and a round that drops below maneuvering speed **self-destructs**: some
  intercepts genuinely run out of energy. If the target dies en route the
  missile retasks onto the nearest valid threat (or self-destructs), and
  it detonates with an **area blast**.
- **Laser (shop upgrade)** — a fully autonomous beam emplacement left of the
  gun with a trainable emitter head. It picks the **lowest visible threat**
  in range (anything that flies — cloaked stealth excepted; armoured targets
  just take a longer, committed burn), **physically slews onto it**, and
  only then burns it down over time. It **can't depress below ~5° above the
  horizon**, so only the lowest deck-skimmers slip under its arc. Output
  **falls off with distance** — full power up close, weaker out toward its
  maximum range, beyond which it can't latch at all. After each kill it
  recharges (~5s, upgradable to ~1s).
- **F-16 airstrike (once per wave)** — the panic button. Buy a **strike
  package** in the armory, then press `Space` mid-wave (or tap the on-screen
  STRIKE button on mobile) and **one F-16 per two visible enemies**
  scrambles, each carrying two air-to-air missiles — **one AAM per enemy**,
  except nukes and unsplit MIRV-nuke buses, which **count as two enemies**
  and draw a pair of missiles **from two different jets** (two hits exactly
  crack a MIRV-nuke bus). Every jet flies its own intercept solution: it
  pairs two x-neighbouring
  targets, **runs in from the side far from them** (a close-side entry would
  over-fly the pair before the rail is in parameters), enters at the
  altitude the pair is *predicted* to occupy when it reaches firing range,
  then **pitches its nose onto each target line** (pitch authority and turn
  rate limited — within reason) and fires **straight off the nose** once
  the target is in range and the nose is on the line — so the flight can
  swarm from both sides at once, announced by a **sonic boom** and an
  *"Engaging hostiles"* radio call. AAMs fly the same honest guidance as
  interceptors — smaller, born fast, with the seeker live immediately (no
  cold-launch climb gate) and the interceptor's solid-motor plume at
  reduced scale (the jets themselves fly clean) — but turn-rate-limited and
  energy-bleeding, so they can still miss a hard-jinking target. One
  package in the rack at a time; an **unused package carries over** to the
  next wave. Calling it on an empty sky is denied (the package is kept).

### Economy & shop

You earn **credits** (separate from score) from several sources, shown as a
breakdown on the wave-clear screen:

- **Kill bounties**, scaled by threat type — standard/drone/glide-bomb `1`,
  evasive `2`, hypersonic/cruise `3`, MIRV carrier/stealth/bomber `4` (split
  MIRV children pay the standard rate), MIRV-nuke bus `10` (its released
  warheads `5` each), nuke `12`.
- **All-clear bonus** for destroying *every* enemy that wave (nothing leaked).
- **Cities saved** — per surviving city.

Between waves the intermission becomes an **armory** — click an item (or press
its number), hover any row for a fuller explanation, then **NEXT WAVE** /
Space to continue. Every ladder runs deep enough to soak late-game credits:

| Item | Effect |
|------|--------|
| Interceptor Battery / Reload | Field the auto-launcher (cheap!), then shorten its cooldown, 6s → 1s (multi-level) |
| Gun Shield / Shield Recharge | Fit a dome on the CIWS that absorbs one warhead, then buy down its recharge (multi-level) |
| Laser Turret / Laser Recharge | Buy the autonomous beam, then speed its recharge (multi-level) |
| Upgrade Fire Rate | Faster CIWS cycle rate (7 levels — each compounds on the last) |
| F-16 Strike Package | One airstrike in the rack; `Space` calls it mid-wave (unused packages carry over) |

The **Gun Shield** (a regular shop item) fits a dome over the CIWS that
**intercepts one warhead on contact** — the missile detonates against the dome
instead of the gun — then **fails with a burst** and **recharges** (~10s,
upgradable down to ~2.5s via Shield Recharge levels). Cities can't be
shielded; the dome is how you survive a hit that would otherwise instantly end
the run.

There are **no city repairs** — a lost city is gone for the run, taking its
end-of-wave income with it.

Prices, amounts and earnings live in `config.economy`, `config.shop`, and
`config.shield`.

### Rules

- 6 wide cities cluster around a single central CIWS gun — flanked, once
  bought, by the laser emplacement (left) and the THAAD launcher truck
  (right; the next missile's tip pokes from the pod whenever a launch is
  ready). Most threats rain from the top; cruise missiles, drone swarms and
  bombers sweep in from the edges.
- The gun tracks the mouse. Rounds disperse in a small cone, so closer,
  well-led shots land more reliably. One hit destroys a standard missile.
- A missile reaching the ground blasts everything within its radius — a hit
  anywhere on a city's footprint counts, not just dead centre. Lose all
  cities, or take a **single hit on the central gun**, and it's game over —
  unless a **shield bubble** is up to absorb it (see the shop).
- Enemies are programmed against structures that are alive **or fell earlier
  this same wave** (their salvo was targeted before the city dropped); from
  the next wave on, known rubble draws no fire. About a third of all shots
  miss into the gaps regardless.
- Clearing a wave awards bonuses for surviving cities, and the interceptor
  launcher and laser come back fully charged.
- Game over shows a **local high-score table** (top 10, stored in
  localStorage) with your run highlighted.
- Progress is **checkpointed in localStorage** whenever a wave is cleared —
  before any armory spending, so a closed tab isn't a lost run: the menu
  offers **CONTINUE** (resume **at the armory** before the saved wave —
  upgrades, credits and rubble intact, shopping never skipped) or **NEW
  GAME** (forfeits the save). A reload after shopping simply refunds those
  purchases to re-pick; the next wave clear banks them. Game over deletes
  the checkpoint — defeat is final. Dev-console runs (sandbox / god mode)
  never touch it.

### Threats

| Threat | Appears | Behaviour |
|--------|---------|-----------|
| Standard RV (red) | wave 1+ | Straight dive toward a structure; 1 hit |
| Drone swarm (gray, squat) | wave 2+ | Five low gliders from one screen edge (counts as one wave slot), each with its own target; 1 hit each |
| Evasive RV (purple) | wave 2+ | Fast (1.35× base) and **jinks with real maneuvering physics**: a constant-g lateral pull that reverses on an irregular timer, carving banked S-turns inside a bounded leash; 1 hit |
| MIRV bus (green, large) | wave 3+ | Armoured (3 hits); splits into red RVs at altitude |
| Cruise missile (gold) | wave 3+ | Enters from a screen edge at low altitude, pops up, then dives; 2 hits |
| Bomber (bronze, Su-27 silhouette) | wave 4+ | Crosses fast at mid altitude dropping 2–3 **glide bombs** (1 hit each — yes, you can shoot down glide bombs; real ones get intercepted too). The pilot **flies defensively**: he weaves whenever a homing round is hunting him *or his own decoy*, **punches out flare bursts** that can seduce the seeker, pulls **high-g S-breaks** when the round closes, and weaves out of incoming **CIWS streams** — all under honest energy physics (total speed stays near cruise; a pull pitches the flight path, it doesn't add free velocity). **Forcing a bomber to jink aborts its bombing run for good** — suppression is a mission kill. About 40% survive a full defensive engagement. Killing the bomber pays 4 but it exits without leaking if you let it go; 3 hits |
| Hypersonic (orange dart) | wave 4+ | Very fast and barely slows in the dense air; 1 hit but hard to track |
| Stealth cruise (pale, ghostly) | wave 6+ | Flies the cruise profile **cloaked** — invisible, silent, no lock-on, no laser — until its pop-up; a blind CIWS sweep can still clip it; 2 hits |
| Nuke (crimson, huge) | wave 5+ | Announced by a klaxon and a **"Nuclear launch detected"** voice; never the first or last threat of a wave, and the per-wave cap **keeps climbing** in later waves (one at wave 5, two at 8, three at 11...). Full ballistic speed and **heavily armoured** (30 hits — a single interceptor barely dents it). Targets **inner cities** and **air-bursts** above them, leveling the target **and both neighbours** — including the CIWS if it's next door — then a mushroom cloud climbs |
| MIRV nuke (hot pink, huge) | wave 9+ | The very-late-game capstone, with its own warning voice. The bus comes in **1.5× faster than a nuke but far less armoured** (10 hits) — kill it before the split and the whole attack dies. Let it split and **three small warheads fan out onto three different cities**, each a fast little air-bursting nuke (3 hits, smaller yield: it levels only the city under it) |

A non-killing hit on the armoured MIRV flashes it white with a metallic ting —
chip it down with the gun, or pop the whole bus with one interceptor before it
splits. Missile **speed is constant across waves** (~190 px/s base); difficulty
ramps via missile *count*, spawn *cadence*, and the threat *mix*, not speed.

Per-type hit points live in `config.missile.hp` and are fully tunable.

## Physics

A simple shared atmosphere ([physics.js](js/physics.js)) governs everything that
flies. Air is **thin up high and dense near the ground** (density decays
exponentially with altitude), and quadratic drag scales with that density and
with speed:

- **CIWS rounds** feel gravity and drag — they slow and **arc**, so long shots
  need lead (the gun is genuinely close-in). A round **burns out once it slows
  below a threshold speed**: a straight-up burst just reaches the top of the
  field and dies near apogee, while a flat shot keeps flying its whole arc —
  still lethal on the way down.
- **Enemy missiles** feel drag only (no gravity, so they still track their
  target) — they **decelerate as they sink** into denser air, giving you more
  time to engage them low.
- **Interceptors** fly a real two-phase profile: a powered **boost** (with a
  rocket-engine roar) that accelerates them to top speed, then an unpowered
  **coast** where gravity and drag bleed off energy while they keep steering.
  Their turn rate and acceleration are limited, so they reliably kill slow/
  straight threats but can **overshoot and miss** fast ones — late-game
  hypersonics in particular will sometimes outrun them.

Tunables live in `config.physics` (gravity, scale height, per-projectile drag).
The play field (`config.world`) is deliberately large so there's plenty of air.

## Architecture

Vanilla JS + Canvas/WebGL, no build step. Three.js is **vendored locally** under
`vendor/three/` (resolved via the import map in `index.html`), so the game runs
fully offline.

| File | Responsibility |
|------|----------------|
| `index.html` / `style.css` | Import map + layered canvases (WebGL scene, 2D HUD) |
| `js/config.js` | **All tunable values** — balance the game here |
| `js/strings.js` | **All user-facing text** — menus, HUD, armory copy |
| `js/utils.js` | Math helpers (clamp, rand, distance, array culling) |
| `js/physics.js` | Altitude-based air-density model + quadratic drag helper |
| `js/entities.js` | `City`, `Turret`, `Bullet`, `EnemyMissile`, `Interceptor` (also flies the AAM), `FriendlyJet`, `Flare`, `Particle` (data + update, no draw) |
| `js/weapons.js` | `CIWSWeapon`, `InterceptorWeapon`, `LaserWeapon`, `AirstrikeWeapon` — stats, upgrades, fire logic |
| `js/scores.js` | Local high-score table (localStorage, injectable for tests) |
| `js/save.js` | Run checkpoint save slot (localStorage, injectable for tests) |
| `js/audio.js` | Procedural Web Audio SFX + speech announcements (singleton `sfx`) |
| `js/renderer3d.js` | `Renderer`: Three.js scene, bloom, GPU buffers, projection |
| `js/game.js` | `Game`: state machine, waves, input, simulation, 2D HUD |
| `js/main.js` | Canvas wiring + rAF loop + frame-rate quality governor |
| `vendor/three/` | Pinned Three.js r160 core + postprocessing addons |
| `serve.py` | No-cache static dev server |
| `tests/` | `bun test` suite + setup/helpers |

**Dependency injection:** `main.js` constructs the WebGL `Renderer` and passes it
into `new Game(hudCanvas, renderer)`. `Game` never imports the renderer (or
Three.js), so the whole simulation loads and runs headlessly under `bun test`
with a stub renderer. Audio is likewise inert until a user gesture calls
`sfx.unlock()`, so it needs no stubbing in tests.

**Separation of concerns:** the simulation runs in a **fixed virtual resolution**
(`config.world`, default 1400×1350) so balance — distances, speeds, gun spacing —
never depends on the window size. The camera frames that field edge-to-edge
vertically at any window aspect; on wide monitors the HUD docks into the spare
columns beside the field (and collapses into corner overlays on narrow ones).
`renderer3d.js` maps sim space to 3D world space, draws everything as emissive
neon with an UnrealBloom pass, and exposes `screenToWorld` / `worldToScreen` so
input and the HUD overlay stay aligned with the tilted camera. The HUD, menus
and shop are drawn in screen space on a 2D canvas. Entities carry no draw code —
the renderer reads their fields.

## License

MIT (see [LICENSE](LICENSE)). Three.js is vendored under `vendor/three/` and
carries its own MIT license.

## Roadmap

This is the foundation for a broader missile-defense game. Natural next steps:

- More weapon systems on the `weapons.js` abstraction (e.g. flak bursts,
  long-range area-denial interceptors) and more shop upgrades.
- More threat variety: saturation salvos, decoys, jamming.
- Deeper economy: persistent upgrades across runs, city armour, etc.
- A music bed and an online leaderboard.
