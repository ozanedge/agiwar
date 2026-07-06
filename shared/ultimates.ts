// ARTIFACTS & ULTIMATES — a collect-and-combine endgame layer.
//
// Five artifact types drop near each player's base and auto-harvest into their inventory. Combining
// any TWO (incl. two of the same) FORGES an ultimate: a powerful effect that then fires on a timer for
// the rest of the match. 5 types, combined two-at-a-time WITH repetition = 15 distinct ultimates.
//
// Pure data (only a UnitType import) so server + client share it.
import type { UnitType } from "./units.js";

// ---- the five artifacts ----
export interface ArtifactType {
  id: number; // 0..4 — index into a player's inventory counts
  key: string; // short code
  name: string;
  color: number; // tint for the on-map drop + inventory chip
  tag: string; // one-word flavor
}
export const ARTIFACTS: ArtifactType[] = [
  { id: 0, key: "sky", name: "Skyshard", color: 0x5fb8ff, tag: "Air" },
  { id: 1, key: "iron", name: "Ironcore", color: 0xb8a888, tag: "Armor" },
  { id: 2, key: "spark", name: "Sparkcell", color: 0xffe24a, tag: "Energy" },
  { id: 3, key: "bloom", name: "Bloomseed", color: 0x57e08a, tag: "Bio" },
  { id: 4, key: "void", name: "Voidstone", color: 0xb26bff, tag: "Gravity" },
];

// ---- ultimate effects ----
// Three primitives the sim executes each time an ultimate fires:
//  • strike — hit the densest enemy cluster (damage, optional disable / pull / damage-over-time)
//  • spawn  — drop elite units for the owner near their base (stat-multiplied existing unit types)
//  • heal   — mend the owner's army (and scorch enemies near it)
export type UltEffect =
  | { kind: "strike"; radius: number; damage: number; disableTicks?: number; pull?: boolean; dotTicks?: number }
  | { kind: "spawn"; unit: UnitType; count: number; hpMult: number; dmgMult: number; slowMult: number; scale: number; regen?: number }
  | { kind: "heal"; amount: number; aoeDamage: number; radius: number };

export interface Ultimate {
  id: string; // sorted-pair key, e.g. "0-0", "1-3"
  pair: [number, number]; // the two artifact type ids (sorted, may be equal)
  name: string;
  blurb: string;
  intervalSec: number; // fires this often once forged
  fx: string; // visual kind the client renders
  effect: UltEffect;
}

// keyed by sorted "a-b". All 15 combinations of 5 types taken two-at-a-time with repetition.
// Every ultimate runs on a uniform 60s clock and is tuned to be a strong tempo swing, NOT a game-ender.
const IV = 60; // seconds between firings for every ultimate
// Every ultimate now SUMMONS a balanced unit (or squad). Each unit excels in one niche and is weak
// elsewhere — see the per-unit stats in units.ts. Stats are baked into the unit types, so the spawn
// mults stay neutral (×1) here; only count, render `scale`, and optional regen vary per ultimate.
const sp = (unit: UnitType, count: number, scale: number, regen?: number): UltEffect =>
  ({ kind: "spawn", unit, count, hpMult: 1, dmgMult: 1, slowMult: 1, scale, regen });

