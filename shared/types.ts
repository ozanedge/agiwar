// Shared protocol + domain types for agiwar.
// Imported by both the server (tsx) and the web client (Vite) via relative path.

import type { UnitType, Faction } from "./units.js";

/** A clamped behavior spec — the *compiled* output of a general's natural-language style.
 *  This is the contract between the LLM "policy compiler" and the deterministic sim.
 *  Nothing outside these fields can influence a unit, so a hostile prompt cannot
 *  break game balance (it can only move these dials within their clamped ranges). */
export interface BehaviorSpec {
  /** 0 = never initiates, 1 = pursues any enemy on sight. */
  aggression: number;
  /** How close (in grid cells) an enemy must be before this unit will engage it. */
  engageRange: number;
  /** Flee toward own base when hp/maxHp drops below this fraction. 0 = never flee. */
  retreatHealthPct: number;
  /** 0 = hug base / push enemy base, 1 = roam the map seeking unexplored cells. */
  explorationBias: number;
  /** If set, the unit only engages enemies within this many cells of its own base,
   *  and otherwise returns to guard. null = no leash (free to roam/attack). */
  defendRadius: number | null;
}

export type DoctrineId = "aggressive" | "recon" | "defensive" | "builder";

/** A camp general. Its `prompt` compiles to `spec`, which becomes the *native* doctrine
 *  of every unit trained at this camp. Edits are throttled by `cooldownUntil`. */
export interface Camp {
  id: DoctrineId;
  label: string;
  prompt: string;
  spec: BehaviorSpec;
  /** ms epoch; client may edit the prompt again only after this time. */
  cooldownUntil: number;
  /** true while a compile is in flight (client shows a spinner, blocks edits). */
  compiling: boolean;
  /** continuous production: spend budgetPct% of income, split across unit types by `mix`
   *  (weights; each camp's spend on a unit = income · budgetPct% · weight/Σweights). */
  production: { budgetPct: number; mix: Partial<Record<UnitType, number>> };
}

export interface UnitState {
  id: number;
  owner: number; // player index
  camp: DoctrineId | null; // trained doctrine; null for buildings (placed, not trained)
  unit: UnitType; // gunner / tank / humvee -> stats (hp, speed, damage)
  dx: number; // facing direction (grid units, -1..1) — for sprite orientation
  dy: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** tick at which a field-general override expires and the unit reverts to native.
   *  0 = no override active (behaving on native doctrine). */
  overrideUntil: number;
  /** short label of the active override, for the client readout. "" when native. */
  overrideLabel: string;
  // ULTIMATE-spawned elites + status effects (all optional; absent on normal units)
  scale?: number; // render size multiplier (mammoth/titan look big)
  dmgMult?: number; // attack-damage multiplier
  slowMult?: number; // move-cadence multiplier (>1 = slower)
  regen?: number; // hp regenerated per tick
  disabledUntil?: number; // tick until which the unit is frozen (stasis) — can't move or fire
}

/** A transient weapon-fire event for the client to animate as a flying projectile. Sent in the
 *  state broadcast (fog-gated), not part of persistent state — purely cosmetic. */
export interface Shot {
  ax: number; ay: number; // attacker cell
  bx: number; by: number; // target cell at fire time
  hit: boolean; // did it connect (passed the accuracy roll)?
  kind: UnitType; // shooter type → projectile look
  owner: number; // shooter's player index → tracer color
  scale?: number; // shooter render scale (elites) → muzzle offset & projectile size track the art
  tid?: number; // target unit id (if the target is a unit) → homing missiles track its live position
}

export interface Death {
  x: number; y: number; // cell where it died
  kind: UnitType; // unit type → death effect (vehicles explode w/ shrapnel; gunners fall over)
  owner: number;
  id: number; // matches the client's unit view, so its art can drive the death animation
  scale?: number; // unit render scale (elites) → bigger units leave a bigger blast
}

