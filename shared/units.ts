// Unit types — orthogonal to doctrine. A unit's TYPE sets its stats (hp/speed/damage/cost/range);
// its CAMP (doctrine) sets its behavior. You pick both when you create a troop.
import type { OutpostBonusKind } from "./types.js";
export type UnitType =
  // ANTHROPIC (GDI-style) base + ultimate units — durable, powerful, slower.
  | "gunner" | "rocket" | "tank" | "humvee" | "drone" | "turret"
  | "jet" | "interceptor" | "wraith" | "gunship" | "dronewing"
  | "mammoth" | "siege" | "warmech" | "titan"
  | "tesla" | "railwalker" | "spitter" | "spore" | "devourer" | "singularity"
  // OPENAI (Nod-style) base + ultimate units — fast, cheap, fragile.
  | "nod_flamer" | "nod_rocket" | "nod_lighttank" | "nod_buggy" | "nod_bike" | "nod_turret"
  | "nod_jet" | "nod_interceptor" | "nod_wraith" | "nod_gunship" | "nod_dronewing"
  | "nod_mammoth" | "nod_siege" | "nod_warmech" | "nod_titan"
  | "nod_tesla" | "nod_railwalker" | "nod_spitter" | "nod_spore" | "nod_devourer" | "nod_singularity";

export type Faction = "anthropic" | "openai";
export const FACTIONS: Faction[] = ["anthropic", "openai"];
export const FACTION_META: Record<Faction, { label: string; blurb: string; color: number }> = {
  anthropic: { label: "Anthropic", blurb: "Durable, powerful, expensive — a robust turtle army.", color: 0xff8a1f }, // orange units
  openai: { label: "OpenAI", blurb: "Fast, cheap, fragile — a relentless rush army.", color: 0xc6ccd4 }, // light-grey units
};

// Spatial resolution multiplier (cells per axis vs. the original coarse grid). 4 → 16× cells
// on the same physical map: finer terrain + smoother movement. All cell-denominated distances
// below (range, vision, investment +range) are pre-multiplied so PHYSICAL reach is unchanged.
export const GRID_SCALE = 4;
// Global HP scale applied to every unit at spawn (higher = longer fights). Structures (bases/outposts) are unaffected.
export const UNIT_HP_MULT = 2;

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
  /** summon-only units (ultimate spawns) — never trained or placed via the economy. */
  summon?: boolean;
  /** visual family for the client renderer (several summon types share an art family). Defaults to the type key. */
  family?: string;
  /** fast fixed-wing flyer: never stops — holds forward momentum and banks into wide sweeping turns. */
  momentum?: boolean;
  /** fires machine-gun bullets: ineffective vs tanks, very ineffective vs aircraft. */
  mg?: boolean;
  /** rocket launcher: extra-effective vs tanks and aircraft. */
  rocket?: boolean;
  blurb: string;
}

