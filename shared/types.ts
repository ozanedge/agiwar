// Shared protocol + domain types for agiwar.
// Imported by both the server (tsx) and the web client (Vite) via relative path.

import type { UnitType } from "./units.js";

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
}

/** A transient weapon-fire event for the client to animate as a flying projectile. Sent in the
 *  state broadcast (fog-gated), not part of persistent state — purely cosmetic. */
export interface Shot {
  ax: number; ay: number; // attacker cell
  bx: number; by: number; // target cell at fire time
  hit: boolean; // did it connect (passed the accuracy roll)?
  kind: UnitType; // shooter type → projectile look
  owner: number; // shooter's player index → tracer color
}

export interface BaseState {
  owner: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

export type ArtifactBonusKind = "income" | "range" | "hp" | "damage";

/** A capturable map resource. Neutral (owner -1) until a player invests to claim it;
 *  then it grants a passive bonus + acts as a turret-build anchor, and can be attacked. */
export interface Artifact {
  id: number;
  x: number;
  y: number;
  owner: number; // -1 = neutral
  hp: number;
  maxHp: number;
  bonus: { kind: ArtifactBonusKind; amount: number; label: string };
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
  incomePerSec: number; // income rate incl. artifact bonuses
  units: UnitState[];
  bases: BaseState[];
  shots: Shot[]; // weapon fire since the last broadcast (fog-gated) — client animates projectiles
  artifacts: Artifact[]; // visible artifacts (fog-gated)
  bonuses: { income: number; range: number; hp: number; damage: number }; // recipient's total bonuses (artifacts + investments)
  invest: Record<ArtifactBonusKind, number>; // recipient's purchased investment levels
  queuedInvest: ArtifactBonusKind | null; // an upgrade the player has queued — all other spending pauses to save for it
  morale: number; // 0..1 team morale — low morale degrades unit speed + accuracy
  boosterCost: number; // current cost to buy a morale booster (scales with army size)
  armyDoctrine: string; // recipient's chosen build identity (id from shared/doctrine.ts); "balanced" until chosen
  rally: { x: number; y: number } | null; // recipient's active rally/commitment point (units concentrate here)
  you: number; // which player index this client controls
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
  | { type: "editPrompt"; camp: DoctrineId; prompt: string }
  | { type: "editFieldGeneral"; prompt: string } // reauthor the field general's command style
  | { type: "editAdvisor"; prompt: string } // reauthor the investment advisor's economic doctrine
  | { type: "setBudget"; camp: DoctrineId; budgetPct: number } // set a camp's share of income
  | { type: "setTurretBudget"; budgetPct: number } // set the % of income spent on turrets
  | { type: "setMix"; camp: DoctrineId; unit: UnitType; weight: number } // set a unit type's weight within a camp
  | { type: "build"; unit: UnitType; x: number; y: number } // place a building at a map tile
  | { type: "captureArtifact"; id: number } // invest to claim a neutral artifact
  | { type: "invest"; kind: ArtifactBonusKind } // buy the next level of a permanent army upgrade (immediate)
  | { type: "queueInvest"; kind: ArtifactBonusKind } // queue an upgrade — pause other spending and save up for it
  | { type: "cancelInvest" } // clear the queued upgrade and resume normal spending
  | { type: "fieldOrder"; order: FieldOrder } // manual time-boxed override (debug/UI)
  | { type: "chooseArmyDoctrine"; id: string } // pick the once-per-match build identity
  | { type: "decide"; id: number; key: string } // answer a commander's strategic fork
  | { type: "setRally"; x: number; y: number } // set a rally/commitment point (double-click the map)
  | { type: "skipToBot" } // stop waiting for a live opponent — start a single-player (bot) match now
  | { type: "buyBooster" }; // purchase a morale booster (cost scales with army size)

/** A field-general command: a *time-boxed override* of native doctrine.
 *  Units revert to their camp doctrine when `durationTicks` elapses. */
export interface FieldOrder {
  kind: "rally" | "defend" | "push";
  /** which units to affect: a camp, or "all". */
  target: DoctrineId | "all";
  durationTicks: number;
  label: string;
}