export const ULTIMATES: Record<string, Ultimate> = {
  // ---- AIR (0) pairs — fast, flying ----
  "0-0": { id: "0-0", pair: [0, 0], name: "Fighter Jet Wing", fx: "spawn", intervalSec: IV,
    blurb: "Scrambles a wing of two very fast fighter jets — high speed, light armor.",
    effect: sp("jet", 2, 1.1) },
  "0-1": { id: "0-1", pair: [0, 1], name: "Gunship", fx: "spawn", intervalSec: IV,
    blurb: "Deploys a tanky attack gunship that hovers and rains rapid cannon fire.",
    effect: sp("gunship", 1, 1.35) },
  "0-2": { id: "0-2", pair: [0, 2], name: "Lightning Interceptor", fx: "spawn", intervalSec: IV,
    blurb: "The fastest flyer with glass-cannon guns — devastating but it shatters if caught.",
    effect: sp("interceptor", 1, 1.15) },
  "0-3": { id: "0-3", pair: [0, 3], name: "Drone Swarm", fx: "spawn", intervalSec: IV,
    blurb: "Releases five small fast flying drones — weak alone, overwhelming together.",
    effect: sp("dronewing", 5, 0.8, 0.3) },
  "0-4": { id: "0-4", pair: [0, 4], name: "Wraith", fx: "spawn", intervalSec: IV,
    blurb: "A flying sniper: enormous range and per-shot damage, but slow firing and frail.",
    effect: sp("wraith", 1, 1.2) },
  // ---- ARMOR (1) pairs — durable, slow ----
  "1-1": { id: "1-1", pair: [1, 1], name: "Mammoth Tank", fx: "spawn", intervalSec: IV,
    blurb: "A juggernaut with colossal HP that crawls forward and pounds anything in reach.",
    effect: sp("mammoth", 1, 2.0) },
  "1-2": { id: "1-2", pair: [1, 2], name: "War Mech", fx: "spawn", intervalSec: IV,
    blurb: "A tanky bipedal bruiser with strong sustained fire — durable but slow.",
    effect: sp("warmech", 1, 1.6) },
  "1-3": { id: "1-3", pair: [1, 3], name: "Regen Titan", fx: "spawn", intervalSec: IV,
    blurb: "A self-healing wall that soaks enormous punishment — but barely scratches back.",
    effect: sp("titan", 1, 1.85, 1.2) },
  "1-4": { id: "1-4", pair: [1, 4], name: "Siege Crawler", fx: "spawn", intervalSec: IV,
    blurb: "Long-range siege armor: heavy HP and huge hits, but it crawls and fires slowly.",
    effect: sp("siege", 1, 2.1) },
  // ---- ENERGY (2) pairs — high firepower, fragile ----
  "2-2": { id: "2-2", pair: [2, 2], name: "Tesla Coil", fx: "spawn", intervalSec: IV,
    blurb: "Shreds anything nearby with relentless rapid arcs — but folds under fire.",
    effect: sp("tesla", 1, 1.2) },
  "2-3": { id: "2-3", pair: [2, 3], name: "Acid Spitters", fx: "spawn", intervalSec: IV,
    blurb: "A squad of three fragile mid-range spitters that slowly knit their wounds.",
    effect: sp("spitter", 3, 0.95, 0.15) },
  "2-4": { id: "2-4", pair: [2, 4], name: "Railgun Walker", fx: "spawn", intervalSec: IV,
    blurb: "Extreme range and a massive railgun slug — but it fires rarely and is fragile.",
    effect: sp("railwalker", 1, 1.4) },
  // ---- BIO (3) pairs — numbers & regen ----
  "3-3": { id: "3-3", pair: [3, 3], name: "Spore Swarm", fx: "spawn", intervalSec: IV,
    blurb: "Bursts a huge swarm of seven expendable raiders — trivial alone, a tide en masse.",
    effect: sp("spore", 7, 0.8, 0.4) },
  "3-4": { id: "3-4", pair: [3, 4], name: "Devourer Pack", fx: "spawn", intervalSec: IV,
    blurb: "Three regenerating bio-bruisers that grind forward and outlast attrition.",
    effect: sp("devourer", 3, 1.1, 0.6) },
  // ---- GRAVITY (4) pair — zoning by reach ----
  "4-4": { id: "4-4", pair: [4, 4], name: "Singularity", fx: "spawn", intervalSec: IV,
    blurb: "A floating gravity well with the longest reach on the field — slow, but untouchable from afar.",
    effect: sp("singularity", 1, 1.6) },
};

export const ultimateKey = (a: number, b: number) => (a <= b ? `${a}-${b}` : `${b}-${a}`);
export const ultimateFor = (a: number, b: number) => ULTIMATES[ultimateKey(a, b)];
export const ALL_ULTIMATES = Object.values(ULTIMATES);
