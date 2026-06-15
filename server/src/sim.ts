// Deterministic, server-authoritative fixed-tick simulation.
// No Math.random / Date.now inside the tick: all "randomness" is a pure hash of
// (unitId, tick) so a match is fully reproducible and replayable.
import type { BehaviorSpec, BaseState, Camp, DoctrineId, FieldGeneral, UnitState } from "../../shared/types.js";
import { PRESET_PROMPTS, PRESET_SPECS, clampSpec } from "../../shared/spec.js";

export const GRID_W = 48;
export const GRID_H = 32;
const ATTACK_RANGE = 1; // Chebyshev cells
const ATTACK_DMG = 2;
const UNIT_HP = 20;
const BASE_HP = 200;
const SENSOR = 14; // how far a unit can "see" an enemy at all

export interface GameState {
  tick: number;
  units: UnitState[];
  bases: BaseState[];
  camps: Camp[];
  fieldGeneral: FieldGeneral;
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
  return { id, label, prompt: PRESET_PROMPTS[id], spec: { ...PRESET_SPECS[id] }, cooldownUntil: 0, compiling: false };
}

export function newGame(): GameState {
  const camps = [
    makeCamp("aggressive", "Gen. Vance · Aggressive"),
    makeCamp("recon", "Gen. Okafor · Recon"),
    makeCamp("defensive", "Gen. Reyes · Defensive"),
  ];
  const bases: BaseState[] = [
    { owner: 0, x: 4, y: GRID_H >> 1, hp: BASE_HP, maxHp: BASE_HP },
    { owner: 1, x: GRID_W - 5, y: GRID_H >> 1, hp: BASE_HP, maxHp: BASE_HP },
  ];
  const fieldGeneral: FieldGeneral = { label: "Field Gen. Mercer", prompt: DEFAULT_FIELD_GENERAL_PROMPT };
  return { tick: 0, units: [], bases, camps, fieldGeneral, nextUnitId: 1 };
}

export function spawnUnit(g: GameState, owner: number, camp: DoctrineId): void {
  const base = g.bases[owner];
  const jitter = g.units.length;
  g.units.push({
    id: g.nextUnitId++,
    owner,
    camp,
    x: base.x + (owner === 0 ? 1 : -1) * (1 + (jitter % 3)),
    y: Math.max(0, Math.min(GRID_H - 1, base.y - 2 + (jitter % 5))),
    hp: UNIT_HP,
    maxHp: UNIT_HP,
    overrideUntil: 0,
    overrideLabel: "",
  });
}

/** Effective spec for a unit this tick: an active field-override wins over native
 *  doctrine; otherwise the unit runs its camp's compiled doctrine. */
function effectiveSpec(g: GameState, u: UnitState): BehaviorSpec {
  if (u.overrideUntil > g.tick && (u as any)._ovr) return (u as any)._ovr as BehaviorSpec;
  const camp = g.camps.find((c) => c.id === u.camp);
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

function moveToward(u: UnitState, tx: number, ty: number) {
  u.x = Math.max(0, Math.min(GRID_W - 1, u.x + sign(tx - u.x)));
  u.y = Math.max(0, Math.min(GRID_H - 1, u.y + sign(ty - u.y)));
}

function wander(g: GameState, u: UnitState) {
  // deterministic outward drift, biased away from own base so scouts explore
  const base = g.bases[u.owner];
  const away = sign(u.x - base.x) || 1;
  const r = hash01(u.id, g.tick >> 2); // change direction every 4 ticks
  const dx = r < 0.5 ? away : sign(Math.round(r * 4) - 2);
  const dy = sign(Math.round(hash01(u.id + 7, g.tick >> 2) * 4) - 2);
  u.x = Math.max(0, Math.min(GRID_W - 1, u.x + dx));
  u.y = Math.max(0, Math.min(GRID_H - 1, u.y + dy));
}

function decide(g: GameState, u: UnitState) {
  const spec = effectiveSpec(g, u);
  const myBase = g.bases[u.owner];

  // 1) retreat if wounded past threshold
  if (u.hp / u.maxHp < spec.retreatHealthPct) {
    if (cheb(u.x, u.y, myBase.x, myBase.y) > 1) moveToward(u, myBase.x, myBase.y);
    return;
  }

  const enemy = nearestEnemy(g, u);
  const enemyDist = enemy ? cheb(u.x, u.y, enemy.x, enemy.y) : Infinity;

  // 2) leashed defenders: only engage intruders near base, else return to guard ring
  if (spec.defendRadius != null) {
    const intruder = enemy && cheb(enemy.x, enemy.y, myBase.x, myBase.y) <= spec.defendRadius;
    if (intruder) {
      if (enemyDist <= ATTACK_RANGE) attack(g, u, enemy!);
      else moveToward(u, enemy!.x, enemy!.y);
    } else if (cheb(u.x, u.y, myBase.x, myBase.y) > spec.defendRadius - 1) {
      moveToward(u, myBase.x, myBase.y);
    }
    return;
  }

  // 3) engage if an enemy is in sensor + within engageRange and we're aggressive enough
  const willEngage = enemy && enemyDist <= SENSOR && enemyDist <= spec.engageRange && hash01(u.id, g.tick) < 0.5 + spec.aggression / 2;
  if (willEngage) {
    if (enemyDist <= ATTACK_RANGE) attack(g, u, enemy!);
    else moveToward(u, enemy!.x, enemy!.y);
    return;
  }

  // 4) no fight: explorers roam, aggressors march on the enemy base
  if (spec.explorationBias > 0.5) {
    wander(g, u);
  } else {
    const enemyBase = g.bases.find((b) => b.owner !== u.owner)!;
    moveToward(u, enemyBase.x, enemyBase.y);
  }
}

function attack(g: GameState, u: UnitState, target: { isBase: boolean; ref: UnitState | BaseState }) {
  target.ref.hp -= ATTACK_DMG;
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
  for (const u of g.units) decide(g, u);
  g.units = g.units.filter((u) => u.hp > 0);
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