export interface BaseState {
  owner: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

export type OutpostBonusKind = "income" | "range" | "hp" | "damage" | "armor" | "speed";

/** A capturable map resource. Neutral (owner -1) until a player invests to claim it;
 *  then it grants a passive bonus + acts as a turret-build anchor, and can be attacked. */
export interface Outpost {
  id: number;
  x: number;
  y: number;
  owner: number; // -1 = neutral
  hp: number;
  maxHp: number;
  bonus: { kind: OutpostBonusKind; amount: number; label: string };
  capProgress: number; // 0..1 capture channel progress while neutral (client shows a spindown)
  capOwner: number; // player currently channeling the capture (-1 = none)
}

/** A collectible ARTIFACT that drops near a player's base and auto-harvests into their inventory. */
export interface ArtifactDrop {
  id: number;
  owner: number; // whose base it spawned near — only they can harvest it
  type: number; // 0..4 (index into ARTIFACTS)
  x: number;
  y: number;
  harvestAt: number; // tick the pickup completes once a friendly unit/base is in range (0 = not yet started)
}

/** A forged ultimate the player has active, with its cooldown for the HUD ring. */
export interface ActiveUltimate {
  id: string; // ULTIMATES key
  cooldown: number; // 0..1 progress toward the next firing (1 = about to fire)
}

/** A transient ultimate-effect event for the client to animate (fog-gated like shots/deaths). */
export interface UltimateFx {
  kind: string; // jet / meteor / orbital / ion / singularity / gunship / locust / stasis / plague / nanite / spawn
  x: number;
  y: number;
  owner: number;
}

/** Lightweight world state, broadcast at the (lower) network rate. Deliberately
 *  excludes camps — those are static between edits, so shipping their prompt strings
 *  every tick was pure egress waste. */
export interface StateMsg {
  type: "state";
  tick: number;
  gridW: number;
  gridH: number;
  seed: number; // per-match map seed -> deterministic shared terrain
  resources: number; // this client's resource total (floored)
  incomePerSec: number; // income rate incl. outpost bonuses
  units: UnitState[];
  bases: BaseState[];
  shots: Shot[]; // weapon fire since the last broadcast (fog-gated) — client animates projectiles
  deaths: Death[]; // units that died since the last broadcast (fog-gated) — client animates death FX
  outposts: Outpost[]; // visible outposts (fog-gated)
  bonuses: { income: number; range: number; hp: number; damage: number; armor: number; speed: number }; // recipient's total bonuses (outposts + investments)
  invest: Record<OutpostBonusKind, number>; // recipient's purchased investment levels
  queuedInvest: OutpostBonusKind | null; // an upgrade the player has queued — all other spending pauses to save for it
  morale: number; // 0..1 team morale — low morale degrades unit speed + accuracy
  boosterCost: number; // current cost to buy a morale booster (scales with army size)
  armyDoctrine: string; // recipient's chosen build identity (id from shared/doctrine.ts); "balanced" until chosen
  rally: { x: number; y: number } | null; // recipient's active rally/commitment point (units concentrate here)
  sandstorm: { progress: number; secsLeft: number } | null; // active board-clearing storm: 0..1 intensity + countdown
  drops: ArtifactDrop[]; // this client's un-harvested artifact drops on the map
  artifacts: number[]; // this client's harvested inventory: count per artifact type (length 5)
  ultimates: ActiveUltimate[]; // this client's forged ultimates (id + cooldown progress)
  ufx: UltimateFx[]; // ultimate-effect events since the last broadcast (fog-gated) — client animates
  you: number; // which player index this client controls
  faction: Faction; // recipient's faction (Anthropic/OpenAI) — drives the roster + ultimate units they get
  factions: Faction[]; // faction per player index — lets the client tint/identify each side's units
}

/** The field general's editable command doctrine. Unlike a camp, this prompt is NOT
 *  compiled to a spec — it's injected into the field general's decision call as the
 *  player's standing command style, so it has no cooldown (editing triggers no compile). */
export interface FieldGeneral {
  label: string;
  prompt: string;
}

/** Camp doctrines + field-general doctrine, sent only when they change + once on connect. */
export interface CampsMsg {
  type: "camps";
  camps: Camp[];
  fieldGeneral: FieldGeneral;
  advisor: FieldGeneral; // investment advisor (same {label,prompt} shape)
  turretBudget: number; // % of income spent auto-building turrets (separate from savings)
  activeOrder: string | null; // the field general's active tactic label (persists until cancelled), or null
}

/** server -> client one-off notices (cooldown rejection, compile result, field order, etc). */
export interface Notice {
  type: "notice";
  level: "info" | "error";
  text: string;
}

/** A field-general observation/decision, streamed to the command-log panel. */
export interface FieldLog {
  type: "fieldlog";
  text: string;
  tick: number;
}

/** Sent to each player when the match ends. */
export interface GameOver {
  type: "gameover";
  won: boolean;
}

/** Sent once on connect: prompt the player to pick a one-per-match army doctrine (build identity).
 *  The full option list is static (shared/doctrine.ts ARMY_DOCTRINES); this just opens the picker. */
export interface DoctrineOffer {
  type: "doctrineOffer";
  current: string; // currently-applied doctrine id (defaults to "balanced" until chosen)
  faction: Faction; // currently-selected faction (defaults to "anthropic" until chosen)
}

/** A strategic FORK the player's commander surfaces at a key moment. The player answers with one
 *  option (or it auto-resolves to `defaultKey` on expiry) — low-stress, high-impact agency. */
export interface DecisionPrompt {
  type: "decision";
  id: number;
  fromLabel: string; // which commander is asking, e.g. "Field Gen. Mercer"
  question: string;
  options: { key: string; label: string; detail: string }[];
  expiresInSec: number;
}

export type ServerMsg = StateMsg | CampsMsg | Notice | FieldLog | GameOver | DoctrineOffer | DecisionPrompt;

/** The field general's structured decision (LLM output, clamped before use).
 *  "hold" = issue no order; units keep running their native doctrine. */
export interface FieldGeneralDecision {
  action: "hold" | "rally" | "defend" | "push";
  target: DoctrineId | "all";
  durationSec: number;
  reason: string;
}

/** client -> server commands. Deliberately sparse — this is a low-APM game. */
export type ClientMsg =
  | { type: "command"; text: string } // ONE order broadcast to the whole staff; each commander applies the part relevant to its role
  | { type: "editPrompt"; camp: DoctrineId; prompt: string }
  | { type: "editFieldGeneral"; prompt: string } // reauthor the field general's command style
  | { type: "editAdvisor"; prompt: string } // reauthor the investment advisor's economic doctrine
  | { type: "setBudget"; camp: DoctrineId; budgetPct: number } // set a camp's share of income
  | { type: "setTurretBudget"; budgetPct: number } // set the % of income spent on turrets
  | { type: "setMix"; camp: DoctrineId; unit: UnitType; weight: number } // set a unit type's weight within a camp
  | { type: "build"; unit: UnitType; x: number; y: number } // place a building at a map tile
  | { type: "captureOutpost"; id: number } // invest to claim a neutral outpost
  | { type: "invest"; kind: OutpostBonusKind } // buy the next level of a permanent army upgrade (immediate)
  | { type: "queueInvest"; kind: OutpostBonusKind } // queue an upgrade — pause other spending and save up for it
  | { type: "cancelInvest" } // clear the queued upgrade and resume normal spending
  | { type: "fieldOrder"; order: FieldOrder } // manual override (debug/UI)
  | { type: "cancelFieldOrder" } // clear the field general's active tactic — units revert to native doctrine
  | { type: "chooseArmyDoctrine"; id: string; faction?: Faction } // pick the once-per-match build identity + faction
  | { type: "decide"; id: number; key: string } // answer a commander's strategic fork
  | { type: "setRally"; x: number; y: number } // set a rally/commitment point (double-click the map)
  | { type: "skipToBot" } // stop waiting for a live opponent — start a single-player (bot) match now
  | { type: "buyBooster" } // purchase a morale booster (cost scales with army size)
  | { type: "forgeUltimate"; a: number; b: number }; // combine two harvested artifact types into an ultimate

/** A field-general command: a *time-boxed override* of native doctrine.
 *  Units revert to their camp doctrine when `durationTicks` elapses. */
export interface FieldOrder {
  kind: "rally" | "defend" | "push";
  /** which units to affect: a camp, or "all". */
  target: DoctrineId | "all";
  durationTicks: number;
  label: string;
}