export const UNIT_STATS: Record<UnitType, UnitTypeStats> = {
  // range is in (fine) cells = GRID_SCALE × the old coarse reach, so physical attack range is unchanged.
  // ANTHROPIC (GDI) base roster — conventional, durable, costlier.
  gunner: { label: "Minigunner", maxHp: 30, moveEvery: 4, attackEvery: 4, dmg: 2, cost: 50, range: 4, accuracy: 0.72, mg: true, family: "gunner", blurb: "balanced infantry" },
  rocket: { label: "Rocket Trooper", maxHp: 30, moveEvery: 4, attackEvery: 7, dmg: 8, cost: 110, range: 8, accuracy: 0.82, rocket: true, family: "gunner", blurb: "anti-tank/air rockets, slow reload" },
  tank: { label: "Medium Tank", maxHp: 80, moveEvery: 8, attackEvery: 6, dmg: 6, cost: 150, range: 4, accuracy: 0.8, family: "tank", blurb: "strong but slow" },
  humvee: { label: "APC", maxHp: 16, moveEvery: 2, attackEvery: 4, dmg: 1, cost: 40, range: 4, accuracy: 0.6, mg: true, family: "humvee", blurb: "fast but lightly armored" },
  drone: { label: "Orca Scout", maxHp: 10, moveEvery: 2, attackEvery: 99, dmg: 0, cost: 90, range: 44, accuracy: 0, flying: true, family: "drone", blurb: "unarmed, huge vision, flies over terrain" },
  turret: { label: "Guard Tower", maxHp: 160, moveEvery: 9999, attackEvery: 5, dmg: 7, cost: 220, range: 28, accuracy: 0.85, stationary: true, building: true, family: "turret", blurb: "placed strongpoint" },

  // ===== ULTIMATE SUMMON UNITS — each is excellent at ONE niche and weak elsewhere (no all-rounders).
  // Power is balanced across damage / durability / mobility / range: high firepower comes with low HP,
  // heavy armor comes with crawling speed, swarms trade per-unit strength for numbers, etc. =====
  // AIR — fast & flying, but lightly armored.
  jet:         { label: "Fighter Jet",    maxHp: 45,  moveEvery: 1,  attackEvery: 3, dmg: 6,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.85, flying: true, momentum: true, summon: true, family: "jet",       blurb: "very fast flyer, light armor" },
  interceptor: { label: "Interceptor",    maxHp: 38,  moveEvery: 0.67, attackEvery: 2, dmg: 9,  cost: 0, range: 8 * GRID_SCALE,  accuracy: 0.9,  flying: true, momentum: true, summon: true, family: "jet",       blurb: "fastest flyer, glass-cannon guns" },
  wraith:      { label: "Wraith",         maxHp: 55,  moveEvery: 2,  attackEvery: 5, dmg: 14, cost: 0, range: 12 * GRID_SCALE, accuracy: 0.9,  flying: true, momentum: true, summon: true, family: "jet",       blurb: "flying sniper: long range, slow fire" },
  gunship:     { label: "Gunship",        maxHp: 130, moveEvery: 3,  attackEvery: 2, dmg: 5,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.85, flying: true, summon: true, family: "gunship",   blurb: "tanky flyer, rapid cannon" },
  dronewing:   { label: "Drone Swarm",    maxHp: 14,  moveEvery: 2,  attackEvery: 4, dmg: 3,  cost: 0, range: 6 * GRID_SCALE,  accuracy: 0.7,  flying: true, summon: true, family: "drone",     blurb: "swarm of small fast flyers" },
  // ARMOR — durable, but slow.
  mammoth:     { label: "Mammoth Tank",   maxHp: 260, moveEvery: 10, attackEvery: 6, dmg: 14, cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.85, summon: true, family: "tank",                  blurb: "juggernaut: huge HP, very slow" },
  siege:       { label: "Siege Crawler",  maxHp: 230, moveEvery: 12, attackEvery: 7, dmg: 22, cost: 0, range: 11 * GRID_SCALE, accuracy: 0.9,  summon: true, family: "tank",                  blurb: "long-range siege, crawls, slow fire" },
  warmech:     { label: "War Mech",       maxHp: 170, moveEvery: 7,  attackEvery: 3, dmg: 8,  cost: 0, range: 6 * GRID_SCALE,  accuracy: 0.85, summon: true, family: "mech",                  blurb: "tanky bruiser, sustained fire, slow" },
  titan:       { label: "Regen Titan",    maxHp: 200, moveEvery: 8,  attackEvery: 5, dmg: 7,  cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.8,  summon: true, family: "mech",                  blurb: "self-healing wall, low damage" },
  // ENERGY — high firepower, but fragile.
  tesla:       { label: "Tesla Coil",     maxHp: 60,  moveEvery: 4,  attackEvery: 1, dmg: 4,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.8,  summon: true, family: "tesla",                 blurb: "shreds with rapid arcs, fragile" },
  railwalker:  { label: "Railgun Walker", maxHp: 65,  moveEvery: 6,  attackEvery: 8, dmg: 34, cost: 0, range: 14 * GRID_SCALE, accuracy: 0.92, summon: true, family: "walker",                blurb: "extreme range & burst, very slow fire" },
  spitter:     { label: "Acid Spitters",  maxHp: 30,  moveEvery: 3,  attackEvery: 3, dmg: 5,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.8,  summon: true, family: "swarmling",             blurb: "fragile mid-range squad" },
  // BIO — numbers & regeneration, but weak individually.
  spore:       { label: "Spore Swarm",    maxHp: 12,  moveEvery: 2,  attackEvery: 4, dmg: 2,  cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.65, summon: true, family: "swarmling",             blurb: "huge expendable swarm" },
  devourer:    { label: "Devourer Pack",  maxHp: 55,  moveEvery: 3,  attackEvery: 4, dmg: 5,  cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.75, summon: true, family: "swarmling",             blurb: "regenerating bio-bruiser pack" },
  // GRAVITY — control by zoning with reach, but slow.
  singularity: { label: "Singularity",    maxHp: 120, moveEvery: 9,  attackEvery: 6, dmg: 10, cost: 0, range: 15 * GRID_SCALE, accuracy: 0.9,  flying: true, summon: true, family: "orb",       blurb: "floating well, longest range, slow" },

  // ===== OPENAI (Nod) ROSTER — same roles/families as Anthropic, but faster, cheaper, and frailer (rush). =====
  // base roster (attack / defense / builder / recon + turret)
  nod_flamer:    { label: "Flamethrower",  maxHp: 24,  moveEvery: 4,  attackEvery: 3, dmg: 4,  cost: 50,  range: 3,            accuracy: 0.85, family: "gunner",  blurb: "short-range, anti-everything, fragile" },
  nod_rocket:    { label: "Missile Squad", maxHp: 22,  moveEvery: 3,  attackEvery: 7, dmg: 8,  cost: 90,  range: 8,            accuracy: 0.82, rocket: true, family: "gunner", blurb: "anti-tank/air rockets, fragile" },
  nod_lighttank: { label: "Light Tank",    maxHp: 60,  moveEvery: 5,  attackEvery: 5, dmg: 5,  cost: 120, range: 4,            accuracy: 0.8,  family: "tank",    blurb: "fast tank, light armor" },
  nod_buggy:     { label: "Buggy",         maxHp: 14,  moveEvery: 1,  attackEvery: 4, dmg: 1,  cost: 40,  range: 4,            accuracy: 0.6,  mg: true, family: "humvee",  blurb: "fast, cheap, fragile" },
  nod_bike:      { label: "Recon Bike",    maxHp: 16,  moveEvery: 1,  attackEvery: 4, dmg: 2,  cost: 60,  range: 5,            accuracy: 0.7,  family: "humvee",  blurb: "fast scout, rockets, big vision" },
  nod_turret:    { label: "Nod Turret",    maxHp: 130, moveEvery: 9999, attackEvery: 4, dmg: 6, cost: 190, range: 26,          accuracy: 0.85, stationary: true, building: true, family: "turret", blurb: "cheaper, weaker strongpoint" },
  // ultimate roster — Nod variants of each archetype (less HP, a touch faster, faster fire)
  nod_jet:         { label: "Venom Wing",        maxHp: 36,  moveEvery: 1,  attackEvery: 3, dmg: 6,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.85, flying: true, momentum: true, summon: true, family: "jet",       blurb: "very fast flyer, light armor" },
  nod_interceptor: { label: "Banshee",           maxHp: 30,  moveEvery: 1,  attackEvery: 2, dmg: 9,  cost: 0, range: 8 * GRID_SCALE,  accuracy: 0.9,  flying: true, momentum: true, summon: true, family: "jet",       blurb: "fastest flyer, glass-cannon guns" },
  nod_wraith:      { label: "Stealth Bomber",    maxHp: 44,  moveEvery: 2,  attackEvery: 5, dmg: 13, cost: 0, range: 12 * GRID_SCALE, accuracy: 0.9,  flying: true, momentum: true, summon: true, family: "jet",       blurb: "flying sniper: long range, slow fire" },
  nod_gunship:     { label: "Apache Gunship",    maxHp: 104, moveEvery: 3,  attackEvery: 2, dmg: 5,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.85, flying: true, summon: true, family: "gunship",   blurb: "tanky flyer, rapid cannon" },
  nod_dronewing:   { label: "Heavy Gunship",     maxHp: 320, moveEvery: 5,  attackEvery: 2, dmg: 8,  cost: 0, range: 8 * GRID_SCALE,  accuracy: 0.85, flying: true, momentum: true, summon: true, family: "gunship",   blurb: "huge armored gunship; big rear-facing autocannon (fires only backward)" },
  nod_mammoth:     { label: "Tiberium Behemoth", maxHp: 208, moveEvery: 9,  attackEvery: 5, dmg: 13, cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.85, summon: true, family: "tank",                  blurb: "juggernaut: huge HP, slow" },
  nod_siege:       { label: "Artillery Crawler", maxHp: 184, moveEvery: 10, attackEvery: 6, dmg: 21, cost: 0, range: 11 * GRID_SCALE, accuracy: 0.9,  summon: true, family: "tank",                  blurb: "long-range siege, crawls" },
  nod_warmech:     { label: "Cyborg Commando",   maxHp: 136, moveEvery: 6,  attackEvery: 3, dmg: 8,  cost: 0, range: 6 * GRID_SCALE,  accuracy: 0.85, summon: true, family: "mech",                  blurb: "tanky bruiser, sustained fire" },
  nod_titan:       { label: "Cyborg Reaper",     maxHp: 160, moveEvery: 7,  attackEvery: 5, dmg: 7,  cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.8,  summon: true, family: "mech",                  blurb: "self-healing wall, low damage" },
  nod_tesla:       { label: "Laser Coil",        maxHp: 48,  moveEvery: 3,  attackEvery: 1, dmg: 4,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.8,  summon: true, family: "tesla",                 blurb: "shreds with rapid arcs, fragile" },
  nod_railwalker:  { label: "Obelisk Walker",    maxHp: 52,  moveEvery: 5,  attackEvery: 7, dmg: 32, cost: 0, range: 14 * GRID_SCALE, accuracy: 0.92, summon: true, family: "walker",                blurb: "extreme range & burst, slow fire" },
  nod_spitter:     { label: "Chem Spitters",     maxHp: 24,  moveEvery: 3,  attackEvery: 3, dmg: 5,  cost: 0, range: 7 * GRID_SCALE,  accuracy: 0.8,  summon: true, family: "swarmling",             blurb: "fragile mid-range squad" },
  nod_spore:       { label: "Visceroid Swarm",   maxHp: 10,  moveEvery: 2,  attackEvery: 4, dmg: 2,  cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.65, summon: true, family: "swarmling",             blurb: "huge expendable swarm" },
  nod_devourer:    { label: "Tiberium Fiends",   maxHp: 44,  moveEvery: 3,  attackEvery: 4, dmg: 5,  cost: 0, range: 5 * GRID_SCALE,  accuracy: 0.75, summon: true, family: "swarmling",             blurb: "regenerating bio-bruiser pack" },
  nod_singularity: { label: "Rift Generator",    maxHp: 96,  moveEvery: 8,  attackEvery: 5, dmg: 10, cost: 0, range: 15 * GRID_SCALE, accuracy: 0.9,  flying: true, summon: true, family: "orb",       blurb: "floating well, longest range, slow" },
};

