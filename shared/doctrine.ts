// Army doctrines: a once-per-match BUILD IDENTITY the player picks. Each applies a small set of
// army-wide multipliers the sim reads (cost / hp / damage / speed / income / vision / high-ground /
// turret stats). They reshape what's *optimal* without adding micro — pick one, then commit to it.
// Pure data + helpers (no imports) so the server and client can both consume it.

export interface ArmyMods {
  costMult: number; // unit train cost
  hpMult: number; // spawned unit hp
  dmgMult: number; // attack damage
  speedMult: number; // move cadence multiplier — LOWER is faster
  incomeMult: number; // resource income
  visionMult: number; // sight radius
  highGroundMult: number; // amplifies the high-ground damage swing
  turretCostMult: number;
  turretHpMult: number;
  turretDmgMult: number;
}

export const DEFAULT_MODS: ArmyMods = {
  costMult: 1, hpMult: 1, dmgMult: 1, speedMult: 1, incomeMult: 1,
  visionMult: 1, highGroundMult: 1, turretCostMult: 1, turretHpMult: 1, turretDmgMult: 1,
};

export interface ArmyDoctrine {
  id: string;
  label: string;
  hint: string; // 2-4 word punchy summary for the picker chip
  blurb: string;
  mods: Partial<ArmyMods>;
}

export const ARMY_DOCTRINES: ArmyDoctrine[] = [
  { id: "balanced", label: "Combined Arms", hint: "Flexible · Forgiving",
    blurb: "No specialization. A steady, adaptable force with no glaring weakness.", mods: {} },
  { id: "vanguard", label: "Vanguard", hint: "Fast · Cheap · Fragile",
    blurb: "Blitz doctrine. Cheaper, faster units with less armor — overwhelm them before they're ready.",
    mods: { speedMult: 0.72, hpMult: 0.85, costMult: 0.88 } },
  { id: "bastion", label: "Bastion", hint: "Turtle · Turrets",
    blurb: "Siege doctrine. Cheap, tough, hard-hitting turrets and durable troops — fortify and grind.",
    mods: { turretCostMult: 0.55, turretHpMult: 1.6, turretDmgMult: 1.45, hpMult: 1.12, speedMult: 1.12 } },
  { id: "phantom", label: "Phantom", hint: "Recon · Raid",
    blurb: "Guerrilla doctrine. Far-seeing and hard-hitting but lightly armored — see first, strike, fade.",
    mods: { visionMult: 1.45, dmgMult: 1.18, hpMult: 0.9 } },
  { id: "highland", label: "Highland", hint: "Own the heights",
    blurb: "Mountain doctrine. A devastating high-ground bonus and sturdier troops — hold the ridges.",
    mods: { highGroundMult: 2.4, hpMult: 1.06 } },
  { id: "industry", label: "Industry", hint: "Eco · Tech",
    blurb: "Economist doctrine. Surging income to out-produce and out-tech the enemy over time.",
    mods: { incomeMult: 1.4 } },
];

export function modsFor(id: string | null | undefined): ArmyMods {
  const d = ARMY_DOCTRINES.find((x) => x.id === id);
  return d ? { ...DEFAULT_MODS, ...d.mods } : DEFAULT_MODS;
}
