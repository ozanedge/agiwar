// Strategic FORKS — the player's commander surfaces a meaningful choice at a key moment and waits
// for a one-tap answer (auto-resolving to a safe default on expiry). Low-stress, high-agency.
//
// Unlike the field general, this layer is fully DETERMINISTIC (no LLM): triggers read game state,
// and each option maps to a concrete effect (a time-boxed field order, a rally/commitment point, or
// an economy nudge). That keeps forks reliable as a game mechanic and free to run.
import type { DecisionPrompt } from "../../shared/types.js";
import { BASE_VISION, GRID_SCALE, visionOf } from "../../shared/units.js";
import { GameState, applyFieldOrder } from "./sim.js";

const TICK_HZ = Number(process.env.TICK_HZ ?? 10);
const MIN_INTERVAL = Number(process.env.DECISION_MIN_S ?? 28) * TICK_HZ; // floor between forks
const TTL_SEC = Number(process.env.DECISION_TTL_S ?? 20); // how long the player has to answer
const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

interface Opt { key: string; label: string; detail: string; run: () => void; refreshCamps?: boolean }
interface Pending { id: number; expiresTick: number; defaultKey: string; opts: Record<string, Opt>; tag: string }

export interface DecisionRunner {
  /** Called each tick: resolves an expired pending fork, else (gated) evaluates triggers and emits one. */
  maybe(g: GameState, emit: (d: DecisionPrompt) => void, log: (t: string) => void, refresh: () => void): void;
  /** Resolve the player's answer; returns true if it matched the live fork. */
  answer(g: GameState, id: number, key: string, log: (t: string) => void, refresh: () => void): boolean;
}

