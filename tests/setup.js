// ---------------------------------------------------------------------------
// Test preload: stub the few browser globals the game logic touches at runtime
// (Game.resize / bindInput). The renderer is dependency-injected and audio is
// inert until unlock(), so nothing else from the DOM is needed.
// ---------------------------------------------------------------------------

import { CONFIG } from '../js/config.js';

// The armory withholds a couple of random offers each wave (run-to-run variety),
// which would make shop contents nondeterministic across the behaviour tests.
// Default it off here; the tests that exercise the drop opt back in explicitly.
CONFIG.shop.dropPerWave = 0;

const noop = () => {};

if (!globalThis.window) {
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener: noop,
    removeEventListener: noop,
  };
}

if (!globalThis.document) {
  globalThis.document = { addEventListener: noop, removeEventListener: noop };
}
