// Single source of truth for terrain. Deterministic from (seed, grid size), so the
// server (movement/placement passability) and the client (rendering) always agree.
import { GRID_SCALE } from "./units.js";
export type TerrainKind = "water" | "sand" | "grass" | "highland" | "rock";

export interface Tile {
  kind: TerrainKind;
  height: number; // 0..~1.6
  elev: number; // render lift in px (0 for water), terraced
  passable: boolean; // land units + buildings may occupy
  cliff: boolean; // impassable because the local slope is too steep (a cliff face)
  micro: number; // small per-tile color jitter
}

const NOISE_SCALE = 22 * GRID_SCALE; // larger = bigger, smoother landmasses (scaled for the finer grid)
export const CLIFF_SLOPE = 0.011; // land steeper than this (height change per cell) is an impassable cliff
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
// Ridged multifractal: inverted-abs noise stacked across octaves → sharp, CONNECTED ridge lines
// (the spine of a mountain range) rather than isolated blobby peaks. Returns ~0..1.
function ridgeNoise(x: number, y: number, seed: number): number {
  let sum = 0, amp = 0.5, f = 1, prev = 1;
  for (let o = 0; o < 4; o++) {
    let n = vnoise(x * f, y * f, seed + o * 57);
    n = 1 - Math.abs(2 * n - 1); // fold into a ridge crest
    n *= n; // sharpen the spine
    sum += amp * n * prev; // higher octaves gated by the lower ones → coherent ranges
    prev = 0.4 + 0.6 * n;
    f *= 2; amp *= 0.5;
  }
  return sum;
}

/** The two base spots — MUST match sim newGame() base positions. */
export function baseSpots(W: number, H: number) {
  // player (owner 0) on the SOUTHWEST wall (gy = H edge → bottom-left of screen); enemy on the
  // NORTHEAST wall (gy = 0). March is along −gy, which projects to "up and to the right".
  return [{ x: W >> 1, y: H - 5 * GRID_SCALE }, { x: W >> 1, y: 5 * GRID_SCALE }];
}

/** Continuous terrain height at a cell (no cliff/kind logic). The single source of the landscape:
 *  rolling continent + aggressive ridged mountain RANGES + medium-frequency roughness for variety,
 *  with a flattened, blended plateau around each base so spawns and a march lane stay clear. */
export function heightAt(gx: number, gy: number, seed: number, W: number, H: number): number {
  let h = fbm(gx / NOISE_SCALE, gy / NOISE_SCALE, seed); // rolling continent (water ↔ land)
  // mountain ranges: ridged spine gated by a low-frequency belt mask → tall, coherent chains
  const belt = Math.max(0, fbm(gx / (NOISE_SCALE * 2.6), gy / (NOISE_SCALE * 2.6), seed + 4096) - 0.45) * 3;
  const spine = ridgeNoise(gx / (NOISE_SCALE * 1.0), gy / (NOISE_SCALE * 1.0), seed + 313);
  h += Math.min(0.95, belt * spine); // prominent, towering ranges
  // medium-frequency roughness everywhere → hills, dips, knolls (variability)
  h += (fbm(gx / (NOISE_SCALE * 0.42), gy / (NOISE_SCALE * 0.42), seed + 71) - 0.5) * 0.34;
  // base region: flat home plateau, blended out to natural terrain so there's no cliff ring at the seam
  const innerR = 11 * GRID_SCALE, outerR = 22 * GRID_SCALE;
  for (const b of baseSpots(W, H)) {
    const d = cheb(gx, gy, b.x, b.y);
    if (d < innerR) return 0.5; // flat, passable home
    if (d < outerR) { const t = (d - innerR) / (outerR - innerR); return h * t + 0.5 * (1 - t); }
  }
  return h;
}

export function kindOf(h: number): TerrainKind {
  if (h < 0.34) return "water";
  if (h < 0.40) return "sand";
  if (h < 0.56) return "grass";
  if (h < 0.82) return "highland";
  return "rock";
}

// SMOOTH render lift (no terracing): near-flat on plains, rising continuously and steeply up high so
// hills are smooth uphills, not stair steps. Divided by GRID_SCALE for the fine grid.
export function elevFromHeight(h: number): number {
  if (h < 0.34) return 0; // water
  return (1 + Math.min(280, Math.pow(Math.max(0, h - 0.38), 1.5) * 360)) / GRID_SCALE;
}

export function terrainAt(gx: number, gy: number, seed: number, W: number, H: number): Tile {
  const h = heightAt(gx, gy, seed, W, H);
  const kind = kindOf(h);
  const micro = (h2(gx, gy, seed + 777) - 0.5) * 0.08;
  let passable = kind !== "water" && kind !== "rock";
  let cliff = false;
  if (passable) {
    // slope from neighbors a few cells out; steep land = an impassable cliff face
    const D = GRID_SCALE;
    const sx = Math.abs(heightAt(gx + D, gy, seed, W, H) - heightAt(gx - D, gy, seed, W, H));
    const sy = Math.abs(heightAt(gx, gy + D, seed, W, H) - heightAt(gx, gy - D, seed, W, H));
    if (Math.max(sx, sy) / (2 * D) > CLIFF_SLOPE) { cliff = true; passable = false; }
  }
  return { kind, height: h, elev: elevFromHeight(h), passable, cliff, micro };
}

/** Cheap elevation lookup (no cliff sampling) — for rendering unit lift, etc. */
export const elevationAt = (gx: number, gy: number, seed: number, W: number, H: number) => elevFromHeight(heightAt(gx, gy, seed, W, H));

export const isPassable = (gx: number, gy: number, seed: number, W: number, H: number) =>
  gx >= 0 && gy >= 0 && gx < W && gy < H && terrainAt(gx, gy, seed, W, H).passable;

/** Extra attack range / sight (in fine cells) granted by standing on high ground — a big edge. */
export function highGroundBonus(height: number): number {
  return Math.round(Math.max(0, height - 0.55) * 70); // 0 on low ground → ~+19 cells on the highest passable ground
}
