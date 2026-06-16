// Single source of truth for terrain. Deterministic from (seed, grid size), so the
// server (movement/placement passability) and the client (rendering) always agree.
import { GRID_SCALE } from "./units.js";
export type TerrainKind = "water" | "sand" | "grass" | "highland" | "rock";

export interface Tile {
  kind: TerrainKind;
  height: number; // 0..~1
  elev: number; // render lift in px (0 for water)
  passable: boolean; // land units + buildings may occupy
  micro: number; // small per-tile color jitter [-0.07, 0.07]
}

const NOISE_SCALE = 22 * GRID_SCALE; // larger = bigger, smoother landmasses (scaled so features keep their physical size on the finer grid)
const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

function h2(x: number, y: number, seed: number): number {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) >>> 0;
  n = (n ^ (n >>> 13)) >>> 0; n = Math.imul(n, 1274126177) >>> 0;
  return (n >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, seed), b = h2(xi + 1, yi, seed), c = h2(xi, yi + 1, seed), d = h2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x: number, y: number, seed: number): number {
  let sum = 0, amp = 0.55, f = 1;
  for (let o = 0; o < 4; o++) { sum += amp * vnoise(x * f, y * f, seed + o * 131); f *= 2; amp *= 0.5; }
  return sum;
}

/** The two base spots — MUST match sim newGame() base positions. */
export function baseSpots(W: number, H: number) {
  return [{ x: 4 * GRID_SCALE, y: H >> 1 }, { x: W - 5 * GRID_SCALE, y: H >> 1 }];
}

export function terrainAt(gx: number, gy: number, seed: number, W: number, H: number): Tile {
  let h = fbm(gx / NOISE_SCALE, gy / NOISE_SCALE, seed);
  // carve flat, passable land around each base so spawns/builds are always valid
  for (const b of baseSpots(W, H)) {
    const d = cheb(gx, gy, b.x, b.y);
    if (d < 11 * GRID_SCALE) h = Math.max(h, 0.5);
    else if (d < 18 * GRID_SCALE) h = Math.max(h, 0.42);
  }
  const micro = (h2(gx, gy, seed + 777) - 0.5) * 0.08; // gentle variation (less speckle)
  // elev is a RENDER lift in px; divide by GRID_SCALE so slopes stay proportional to the (now 4× smaller) tiles
  const E = (raw: number) => raw / GRID_SCALE;
  let kind: TerrainKind, passable = true, elev: number;
  if (h < 0.34) { kind = "water"; passable = false; elev = 0; }
  else if (h < 0.39) { kind = "sand"; elev = E(1); }
  else if (h < 0.62) { kind = "grass"; elev = E(2 + (h - 0.39) * 34); }
  else if (h < 0.8) { kind = "highland"; elev = E(2 + (h - 0.39) * 34); }
  else { kind = "rock"; passable = false; elev = E(2 + (h - 0.39) * 34); } // mountain peaks block land units
  return { kind, height: h, elev, passable, micro };
}

export const isPassable = (gx: number, gy: number, seed: number, W: number, H: number) =>
  gx >= 0 && gy >= 0 && gx < W && gy < H && terrainAt(gx, gy, seed, W, H).passable;
