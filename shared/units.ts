// Unit types — orthogonal to doctrine. A unit's TYPE sets its stats (hp/speed/damage);
// its CAMP (doctrine) sets its behavior. You pick both when you create a troop.
export type UnitType = "gunner" | "tank" | "humvee";

export interface UnitTypeStats {
  label: string;
  maxHp: number;
  /** move one cell every N ticks — lower is faster. */
  moveEvery: number;
  /** land one hit every N ticks. */
  attackEvery: number;
  dmg: number;
  blurb: string;
}

export const UNIT_STATS: Record<UnitType, UnitTypeStats> = {
  gunner: { label: "Gunner Infantry", maxHp: 30, moveEvery: 4, attackEvery: 4, dmg: 2, blurb: "balanced" },
  tank: { label: "Tank", maxHp: 80, moveEvery: 9, attackEvery: 6, dmg: 6, blurb: "strong but slow" },
  humvee: { label: "Humvee", maxHp: 16, moveEvery: 2, attackEvery: 4, dmg: 1, blurb: "fast but weak" },
};

export const UNIT_TYPES: UnitType[] = ["gunner", "tank", "humvee"];
