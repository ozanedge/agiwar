// Unit types — orthogonal to doctrine. A unit's TYPE sets its stats (hp/speed/damage/cost/range);
// its CAMP (doctrine) sets its behavior. You pick both when you create a troop.
export type UnitType = "gunner" | "tank" | "humvee" | "turret";

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
  /** stationary units never move (turrets). */
  stationary?: boolean;
  /** buildings are placed on the map (no training camp / doctrine). */
  building?: boolean;
  blurb: string;
}

export const UNIT_STATS: Record<UnitType, UnitTypeStats> = {
  gunner: { label: "Gunner Infantry", maxHp: 30, moveEvery: 4, attackEvery: 4, dmg: 2, cost: 50, range: 1, blurb: "balanced" },
  tank: { label: "Tank", maxHp: 80, moveEvery: 9, attackEvery: 6, dmg: 6, cost: 150, range: 1, blurb: "strong but slow" },
  humvee: { label: "Humvee", maxHp: 16, moveEvery: 2, attackEvery: 4, dmg: 1, cost: 40, range: 1, blurb: "fast but weak" },
  turret: { label: "Turret", maxHp: 160, moveEvery: 9999, attackEvery: 5, dmg: 7, cost: 220, range: 7, stationary: true, building: true, blurb: "placed strongpoint" },
};

export const UNIT_TYPES: UnitType[] = ["gunner", "tank", "humvee", "turret"];

// A unit sees 3× as far as it can shoot; a base reveals a fixed radius.
export const VISION_MULT = 3;
export const BASE_VISION = 16;
export const visionOf = (u: UnitType) => UNIT_STATS[u].range * VISION_MULT;
// Units are trained at a camp; buildings are placed on the map (no doctrine).
export const TRAINABLE: UnitType[] = UNIT_TYPES.filter((t) => !UNIT_STATS[t].building);
export const BUILDINGS: UnitType[] = UNIT_TYPES.filter((t) => UNIT_STATS[t].building);
