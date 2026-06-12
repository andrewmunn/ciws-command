// ---------------------------------------------------------------------------
// Small, dependency-free math helpers shared across the game.
// ---------------------------------------------------------------------------

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** Uniform random in [min, max). */
export const rand = (min, max) => min + Math.random() * (max - min);

/** Random integer in [min, max] inclusive. */
export const randInt = (min, max) => Math.floor(rand(min, max + 1));

export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Squared distance — cheaper when you only need to compare. */
export const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export const TAU = Math.PI * 2;
export const deg2rad = (d) => (d * Math.PI) / 180;

/** Pick a random element of an array. */
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Fisher-Yates shuffle, returning a new array (the input is left untouched). */
export const shuffle = (arr) => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * Remove array elements for which `pred` returns true, in place.
 * Used every frame to cull dead entities without allocating new arrays.
 */
export const removeWhere = (arr, pred) => {
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    if (!pred(arr[r])) arr[w++] = arr[r];
  }
  arr.length = w;
};
