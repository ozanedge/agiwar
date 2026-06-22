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

// Initial budget allocation a doctrine sets when chosen (% of income per camp + turret ring). The
// remainder up to 100 banks as savings (for upgrades). Aligns the opening economy with the strategy
// so e.g. Bastion starts pouring into turrets and Vanguard into the attack camp — the player can still
// retune the Sankey live afterward. Camp keys match the four camp ids (DoctrineId).
export interface ArmyBudget {
  aggressive: number; // Attack camp
  recon: number; // Intel camp
  defensive: number; // Defense camp
  builder: number; // Builder camp (artifact capture)
  turret: number; // auto-built turret ring
}
export const DEFAULT_BUDGET: ArmyBudget = { aggressive: 30, recon: 12, defensive: 15, builder: 10, turret: 10 }; // → 23% savings

export interface ArmyDoctrine {
  id: string;
  label: string;
  hint: string; // 2-4 word punchy summary for the picker chip
  blurb: string;
  mods: Partial<ArmyMods>;
  budget?: ArmyBudget; // opening Sankey allocation; falls back to DEFAULT_BUDGET (Combined Arms)
}

export const ARMY_DOCTRINES: ArmyDoctrine[] = [
  { id: "balanced", label: "Combined Arms", hint: "Flexible · Forgiving",
    blurb: "No specialization. A steady, adaptable force with no glaring weakness.", mods: {},
    budget: { aggressive: 30, recon: 12, defensive: 15, builder: 10, turret: 10 } }, // even spread, healthy savings
  { id: "vanguard", label: "Vanguard", hint: "Fast · Cheap · Fragile",
    blurb: "Blitz doctrine. Cheaper, faster units with less armor — overwhelm them before they're ready.",
    mods: { speedMult: 0.72, hpMult: 0.85, costMult: 0.88 },
    budget: { aggressive: 58, recon: 12, defensive: 4, builder: 6, turret: 2 } }, // dump it all into the attack camp
  { id: "bastion", label: "Bastion", hint: "Turtle · Turrets",
    blurb: "Siege doctrine. Cheap, tough, hard-hitting turrets and durable troops — fortify and grind.",
    mods: { turretCostMult: 0.55, turretHpMult: 1.6, turretDmgMult: 1.45, hpMult: 1.12, speedMult: 1.12 },
    budget: { aggressive: 14, recon: 8, defensive: 28, builder: 5, turret: 32 } }, // fortify: turrets + defense
  { id: "phantom", label: "Phantom", hint: "Recon · Raid",
    blurb: "Guerrilla doctrine. Far-seeing and hard-hitting but lightly armored — see first, strike, fade.",
    mods: { visionMult: 1.45, dmgMult: 1.18, hpMult: 0.9 },
    budget: { aggressive: 30, recon: 30, defensive: 6, builder: 12, turret: 4 } }, // eyes everywhere + raid force
  { id: "highland", label: "Highland", hint: "Own the heights",
    blurb: "Mountain doctrine. A devastating high-ground bonus and sturdier troops — hold the ridges.",
    mods: { highGroundMult: 2.4, hpMult: 1.06 },
    budget: { aggressive: 26, recon: 14, defensive: 30, builder: 6, turret: 12 } }, // dig into defensible ground
  { id: "industry", label: "Industry", hint: "Eco · Tech",
    blurb: "Economist doctrine. Surging income to out-produce and out-tech the enemy over time.",
    mods: { incomeMult: 1.4 },
    budget: { aggressive: 18, recon: 8, defensive: 10, builder: 18, turret: 4 } }, // → 42% savings: bank for upgrades + grab artifacts
];

export function modsFor(id: string | null | undefined): ArmyMods {
  const d = ARMY_DOCTRINES.find((x) => x.id === id);
  return d ? { ...DEFAULT_MODS, ...d.mods } : DEFAULT_MODS;
}

export function budgetFor(id: string | null | undefined): ArmyBudget {
  const d = ARMY_DOCTRINES.find((x) => x.id === id);
  return d?.budget ?? DEFAULT_BUDGET;
}
