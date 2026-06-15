// Shared protocol + domain types for agiwar.
// Imported by both the server (tsx) and the web client (Vite) via relative path.

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

export type DoctrineId = "aggressive" | "recon" | "defensive";

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
}

export interface UnitState {
  id: number;
  owner: number; // player index
  camp: DoctrineId; // which general trained it -> its NATIVE doctrine
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

export interface BaseState {
  owner: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
}

/** Full snapshot streamed server -> client each network tick. */
export interface Snapshot {
  type: "snapshot";
  tick: number;
  gridW: number;
  gridH: number;
  units: UnitState[];
  bases: BaseState[];
  camps: Camp[];
  you: number; // which player index this client controls
}

/** server -> client one-off notices (cooldown rejection, compile result, etc). */
export interface Notice {
  type: "notice";
  level: "info" | "error";
  text: string;
}

export type ServerMsg = Snapshot | Notice;

/** client -> server commands. Deliberately sparse — this is a low-APM game. */
export type ClientMsg =
  | { type: "editPrompt"; camp: DoctrineId; prompt: string }
  | { type: "spawn"; camp: DoctrineId } // train a unit at a camp
  | { type: "fieldOrder"; order: FieldOrder }; // field general (15s) -> time-boxed override

/** A field-general command: a *time-boxed override* of native doctrine.
 *  Units revert to their camp doctrine when `durationTicks` elapses. */
export interface FieldOrder {
  kind: "rally" | "defend" | "push";
  /** which units to affect: a camp, or "all". */
  target: DoctrineId | "all";
  durationTicks: number;
  label: string;
}
