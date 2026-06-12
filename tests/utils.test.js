import { describe, it, expect } from 'bun:test';
import {
  clamp,
  lerp,
  rand,
  randInt,
  dist,
  dist2,
  deg2rad,
  pick,
  shuffle,
  removeWhere,
  TAU,
} from '../js/utils.js';

describe('clamp', () => {
  it('bounds below, within, and above', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('lerp', () => {
  it('interpolates endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });
});

describe('rand / randInt', () => {
  it('rand stays within [min, max)', () => {
    for (let i = 0; i < 500; i++) {
      const v = rand(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(7);
    }
  });

  it('randInt is an integer within [min, max]', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const v = randInt(1, 4);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(4);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('distance', () => {
  it('dist is euclidean', () => {
    expect(dist(0, 0, 3, 4)).toBe(5);
  });
  it('dist2 is the square of dist', () => {
    expect(dist2(0, 0, 3, 4)).toBe(25);
    expect(dist2(1, 1, 1, 1)).toBe(0);
  });
});

describe('deg2rad / TAU', () => {
  it('converts degrees to radians', () => {
    expect(deg2rad(180)).toBeCloseTo(Math.PI, 10);
    expect(deg2rad(0)).toBe(0);
  });
  it('TAU is two pi', () => {
    expect(TAU).toBeCloseTo(Math.PI * 2, 10);
  });
});

describe('pick', () => {
  it('returns an element of the array', () => {
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) expect(arr).toContain(pick(arr));
  });
});

describe('shuffle', () => {
  it('returns a new array with the same elements, leaving the input untouched', () => {
    const arr = [1, 2, 3, 4, 5];
    const out = shuffle(arr);
    expect(out).not.toBe(arr);
    expect(arr).toEqual([1, 2, 3, 4, 5]); // original unchanged
    expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
  it('handles empty and single-element arrays', () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle([7])).toEqual([7]);
  });
});

describe('removeWhere', () => {
  it('removes matching elements in place, preserving order', () => {
    const arr = [1, 2, 3, 4, 5, 6];
    removeWhere(arr, (n) => n % 2 === 0);
    expect(arr).toEqual([1, 3, 5]);
  });
  it('can empty the array', () => {
    const arr = [1, 2, 3];
    removeWhere(arr, () => true);
    expect(arr).toHaveLength(0);
  });
  it('keeps everything when nothing matches', () => {
    const arr = [1, 2, 3];
    removeWhere(arr, () => false);
    expect(arr).toEqual([1, 2, 3]);
  });
});
