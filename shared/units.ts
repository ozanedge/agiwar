// Unit types — orthogonal to doctrine. A unit's TYPE sets its stats (hp/speed/damage/cost/range);
// its CAMP (doctrine) sets its behavior. You pick both when you create a troop.
import type { ArtifactBonusKind } from "./types.js";
export type UnitType = "gunner" | "tank" | "humvee" | "drone" | "turret";

// Spatial resolution multiplier (cells per axis vs. the original coarse grid). 4 → 16× cells
// on the same physical map: finer terrain + smoother movement. All cell-denominated distances
// below (range, vision, investment +range) are pre-multiplied so PHYSICAL reach is unchanged.
export const GRID_SCALE = 4;

export interface UnitTypeStats {
  label: string;
  maxHp: number;
  /** move one cell every N ticks — lower is faster. */
  moveEvery: number;
  /** land one hit every N ticks. */
  attackEvery: number;
  dmg: number;
  /** resource cost to create. */
  cost: number;
  /** attack reach in cells (1 = melee). Turrets reach far. */
  range: number;
  /** base chance to hit on target (0..1), before distance falloff — units can miss. */
  accuracy: number;
  /** stationary units never move (turrets). */
  stationary?: boolean;
  /** buildings are placed on the map (no training camp / doctrine). */
  building?: boolean;
  /** flying units (drones) ignore surface obstacles — water, mountains, cliffs. */
  flying?: boolean;
  blurb: string;
}

export const UNIT_STATS: Record<UnitType, UnitTypeStats> = {
  // range is in (fine) cells = GRID_SCALE × the old coarse reach, so physical attack range is unchanged.
  gunner: { label: "Gunner Infantry", maxHp: 30, moveEvery: 4, attackEvery: 4, dmg: 2, cost: 50, range: 4, accuracy: 0.72, blurb: "balanced" },
  tank: { label: "Tank", maxHp: 80, moveEvery: 8, attackEvery: 6, dmg: 6, cost: 150, range: 4, accuracy: 0.8, blurb: "strong but slow" },
  humvee: { label: "Humvee", maxHp: 16, moveEvery: 2, attackEvery: 4, dmg: 1, cost: 40, range: 4, accuracy: 0.6, blurb: "fast but weak" },
  drone: { label: "Drone", maxHp: 10, moveEvery: 2, attackEvery: 99, dmg: 0, cost: 90, range: 44, accuracy: 0, flying: true, blurb: "unarmed, huge vision, flies over terrain" },
  turret: { label: "Turret", maxHp: 160, moveEvery: 9999, attackEvery: 5, dmg: 7, cost: 220, range: 28, accuracy: 0.85, stationary: true, building: true, blurb: "placed strongpoint" },
};

export const UNIT_TYPES: UnitType[] = ["gunner", "tank", "humvee", "drone", "turret"];

// Permanent, repeatable investments — each level adds to that player's army-wide bonus.
// (kind matches the artifact bonus pool, so they stack.) Cost escalates per level.
export const INVESTMENTS: { kind: ArtifactBonusKind; label: string; amount: number; base: number; effect: string }[] = [
  { kind: "damage", label: "Munitions", amount: 1, base: 120, effect: "+1 dmg" },
  { kind: "hp", label: "Plating", amount: 5, base: 120, effect: "+5 hp" },
  { kind: "armor", label: "Armor", amount: 1, base: 150, effect: "−1 dmg taken" },
  { kind: "range", label: "Optics", amount: GRID_SCALE, base: 170, effect: "+1 range" },
  { kind: "speed", label: "Engines", amount: 1, base: 160, effect: "+10% speed" },
  { kind: "income", label: "Reactor", amount: 1, base: 140, effect: "+1 ⛃/s" },
];
export const investCost = (base: number, level: number) => base * (level + 1);

// Units see far beyond their attack range; a base reveals a fixed radius.
export const VISION_MULT = 9;
export const VISION_CAP = 42 * GRID_SCALE; // so a long-range scout can't reveal the entire map
export const BASE_VISION = 20 * GRID_SCALE;
export const visionOf = (u: UnitType) => Math.min(VISION_CAP, UNIT_STATS[u].range * VISION_MULT);
// Units are trained at a camp; buildings are placed on the map (no doctrine).
export const TRAINABLE: UnitType[] = UNIT_TYPES.filter((t) => !UNIT_STATS[t].building);
export const BUILDINGS: UnitType[] = UNIT_TYPES.filter((t) => UNIT_STATS[t].building);
