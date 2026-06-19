// Validation/clamping for BehaviorSpec + doctrine presets + the deterministic
// keyword-stub compiler used as a fallback when Bedrock is unreachable.
import type { BehaviorSpec, DoctrineId } from "./types.js";

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Clamp any candidate spec (from the LLM or the stub) into legal, balanced ranges.
 *  This is the safety boundary: whatever the prompt says, the sim only ever sees a
 *  spec that has passed through here. */
export function clampSpec(raw: Partial<BehaviorSpec> | null | undefined): BehaviorSpec {
  const r = raw ?? {};
  const defended =
    r.defendRadius === null || r.defendRadius === undefined
      ? null
      : Math.max(2, Math.min(20, Math.round(Number(r.defendRadius) || 0)));
  return {
    aggression: clamp01(Number(r.aggression) ?? 0.5),
    engageRange: Math.max(1, Math.min(30, Math.round(Number(r.engageRange) || 6))),
    retreatHealthPct: clamp01(Number(r.retreatHealthPct) ?? 0.2),
    explorationBias: clamp01(Number(r.explorationBias) ?? 0.3),
    defendRadius: defended,
  };
}

/** The three shipped doctrines — also the seed specs before any prompt edit. */
export const PRESET_SPECS: Record<DoctrineId, BehaviorSpec> = {
  aggressive: { aggression: 0.95, engageRange: 30, retreatHealthPct: 0.05, explorationBias: 0.1, defendRadius: null },
  recon: { aggression: 0.1, engageRange: 3, retreatHealthPct: 0.6, explorationBias: 0.95, defendRadius: null },
  defensive: { aggression: 0.5, engageRange: 8, retreatHealthPct: 0.25, explorationBias: 0.0, defendRadius: 15 },
  builder: { aggression: 0.1, engageRange: 2, retreatHealthPct: 0.5, explorationBias: 0.9, defendRadius: null },
};

export const PRESET_PROMPTS: Record<DoctrineId, string> = {
  aggressive:
    "Train troops to be relentlessly aggressive. Seek out and attack any enemy on sight, anywhere on the map. Never retreat — fight to the death.",
  recon:
    "Train troops as scouts. Roam the map and explore unknown territory. Avoid combat: keep your distance from enemies and flee early if threatened.",
  defensive:
    "Train troops to defend the home base. Hold a tight perimeter and only engage enemies that come close to base. Do not chase or wander.",
  builder:
    "Send engineers out to find resources and artifacts across the map and claim them for our side. Avoid combat — secure territory, not kills.",
};

/** Deterministic keyword fallback compiler. Used when Bedrock is unreachable so the
 *  game is always playable offline. Maps style words -> dials. */
export function stubCompile(prompt: string): BehaviorSpec {
  const p = prompt.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => p.includes(w));
  let spec: BehaviorSpec = { aggression: 0.5, engageRange: 6, retreatHealthPct: 0.2, explorationBias: 0.3, defendRadius: null };

  if (has("aggress", "attack", "hunt", "relentless", "offensive", "kill")) {
    spec = { ...spec, aggression: 0.95, engageRange: 30, retreatHealthPct: 0.05, explorationBias: 0.1, defendRadius: null };
  }
  if (has("recon", "scout", "explore", "roam", "avoid", "evade", "flee", "stealth")) {
    spec = { ...spec, aggression: 0.1, engageRange: 3, retreatHealthPct: 0.6, explorationBias: 0.95, defendRadius: null };
  }
  if (has("defens", "defend", "guard", "protect", "perimeter", "hold", "fortif", "turtle", "wall", "garrison")) {
    spec = { ...spec, aggression: 0.5, engageRange: 8, retreatHealthPct: 0.25, explorationBias: 0.0, defendRadius: 15 };
  }
  // fine-grained nudges
  if (has("never retreat", "fight to the death", "no retreat")) spec.retreatHealthPct = 0;
  if (has("cautious", "careful", "flee early")) spec.retreatHealthPct = Math.max(spec.retreatHealthPct, 0.5);
  return clampSpec(spec);
}

/** Keyword fallback for the unit MIX (what types a camp trains), used when Bedrock is down.
 *  Returns weights over the trainable types; the dominant keyword wins, default = gunners. */
