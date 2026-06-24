// Deterministic, server-authoritative fixed-tick simulation.
// No Math.random / Date.now inside the tick: all "randomness" is a pure hash of
// (unitId, tick) so a match is fully reproducible and replayable.
import type { Outpost, OutpostBonusKind, BehaviorSpec, BaseState, Camp, DoctrineId, FieldGeneral, Shot, UnitState } from "../../shared/types.js";
import { PRESET_PROMPTS, PRESET_SPECS, clampSpec } from "../../shared/spec.js";
import { UNIT_STATS, UnitType, TRAINABLE, VISION_MULT, VISION_CAP, BASE_VISION, INVESTMENTS, investCost, GRID_SCALE } from "../../shared/units.js";
import { terrainAt, heightAt, highGroundBonus } from "../../shared/terrain.js";
import { modsFor, budgetFor, type ArmyMods } from "../../shared/doctrine.js";

const OUTPOST_CAP = Number(process.env.OUTPOST_CAP ?? 9);
const OUTPOST_EVERY = Number(process.env.OUTPOST_EVERY ?? 150); // ticks between spawns (~15s)
const OUTPOST_HP = 120;
export type Bonus = { income: number; range: number; hp: number; damage: number; armor: number; speed: number };

// Pacing knobs (env-tunable so we can dial feel without code edits).
// 16× cell density (4× per axis). The march now runs SW→NE along the gy (H) axis, so H is the
// LONG dimension — restores the original long-march distance in the reoriented layout. (520×800)
export const GRID_W = Number(process.env.GRID_W ?? 130 * GRID_SCALE); // 520 (lateral)
export const GRID_H = Number(process.env.GRID_H ?? 200 * GRID_SCALE); // 800 (march axis, base→base)
const BASE_HP = Number(process.env.BASE_HP ?? 400);
export const INCOME_PER_TICK = Number(process.env.INCOME_PER_TICK ?? 2); // ~20 resources/sec at 10Hz
const STARTING_RESOURCES = Number(process.env.STARTING_RESOURCES ?? 250);
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);

// default budget allocation per camp (% of income) + unit mix (weights). Players tune live.
// Sum of budgets < 100 -> the remainder banks as savings for turrets.
const DEFAULT_PROD: Record<DoctrineId, { budgetPct: number; mix: Partial<Record<UnitType, number>> }> = {
  aggressive: { budgetPct: 30, mix: { gunner: 100 } }, // Attack budget
  recon: { budgetPct: 12, mix: { drone: 100 } }, // Intelligence budget — drones are our eyes
  defensive: { budgetPct: 15, mix: { tank: 100 } }, // Defense budget
  builder: { budgetPct: 10, mix: { humvee: 100 } }, // Builder budget — units hunt outposts
};
const DEFAULT_TURRET_BUDGET = 10; // 30+10+15+10 camps + 10 turret = 75 → 25% savings
const CAPTURE_COST = Number(process.env.CAPTURE_COST ?? 180); // drawn from the bank when a capture completes
const CAPTURE_TICKS = Number(process.env.CAPTURE_TICKS ?? 60); // ~6s of channeling to claim a neutral outpost
// Movement/attack cadence and HP/damage are now PER UNIT TYPE (see shared/units.ts):
// gunner = balanced, tank = strong+slow, humvee = fast+weak. A global SPEED_MULT scales
// all cadences if we want to slow/speed everything uniformly without touching per-type feel.
const SPEED_MULT = Number(process.env.SPEED_MULT ?? 1);
// High-ground edge: damage is scaled by the attacker's terrain height minus the target's.
// Firing downhill hits harder, uphill softer — clamped so it's an edge, never a one-shot.
const HIGH_GROUND_GAIN = Number(process.env.HIGH_GROUND_GAIN ?? 1.8);
const HIGH_GROUND_MIN = 0.6, HIGH_GROUND_MAX = 1.6;
// Pack cohesion: an advancing unit that has fallen BEHIND its local group steers back to it, so
// the army travels as a coherent pack instead of a scattered swarm of independent wanderers.
const PACK_RADIUS = 14 * GRID_SCALE; // friendly combatants within this many cells form one pack
const PACK_KEEP = 4 * GRID_SCALE; // a straggler farther than this from the pack center rejoins it
const SUPPORT_RADIUS = 8 * GRID_SCALE; // a unit rushes to help only allies being attacked THIS close
const SUPPORT_MEMORY = 14; // ticks an "ally under attack" beacon stays hot after the last shot at it
// SANDSTORM: a stalemate-breaker. When the map is choked with units (both armies summed), a storm
// rolls in and scours EVERY unit off the field over SANDSTORM_SECS — production halts, the board
// clears, both sides rebuild. Bases are untouched. Stops armies ballooning without bound (which also
// used to choke the renderer) while giving the wipe real in-world drama instead of a silent cap.
export const SANDSTORM_TRIGGER = Number(process.env.SANDSTORM_TRIGGER ?? 400); // total units that summon the storm
export const SANDSTORM_SECS = Number(process.env.SANDSTORM_SECS ?? 30);
const SANDSTORM_TICKS = Math.max(1, Math.round(SANDSTORM_SECS * TICK_HZ));
const SANDSTORM_KILL_TICKS = Math.max(1, Math.round(SANDSTORM_TICKS * 0.85)); // all units dead by ~85% in, leaving a few seconds of empty howling storm
const SANDSTORM_COOLDOWN_TICKS = Math.round(20 * TICK_HZ); // breather after a storm before it can recur
// last tick each unit was fired upon (by an enemy) — lets nearby allies rally to a unit in a fight.
const underAttack = new Map<number, number>();
const groundHeight = (g: GameState, x: number, y: number) => heightAt(x, y, g.seed, GRID_W, GRID_H);
// extra attack range + sight (in fine cells) from standing on high ground — a big positional edge
const hgBonus = (g: GameState, x: number, y: number) => highGroundBonus(groundHeight(g, x, y));

/** Everything that belongs to one player: their three camp generals and their field general. */
export interface PlayerState {
  camps: Camp[];
  fieldGeneral: FieldGeneral;
  resources: number;
  invest: Bonus; // purchased investment levels per kind
  turretBudget: number; // % of income auto-spent building turrets (separate from savings)
  advisor: FieldGeneral; // investment advisor (label + editable economic doctrine)
  armyDoctrine: string; // once-per-match build identity (id from shared/doctrine.ts)
  rally: { x: number; y: number; until: number } | null; // commitment point: forward units concentrate here until `until` tick
  fieldOrder: { kind: "defend" | "push"; target: DoctrineId | "all"; label: string; ovr: BehaviorSpec } | null; // the field general's ACTIVE tactic — overrides doctrine until the player cancels it
  queuedInvest: OutpostBonusKind | null; // a player-queued upgrade — pauses all other spending to save for it
  morale: number; // 0..1 team morale (degrades speed + accuracy when low); recomputed each tick
  recentLosses: number; // decaying tally of recent unit deaths (drags morale down)
  moraleBoost: number; // temporary morale lift from a purchased booster (decays over time)
}

/** This player's army-wide modifiers, derived from their chosen doctrine. */
export const playerMods = (g: GameState, owner: number): ArmyMods => modsFor(g.players[owner]?.armyDoctrine);

