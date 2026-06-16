// Deterministic, server-authoritative fixed-tick simulation.
// No Math.random / Date.now inside the tick: all "randomness" is a pure hash of
// (unitId, tick) so a match is fully reproducible and replayable.
import type { BehaviorSpec, BaseState, Camp, DoctrineId, FieldGeneral, UnitState } from "../../shared/types.js";
import { PRESET_PROMPTS, PRESET_SPECS, clampSpec } from "../../shared/spec.js";
import { UNIT_STATS, UnitType } from "../../shared/units.js";
import { isPassable } from "../../shared/terrain.js";

// Pacing knobs (env-tunable so we can dial feel without code edits).
export const GRID_W = Number(process.env.GRID_W ?? 200); // large map -> long marches
export const GRID_H = Number(process.env.GRID_H ?? 130);
const BASE_HP = Number(process.env.BASE_HP ?? 400);
const SENSOR = Number(process.env.SENSOR ?? 18); // targeting range
const VISION = Number(process.env.VISION ?? 14); // fog reveal range
export const INCOME_PER_TICK = Number(process.env.INCOME_PER_TICK ?? 2); // ~20 resources/sec at 10Hz
const STARTING_RESOURCES = Number(process.env.STARTING_RESOURCES ?? 250);
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);

// default budget allocation per camp (% of income). Players tune these live.
// Sum < 100 -> the remainder banks as savings for turrets.
const DEFAULT_PROD: Record<DoctrineId, { unit: UnitType; budgetPct: number }> = {
  aggressive: { unit: "gunner", budgetPct: 40 }, // Attack budget
  recon: { unit: "humvee", budgetPct: 20 }, // Intelligence budget
  defensive: { unit: "tank", budgetPct: 25 }, // Defense budget
};
// Movement/attack cadence and HP/damage are now PER UNIT TYPE (see shared/units.ts):
// gunner = balanced, tank = strong+slow, humvee = fast+weak. A global SPEED_MULT scales
// all cadences if we want to slow/speed everything uniformly without touching per-type feel.
const SPEED_MULT = Number(process.env.SPEED_MULT ?? 1);

/** Everything that belongs to one player: their three camp generals and their field general. */
export interface PlayerState {
  camps: Camp[];
  fieldGeneral: FieldGeneral;
  resources: number;
}

export interface GameState {
  tick: number;
  seed: number; // map seed (cosmetic terrain); fixed per match
  units: UnitState[];
  bases: BaseState[];
  players: PlayerState[]; // index = player/owner
  nextUnitId: number;
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
  return { id, label, prompt: PRESET_PROMPTS[id], spec: { ...PRESET_SPECS[id] }, cooldownUntil: 0, compiling: false, production: { ...DEFAULT_PROD[id] } };
}

function makePlayer(): PlayerState {
  return {
    camps: [
      makeCamp("aggressive", "Gen. Vance · Aggressive"),
      makeCamp("recon", "Gen. Okafor · Recon"),
      makeCamp("defensive", "Gen. Reyes · Defensive"),
    ],
    fieldGeneral: { label: "Field Gen. Mercer", prompt: DEFAULT_FIELD_GENERAL_PROMPT },
    resources: STARTING_RESOURCES,
  };
}

export function newGame(seed = 1): GameState {
  const bases: BaseState[] = [
    { owner: 0, x: 4, y: GRID_H >> 1, hp: BASE_HP, maxHp: BASE_HP },
    { owner: 1, x: GRID_W - 5, y: GRID_H >> 1, hp: BASE_HP, maxHp: BASE_HP },
  ];
  return { tick: 0, seed: seed >>> 0, units: [], bases, players: [makePlayer(), makePlayer()], nextUnitId: 1 };
}