export const UNIT_TYPES: UnitType[] = [
  "gunner", "tank", "humvee", "drone", "turret",
  "jet", "interceptor", "wraith", "gunship", "dronewing",
  "mammoth", "siege", "warmech", "titan",
  "tesla", "railwalker", "spitter", "spore", "devourer", "singularity",
  "nod_flamer", "nod_lighttank", "nod_buggy", "nod_bike", "nod_turret",
  "nod_jet", "nod_interceptor", "nod_wraith", "nod_gunship", "nod_dronewing",
  "nod_mammoth", "nod_siege", "nod_warmech", "nod_titan",
  "nod_tesla", "nod_railwalker", "nod_spitter", "nod_spore", "nod_devourer", "nod_singularity",
];

// Permanent, repeatable investments — each level adds to that player's army-wide bonus.
// (kind matches the outpost bonus pool, so they stack.) Cost escalates per level.
export const INVESTMENTS: { kind: OutpostBonusKind; label: string; amount: number; base: number; effect: string }[] = [
  { kind: "damage", label: "Munitions", amount: 1, base: 120, effect: "+1 dmg" },
  { kind: "hp", label: "Health", amount: 5, base: 120, effect: "+5 hp" },
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
export const TRAINABLE: UnitType[] = UNIT_TYPES.filter((t) => !UNIT_STATS[t].building && !UNIT_STATS[t].summon);
export const BUILDINGS: UnitType[] = UNIT_TYPES.filter((t) => UNIT_STATS[t].building);

// ===== FACTION ROSTERS =====
// the four camp roles map to a faction-specific unit; each faction also has its own turret.
export type CampRole = "aggressive" | "recon" | "defensive" | "builder";
export const FACTION_ROLE_UNIT: Record<Faction, Record<CampRole, UnitType>> = {
  anthropic: { aggressive: "gunner", recon: "drone", defensive: "tank", builder: "humvee" },
  openai: { aggressive: "nod_flamer", recon: "nod_bike", defensive: "nod_lighttank", builder: "nod_buggy" },
};
export const FACTION_TURRET: Record<Faction, UnitType> = { anthropic: "turret", openai: "nod_turret" };
// an extra specialist each faction can also train beyond its four role units: rocket infantry.
export const FACTION_EXTRA_UNIT: Record<Faction, UnitType> = { anthropic: "rocket", openai: "nod_rocket" };
// what a faction can train (its four role units + the rocket specialist). Used by production, the AI prompts, and the mix UI.
export const trainableFor = (f: Faction): UnitType[] => [...["aggressive", "recon", "defensive", "builder"].map((r) => FACTION_ROLE_UNIT[f][r as CampRole]), FACTION_EXTRA_UNIT[f]];
export const factionOfUnit = (t: UnitType): Faction => (t.startsWith("nod_") ? "openai" : "anthropic");

// Ultimates store the canonical (Anthropic) unit; this maps it to the OpenAI (Nod) counterpart.
const NOD_ULT: Partial<Record<UnitType, UnitType>> = {
  jet: "nod_jet", interceptor: "nod_interceptor", wraith: "nod_wraith", gunship: "nod_gunship", dronewing: "nod_dronewing",
  mammoth: "nod_mammoth", siege: "nod_siege", warmech: "nod_warmech", titan: "nod_titan",
  tesla: "nod_tesla", railwalker: "nod_railwalker", spitter: "nod_spitter", spore: "nod_spore", devourer: "nod_devourer", singularity: "nod_singularity",
};
export const ultUnitFor = (baseUnit: UnitType, f: Faction): UnitType => (f === "openai" ? NOD_ULT[baseUnit] ?? baseUnit : baseUnit);