export function stubMix(prompt: string): Record<string, number> {
  const p = prompt.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => p.includes(w));
  const mix: Record<string, number> = {};
  if (has("drone", "scout", "recon", "eyes", "surveil", "spotter")) mix.drone = 100;
  if (has("tank", "armor", "heavy", "siege")) mix.tank = (mix.tank || 0) + 100;
  if (has("humvee", "fast", "raid", "harass", "mobile")) mix.humvee = (mix.humvee || 0) + 100;
  if (has("gunner", "infantry", "soldier", "rifle", "troops")) mix.gunner = (mix.gunner || 0) + 100;
  return Object.keys(mix).length ? mix : { gunner: 100 };
}

/** Deterministic fallback ADVISOR (used when Bedrock is down): maps the player's MOST RECENT order
 *  to a budget split + per-camp unit mix, so an executive order still visibly moves the economy
 *  offline. Reads only the latest order line so it overrides the standing doctrine. */
export function stubAdvise(prompt: string): {
  attack: number; intel: number; defense: number; builder: number; turret: number;
  mixes: Record<string, Record<string, number>>; reason: string;
} {
  const lines = prompt.split("\n").map((s) => s.replace(/^[•\-\s]+/, "").trim()).filter(Boolean);
  const latest = (lines[lines.length - 1] ?? "").toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => latest.includes(w));
  const hard = has("all ", "only", "everything", "100%", "full", "max", "pure", "nothing but", "!!"); // "go all-in" intent
  // budget split — pick the dominant doctrine in the order, then bias hard or moderate.
  let b = { attack: 30, intel: 12, defense: 15, builder: 10, turret: 10 };
  if (has("defens", "defend", "turtle", "fortif", "hold the", "protect", "guard", "wall", "garrison")) {
    b = hard ? { attack: 0, intel: 0, defense: 85, builder: 0, turret: 15 } : { attack: 12, intel: 8, defense: 52, builder: 8, turret: 20 };
  } else if (has("attack", "aggress", "offens", "rush", "assault", "push", "strike", "siege", "overwhelm", "blitz")) {
    b = hard ? { attack: 90, intel: 8, defense: 2, builder: 0, turret: 0 } : { attack: 58, intel: 10, defense: 12, builder: 10, turret: 10 };
  } else if (has("recon", "scout", "intel", "spot", "surveil", "vision", "eyes", "map")) {
    b = hard ? { attack: 12, intel: 73, defense: 5, builder: 10, turret: 0 } : { attack: 25, intel: 40, defense: 10, builder: 15, turret: 10 };
  } else if (has("eco", "econom", "expand", "artifact", "boom", "greed", "engineer", "income", "build up")) {
    b = hard ? { attack: 8, intel: 8, defense: 6, builder: 68, turret: 10 } : { attack: 20, intel: 12, defense: 12, builder: 45, turret: 11 };
  }
  // unit mix — if the order names a unit type, set EVERY camp to it (covers "ALL DEFENSE TANKS").
  const mixes: Record<string, Record<string, number>> = {};
  if (has("tank", "armor", "heavy", "humvee", "fast", "raid", "drone", "scout", "gunner", "infantry", "soldier", "rifle", "troops", "siege", "harass")) {
    const u = stubMix(latest);
    for (const c of ["aggressive", "recon", "defensive", "builder"]) mixes[c] = { ...u };
  }
  return { ...b, mixes, reason: "offline (no LLM)" };
}

/** The JSON contract handed to the LLM. Kept here so server + docs stay in sync. */
export const SPEC_SCHEMA_HINT = `Return ONLY a JSON object with these fields:
{
  "aggression": number 0..1,        // 0 = never initiates, 1 = attacks any enemy on sight
  "engageRange": integer 1..30,     // cells within which the unit will engage an enemy
  "retreatHealthPct": number 0..1,  // flee to base below this hp fraction; 0 = never flee
  "explorationBias": number 0..1,   // 0 = hug base/push enemy base, 1 = roam seeking the unknown
  "defendRadius": integer 2..20 or null, // leash to base in cells; null = free to roam
  "mix": { "gunner": number, "tank": number, "humvee": number, "drone": number } // relative weights of which unit types this camp TRAINS (drone = unarmed high-vision scout). Use whatever fits the general's intent; omit types you don't want.
}`;