export function createDecisionRunner(player: number): DecisionRunner {
  let pending: Pending | null = null;
  let lastTick = -1e9;
  let nextId = 1;
  let lastTag = "";

  const resolve = (g: GameState, key: string, auto: boolean, log: (t: string) => void, refresh: () => void) => {
    if (!pending) return;
    const opt = pending.opts[key] ?? pending.opts[pending.defaultKey];
    opt?.run();
    log(`▸ ${opt?.label ?? "Hold"}${auto ? " (auto)" : ""}`);
    if (opt?.refreshCamps) refresh();
    pending = null;
  };

  return {
    answer(g, id, key, log, refresh) {
      if (!pending || pending.id !== id) return false;
      if (key === "dismiss") { log("▸ Stand by — no action"); pending = null; return true; } // explicit "do nothing": drop the fork, don't auto-resolve
      if (!pending.opts[key]) return false;
      resolve(g, key, false, log, refresh);
      return true;
    },
    maybe(g, emit, log, refresh) {
      if (pending && g.tick >= pending.expiresTick) resolve(g, pending.defaultKey, true, log, refresh);
      if (pending) return; // one fork at a time
      if (g.tick % 10 !== 0) return; // evaluate triggers ~1×/s
      if (g.tick - lastTick < MIN_INTERVAL) return;

      const own = g.units.filter((u) => u.owner === player);
      if (own.length === 0) return;
      const base = g.bases[player];
      const enemyBase = g.bases.find((b) => b.owner !== player);
      if (!enemyBase) return;
      const setRally = (x: number, y: number, sec: number) => { g.players[player].rally = { x, y, until: g.tick + sec * TICK_HZ }; };
      const fromLabel = g.players[player].fieldGeneral.label;

      let built: { question: string; opts: Opt[]; defaultKey: string; tag: string } | null = null;

      // (1) BASE THREAT — enemies massing on home, or the base taking damage.
      const threat = g.units.filter((e) => e.owner !== player && cheb(e.x, e.y, base.x, base.y) <= BASE_VISION).length;
      const baseHurt = base.hp < base.maxHp * 0.8;
      if ((threat >= 3 || baseHurt) && lastTag !== "threat") {
        built = {
          tag: "threat",
          question: `⚠ Enemy pressure on our base (${threat} in sight, base ${Math.round((base.hp / base.maxHp) * 100)}%). Orders?`,
          defaultKey: "hold",
          opts: [
            { key: "hold", label: "Hold the line", detail: "Dig in and defend home", run: () => { g.players[player].rally = null; applyFieldOrder(g, player, "defend", "all", 18 * TICK_HZ, "hold the line"); } },
            { key: "counter", label: "Counter-attack", detail: "Push them off our ground", run: () => { g.players[player].rally = null; applyFieldOrder(g, player, "push", "all", 16 * TICK_HZ, "counter-attack"); } },
            { key: "fortify", label: "Fall back & fortify", detail: "Defend + build more turrets", refreshCamps: true, run: () => { g.players[player].rally = null; applyFieldOrder(g, player, "defend", "all", 20 * TICK_HZ, "fortify"); g.players[player].turretBudget = Math.min(60, g.players[player].turretBudget + 12); } },
          ],
        };
      }

      // (2) OBJECTIVE LIVE — a neutral relay is up; commit, scout, or ignore. (the commitment call, #5)
      if (!built) {
        const neutral = g.artifacts.filter((a) => a.owner < 0);
        if (neutral.length && lastTag !== "objective") {
          // pick the most valuable, then nearest-to-us as tiebreak
          neutral.sort((a, b) => b.bonus.amount - a.bonus.amount || cheb(a.x, a.y, base.x, base.y) - cheb(b.x, b.y, base.x, base.y));
          const a = neutral[0];
          built = {
            tag: "objective",
            question: `A ${a.bonus.label} relay is live to the ${dirLabel(base.x, base.y, a.x, a.y)}. Commit?`,
            defaultKey: "scout",
            opts: [
              { key: "commit", label: "Commit the main force", detail: "Concentrate the army on it", run: () => { setRally(a.x, a.y, 30); applyFieldOrder(g, player, "push", "all", 24 * TICK_HZ, "take the relay"); } },
              { key: "scout", label: "Send scouts only", detail: "Let recon & builders handle it", run: () => { g.players[player].rally = null; } },
              { key: "ignore", label: "Ignore — push their base", detail: "Race for the enemy base instead", run: () => { setRally(enemyBase.x, enemyBase.y, 26); applyFieldOrder(g, player, "push", "all", 24 * TICK_HZ, "all-in push"); } },
            ],
          };
        }
      }

      // (3) STALEMATE — quiet front, even-ish; press, scout, or bank.
      if (!built) {
        const contacts = g.units.filter((e) => e.owner !== player && own.some((u) => cheb(u.x, u.y, e.x, e.y) <= visionOf(u.unit))).length;
        if (contacts === 0 && own.length >= 4 && lastTag !== "quiet") {
          built = {
            tag: "quiet",
            question: `The front's gone quiet — ${own.length} units idle. Your call, commander.`,
            defaultKey: "scout",
            opts: [
              { key: "press", label: "Press the attack", detail: "March on the enemy base", run: () => { setRally(enemyBase.x, enemyBase.y, 26); applyFieldOrder(g, player, "push", "all", 22 * TICK_HZ, "press the attack"); } },
              { key: "scout", label: "Scout wide", detail: "Find their forces & relays", run: () => { g.players[player].rally = null; } },
              { key: "bank", label: "Bank & upgrade", detail: "Shift to savings + turrets", refreshCamps: true, run: () => { const p = g.players[player]; const agg = p.camps.find((c) => c.id === "aggressive"); if (agg) agg.production.budgetPct = Math.max(0, agg.production.budgetPct - 10); p.turretBudget = Math.min(60, p.turretBudget + 10); } },
            ],
          };
        }
      }

      if (!built) return;
      lastTick = g.tick;
      lastTag = built.tag;
      const id = nextId++;
      pending = { id, expiresTick: g.tick + TTL_SEC * TICK_HZ, defaultKey: built.defaultKey, tag: built.tag, opts: Object.fromEntries(built.opts.map((o) => [o.key, o])) };
      emit({ type: "decision", id, fromLabel, question: built.question, options: built.opts.map(({ key, label, detail }) => ({ key, label, detail })), expiresInSec: TTL_SEC });
      log(`❓ ${built.question}`);
    },
  };
}

// rough compass label of (x,y) relative to the player's base (gy↓ = "north"/toward enemy)
function dirLabel(bx: number, by: number, x: number, y: number): string {
  const t = 10 * GRID_SCALE;
  const ns = y < by - t ? "north" : y > by + t ? "south" : "";
  const ew = x > bx + t ? "east" : x < bx - t ? "west" : "";
  return [ns, ew].filter(Boolean).join("-") || "center";
}