/** Lock in a player's once-per-match army doctrine: set the build identity AND seed the opening budget
 *  (camp %s + turret ring) to match the strategy. The player can retune the Sankey live afterward. */
export function applyArmyDoctrine(g: GameState, owner: number, id: string): void {
  const p = g.players[owner];
  if (!p) return;
  p.armyDoctrine = id;
  const b = budgetFor(id);
  for (const camp of p.camps) camp.production.budgetPct = b[camp.id];
  p.turretBudget = b.turret;
}

// ---- Morale ----------------------------------------------------------------------------------
// Team morale (0..1). UP with a larger force (strength in numbers); DOWN the further the army is
// from its nearest supply point (base/owned outpost — overextension) and the more units it has
// lost recently. Low morale degrades movement speed and accuracy. Boosters lift it temporarily.
const MORALE_BASE = 0.7;
export function computeMorale(g: GameState, pi: number): number {
  const p = g.players[pi];
  const own = g.units.filter((u) => u.owner === pi && !UNIT_STATS[u.unit].building);
  const n = own.length;
  const supply = [g.bases[pi], ...g.outposts.filter((a) => a.owner === pi)].filter(Boolean);
  let avgDist = 0;
  if (n && supply.length) {
    let s = 0;
    for (const u of own) { let md = Infinity; for (const sp of supply) md = Math.min(md, cheb(u.x, u.y, sp.x, sp.y)); s += md; }
    avgDist = s / n;
  }
  const sizeTerm = Math.min(0.2, (n / 60) * 0.2); // confidence in numbers
  const distTerm = Math.min(0.45, (avgDist / (GRID_H * 0.8)) * 0.45); // overextension from supply
  const lossTerm = Math.min(0.4, p.recentLosses * 0.04); // recent casualties
  return Math.max(0.05, Math.min(1, MORALE_BASE + sizeTerm - distTerm - lossTerm + p.moraleBoost));
}
/** Booster cost scales with the player's standing army (so it's never a spammed crutch). */
export const boosterCost = (g: GameState, pi: number) =>
  120 + 6 * g.units.filter((u) => u.owner === pi && !UNIT_STATS[u.unit].building).length;
const moraleSpeedFactor = (m: number) => 1 + (1 - m) * 0.6; // low morale → bigger movePeriod (slower)
const moraleAccFactor = (m: number) => 0.6 + 0.4 * m; // low morale → worse accuracy

export interface GameState {
  tick: number;
  seed: number; // map seed (cosmetic terrain); fixed per match
  units: UnitState[];
  bases: BaseState[];
  outposts: Outpost[];
  shots: Shot[]; // transient weapon-fire events accumulated since the last broadcast (cosmetic)
  players: PlayerState[]; // index = player/owner
  flow: Int32Array[]; // BFS distance-to-base field per base, for obstacle-routed movement
  passGrid: Uint8Array; // 1 = passable, 0 = blocked (water/rock/cliff) — precomputed once per match
  dynFlow: Map<number, { tick: number; dist: Int32Array }>; // cached flow fields toward dynamic goals
  nextUnitId: number;
  nextOutpostId: number;
  sandstorm: { from: number; until: number } | null; // active board-clearing storm (null = clear skies)
  sandstormCooldownUntil: number; // tick before which a new storm can't trigger (post-storm breather)
}

/** Sum of bonuses from outposts a player currently controls. */
export function playerBonus(g: GameState, player: number): Bonus {
  const b: Bonus = { income: 0, range: 0, hp: 0, damage: 0, armor: 0, speed: 0 };
  for (const a of g.outposts) if (a.owner === player) b[a.bonus.kind] += a.bonus.amount;
  const inv = g.players[player].invest; // permanent investments stack with outposts
  for (const i of INVESTMENTS) b[i.kind] += inv[i.kind] * i.amount;
  return b;
}

export const DEFAULT_FIELD_GENERAL_PROMPT =
  "Command pragmatically. Let the camps' doctrines do their job — only override when there's a " +
  "clear opening or a real threat. Concentrate force to push when the enemy overcommits or thins out; " +
  "pull back to defend the home base when it's pressured. Keep overrides short.";

const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
// pure deterministic hash -> [0,1)
function hash01(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

function makeCamp(id: DoctrineId, label: string): Camp {
  return { id, label, prompt: PRESET_PROMPTS[id], spec: { ...PRESET_SPECS[id] }, cooldownUntil: 0, compiling: false, production: { budgetPct: DEFAULT_PROD[id].budgetPct, mix: { ...DEFAULT_PROD[id].mix } } };
}

function makePlayer(): PlayerState {
  return {
    camps: [
      makeCamp("aggressive", "Gen. Vance · Aggressive"),
      makeCamp("recon", "Gen. Okafor · Recon"),
      makeCamp("defensive", "Gen. Reyes · Defensive"),
      makeCamp("builder", "Gen. Singh · Builder"),
    ],
    fieldGeneral: { label: "Field Gen. Mercer", prompt: DEFAULT_FIELD_GENERAL_PROMPT },
    resources: STARTING_RESOURCES,
    invest: { income: 0, range: 0, hp: 0, damage: 0, armor: 0, speed: 0 },
    turretBudget: DEFAULT_TURRET_BUDGET,
    advisor: { label: "Advisor Holt", prompt: DEFAULT_ADVISOR_PROMPT },
    armyDoctrine: "balanced", // neutral until the player chooses
    rally: null,
    fieldOrder: null,
    queuedInvest: null,
    morale: 0.7,
    recentLosses: 0,
    moraleBoost: 0,
  };
}

export const DEFAULT_ADVISOR_PROMPT =
  "Run a balanced war economy. Fund attack and defense steadily, keep some income flowing to the " +
  "builder so we grab outposts, and bank a little savings. Invest gradually in munitions and plating. " +
  "If our base comes under pressure, shift toward defense and turrets.";

export function newGame(seed = 1): GameState {
  const bases: BaseState[] = [
    // owner 0 = SW wall (bottom-left), owner 1 = NE wall (top-right) — MUST match baseSpots()
    { owner: 0, x: GRID_W >> 1, y: GRID_H - 5 * GRID_SCALE, hp: BASE_HP, maxHp: BASE_HP },
    { owner: 1, x: GRID_W >> 1, y: 5 * GRID_SCALE, hp: BASE_HP, maxHp: BASE_HP },
  ];
  // pick a terrain seed that keeps the two bases well-connected (no long range/lake walling the field)
  const mapSeed = pickMapSeed(seed >>> 0, bases);
  const g: GameState = { tick: 0, seed: mapSeed, units: [], bases, outposts: [], shots: [], players: [makePlayer(), makePlayer()], flow: [], passGrid: new Uint8Array(0), dynFlow: new Map(), nextUnitId: 1, nextOutpostId: 1, sandstorm: null, sandstormCooldownUntil: 0 };
  // precompute passability ONCE (terrain w/ cliff slope is costly) — movement + flow read this grid
  const grid = new Uint8Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) grid[y * GRID_W + x] = terrainAt(x, y, g.seed, GRID_W, GRID_H).passable ? 1 : 0;
  g.passGrid = grid;
  // final safety net: the coarse vet samples every few cells, so a thin cliff line could still split
  // the field at full resolution. If the bases are truly disconnected, carve a march lane between them.
  if (bfsFrom(g, bases[0].x, bases[0].y)[bases[1].y * GRID_W + bases[1].x] >= 1e9) carveCorridor(grid, bases);
  g.flow = [computeFlow(g, 0), computeFlow(g, 1)]; // route-around-terrain fields, once per match
  return g;
}

