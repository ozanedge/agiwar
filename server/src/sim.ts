// Deterministic, server-authoritative fixed-tick simulation.
// No Math.random / Date.now inside the tick: all "randomness" is a pure hash of
// (unitId, tick) so a match is fully reproducible and replayable.
import type { Artifact, ArtifactBonusKind, BehaviorSpec, BaseState, Camp, DoctrineId, FieldGeneral, UnitState } from "../../shared/types.js";
import { PRESET_PROMPTS, PRESET_SPECS, clampSpec } from "../../shared/spec.js";
import { UNIT_STATS, UnitType, TRAINABLE, VISION_MULT, VISION_CAP, BASE_VISION, INVESTMENTS, GRID_SCALE } from "../../shared/units.js";
import { isPassable, terrainAt } from "../../shared/terrain.js";
import { modsFor, type ArmyMods } from "../../shared/doctrine.js";

const ARTIFACT_CAP = Number(process.env.ARTIFACT_CAP ?? 9);
const ARTIFACT_EVERY = Number(process.env.ARTIFACT_EVERY ?? 150); // ticks between spawns (~15s)
const ARTIFACT_HP = 120;
export type Bonus = { income: number; range: number; hp: number; damage: number };

// Pacing knobs (env-tunable so we can dial feel without code edits).
// 16× cell density (4× per axis) on the same physical map: smoother terrain + movement.
// (was 200×130; ×GRID_SCALE per axis.)
export const GRID_W = Number(process.env.GRID_W ?? 200 * GRID_SCALE); // 800
export const GRID_H = Number(process.env.GRID_H ?? 130 * GRID_SCALE); // 520
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
  builder: { budgetPct: 10, mix: { humvee: 100 } }, // Builder budget — units hunt artifacts
};
const DEFAULT_TURRET_BUDGET = 10; // 30+10+15+10 camps + 10 turret = 75 → 25% savings
const CAPTURE_COST = Number(process.env.CAPTURE_COST ?? 180); // builder auto-claim draws this from the bank
// Movement/attack cadence and HP/damage are now PER UNIT TYPE (see shared/units.ts):
// gunner = balanced, tank = strong+slow, humvee = fast+weak. A global SPEED_MULT scales
// all cadences if we want to slow/speed everything uniformly without touching per-type feel.
const SPEED_MULT = Number(process.env.SPEED_MULT ?? 1);
// High-ground edge: damage is scaled by the attacker's terrain height minus the target's.
// Firing downhill hits harder, uphill softer — clamped so it's an edge, never a one-shot.
const HIGH_GROUND_GAIN = Number(process.env.HIGH_GROUND_GAIN ?? 1.8);
const HIGH_GROUND_MIN = 0.6, HIGH_GROUND_MAX = 1.6;
const groundHeight = (g: GameState, x: number, y: number) => terrainAt(x, y, g.seed, GRID_W, GRID_H).height;

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
}

/** This player's army-wide modifiers, derived from their chosen doctrine. */
export const playerMods = (g: GameState, owner: number): ArmyMods => modsFor(g.players[owner]?.armyDoctrine);

export interface GameState {
  tick: number;
  seed: number; // map seed (cosmetic terrain); fixed per match
  units: UnitState[];
  bases: BaseState[];
  artifacts: Artifact[];
  players: PlayerState[]; // index = player/owner
  flow: Int32Array[]; // BFS distance-to-base field per base, for obstacle-routed movement
  nextUnitId: number;
  nextArtifactId: number;
}

/** Sum of bonuses from artifacts a player currently controls. */
export function playerBonus(g: GameState, player: number): Bonus {
  const b: Bonus = { income: 0, range: 0, hp: 0, damage: 0 };
  for (const a of g.artifacts) if (a.owner === player) b[a.bonus.kind] += a.bonus.amount;
  const inv = g.players[player].invest; // permanent investments stack with artifacts
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
    invest: { income: 0, range: 0, hp: 0, damage: 0 },
    turretBudget: DEFAULT_TURRET_BUDGET,
    advisor: { label: "Advisor Holt", prompt: DEFAULT_ADVISOR_PROMPT },
    armyDoctrine: "balanced", // neutral until the player chooses
    rally: null,
  };
}

