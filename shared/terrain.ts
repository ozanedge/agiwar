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
  return [{ x: 4 * GRID_SCALE, y: H >> 1 }, { x: W - 5 * GRID_SCALE, y: H >> 1 }];
}

export function terrainAt(gx: number, gy: number, seed: number, W: number, H: number): Tile {
  let h = fbm(gx / NOISE_SCALE, gy / NOISE_SCALE, seed); // base landmass (water ↔ land)
  // Mountain RANGES: ridged noise, gated by a low-frequency "belt" mask so ranges cluster into a
  // few coherent chains across the map (not mountains everywhere). The belt is also pinched in the
  // vertical middle so the two bases usually have a navigable lane between the chains.
  const belt = Math.max(0, fbm(gx / (NOISE_SCALE * 2.6), gy / (NOISE_SCALE * 2.6), seed + 4096) - 0.48) * 2.6;
  const spine = ridgeNoise(gx / (NOISE_SCALE * 1.15), gy / (NOISE_SCALE * 1.15), seed + 313);
  h += Math.min(0.62, belt * spine * 0.78); // push belts up into highland/rock crests
  // carve passable land around each base so spawns/builds + a march lane are always valid
  for (const b of baseSpots(W, H)) {
    const d = cheb(gx, gy, b.x, b.y);
    if (d < 11 * GRID_SCALE) h = Math.max(0.46, Math.min(h, 0.58)); // flat home plateau (clamped passable)
    else if (d < 18 * GRID_SCALE) h = Math.max(0.42, Math.min(h, 0.74)); // gentle apron, no peaks
  }
  const micro = (h2(gx, gy, seed + 777) - 0.5) * 0.08; // gentle variation (less speckle)
  // elev is a RENDER lift in px; /GRID_SCALE keeps slopes proportional to the (4× smaller) tiles.
  // The curve is near-flat on plains and rises steeply on highland/rock so mountains genuinely tower.
  const E = (raw: number) => raw / GRID_SCALE;
  let kind: TerrainKind, passable = true, elev: number;
  if (h < 0.34) { kind = "water"; passable = false; elev = 0; }
  else if (h < 0.40) { kind = "sand"; elev = E(1); }
  else if (h < 0.60) { kind = "grass"; elev = E(2 + (h - 0.40) * 26); }
  else if (h < 0.86) { kind = "highland"; elev = E(8 + (h - 0.60) * 130); } // mountain flanks (passable)
  else { kind = "rock"; passable = false; elev = E(42 + Math.min(72, (h - 0.86) * 230)); } // impassable crests, towering
  return { kind, height: h, elev, passable, micro };
}

export const isPassable = (gx: number, gy: number, seed: number, W: number, H: number) =>
  gx >= 0 && gy >= 0 && gx < W && gy < H && terrainAt(gx, gy, seed, W, H).passable;