// ---- MAP VETTING ----------------------------------------------------------------------------------
// Auto-generated terrain must never wall the field into a stalemate. We score candidate seeds on a
// COARSE sample (every COARSE_STEP fine cells) — cheap enough to try many — and take the first that is
// open: bases connected, the base→base path no more than MAX_DETOUR× the straight line (so no long
// mountain range/lake forces a huge march), and at least MIN_PASSABLE of the field traversable.
const COARSE_STEP = 2 * GRID_SCALE; // sample terrain every 8 fine cells when vetting
const MAP_TRIES = 40; // candidate seeds to try before settling for the most-open one found
// These gates run on the COARSE sample, which understates thin passable necks (so it reads as more
// obstructed than the real grid). Kept deliberately loose — a coarse-acceptable map is comfortably
// open at full resolution — so vetting usually accepts an early candidate instead of scanning all 40.
const MAX_DETOUR = 1.7; // coarse base→base route at most 70% longer than the straight line
const MIN_PASSABLE = 0.45; // at least ~45% of the coarse field traversable

function coarseMobility(seed: number, bases: BaseState[]): { connected: boolean; detour: number; passFrac: number; score: number } {
  const CW = Math.ceil(GRID_W / COARSE_STEP), CH = Math.ceil(GRID_H / COARSE_STEP), N = CW * CH;
  const pass = new Uint8Array(N);
  let passN = 0;
  for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
    const p = terrainAt(Math.min(GRID_W - 1, cx * COARSE_STEP), Math.min(GRID_H - 1, cy * COARSE_STEP), seed, GRID_W, GRID_H).passable ? 1 : 0;
    pass[cy * CW + cx] = p; passN += p;
  }
  const cc = (b: BaseState) => ((b.y / COARSE_STEP) | 0) * CW + ((b.x / COARSE_STEP) | 0);
  const start = cc(bases[0]), goal = cc(bases[1]);
  const INF = 1e9, dist = new Int32Array(N).fill(INF), q = [start];
  dist[start] = 0;
  for (let head = 0; head < q.length; head++) {
    const k = q[head], cx = k % CW, cy = (k / CW) | 0, nd = dist[k] + 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
      const nk = ny * CW + nx;
      if (dist[nk] <= nd || pass[nk] === 0) continue;
      dist[nk] = nd; q.push(nk);
    }
  }
  const straight = Math.max(1, Math.max(Math.abs((start % CW) - (goal % CW)), Math.abs(((start / CW) | 0) - ((goal / CW) | 0))));
  const connected = dist[goal] < INF;
  const detour = connected ? dist[goal] / straight : Infinity;
  const passFrac = passN / N;
  const score = connected ? passFrac - 0.4 * Math.max(0, detour - 1) : -1 + passFrac * 0.01; // prefer open + direct
  return { connected, detour, passFrac, score };
}

function pickMapSeed(startSeed: number, bases: BaseState[]): number {
  let s = startSeed >>> 0, bestSeed = s, bestScore = -Infinity;
  for (let t = 0; t < MAP_TRIES; t++) {
    const m = coarseMobility(s, bases);
    if (m.connected && m.detour <= MAX_DETOUR && m.passFrac >= MIN_PASSABLE) return s; // open field — take it
    if (m.score > bestScore) { bestScore = m.score; bestSeed = s; }
    s = (Math.imul(s, 1103515245) + 12345) >>> 0; // next candidate seed (LCG)
  }
  return bestSeed; // none ideal in MAP_TRIES — use the most open one we saw
}

// Last-resort guarantee: force-open a straight vertical march lane between the bases so land units can
// always cross. Only invoked when the bases are genuinely disconnected at full resolution (very rare).
function carveCorridor(grid: Uint8Array, bases: BaseState[]): void {
  const x0 = GRID_W >> 1, HW = 2 * GRID_SCALE;
  const y0 = Math.min(bases[0].y, bases[1].y), y1 = Math.max(bases[0].y, bases[1].y);
  for (let y = y0; y <= y1; y++) for (let dx = -HW; dx <= HW; dx++) {
    const x = x0 + dx;
    if (x >= 0 && x < GRID_W) grid[y * GRID_W + x] = 1;
  }
}

/** BFS distance (in 8-dir steps) from cell (sx,sy) to every passable cell. Unreachable = INF.
 *  This is the single pathfinding primitive: globally routes around terrain/cliffs. */
function bfsFrom(g: GameState, sx: number, sy: number): Int32Array {
  const W = GRID_W, H = GRID_H, INF = 1e9;
  const dist = new Int32Array(W * H).fill(INF);
  sx = Math.max(0, Math.min(W - 1, sx)); sy = Math.max(0, Math.min(H - 1, sy));
  const q: number[] = [sy * W + sx];
  dist[sy * W + sx] = 0;
  for (let head = 0; head < q.length; head++) {
    const k = q[head], cx = k % W, cy = (k / W) | 0, nd = dist[k] + 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nk = ny * W + nx;
      if (dist[nk] <= nd || g.passGrid[nk] === 0) continue;
      dist[nk] = nd; q.push(nk);
    }
  }
  return dist;
}
const computeFlow = (g: GameState, owner: number): Int32Array => bfsFrom(g, g.bases[owner].x, g.bases[owner].y);

// On-demand flow fields toward DYNAMIC goals (rally, chased enemy, outposts). Quantized + TTL'd +
// budget-capped per tick + LRU-evicted so global pathing for moving targets stays cheap.
const FLOW_Q = 6, FLOW_TTL = 30, FLOW_CACHE_MAX = 16, FLOW_PER_TICK = 3;
let flowComputes = 0; // reset each step before the decide loop
function flowTo(g: GameState, tx: number, ty: number): Int32Array | null {
  const qx = Math.max(0, Math.min(GRID_W - 1, Math.round(tx / FLOW_Q) * FLOW_Q));
  const qy = Math.max(0, Math.min(GRID_H - 1, Math.round(ty / FLOW_Q) * FLOW_Q));
  const key = qy * GRID_W + qx;
  const c = g.dynFlow.get(key);
  if (c && g.tick - c.tick < FLOW_TTL) return c.dist;
  if (c) return c.dist; // stale but usable when over the per-tick compute budget
  if (flowComputes >= FLOW_PER_TICK) return null; // defer; caller falls back to local steering
  flowComputes++;
  const dist = bfsFrom(g, qx, qy);
  g.dynFlow.set(key, { tick: g.tick, dist });
  if (g.dynFlow.size > FLOW_CACHE_MAX) { // evict the least-recently-computed field
    let ok = -1, ot = Infinity;
    for (const [k, v] of g.dynFlow) if (v.tick < ot) { ot = v.tick; ok = k; }
    if (ok >= 0) g.dynFlow.delete(ok);
  }
  return dist;
}
// re-stamp a cached field's tick when reused so the LRU keeps hot goals
function touchFlow(g: GameState, tx: number, ty: number) {
  const qx = Math.max(0, Math.min(GRID_W - 1, Math.round(tx / FLOW_Q) * FLOW_Q));
  const qy = Math.max(0, Math.min(GRID_H - 1, Math.round(ty / FLOW_Q) * FLOW_Q));
  const c = g.dynFlow.get(qy * GRID_W + qx); if (c) c.tick = g.tick;
}