export const DEFAULT_ADVISOR_PROMPT =
  "Run a balanced war economy. Fund attack and defense steadily, keep some income flowing to the " +
  "builder so we grab artifacts, and bank a little savings. Invest gradually in munitions and plating. " +
  "If our base comes under pressure, shift toward defense and turrets.";

export function newGame(seed = 1): GameState {
  const bases: BaseState[] = [
    // owner 0 = SW wall (bottom-left), owner 1 = NE wall (top-right) — MUST match baseSpots()
    { owner: 0, x: GRID_W >> 1, y: GRID_H - 5 * GRID_SCALE, hp: BASE_HP, maxHp: BASE_HP },
    { owner: 1, x: GRID_W >> 1, y: 5 * GRID_SCALE, hp: BASE_HP, maxHp: BASE_HP },
  ];
  const g: GameState = { tick: 0, seed: seed >>> 0, units: [], bases, artifacts: [], players: [makePlayer(), makePlayer()], flow: [], nextUnitId: 1, nextArtifactId: 1 };
  g.flow = [computeFlow(g, 0), computeFlow(g, 1)]; // route-around-terrain fields, once per match
  return g;
}

/** BFS distance (in 8-dir steps) from base[owner] to every passable cell. Unreachable = INF. */
function computeFlow(g: GameState, owner: number): Int32Array {
  const W = GRID_W, H = GRID_H, INF = 1e9;
  const dist = new Int32Array(W * H).fill(INF);
  const b = g.bases[owner];
  const q: number[] = [b.y * W + b.x];
  dist[b.y * W + b.x] = 0;
  for (let head = 0; head < q.length; head++) {
    const k = q[head], cx = k % W, cy = (k / W) | 0, nd = dist[k] + 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nk = ny * W + nx;
      if (dist[nk] <= nd || !isPassable(nx, ny, g.seed, W, H)) continue;
      dist[nk] = nd; q.push(nk);
    }
  }
  return dist;
}

/** Step one cell down the flow field toward base[owner] — globally routed around terrain. */
function stepToBase(g: GameState, u: UnitState, owner: number) {
  const W = GRID_W, dist = g.flow[owner];
  let bx = u.x, by = u.y, best = dist[u.y * W + u.x];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = u.x + dx, ny = u.y + dy;
    if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
    const d = dist[ny * W + nx];
    if (d < best) { best = d; bx = nx; by = ny; }
  }
  if (bx !== u.x || by !== u.y) { u.dx = sign(bx - u.x); u.dy = sign(by - u.y); } // heading
  u.x = bx; u.y = by;
}

const ARTIFACT_BONUSES: { kind: ArtifactBonusKind; amount: number; label: string }[] = [
  { kind: "income", amount: 3, label: "+3 ⛃/s" },
  { kind: "income", amount: 2, label: "+2 ⛃/s" },
  { kind: "range", amount: GRID_SCALE, label: "+1 unit range" },
  { kind: "hp", amount: 5, label: "+5 unit HP" },
  { kind: "damage", amount: 2, label: "+2 attack dmg" },
];

function spawnArtifact(g: GameState) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const r = hash01(g.seed ^ 0x5a17, g.nextArtifactId * 31 + attempt);
    const r2 = hash01(g.nextArtifactId * 97 + attempt, g.seed ^ 0xa11);
    const x = Math.round(GRID_W * (0.22 + 0.56 * r)); // mid-map band, away from the bases
    const y = Math.round(GRID_H * (0.12 + 0.76 * r2));
    if (!isPassable(x, y, g.seed, GRID_W, GRID_H)) continue;
    if (g.artifacts.some((a) => cheb(a.x, a.y, x, y) < 14 * GRID_SCALE)) continue; // spread them out
    const bonus = ARTIFACT_BONUSES[Math.floor(hash01(g.nextArtifactId * 7, g.seed) * ARTIFACT_BONUSES.length)];
    g.artifacts.push({ id: g.nextArtifactId++, x, y, owner: -1, hp: ARTIFACT_HP, maxHp: ARTIFACT_HP, bonus });
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
  if (u.overrideUntil > g.tick && (u as any)._ovr) return (u as any)._ovr as BehaviorSpec;
  if (!u.camp) return PRESET_SPECS.defensive; // building fallback (buildings never reach here)
  const camp = g.players[u.owner]?.camps.find((c) => c.id === u.camp);
  return camp ? camp.spec : PRESET_SPECS[u.camp];
}

