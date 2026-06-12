# Cervix Command

A Missile Command–style game, reskinned as biology: instead of cities under a
nuclear barrage, you are the reproductive tract defending six **ova** against an
endless **swarm of sperm**. Your central **mucus cannon** (the cervix) sprays a
rapid-fire stream of cervical mucus; the supply is endless, but globs arc and
slow with distance, so you still have to lead your targets.

Rendered in **WebGL** (Three.js) with bloom for a warm, glowing, fleshy interior,
while the gameplay stays a flat 2D plane viewed nearly head-on.

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

It covers `utils`, `physics`, the entities (ballistics, drag, clump split,
antibody boost/coast/energy), the weapon systems, the high-score table, the
save checkpoint, and the `Game` orchestration (waves, spawning/threat gating, collisions & HP,
bounties, impacts and mutant air-bursts, enzyme bombers, the autonomous antibody gland and
acid gland, the economy, the biolab, and win/lose conditions).

The simulation is headless-testable because the WebGL renderer is **injected**
into `Game` rather than imported — see the architecture note below.

For hands-on testing there is also a hidden **dev console**: press `` ` ``
(backquote) in any state. It offers god mode (ova & cervix invincible) and
endless single-threat sandboxes (loop enzyme bombers, swarmer swarms, mutants, etc.) for
observing sperm and autonomous-defense behaviour in isolation. Dev runs are
marked with a DEV badge and never touch the high-score table.

### Controls

| Input | Action |
|-------|--------|
| Mouse move | Aim the mucus cannon — it fires on its own while sperm are inbound |
| Touch (mobile) | Drag on the **aim pad** below the field — an absolute aim mapping, so your thumb never covers the action (touching the field directly also aims) |
| `P` | Pause / resume |
| `R` | Restart |
| `M` | Mute / unmute |
| `Space` / click | Defend from the tutorial screen / restart after game over (with a saved run, `Space` continues it) |

You aim; everything fires itself. The mucus cannon sprays wherever you point it
(and holds fire when the field is clear), antibodies launch themselves at distant
high-value swimmers, and the acid gland handles whatever gets close. A tutorial
screen at the start covers all of this in-game.

### Defenses

- **Mucus cannon** — a single central rapid-fire gland with an **endless
  supply** that sprays automatically while sperm are inbound; you steer the
  stream with the mouse and must lead targets. One glob kills a standard
  sperm. **If a sperm ever reaches the cervix, you instantly lose** — so anything
  heading for the centre is top priority.
- **Antibodies (autonomous)** — a **cheap biolab purchase** (the natural
  first buy) that fields homing antibodies with unlimited stock, gated by
  a **synthesis cooldown** (6s at the start; biolab upgrades buy it down to 1s);
  the gland comes back fully stocked each wave. It fires
  itself at the **highest-value, most distant swimmer** — it never engages
  cheap clutter (swarmers and acrosome bombs are the acid gland's and cannon's business,
  though a blast can still catch one), can't see cloaked ghost sperm, and won't
  shoot inside its minimum engagement distance. Antibodies **launch
  straight up** from the gland — guidance stays locked for the
  first ~100px of climb — then turn onto an intercept course —
  but coasting flight **bleeds energy**, hard turns scrub extra speed,
  and an antibody that drops below maneuvering speed **breaks down**: some
  intercepts genuinely run out of energy. If the target dies en route the
  antibody retasks onto the nearest valid swimmer (or breaks down), and
  it detonates with an **area blast**.
- **Acid gland (biolab upgrade)** — a fully autonomous pH beam emplacement left
  of the cervix with a trainable emitter head. It picks the **lowest** swarmer or
  normal-type sperm in range (it can't track the fast movers), **physically
  slews onto it**, and only then dissolves it over time. It **can't depress
  below ~15° above the horizon**, so wall-huggers slip under its arc. Output
  **falls off with distance** — full power up close, weaker out toward its
  maximum range, beyond which it can't latch at all. After each kill it
  rebuilds acid (~6s, upgradable to ~2s).

### Economy & biolab

You earn **ATP** (separate from score) from several sources, shown as a
breakdown on the wave-clear screen:

- **Kill bounties**, scaled by sperm type — standard/swarmer/acrosome `1`,
  wriggler `2`, sprinter/wall-hugger `3`, clump/ghost/enzyme-bomber `4` (split
  clump children pay the standard rate), mutant `12`.
- **All-clear bonus** for repelling *every* sperm that wave (nothing leaked).
- **Ova saved** — per surviving ovum.

Between waves the intermission becomes a **biolab** — click an item (or press
its number), hover any row for a fuller explanation, then **NEXT WAVE** /
Space to continue. Every ladder runs deep enough to soak late-game ATP:

| Item | Effect |
|------|--------|
| Antibody Gland / Synthesis | Field the auto-launcher (cheap!), then shorten its cooldown, 6s → 1s (multi-level) |
| Mucus Plug / Regrowth | Fit a plug on the cervix that absorbs one sperm, then buy down its regrowth (multi-level) |
| Acid Gland / Buildup | Buy the autonomous beam, then speed its buildup (multi-level) |
| Upgrade Spray Rate | Faster mucus cannon cycle rate (multi-level) |
| Twin Glands | One-time: a second nozzle spraying side-by-side (2× globs) |

The **Mucus Plug** (a regular biolab item) fits over the cervix and
**intercepts one sperm on contact** — the sperm bursts against the plug
instead of the cervix — then **fails with a burst** and **regrows** (~10s,
upgradable down to ~2.5s via Mucus Regrowth levels). Ova can't be
plugged; the plug is how you survive a hit that would otherwise instantly end
the run.

There are **no ovum repairs** — a lost ovum is gone for the run, taking its
end-of-wave income with it.

Prices, amounts and earnings live in `config.economy`, `config.shop`, and
`config.shield`.

### Rules

- 6 wide ova cluster around a single central cervix — flanked, once
  bought, by the acid gland (left) and the antibody gland
  (right; the next antibody's tip pokes from the gland whenever a launch is
  ready). Most sperm rain from the top; wall-huggers, swarmer swarms and
  enzyme bombers sweep in from the edges.
- The cannon tracks the mouse. Globs disperse in a small cone, so closer,
  well-led shots land more reliably. One hit destroys a standard sperm.
- A sperm reaching an ovum blasts everything within its radius — a hit
  anywhere on an ovum's footprint counts, not just dead centre. Lose all
  ova, or take a **single sperm on the central cervix**, and it's game over —
  unless a **mucus plug** is up to absorb it (see the biolab).
- Sperm are programmed against ova that are alive **or ruptured earlier
  this same wave** (their salvo was targeted before the ovum dropped); from
  the next wave on, known wreckage draws no fire. About a third of all swimmers
  miss into the gaps regardless.
- Clearing a wave awards bonuses for surviving ova, and the antibody
  gland and acid gland come back fully charged.
- Game over shows a **local high-score table** (top 10, stored in
  localStorage) with your run highlighted.
- Progress is **checkpointed in localStorage** whenever a wave is cleared —
  before any biolab spending, so a closed tab isn't a lost run: the menu
  offers **CONTINUE** (resume **at the biolab** before the saved wave —
  upgrades, ATP and wreckage intact, shopping never skipped) or **NEW
  CYCLE** (forfeits the save). A reload after shopping simply refunds those
  purchases to re-pick; the next wave clear banks them. Game over deletes
  the checkpoint — defeat is final. Dev-console runs (sandbox / god mode)
  never touch it.

### Sperm

| Threat | Appears | Behaviour |
|--------|---------|-----------|
| Sperm (pale cream) | wave 1+ | Straight dive toward an ovum; 1 hit |
| Swarmer swarm (gray, squat) | wave 2+ | Five low gliders from one screen edge (counts as one wave slot), each with its own target; 1 hit each |
| Wriggler (purple) | wave 2+ | Weaves on an irregular path; 1 hit |
| Clump (green, large) | wave 3+ | Armoured (3 hits); splits into single sperm at altitude |
| Wall-hugger (gold) | wave 3+ | Enters from a screen edge at low altitude, pops up, then dives; 2 hits |
| Enzyme bomber (bronze) | wave 4+ | Crosses fast at mid altitude dropping 2–3 **acrosome bombs** (1 hit each — yes, you can dissolve acrosome bombs in flight). The bomber **flies defensively**: it weaves whenever an antibody is hunting it *or its own decoy*, **ejects bursts of decoy proteins** that can seduce the antibody, pulls **high-g S-breaks** when the antibody closes, and weaves out of incoming **mucus streams** — all under honest energy physics (total speed stays near cruise; a pull pitches the flight path, it doesn't add free velocity). **Forcing a bomber to jink aborts its run for good** — suppression is a mission kill. About 40% survive a full defensive engagement. Killing it pays 4 but it exits without leaking if you let it go; 3 hits |
| Sprinter (orange dart) | wave 4+ | Very fast and barely slows in the dense fluid; 1 hit but hard to track |
| Ghost sperm (pale, ghostly) | wave 6+ | Flies the wall-hugger profile **cloaked** — invisible, silent, no lock-on, no acid — until its pop-up; a blind mucus sweep can still clip it; 2 hits |
| Mutant (crimson, huge) | wave 5+ | Announced by a klaxon and a **"Mutant swimmer detected"** voice; never the first or last threat of a wave, and the per-wave cap **keeps climbing** in later waves (one at wave 5, two at 8, three at 11...). Full speed and **heavily armoured** (30 hits — a single antibody barely dents it). Targets **inner ova** and **bursts** over them, leveling the target **and both neighbours** — including the cervix if it's next door — then a bloom of cytoplasm climbs |

A non-killing hit on the armoured clump flashes it white with a wet thud —
chip it down with the cannon, or pop the whole clump with one antibody before it
splits. Sperm **speed is constant across waves** (~190 px/s base); difficulty
ramps via sperm *count*, spawn *cadence*, and the *mix*, not speed.

Per-type hit points live in `config.missile.hp` and are fully tunable.

## Physics

A simple shared atmosphere ([physics.js](js/physics.js)) governs everything that
moves. The fluid is **thin up high and dense near the wall** (density decays
exponentially with altitude), and quadratic drag scales with that density and
with speed:

- **Mucus globs** feel gravity and drag — they slow and **arc**, so long shots
  need lead (the cannon is genuinely close-in). A glob **burns out once it slows
  below a threshold speed**: a straight-up burst just reaches the top of the
  field and dies near apogee, while a flat shot keeps flying its whole arc —
  still lethal on the way down.
- **Sperm** feel drag only (no gravity, so they still track their
  target) — they **decelerate as they sink** into denser fluid, giving you more
  time to engage them low.
- **Antibodies** fly a real two-phase profile: a powered **boost** (with a
  propulsion surge) that accelerates them to top speed, then an unpowered
  **coast** where gravity and drag bleed off energy while they keep steering.
  Their turn rate and acceleration are limited, so they reliably kill slow/
  straight sperm but can **overshoot and miss** fast ones — late-game
  sprinters in particular will sometimes outrun them.

Tunables live in `config.physics` (gravity, scale height, per-projectile drag).
The play field (`config.world`) is deliberately large so there's plenty of room.

## Architecture

Vanilla JS + Canvas/WebGL, no build step. Three.js is **vendored locally** under
`vendor/three/` (resolved via the import map in `index.html`), so the game runs
fully offline.

| File | Responsibility |
|------|----------------|
| `index.html` / `style.css` | Import map + layered canvases (WebGL scene, 2D HUD) |
| `js/config.js` | **All tunable values** — balance the game here |
| `js/strings.js` | **All user-facing text** — menus, HUD, biolab copy |
| `js/utils.js` | Math helpers (clamp, rand, distance, array culling) |
| `js/physics.js` | Altitude-based density model + quadratic drag helper |
| `js/entities.js` | `City`, `Turret`, `Bullet`, `EnemyMissile`, `Interceptor`, `Flare`, `Particle` (data + update, no draw) |
| `js/weapons.js` | `CIWSWeapon`, `InterceptorWeapon`, `LaserWeapon` — stats, upgrades, fire logic |
| `js/scores.js` | Local high-score table (localStorage, injectable for tests) |
| `js/save.js` | Run checkpoint save slot (localStorage, injectable for tests) |
| `js/audio.js` | Procedural Web Audio SFX + speech announcements (singleton `sfx`) |
| `js/renderer3d.js` | `Renderer`: Three.js scene, bloom, GPU buffers, projection |
| `js/game.js` | `Game`: state machine, waves, input, simulation, 2D HUD |
| `js/main.js` | Canvas wiring + rAF loop + frame-rate quality governor |
| `vendor/three/` | Pinned Three.js r160 core + postprocessing addons |
| `serve.py` | No-cache static dev server |
| `tests/` | `bun test` suite + setup/helpers |

The internal code keeps its original military identifiers (`turret`, `missile`,
`interceptor`, `laser`, `nuke`, `mirv`…); only the **user-facing text and palette**
are reskinned, so the engine and its test suite are untouched by the theme.

**Dependency injection:** `main.js` constructs the WebGL `Renderer` and passes it
into `new Game(hudCanvas, renderer)`. `Game` never imports the renderer (or
Three.js), so the whole simulation loads and runs headlessly under `bun test`
with a stub renderer. Audio is likewise inert until a user gesture calls
`sfx.unlock()`, so it needs no stubbing in tests.

**Separation of concerns:** the simulation runs in a **fixed virtual resolution**
(`config.world`, default 1400×1350) so balance — distances, speeds, gland spacing —
never depends on the window size. The camera frames that field edge-to-edge
vertically at any window aspect; on wide monitors the HUD docks into the spare
columns beside the field (and collapses into corner overlays on narrow ones).
`renderer3d.js` maps sim space to 3D world space, draws everything as emissive
neon with an UnrealBloom pass, and exposes `screenToWorld` / `worldToScreen` so
input and the HUD overlay stay aligned with the tilted camera. The HUD, menus
and biolab are drawn in screen space on a 2D canvas. Entities carry no draw code —
the renderer reads their fields.

## License

MIT (see [LICENSE](LICENSE)). Three.js is vendored under `vendor/three/` and
carries its own MIT license.

## Roadmap

This is the foundation for a broader biological-defense game. Natural next steps:

- More defense systems on the `weapons.js` abstraction (e.g. spermicide bursts,
  long-range immune patrols) and more biolab upgrades.
- More sperm variety: saturation salvos, decoys, chemical jamming.
- Deeper economy: persistent upgrades across runs, ovum armour, etc.
- A music bed and an online leaderboard.