/** Step one cell down an arbitrary distance field, skipping occupied cells. Returns whether it moved. */
function stepDownField(g: GameState, u: UnitState, dist: Int32Array): boolean {
  const W = GRID_W;
  let bx = u.x, by = u.y, best = dist[u.y * W + u.x];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = u.x + dx, ny = u.y + dy;
    if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H || unitBlocked(u, nx, ny)) continue;
    const d = dist[ny * W + nx];
    if (d < best) { best = d; bx = nx; by = ny; }
  }
  if (bx !== u.x || by !== u.y) { u.dx = sign(bx - u.x); u.dy = sign(by - u.y); placeUnit(u, bx, by); return true; }
  return false;
}

/** Step one cell down the flow field toward base[owner] — globally routed around terrain. */
function stepToBase(g: GameState, u: UnitState, owner: number) {
  const W = GRID_W, dist = g.flow[owner];
  let bx = u.x, by = u.y, best = dist[u.y * W + u.x];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = u.x + dx, ny = u.y + dy;
    if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
    if (unitBlocked(u, nx, ny)) continue; // keep clear of other units (size-aware) — else queue up
    const d = dist[ny * W + nx];
    if (d < best) { best = d; bx = nx; by = ny; }
  }
  if (bx !== u.x || by !== u.y) { u.dx = sign(bx - u.x); u.dy = sign(by - u.y); placeUnit(u, bx, by); } // heading + move (else wait)
}

const OUTPOST_BONUSES: { kind: OutpostBonusKind; amount: number; label: string }[] = [
  { kind: "income", amount: 3, label: "+3 ⛃/s" },
  { kind: "income", amount: 2, label: "+2 ⛃/s" },
  { kind: "range", amount: GRID_SCALE, label: "+1 unit range" },
  { kind: "hp", amount: 5, label: "+5 unit HP" },
  { kind: "damage", amount: 2, label: "+2 attack dmg" },
];

function spawnOutpost(g: GameState) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const r = hash01(g.seed ^ 0x5a17, g.nextOutpostId * 31 + attempt);
    const r2 = hash01(g.nextOutpostId * 97 + attempt, g.seed ^ 0xa11);
    const x = Math.round(GRID_W * (0.22 + 0.56 * r)); // mid-map band, away from the bases
    const y = Math.round(GRID_H * (0.12 + 0.76 * r2));
    if (!passable(g, x, y)) continue;
    if (g.outposts.some((a) => cheb(a.x, a.y, x, y) < 14 * GRID_SCALE)) continue; // spread them out
    const bonus = OUTPOST_BONUSES[Math.floor(hash01(g.nextOutpostId * 7, g.seed) * OUTPOST_BONUSES.length)];
    g.outposts.push({ id: g.nextOutpostId++, x, y, owner: -1, hp: OUTPOST_HP, maxHp: OUTPOST_HP, bonus, capProgress: 0, capOwner: -1 });
    return;
  }
}

/** Spawn a unit (camp = doctrine) near base, or place a building (camp = null) at `pos`. */
export function spawnUnit(g: GameState, owner: number, camp: DoctrineId | null, type: UnitType = "gunner", pos?: { x: number; y: number }): void {
  const base = g.bases[owner];
  const jitter = g.units.length;
  const mods = playerMods(g, owner);
  const hp = Math.round((UNIT_STATS[type].maxHp + playerBonus(g, owner).hp) * (type === "turret" ? mods.turretHpMult : mods.hpMult));
  g.units.push({
    id: g.nextUnitId++,
    owner,
    camp,
    unit: type,
    dx: 0,
    dy: owner === 0 ? -1 : 1, // start facing the enemy (player 0 marches −gy = up/right on screen)
    x: pos ? pos.x : Math.max(0, Math.min(GRID_W - 1, base.x + (-2 + (jitter % 5)) * GRID_SCALE)), // lateral spread
    y: pos ? pos.y : Math.max(0, Math.min(GRID_H - 1, base.y + (owner === 0 ? -1 : 1) * (1 + (jitter % 3)) * GRID_SCALE)), // step out toward the field
    hp,
    maxHp: hp,
    overrideUntil: 0,
    overrideLabel: "",
  });
}

/** Effective spec for a unit this tick: an active field-override wins over native
 *  doctrine; otherwise the unit runs its camp's compiled doctrine. */
function effectiveSpec(g: GameState, u: UnitState): BehaviorSpec {
  const fo = g.players[u.owner]?.fieldOrder; // active field tactic overrides native doctrine (until cancelled)
  if (fo && (fo.target === "all" || u.camp === fo.target)) return fo.ovr;
  if (!u.camp) return PRESET_SPECS.defensive; // building fallback (buildings never reach here)
  const camp = g.players[u.owner]?.camps.find((c) => c.id === u.camp);
  return camp ? camp.spec : PRESET_SPECS[u.camp];
}

type Target = { x: number; y: number; owner: number; ref: { hp: number }; unit?: UnitState };
function nearestEnemy(g: GameState, u: UnitState): Target | null {
  let best: Target | null = null;
  let bestD = Infinity;
  const consider = (x: number, y: number, owner: number, ref: { hp: number }, unit?: UnitState) => {
    const d = cheb(u.x, u.y, x, y);
    if (d < bestD) { bestD = d; best = { x, y, owner, ref, unit }; }
  };
  for (const e of g.units) if (e.owner !== u.owner && e.hp > 0) consider(e.x, e.y, e.owner, e, e);
  for (const b of g.bases) if (b.owner !== u.owner && b.hp > 0) consider(b.x, b.y, b.owner, b);
  for (const a of g.outposts) if (a.owner >= 0 && a.owner !== u.owner && a.hp > 0) consider(a.x, a.y, a.owner, a); // siege enemy outposts
  return best;
}

const passable = (g: GameState, x: number, y: number) => x >= 0 && y >= 0 && x < GRID_W && y < GRID_H && g.passGrid[y * GRID_W + x] === 1;

// Occupancy: each unit has SIZE — a footprint radius (in fine cells). Two units must stay at least
// (footprint_a + footprint_b) cells apart, so bigger units carve out more room and everyone spreads
// out instead of stacking. `occ` maps each unit's cell → the unit (rebuilt each step, updated
// incrementally as units move so later movers see it).
const FOOTPRINT: Record<string, number> = { gunner: 1, humvee: 2, tank: 2, turret: 2, drone: 0 };
const MAX_FOOT = 2; // largest FOOTPRINT — scan radius bound
const cellKey = (x: number, y: number) => y * GRID_W + x;
let occ: Map<number, UnitState> | null = null;
// would (x,y) put u within (its footprint + the other's footprint) of any OTHER unit? (excludes self)
function unitBlocked(u: UnitState, x: number, y: number): boolean {
  if (!occ) return false;
  const Ru = FOOTPRINT[u.unit] ?? 1, reach = Ru + MAX_FOOT;
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
    const other = occ.get(cellKey(x + dx, y + dy));
    if (!other || other === u) continue;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < Ru + (FOOTPRINT[other.unit] ?? 1)) return true;
  }
  return false;
}
function placeUnit(u: UnitState, nx: number, ny: number) {
  if (occ) { occ.delete(cellKey(u.x, u.y)); occ.set(cellKey(nx, ny), u); }
  u.x = nx; u.y = ny;
}