/** Spawn a unit (camp = doctrine) near base, or place a building (camp = null) at `pos`. */
export function spawnUnit(g: GameState, owner: number, camp: DoctrineId | null, type: UnitType = "gunner", pos?: { x: number; y: number }): void {
  const base = g.bases[owner];
  const jitter = g.units.length;
  const hp = UNIT_STATS[type].maxHp;
  g.units.push({
    id: g.nextUnitId++,
    owner,
    camp,
    unit: type,
    x: pos ? pos.x : base.x + (owner === 0 ? 1 : -1) * (1 + (jitter % 3)),
    y: pos ? pos.y : Math.max(0, Math.min(GRID_H - 1, base.y - 2 + (jitter % 5))),
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

function nearestEnemy(g: GameState, u: UnitState): { x: number; y: number; isBase: boolean; ref: UnitState | BaseState } | null {
  let best: { x: number; y: number; isBase: boolean; ref: UnitState | BaseState } | null = null;
  let bestD = Infinity;
  for (const e of g.units) {
    if (e.owner === u.owner || e.hp <= 0) continue;
    const d = cheb(u.x, u.y, e.x, e.y);
    if (d < bestD) { bestD = d; best = { x: e.x, y: e.y, isBase: false, ref: e }; }
  }
  for (const b of g.bases) {
    if (b.owner === u.owner || b.hp <= 0) continue;
    const d = cheb(u.x, u.y, b.x, b.y);
    if (d < bestD) { bestD = d; best = { x: b.x, y: b.y, isBase: true, ref: b }; }
  }
  return best;
}

const passable = (g: GameState, x: number, y: number) => isPassable(x, y, g.seed, GRID_W, GRID_H);
const tryStep = (g: GameState, u: UnitState, dx: number, dy: number) => {
  if (dx === 0 && dy === 0) return false;
  const nx = u.x + dx, ny = u.y + dy;
  if (!passable(g, nx, ny)) return false;
  u.x = nx; u.y = ny; return true;
};

// Move one cell toward target, avoiding water/mountains: try the direct step, then
// axis-aligned slides, then a sidestep. Stays put only if fully boxed in.
function moveToward(g: GameState, u: UnitState, tx: number, ty: number) {
  const dx = sign(tx - u.x), dy = sign(ty - u.y);
  const cands: [number, number][] = [[dx, dy], [dx, 0], [0, dy], [dx, -dy], [-dx, dy], [0, dy || 1], [0, -(dy || 1)]];
  for (const [cx, cy] of cands) if (tryStep(g, u, cx, cy)) return;
}

function wander(g: GameState, u: UnitState) {
  // deterministic outward drift (biased away from base), but only onto passable ground
  const base = g.bases[u.owner];
  const away = sign(u.x - base.x) || 1;
  const r = hash01(u.id, g.tick >> 2);
  const dx = r < 0.5 ? away : sign(Math.round(r * 4) - 2);
  const dy = sign(Math.round(hash01(u.id + 7, g.tick >> 2) * 4) - 2);
  if (!tryStep(g, u, dx, dy)) tryStep(g, u, away, 0); // fall back to pushing outward
}

function decide(g: GameState, u: UnitState) {
  const stats = UNIT_STATS[u.unit];
  const period = (n: number) => Math.max(1, Math.round(n * SPEED_MULT));
  const canMove = (g.tick + u.id) % period(stats.moveEvery) === 0; // per-type speed
  const canAttack = (g.tick + u.id) % period(stats.attackEvery) === 0;
  if (!canMove && !canAttack) return; // between actions this tick — do nothing

  const atk = (t: { isBase: boolean; ref: UnitState | BaseState }) => { if (canAttack) attack(g, u, t); };

  // 0) stationary buildings (turrets): no doctrine — just fire on the nearest enemy in range
  if (stats.stationary) {
    const e = nearestEnemy(g, u);
    if (e && cheb(u.x, u.y, e.x, e.y) <= stats.range) atk(e);
    return;
  }

  const spec = effectiveSpec(g, u);
  const myBase = g.bases[u.owner];
  const mv = (tx: number, ty: number) => { if (canMove) moveToward(g, u, tx, ty); };

  // 1) retreat if wounded past threshold
  if (u.hp / u.maxHp < spec.retreatHealthPct) {
    if (cheb(u.x, u.y, myBase.x, myBase.y) > 1) mv(myBase.x, myBase.y);
    return;
  }

  const enemy = nearestEnemy(g, u);
  const enemyDist = enemy ? cheb(u.x, u.y, enemy.x, enemy.y) : Infinity;

  // 2) leashed defenders: only engage intruders near base, else return to guard ring
  if (spec.defendRadius != null) {
    const intruder = enemy && cheb(enemy.x, enemy.y, myBase.x, myBase.y) <= spec.defendRadius;
    if (intruder) {
      if (enemyDist <= stats.range) atk(enemy!);
      else mv(enemy!.x, enemy!.y);
    } else if (cheb(u.x, u.y, myBase.x, myBase.y) > spec.defendRadius - 1) {
      mv(myBase.x, myBase.y);
    }
    return;
  }

  // 3) engage if an enemy is in sensor + within engageRange and we're aggressive enough
  const willEngage = enemy && enemyDist <= SENSOR && enemyDist <= spec.engageRange && hash01(u.id, g.tick) < 0.5 + spec.aggression / 2;
  if (willEngage) {
    if (enemyDist <= stats.range) atk(enemy!);
    else mv(enemy!.x, enemy!.y);
    return;
  }

  // 4) no fight: explorers roam, aggressors march on the enemy base
  if (spec.explorationBias > 0.5) {
    if (canMove) wander(g, u);
  } else {
    const enemyBase = g.bases.find((b) => b.owner !== u.owner)!;
    mv(enemyBase.x, enemyBase.y);
  }
}

function attack(g: GameState, u: UnitState, target: { isBase: boolean; ref: UnitState | BaseState }) {
  target.ref.hp -= UNIT_STATS[u.unit].dmg;
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
  for (const p of g.players) p.resources += INCOME_PER_TICK; // fixed income
  // continuous production: each camp trains its unit at its rate (deterministic cadence)
  for (let pi = 0; pi < g.players.length; pi++) {
    const player = g.players[pi];
    player.camps.forEach((camp, ci) => {
      const pct = camp.production.budgetPct;
      if (pct <= 0) return;
      const stats = UNIT_STATS[camp.production.unit];
      if (!stats || stats.building) return;
      // spend rate = income * pct% ; ticks to fund one unit = cost / spendPerTick
      const interval = Math.max(1, Math.round((stats.cost * 100) / (INCOME_PER_TICK * pct)));
      if ((g.tick + ci * 7) % interval !== 0) return; // stagger camps
      if (player.resources < stats.cost) return; // bank can't cover it this cycle — skip
      player.resources -= stats.cost;
      spawnUnit(g, pi, camp.id, camp.production.unit);
    });
  }
  // decide() self-gates movement/attack per unit type (deterministic, staggered by id).
  for (const u of g.units) decide(g, u);
  g.units = g.units.filter((u) => u.hp > 0);
}

/** Public (wire) shape of a unit — drops the internal `_ovr` spec so it never leaks. */
function pub(u: UnitState): UnitState {
  return {
    id: u.id, owner: u.owner, camp: u.camp, unit: u.unit, x: u.x, y: u.y,
    hp: u.hp, maxHp: u.maxHp, overrideUntil: u.overrideUntil, overrideLabel: u.overrideLabel,
  };
}

/** Fog of war: what `player` can see. Own units/base always; enemy units/base only when
 *  within VISION of one of the player's units or base — so scouting (recon doctrine) pays off. */
export function computeVisibleState(g: GameState, player: number): { units: UnitState[]; bases: BaseState[] } {
  const viewers = g.units.filter((u) => u.owner === player).map((u) => ({ x: u.x, y: u.y }));
  const ownBase = g.bases[player];
  if (ownBase) viewers.push({ x: ownBase.x, y: ownBase.y });
  const visible = (x: number, y: number) => viewers.some((v) => cheb(v.x, v.y, x, y) <= VISION);
  return {
    units: g.units.filter((u) => u.owner === player || visible(u.x, u.y)).map(pub),
    bases: g.bases.filter((b) => b.owner === player || visible(b.x, b.y)),
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