type Target = { x: number; y: number; ref: { hp: number } };
function nearestEnemy(g: GameState, u: UnitState): Target | null {
  let best: Target | null = null;
  let bestD = Infinity;
  const consider = (x: number, y: number, ref: { hp: number }) => {
    const d = cheb(u.x, u.y, x, y);
    if (d < bestD) { bestD = d; best = { x, y, ref }; }
  };
  for (const e of g.units) if (e.owner !== u.owner && e.hp > 0) consider(e.x, e.y, e);
  for (const b of g.bases) if (b.owner !== u.owner && b.hp > 0) consider(b.x, b.y, b);
  for (const a of g.artifacts) if (a.owner >= 0 && a.owner !== u.owner && a.hp > 0) consider(a.x, a.y, a); // siege enemy artifacts
  return best;
}

const passable = (g: GameState, x: number, y: number) => isPassable(x, y, g.seed, GRID_W, GRID_H);
const tryStep = (g: GameState, u: UnitState, dx: number, dy: number) => {
  if (dx === 0 && dy === 0) return false;
  const nx = u.x + dx, ny = u.y + dy;
  if (!passable(g, nx, ny)) return false;
  u.x = nx; u.y = ny; u.dx = dx; u.dy = dy; return true; // record heading
};

// Local stepper for DYNAMIC targets (chasing a unit, sieging an artifact): pick the passable
// neighbor that gets closest to the target; if none improves, slide laterally to skirt walls.
function moveToward(g: GameState, u: UnitState, tx: number, ty: number) {
  const cur = cheb(u.x, u.y, tx, ty);
  let bx = u.x, by = u.y, best = cur;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = u.x + dx, ny = u.y + dy;
    if (!passable(g, nx, ny)) continue;
    const d = cheb(nx, ny, tx, ty);
    if (d < best) { best = d; bx = nx; by = ny; }
  }
  if (bx !== u.x || by !== u.y) { u.x = bx; u.y = by; return; }
  // local minimum — slide along the obstacle (any passable neighbor that doesn't retreat)
  for (const [cx, cy] of [[sign(tx - u.x), 0], [0, sign(ty - u.y)], [sign(tx - u.x), -sign(ty - u.y) || 1], [-sign(tx - u.x) || 1, sign(ty - u.y)]] as [number, number][])
    if (cheb(u.x + cx, u.y + cy, tx, ty) <= cur && tryStep(g, u, cx, cy)) return;
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