const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
const flying = (u: UnitState) => !!UNIT_STATS[u.unit].flying;
// Flying units (drones) ignore terrain AND ground occupancy — they're in the air.
const canEnter = (g: GameState, u: UnitState, x: number, y: number) =>
  inBounds(x, y) && (flying(u) || (passable(g, x, y) && !unitBlocked(u, x, y)));
const moveUnit = (u: UnitState, x: number, y: number) => { if (flying(u)) { u.x = x; u.y = y; } else placeUnit(u, x, y); };

const tryStep = (g: GameState, u: UnitState, dx: number, dy: number) => {
  if (dx === 0 && dy === 0) return false;
  const nx = u.x + dx, ny = u.y + dy;
  if (!canEnter(g, u, nx, ny)) return false; // blocked by terrain/unit (ground units only)
  u.dx = dx; u.dy = dy; moveUnit(u, nx, ny); return true; // record heading + occupancy
};

// Local stepper for DYNAMIC targets (chasing a unit, sieging an outpost): pick the passable
// neighbor that gets closest to the target; if none improves, slide laterally to skirt walls.
function moveToward(g: GameState, u: UnitState, tx: number, ty: number) {
  const cur = cheb(u.x, u.y, tx, ty);
  let bx = u.x, by = u.y, best = cur;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = u.x + dx, ny = u.y + dy;
    if (!canEnter(g, u, nx, ny)) continue;
    const d = cheb(nx, ny, tx, ty);
    if (d < best) { best = d; bx = nx; by = ny; }
  }
  if (bx !== u.x || by !== u.y) { u.dx = sign(bx - u.x); u.dy = sign(by - u.y); moveUnit(u, bx, by); return; }
  // local minimum — slide along the obstacle (any passable neighbor that doesn't retreat)
  for (const [cx, cy] of [[sign(tx - u.x), 0], [0, sign(ty - u.y)], [sign(tx - u.x), -sign(ty - u.y) || 1], [-sign(tx - u.x) || 1, sign(ty - u.y)]] as [number, number][])
    if (cheb(u.x + cx, u.y + cy, tx, ty) <= cur && tryStep(g, u, cx, cy)) return;
}

// Sophisticated path to a DYNAMIC target: a global flow field (BFS from the goal) routes around
// terrain/cliffs at range, with the local greedy stepper handling the final approach + occupancy.
function navigate(g: GameState, u: UnitState, tx: number, ty: number) {
  if (cheb(u.x, u.y, tx, ty) > 2 * GRID_SCALE) {
    const field = flowTo(g, tx, ty);
    if (field && field[u.y * GRID_W + u.x] < 1e9) { touchFlow(g, tx, ty); if (stepDownField(g, u, field)) return; }
  }
  moveToward(g, u, tx, ty); // close range, off-field, or field stalled → local steering
}

function wander(g: GameState, u: UnitState) {
  // meander in ANY direction (incl. back toward base), only onto passable ground
  const dx = Math.round(hash01(u.id, g.tick >> 1) * 2) - 1; // -1 | 0 | 1
  const dy = Math.round(hash01(u.id + 7, g.tick >> 1) * 2) - 1;
  tryStep(g, u, dx, dy);
}

// Recon exploration: move AWAY from our own vision sources (units + base) toward the fog,
// so scouts fan out and uncover unseen map instead of milling around covered ground.
function explore(g: GameState, u: UnitState) {
  let rx = 0, ry = 0;
  const push = (sx: number, sy: number, w: number) => {
    const dx = u.x - sx, dy = u.y - sy, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.5) { rx += 1; return; } // coincident -> arbitrary nudge
    if (d > 32 * GRID_SCALE) return; // only nearby coverage repels
    rx += (dx / d) * (w / d); ry += (dy / d) * (w / d); // closer/already-covered = stronger push outward
  };
  const base = g.bases[u.owner];
  push(base.x, base.y, 6); // leave home
  for (const f of g.units) if (f.owner === u.owner && f.id !== u.id) push(f.x, f.y, 1.6);
  if (Math.abs(rx) < 0.05 && Math.abs(ry) < 0.05) { wander(g, u); return; } // already isolated -> meander
  if (tryStep(g, u, sign(rx), sign(ry))) return;
  if (tryStep(g, u, sign(rx), 0)) return;
  if (tryStep(g, u, 0, sign(ry))) return;
  wander(g, u);
}