function decide(g: GameState, u: UnitState) {
  const stats = UNIT_STATS[u.unit];
  const period = (n: number) => Math.max(1, Math.round(n * SPEED_MULT));
  // Movement is on the finer grid (GRID_SCALE× cells/axis). To keep PHYSICAL speed + the
  // per-type hierarchy: act ~GRID_SCALE× more often (movePeriod), and for units whose ideal
  // cadence would drop below 1 tick, take `stepBoost` fine steps per action instead. Attack
  // cadence is time-based, so it is NOT touched by the grid change.
  const mods = playerMods(g, u.owner);
  const movePeriod = Math.max(1, Math.round((stats.moveEvery / GRID_SCALE) * SPEED_MULT * mods.speedMult)); // doctrine speed
  const stepBoost = Math.max(1, Math.round(GRID_SCALE / stats.moveEvery));
  const canMove = (g.tick + u.id) % movePeriod === 0; // per-type speed
  const canAttack = (g.tick + u.id) % period(stats.attackEvery) === 0;
  if (!canMove && !canAttack) return; // between actions this tick — do nothing

  const bonus = playerBonus(g, u.owner);
  const range = stats.range + bonus.range; // artifact range bonus
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
  // each move action advances `stepBoost` fine cells (see above) so fast units keep their speed
  const mv = (tx: number, ty: number) => { if (canMove) for (let i = 0; i < stepBoost; i++) moveToward(g, u, tx, ty); };
  const toBase = (owner: number) => { if (canMove) for (let i = 0; i < stepBoost; i++) stepToBase(g, u, owner); }; // flow-field routed
  const roam = () => { if (canMove) for (let i = 0; i < stepBoost; i++) explore(g, u); };

  // Builder doctrine: roam to the nearest neutral artifact and claim it (engineers, not fighters)
  if (u.camp === "builder") {
    let target: Artifact | null = null, td = Infinity;
    for (const a of g.artifacts) if (a.owner < 0) { const d = cheb(u.x, u.y, a.x, a.y); if (d < td) { td = d; target = a; } }
    if (!target) { roam(); return; } // none known → scout for more
    if (td <= 2 * GRID_SCALE) {
      const p = g.players[u.owner];
      if (p.resources >= CAPTURE_COST) { p.resources -= CAPTURE_COST; target.owner = u.owner; target.hp = target.maxHp; } // claim
      // else: wait on it until the bank can afford the claim
    } else mv(target.x, target.y);
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
    } else if (cheb(u.x, u.y, myBase.x, myBase.y) > leash - 1) {
      toBase(u.owner);
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

  // 4) no engagement: drift by doctrine.
  //    forwardChance high for attack, ~0 for recon; wanderChance high for recon (roams, incl back);
  //    leftover probability = hold position (conservative). Defensive units are usually leashed above.
  const enemyBase = g.bases.find((b) => b.owner !== u.owner)!;
  const roll = hash01(u.id, g.tick);
  const wanderChance = spec.explorationBias;
  const forwardChance = spec.aggression * (1 - spec.explorationBias);
  // an active RALLY point (player commitment, #5) redirects advancing units to concentrate there
  // until they arrive / it expires — then they resume pushing the enemy base.
  const rally = g.players[u.owner].rally;
  const rallyActive = rally && rally.until > g.tick && cheb(u.x, u.y, rally.x, rally.y) > 3 * GRID_SCALE;
  if (roll < wanderChance) {
    roam(); // recon: head toward the fog, away from already-seen ground
  } else if (roll < wanderChance + forwardChance) {
    if (rallyActive) mv(rally!.x, rally!.y); // converge on the rally/commitment point
    else toBase(enemyBase.owner); // advance on the enemy base (flow-field routed around terrain)
  } // else: hold position
}

function attack(g: GameState, u: UnitState, target: Target) {
  const base = UNIT_STATS[u.unit].dmg;
  if (base <= 0) return; // unarmed (drones)
  const mods = playerMods(g, u.owner);
  const dmg = (base + playerBonus(g, u.owner).damage) * (UNIT_STATS[u.unit].building ? mods.turretDmgMult : mods.dmgMult); // artifact/investment + doctrine
  // high-ground rule: scale by elevation delta (attacker height − target height), clamped.
  // the Highland doctrine amplifies the swing via highGroundMult.
  const dh = (groundHeight(g, u.x, u.y) - groundHeight(g, target.x, target.y)) * mods.highGroundMult;
  const mult = Math.max(HIGH_GROUND_MIN, Math.min(HIGH_GROUND_MAX, 1 + dh * HIGH_GROUND_GAIN));
  target.ref.hp -= dmg * mult;
}

export function step(g: GameState) {
  g.tick++;
  // clear expired field-general overrides -> units revert to native doctrine
  for (const u of g.units) {
    if (u.overrideUntil && u.overrideUntil <= g.tick) {
      u.overrideUntil = 0;
      u.overrideLabel = "";
      delete (u as any)._ovr;
    }
  }
  g.players.forEach((p, i) => (p.resources += INCOME_PER_TICK * playerMods(g, i).incomeMult + playerBonus(g, i).income / TICK_HZ)); // income (doctrine-scaled) + artifact bonus
  if (g.tick % ARTIFACT_EVERY === 0 && g.artifacts.length < ARTIFACT_CAP) spawnArtifact(g);
  // continuous production: each camp trains its unit at its rate (deterministic cadence)
  for (let pi = 0; pi < g.players.length; pi++) {
    const player = g.players[pi];
    const mods = playerMods(g, pi);
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
  // decide() self-gates movement/attack per unit type (deterministic, staggered by id).
  for (const u of g.units) decide(g, u);
  g.units = g.units.filter((u) => u.hp > 0);
  // a sieged artifact reverts to neutral (recapturable) rather than being destroyed
  for (const a of g.artifacts) if (a.owner >= 0 && a.hp <= 0) { a.owner = -1; a.hp = a.maxHp; }
}

/** Next open turret-ring slot around any of a player's anchors (base + owned artifacts). */
function freeTurretSlot(g: GameState, owner: number): { x: number; y: number } | null {
  const anchors = [{ x: g.bases[owner].x, y: g.bases[owner].y }, ...g.artifacts.filter((a) => a.owner === owner)];
  for (const anchor of anchors) {
    for (const R of [5 * GRID_SCALE, 8 * GRID_SCALE]) {
      const n = Math.round(R * 1.4);
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + owner * 0.4;
        const x = Math.round(anchor.x + Math.cos(ang) * R);
        const y = Math.round(anchor.y + Math.sin(ang) * R);
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        if (!isPassable(x, y, g.seed, GRID_W, GRID_H)) continue;
        if (g.units.some((u) => u.owner === owner && u.unit === "turret" && Math.max(Math.abs(u.x - x), Math.abs(u.y - y)) <= 2 * GRID_SCALE)) continue;
        return { x, y };
      }
    }
  }
  return null; // all rings full
}

/** Public (wire) shape of a unit — drops the internal `_ovr` spec so it never leaks. */
function pub(u: UnitState): UnitState {
  return {
    id: u.id, owner: u.owner, camp: u.camp, unit: u.unit, dx: u.dx, dy: u.dy, x: u.x, y: u.y,
    hp: u.hp, maxHp: u.maxHp, overrideUntil: u.overrideUntil, overrideLabel: u.overrideLabel,
  };
}

/** Fog of war: what `player` can see. Own units/base always; enemy units/base only when
 *  within VISION of one of the player's units or base — so scouting (recon doctrine) pays off. */
export function computeVisibleState(g: GameState, player: number): { units: UnitState[]; bases: BaseState[]; artifacts: Artifact[] } {
  const own = g.units.filter((u) => u.owner === player);
  const ownBase = g.bases[player];
  const vr = playerBonus(g, player).range; // artifact range bonus widens vision too
  const vm = playerMods(g, player).visionMult; // doctrine vision (e.g. Phantom sees farther)
  const visible = (x: number, y: number) =>
    (!!ownBase && cheb(ownBase.x, ownBase.y, x, y) <= BASE_VISION * vm) ||
    own.some((u) => cheb(u.x, u.y, x, y) <= Math.min(VISION_CAP, (UNIT_STATS[u.unit].range + vr) * VISION_MULT) * vm); // wide vision, capped
  return {
    units: g.units.filter((u) => u.owner === player || visible(u.x, u.y)).map(pub),
    bases: g.bases.filter((b) => b.owner === player || visible(b.x, b.y)),
    artifacts: g.artifacts.filter((a) => a.owner === player || visible(a.x, a.y)), // neutral/enemy artifacts fog-gated
  };
}

/** Apply a field-general order as a time-boxed override on the targeted units. */
export function applyFieldOrder(g: GameState, owner: number, kind: "rally" | "defend" | "push", target: DoctrineId | "all", durationTicks: number, label: string) {
  const ovr: BehaviorSpec =
    kind === "push"
      ? clampSpec({ aggression: 1, engageRange: 30, retreatHealthPct: 0, explorationBias: 0, defendRadius: null })
      : clampSpec({ aggression: 0.4, engageRange: 8, retreatHealthPct: 0.1, explorationBias: 0, defendRadius: 5 });
  for (const u of g.units) {
    if (u.owner !== owner) continue;
    if (target !== "all" && u.camp !== target) continue;
    u.overrideUntil = g.tick + durationTicks;
    u.overrideLabel = label;
    (u as any)._ovr = ovr;
  }
}