// Local center of mass of nearby friendly COMBATANTS (armed, mobile — no turrets/drones), used
// for pack cohesion. Returns null if the unit is alone. O(armed²) but armed counts are modest.
function packCenter(g: GameState, u: UnitState, R: number): { x: number; y: number } | null {
  let sx = 0, sy = 0, n = 0;
  for (const f of g.units) {
    if (f.owner !== u.owner || f.id === u.id) continue;
    const s = UNIT_STATS[f.unit];
    if (s.building || s.dmg <= 0) continue; // armed mobile only
    if (cheb(u.x, u.y, f.x, f.y) > R) continue;
    sx += f.x; sy += f.y; n++;
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

function decide(g: GameState, u: UnitState) {
  const stats = UNIT_STATS[u.unit];
  const period = (n: number) => Math.max(1, Math.round(n * SPEED_MULT));
  const mods = playerMods(g, u.owner);
  const bonus = playerBonus(g, u.owner);
  // FRACTIONAL speed: accumulate cells/tick (no integer-period rounding, so the per-type ratio is
  // exact — a tank with moveEvery 2× a gunner's moves at exactly half a gunner's speed, always).
  //   cells/tick = (GRID_SCALE / moveEvery) × Engines-speedup ÷ (global × doctrine × morale slowdowns)
  const slow = SPEED_MULT * mods.speedMult * moraleSpeedFactor(g.players[u.owner].morale);
  const cellsPerTick = stats.stationary ? 0 : (GRID_SCALE / stats.moveEvery) * (1 + bonus.speed * 0.1) / slow;
  const acc = ((u as any)._acc || 0) + cellsPerTick;
  const stepBoost = Math.floor(acc); // whole cells to advance this tick (0,1,2…)
  (u as any)._acc = acc - stepBoost; // carry the fraction
  const canMove = stepBoost > 0;
  const canAttack = (g.tick + u.id) % period(stats.attackEvery) === 0;
  if (!canMove && !canAttack) return; // between actions this tick — do nothing

  const range = stats.range + bonus.range + hgBonus(g, u.x, u.y); // outpost range + HIGH-GROUND reach
  const isScout = stats.dmg <= 0; // drones: never engage, just scout
  const atk = (t: Target) => { if (canAttack) attack(g, u, t); };

  // 0) stationary buildings (turrets): no doctrine — just fire on the nearest enemy in range
  if (stats.stationary) {
    const e = nearestEnemy(g, u);
    if (e) { u.dx = sign(e.x - u.x); u.dy = sign(e.y - u.y); if (cheb(u.x, u.y, e.x, e.y) <= range) atk(e); } // aim at target
    return;
  }

  const spec = effectiveSpec(g, u);
  const myBase = g.bases[u.owner];
  // each move action advances `stepBoost` fine cells (see above) so fast units keep their speed.
  // ground units use global flow-field pathing (routes around cliffs); flying units (drones) ignore
  // terrain entirely and steer straight to the target.
  const fly = !!stats.flying;
  const mv = (tx: number, ty: number) => { if (canMove) for (let i = 0; i < stepBoost; i++) (fly ? moveToward(g, u, tx, ty) : navigate(g, u, tx, ty)); };
  const toBase = (owner: number) => { if (canMove) for (let i = 0; i < stepBoost; i++) (fly ? moveToward(g, u, g.bases[owner].x, g.bases[owner].y) : stepToBase(g, u, owner)); };
  const roam = () => { if (canMove) for (let i = 0; i < stepBoost; i++) explore(g, u); };

  // Builder doctrine: roam to the nearest neutral outpost and claim it (engineers, not fighters)
  if (u.camp === "builder") {
    // engineers, not pacifists: if an enemy is contesting LOCALLY (e.g. another builder fighting over
    // the same outpost, or a threat closing in), break off and ENGAGE it — close to range and fire —
    // instead of passively channeling across the outpost from an enemy. Clear it, then resume capturing.
    const foe = nearestEnemy(g, u);
    const foeDist = foe ? cheb(u.x, u.y, foe.x, foe.y) : Infinity;
    if (!isScout && foe && foeDist <= 12 * GRID_SCALE) {
      if (foeDist <= range) atk(foe); else mv(foe.x, foe.y);
      return;
    }
    let target: Outpost | null = null, td = Infinity;
    for (const a of g.outposts) if (a.owner < 0) { const d = cheb(u.x, u.y, a.x, a.y); if (d < td) { td = d; target = a; } }
    if (!target) { roam(); return; } // none known → scout for more
    if (td > 2 * GRID_SCALE) mv(target.x, target.y); // else: hold and channel — the capture pass in step() advances progress
    return;
  }

  // 1) retreat if wounded past threshold
  if (u.hp / u.maxHp < spec.retreatHealthPct) {
    if (cheb(u.x, u.y, myBase.x, myBase.y) > GRID_SCALE) toBase(u.owner);
    return;
  }

  const enemy = nearestEnemy(g, u);
  const enemyDist = enemy ? cheb(u.x, u.y, enemy.x, enemy.y) : Infinity;

  // 2) leashed defenders: only engage intruders near base, else return to guard ring
  if (!isScout && spec.defendRadius != null) {
    const leash = spec.defendRadius * GRID_SCALE; // spec radii are in coarse cells → scale to fine cells
    const intruder = enemy && cheb(enemy.x, enemy.y, myBase.x, myBase.y) <= leash;
    if (intruder) {
      if (enemyDist <= range) atk(enemy!);
      else mv(enemy!.x, enemy!.y);
    } else {
      // no intruder: hold a forward GUARD RING in front of the base (toward the enemy), not on top of
      // it. Each defender takes a slightly different angle across the frontal arc → a spread picket
      // line. Falls back to walking out there; the occupancy spacing keeps them from stacking.
      const foe = g.bases.find((b) => b.owner !== u.owner);
      const guardR = Math.max(4 * GRID_SCALE, Math.round(leash * 0.62)); // hold a wide perimeter, not hugging the base
      const ang = (foe ? Math.atan2(foe.y - myBase.y, foe.x - myBase.x) : 0) + (hash01(u.id, 7) - 0.5) * 1.5;
      const gx = Math.max(0, Math.min(GRID_W - 1, Math.round(myBase.x + Math.cos(ang) * guardR)));
      const gy = Math.max(0, Math.min(GRID_H - 1, Math.round(myBase.y + Math.sin(ang) * guardR)));
      if (cheb(u.x, u.y, gx, gy) > GRID_SCALE) mv(gx, gy); // march out to / hold the picket
    }
    return;
  }

  // 3) engage if an enemy is in range + within engageRange and we're aggressive enough (armed units only)
  const willEngage = !isScout && enemy && enemyDist <= range * VISION_MULT && enemyDist <= spec.engageRange * GRID_SCALE && hash01(u.id, g.tick) < 0.5 + spec.aggression / 2;
  if (willEngage) {
    if (enemyDist <= range) atk(enemy!);
    else mv(enemy!.x, enemy!.y);
    return;
  }

  // 3b) SUPPORT A NEARBY ALLY UNDER ATTACK: if a close ally is currently in a fight, rush to group up
  // with it and join the engagement. Deliberately short-ranged (SUPPORT_RADIUS) so it's local mutual
  // support, not a map-wide swarm. Armed units only; scouts keep scouting.
  if (!isScout && canMove) {
    let ally: UnitState | null = null, ad = SUPPORT_RADIUS + 1;
    for (const a of g.units) {
      if (a === u || a.owner !== u.owner || a.hp <= 0) continue;
      const last = underAttack.get(a.id);
      if (last === undefined || g.tick - last > SUPPORT_MEMORY) continue; // not currently in a fight
      const d = cheb(u.x, u.y, a.x, a.y);
      if (d <= SUPPORT_RADIUS && d < ad) { ad = d; ally = a; }
    }
    if (ally) {
      // close in: shoot the attacker if it's already in reach, else move onto the embattled ally
      if (enemy && enemyDist <= SUPPORT_RADIUS) { if (enemyDist <= range) atk(enemy!); else mv(enemy!.x, enemy!.y); }
      else mv(ally.x, ally.y);
      return;
    }
  }

  // 4) no engagement: drift by doctrine.
  //    forwardChance high for attack, ~0 for recon; wanderChance high for recon (roams, incl back);
  //    leftover probability = hold position (conservative). Defensive units are usually leashed above.
  const enemyBase = g.bases.find((b) => b.owner !== u.owner)!;
  // coarse time bucket: the drift decision persists ~8 ticks instead of re-rolling every tick, so
  // units commit to a behavior rather than flickering advance/hold/wander (the "disoriented" look).
  const roll = hash01(u.id, g.tick >> 3);
  const wanderChance = spec.explorationBias;
  const forwardChance = spec.aggression * (1 - spec.explorationBias);
  // an active RALLY point (player commitment, #5) redirects advancing units to concentrate there
  // until they arrive / it expires — then they resume pushing the enemy base.
  const rally = g.players[u.owner].rally;
  const rallyActive = rally && rally.until > g.tick && cheb(u.x, u.y, rally.x, rally.y) > 3 * GRID_SCALE;
  if (roll < wanderChance) {
    roam(); // recon: head toward the fog, away from already-seen ground
  } else if (roll < wanderChance + forwardChance) {
    if (rallyActive) { mv(rally!.x, rally!.y); return; } // converge on the rally/commitment point
    // PACK COHESION: if we've fallen behind the local group (farther from the enemy than the pack
    // center) and drifted loose from it, close back up; otherwise lead the advance with the pack.
    const pc = packCenter(g, u, PACK_RADIUS);
    const behind = pc && cheb(u.x, u.y, enemyBase.x, enemyBase.y) > cheb(pc.x, pc.y, enemyBase.x, enemyBase.y);
    if (pc && behind && cheb(u.x, u.y, pc.x, pc.y) > PACK_KEEP) mv(pc.x, pc.y); // straggler rejoins
    else toBase(enemyBase.owner); // advance on the enemy base (flow-field routed around terrain)
  } // else: hold position
}

function attack(g: GameState, u: UnitState, target: Target) {
  const stats = UNIT_STATS[u.unit];
  if (stats.dmg <= 0) return; // unarmed (drones)
  const mods = playerMods(g, u.owner);
  // ACCURACY: base per-type hit chance, falling off with distance (point-blank reliable, the far
  // edge of range chancy). A little high-ground steadiness bonus rewards the heights.
  const dist = cheb(u.x, u.y, target.x, target.y);
  const range = Math.max(1, stats.range + playerBonus(g, u.owner).range + hgBonus(g, u.x, u.y)); // high-ground reach
  const falloff = 1 - 0.45 * Math.min(1, dist / range); // 1.0 → ~0.55 across the range band
  const highSteady = 1 + 0.12 * (groundHeight(g, u.x, u.y) - groundHeight(g, target.x, target.y));
  const hitChance = Math.max(0.1, Math.min(0.98, stats.accuracy * falloff * highSteady * moraleAccFactor(g.players[u.owner].morale)));
  const hit = hash01(u.id + 91, g.tick) < hitChance; // decorrelated from movement/engage rolls
  if (target.unit) underAttack.set(target.unit.id, g.tick); // beacon: this ally is in a fight (hit or not)
  if (hit) {
    const dmg = (stats.dmg + playerBonus(g, u.owner).damage) * (stats.building ? mods.turretDmgMult : mods.dmgMult); // outpost/investment + doctrine
    // high-ground rule: scale damage by elevation delta, clamped; Highland doctrine amplifies it.
    const dh = (groundHeight(g, u.x, u.y) - groundHeight(g, target.x, target.y)) * mods.highGroundMult;
    const mult = Math.max(HIGH_GROUND_MIN, Math.min(HIGH_GROUND_MAX, 1 + dh * HIGH_GROUND_GAIN));
    const armor = target.owner >= 0 ? playerBonus(g, target.owner).armor : 0; // defender's Armor upgrade
    target.ref.hp -= Math.max(1, dmg * mult - armor); // armor reduces damage taken, never below 1
  }
  if (g.shots.length < 240) g.shots.push({ ax: u.x, ay: u.y, bx: target.x, by: target.y, hit, kind: u.unit, owner: u.owner }); // cosmetic, capped
}

export function step(g: GameState) {
  g.tick++;
  // mirror each player's ACTIVE field tactic onto its units (for the client's override ring/label).
  // Persists while fieldOrder is set — incl. units trained later; clears the instant it's cancelled.
  for (const u of g.units) {
    if (UNIT_STATS[u.unit].building) continue;
    const fo = g.players[u.owner]?.fieldOrder;
    if (fo && (fo.target === "all" || u.camp === fo.target)) { u.overrideUntil = g.tick + 2; u.overrideLabel = fo.label; }
    else if (u.overrideUntil) { u.overrideUntil = 0; u.overrideLabel = ""; }
  }
  g.players.forEach((p, i) => (p.resources += INCOME_PER_TICK * playerMods(g, i).incomeMult + playerBonus(g, i).income / TICK_HZ)); // income (doctrine-scaled) + outpost bonus
  if (g.tick % OUTPOST_EVERY === 0 && g.outposts.length < OUTPOST_CAP) spawnOutpost(g);
  // SANDSTORM — stalemate-breaker. Once the field is choked with units (both armies summed), a storm
  // rolls in and scours EVERY unit away over ~SANDSTORM_SECS; production halts until skies clear, then
  // both sides rebuild from nothing. Each unit bleeds a fixed fraction of its OWN max hp per tick, so
  // big and small alike are gone by ~85% through (the rest is empty howling wind). Bases are untouched.
  if (!g.sandstorm && g.tick >= g.sandstormCooldownUntil && g.units.length >= SANDSTORM_TRIGGER) {
    g.sandstorm = { from: g.tick, until: g.tick + SANDSTORM_TICKS };
  }
  if (g.sandstorm) {
    for (const u of g.units) u.hp -= u.maxHp / SANDSTORM_KILL_TICKS;
    if (g.tick >= g.sandstorm.until) { g.sandstorm = null; g.sandstormCooldownUntil = g.tick + SANDSTORM_COOLDOWN_TICKS; }
  }
  // continuous production: each camp trains its unit at its rate (deterministic cadence)
  for (let pi = 0; pi < g.players.length; pi++) {
    if (g.sandstorm) break; // no reinforcements deploy into the storm
    const player = g.players[pi];
    const mods = playerMods(g, pi);
    // QUEUED UPGRADE: pause ALL other spending and bank income until we can afford it, then buy.
    const qk = player.queuedInvest;
    if (qk) {
      const inv = INVESTMENTS.find((i) => i.kind === qk);
      if (inv) {
        const cost = investCost(inv.base, player.invest[qk]);
        if (player.resources >= cost) { player.resources -= cost; player.invest[qk] += 1; player.queuedInvest = null; }
      } else player.queuedInvest = null;
      continue; // no unit training / turret building while saving for the upgrade
    }
    player.camps.forEach((camp, ci) => {
      const pct = camp.production.budgetPct;
      if (pct <= 0) return;
      const mix = camp.production.mix;
      const total = TRAINABLE.reduce((a, u) => a + (mix[u] || 0), 0);
      if (total <= 0) return;
      TRAINABLE.forEach((u, ui) => {
        const w = mix[u] || 0;
        if (w <= 0) return;
        const cost = Math.round(UNIT_STATS[u].cost * mods.costMult); // doctrine-scaled train cost
        const spendShare = (pct / 100) * (w / total); // fraction of income on this unit
        const interval = Math.max(1, Math.round(cost / (INCOME_PER_TICK * spendShare)));
        if ((g.tick + ci * 7 + ui * 13) % interval !== 0) return; // stagger camp×unit
        if (player.resources < cost) return; // bank can't cover it — skip
        player.resources -= cost;
        spawnUnit(g, pi, camp.id, u);
      });
    });
    // turret budget auto-builds a protective turret ring (savings = the unspent remainder)
    if (player.turretBudget > 0) {
      const tcost = Math.round(UNIT_STATS.turret.cost * mods.turretCostMult);
      const interval = Math.max(1, Math.round((tcost * 100) / (INCOME_PER_TICK * player.turretBudget)));
      if ((g.tick + pi * 5) % interval === 0 && player.resources >= tcost) {
        const spot = freeTurretSlot(g, pi);
        if (spot) { player.resources -= tcost; spawnUnit(g, pi, null, "turret", spot); }
      }
    }
  }
  // occupancy: units have size — mark every unit's cell, then movement avoids occupied cells so no
  // two units stack. Updated incrementally as each unit moves, so the order is consistent.
  occ = new Map<number, UnitState>();
  for (const u of g.units) if (!flying(u)) occ.set(cellKey(u.x, u.y), u); // flying units don't occupy the ground
  flowComputes = 0; // per-tick budget for new dynamic flow fields
  // morale: decay recent losses + booster, then recompute (used by decide() this tick)
  for (const p of g.players) {
    p.recentLosses *= 0.995; // ~14s half-life so a bad fight stings then fades
    p.moraleBoost = Math.max(0, p.moraleBoost - 0.35 / (30 * TICK_HZ)); // a booster lasts ~30s
  }
  g.players.forEach((p, i) => (p.morale = computeMorale(g, i)));
  // decide() self-gates movement/attack per unit type (deterministic, staggered by id).
  for (const u of g.units) decide(g, u);
  occ = null;
  // tally casualties this tick → recent losses (drags morale). The sandstorm is an act of nature, not
  // a defeat — units lost to it don't crater morale (else both armies would rebuild demoralized).
  if (!g.sandstorm) for (const u of g.units) if (u.hp <= 0 && !UNIT_STATS[u.unit].building) g.players[u.owner].recentLosses += 1;
  for (const u of g.units) if (u.hp <= 0) underAttack.delete(u.id); // drop dead units from the support beacons
  g.units = g.units.filter((u) => u.hp > 0);
  // a sieged outpost reverts to neutral (recapturable) rather than being destroyed
  for (const a of g.outposts) if (a.owner >= 0 && a.hp <= 0) { a.owner = -1; a.hp = a.maxHp; a.capProgress = 0; a.capOwner = -1; }
  // TIMED CAPTURE: a neutral outpost is claimed over CAPTURE_TICKS while exactly one player's
  // builder channels on it (and can afford the cost); progress decays when unattended/contested.
  for (const a of g.outposts) {
    if (a.owner >= 0) continue;
    let chan = -1; // -1 none, -2 contested
    for (let pi = 0; pi < g.players.length && chan !== -2; pi++) {
      if (g.players[pi].resources < CAPTURE_COST) continue;
      if (g.units.some((u) => u.owner === pi && u.camp === "builder" && cheb(u.x, u.y, a.x, a.y) <= 2 * GRID_SCALE)) chan = chan === -1 ? pi : -2;
    }
    if (chan >= 0) {
      a.capOwner = chan;
      a.capProgress = Math.min(1, a.capProgress + 1 / CAPTURE_TICKS);
      if (a.capProgress >= 1) { g.players[chan].resources -= CAPTURE_COST; a.owner = chan; a.hp = a.maxHp; a.capProgress = 0; a.capOwner = -1; }
    } else {
      a.capProgress = Math.max(0, a.capProgress - 1.5 / CAPTURE_TICKS); // decay faster than it builds
      if (a.capProgress === 0) a.capOwner = -1;
    }
  }
}

/** Next open turret-ring slot around any of a player's anchors (base + owned outposts). */
function freeTurretSlot(g: GameState, owner: number): { x: number; y: number } | null {
  const anchors = [{ x: g.bases[owner].x, y: g.bases[owner].y }, ...g.outposts.filter((a) => a.owner === owner)];
  for (const anchor of anchors) {
    for (const R of [5 * GRID_SCALE, 8 * GRID_SCALE]) {
      const n = Math.round(R * 1.4);
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + owner * 0.4;
        const x = Math.round(anchor.x + Math.cos(ang) * R);
        const y = Math.round(anchor.y + Math.sin(ang) * R);
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        if (!passable(g, x, y)) continue;
        if (g.units.some((u) => u.owner === owner && u.unit === "turret" && Math.max(Math.abs(u.x - x), Math.abs(u.y - y)) <= 2 * GRID_SCALE)) continue;
        return { x, y };
      }
    }
  }
  return null; // all rings full
}

/** Public (wire) shape of a unit. */
function pub(u: UnitState): UnitState {
  return {
    id: u.id, owner: u.owner, camp: u.camp, unit: u.unit, dx: u.dx, dy: u.dy, x: u.x, y: u.y,
    hp: u.hp, maxHp: u.maxHp, overrideUntil: u.overrideUntil, overrideLabel: u.overrideLabel,
  };
}

/** Fog of war: what `player` can see. Own units/base always; enemy units/base only when
 *  within VISION of one of the player's units or base — so scouting (recon doctrine) pays off. */
/** A player's vision sources for this snapshot: base + each unit, with HIGH-GROUND-boosted radius.
 *  Computed once and reused (heightAt per own unit, not per candidate cell). */
function visionSources(g: GameState, player: number): { x: number; y: number; r: number }[] {
  const vm = playerMods(g, player).visionMult, vr = playerBonus(g, player).range;
  const out: { x: number; y: number; r: number }[] = [];
  const b = g.bases[player];
  if (b) out.push({ x: b.x, y: b.y, r: BASE_VISION * vm });
  for (const u of g.units) if (u.owner === player) {
    const r = Math.min(VISION_CAP, (UNIT_STATS[u.unit].range + vr + hgBonus(g, u.x, u.y)) * VISION_MULT) * vm; // high ground sees far
    out.push({ x: u.x, y: u.y, r });
  }
  return out;
}

export function computeVisibleState(g: GameState, player: number): { units: UnitState[]; bases: BaseState[]; outposts: Outpost[] } {
  const src = visionSources(g, player);
  const visible = (x: number, y: number) => src.some((s) => cheb(s.x, s.y, x, y) <= s.r);
  return {
    units: g.units.filter((u) => u.owner === player || visible(u.x, u.y)).map(pub),
    bases: g.bases.filter((b) => b.owner === player || visible(b.x, b.y)),
    outposts: g.outposts.filter((a) => a.owner === player || visible(a.x, a.y)), // neutral/enemy outposts fog-gated
  };
}

/** Shots `player` should see this broadcast: their own fire, or fire near their vision. */
export function visibleShots(g: GameState, player: number): Shot[] {
  const src = visionSources(g, player);
  const see = (x: number, y: number) => src.some((s) => cheb(s.x, s.y, x, y) <= s.r);
  return g.shots.filter((s) => s.owner === player || see(s.ax, s.ay) || see(s.bx, s.by));
}

/** Apply a field-general order as a time-boxed override on the targeted units. */
// Set the player's ACTIVE field tactic — it overrides doctrine for every matching unit (incl. units
// trained later) and PERSISTS until the player cancels it (clearFieldOrder). `rally`/`hold` map to
// the defensive override; `push` to the all-out attack override.
export function applyFieldOrder(g: GameState, owner: number, kind: "rally" | "defend" | "push", target: DoctrineId | "all", _durationTicks: number, label: string) {
  const k: "defend" | "push" = kind === "push" ? "push" : "defend";
  const ovr: BehaviorSpec =
    k === "push"
      ? clampSpec({ aggression: 1, engageRange: 30, retreatHealthPct: 0, explorationBias: 0, defendRadius: null })
      : clampSpec({ aggression: 0.4, engageRange: 8, retreatHealthPct: 0.1, explorationBias: 0, defendRadius: 13 });
  g.players[owner].fieldOrder = { kind: k, target, label, ovr };
}
export function clearFieldOrder(g: GameState, owner: number) { g.players[owner].fieldOrder = null; }
