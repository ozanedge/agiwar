// The field general: a periodic, EVENT-GATED strategic commander.
//
// Cost discipline lives here. A naive "call an LLM every 15s per player, forever"
// loop is the single most expensive thing this game could do (~$8k/mo at 10 concurrent
// 24/7 on Sonnet). So this implementation:
//   1. uses Haiku 4.5 (≈3x cheaper than Sonnet) — doctrine-level commands don't need Sonnet
//   2. enforces a 30s minimum interval between calls (a floor, not a metronome)
//   3. is EVENT-GATED: it only calls the LLM when the battlefield has materially changed
//      since the last decision (losses, new enemy contacts, base damage). A stalemate or
//      idle field costs $0.
//   4. caches the static system prompt (Bedrock prompt caching)
// Net effect: from ~$8k/mo down to a few hundred for the same gameplay.
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { DoctrineId, FieldGeneralDecision } from "../../shared/types.js";
import { visionOf } from "../../shared/units.js";
import type { GameState } from "./sim.js";

const ENABLED = (process.env.FIELD_GENERAL ?? "on") !== "off";
const MIN_INTERVAL_MS = Number(process.env.FG_MIN_INTERVAL_MS ?? 30_000); // 30s floor
const REGION = process.env.AWS_REGION ?? "us-west-2";
const MODEL_ID = process.env.FG_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);

let client: BedrockRuntimeClient | null = null;
const bedrock = () => (client ??= new BedrockRuntimeClient({ region: REGION }));

const SYSTEM = `You are the FIELD GENERAL in a real-time strategy game, commanding one player's army.
Your three camps train troops with their own doctrines; you can issue a short, time-boxed override
that bends the whole army (or one camp) to the moment, after which troops REVERT to their training.
Given a battlefield report, decide the single best order — or hold if the doctrines are already handling it.
Respond with ONLY a JSON object:
{
  "action": "hold" | "rally" | "defend" | "push",   // hold = issue no override
  "target": "all" | "aggressive" | "recon" | "defensive",
  "durationSec": integer 5..30,
  "reason": "<= 8 words"
}
Prefer "hold" unless an override clearly helps. "push" = concentrate offense on the enemy base;
"defend"/"rally" = pull back to protect home base.`;

interface Summary {
  text: string;
  sig: string;
  ownCount: number;
  contacts: number;
  baseHpPct: number;
}

function summarize(g: GameState, player: number): Summary {
  const own = g.units.filter((u) => u.owner === player);
  const byCamp: Record<string, number> = { aggressive: 0, recon: 0, defensive: 0, builder: 0 };
  let hpSum = 0;
  for (const u of own) { if (u.camp) byCamp[u.camp]++; hpSum += u.hp / u.maxHp; }
  const myBase = g.bases[player];
  // enemy units seen by any of my units (each sees 3× its range)
  const contacts = g.units.filter(
    (e) => e.owner !== player && own.some((u) => Math.max(Math.abs(u.x - e.x), Math.abs(u.y - e.y)) <= visionOf(u.unit))
  );
  const baseHpPct = Math.round((myBase.hp / myBase.maxHp) * 100);
  const avgHp = own.length ? Math.round((hpSum / own.length) * 100) : 0;
  const overrideActive = own.some((u) => u.overrideUntil > g.tick);

  const text =
    `Your army: ${own.length} units (aggressive ${byCamp.aggressive}, recon ${byCamp.recon}, defensive ${byCamp.defensive}), avg hp ${avgHp}%.\n` +
    `Home base hp: ${baseHpPct}%.\n` +
    `Enemy contacts in sight: ${contacts.length}.\n` +
    `An override is currently ${overrideActive ? "ACTIVE" : "not active"}.`;

  // coarse buckets -> a "material change" signature. Small wiggles don't trigger a call.
  const sig = [
    Math.round(own.length / 2),
    contacts.length === 0 ? 0 : contacts.length <= 3 ? 1 : 2,
    Math.round(baseHpPct / 25),
    Math.round(avgHp / 25),
  ].join("/");

  return { text, sig, ownCount: own.length, contacts: contacts.length, baseHpPct };
}

function clampDecision(raw: any): FieldGeneralDecision {
  const actions = ["hold", "rally", "defend", "push"];
  const targets: (DoctrineId | "all")[] = ["all", "aggressive", "recon", "defensive"];
  return {
    action: actions.includes(raw?.action) ? raw.action : "hold",
    target: targets.includes(raw?.target) ? raw.target : "all",
    durationSec: Math.max(5, Math.min(30, Math.round(Number(raw?.durationSec) || 10))),
    reason: typeof raw?.reason === "string" ? raw.reason.slice(0, 60) : "",
  };
}

async function decide(summaryText: string, commandStyle: string): Promise<FieldGeneralDecision> {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 150,
    // Static rules go in the cached system block; the player's editable command style is
    // injected in the user turn so it doesn't bust the cached prefix. (cache_control only
    // bites above Bedrock's min cacheable size — today's savings come from Haiku + gating.)
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Your standing command doctrine:\n"""${commandStyle}"""\n\nBattlefield report:\n${summaryText}\n\nYour order (JSON only):`,
      },
    ],
  };
  const res = await bedrock().send(
    new InvokeModelCommand({ modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) })
  );
  const decoded = JSON.parse(new TextDecoder().decode(res.body));
  const text: string = decoded?.content?.[0]?.text ?? "";
  return clampDecision(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
}

type ApplyFn = (g: GameState, owner: number, kind: "rally" | "defend" | "push", target: DoctrineId | "all", durationTicks: number, label: string) => void;

/** One field general bound to one player. Holds its OWN gate state, so multiple rooms /
 *  players never share signatures or in-flight flags. */
export interface FieldGeneralRunner {
  maybe(g: GameState, apply: ApplyFn, notify: (text: string) => void): void;
  /** Force re-evaluation on the next eligible tick (still bounded by the 30s floor) —
   *  called when the player reauthors this general's doctrine. */
  resetGate(): void;
}

export function createFieldGeneral(player: number): FieldGeneralRunner {
  let lastSig: string | null = null;
  let lastCallMs = 0;
  let inFlight = false;

  return {
    resetGate() { lastSig = null; },
    maybe(g, apply, notify) {
      if (!ENABLED || inFlight) return;
      const sum = summarize(g, player);
      if (sum.ownCount === 0) return; // nothing to command

      const now = Date.now();
      if (sum.sig === lastSig) return; // EVENT GATE: no material change -> no LLM call, $0
      if (now - lastCallMs < MIN_INTERVAL_MS) return; // 30s floor even when things change

      lastCallMs = now;
      lastSig = sum.sig;
      inFlight = true;
      const obs = `${sum.ownCount}u · ${sum.contacts} contacts · base ${sum.baseHpPct}%`;
      decide(sum.text, g.players[player].fieldGeneral.prompt)
        .then((d) => {
          if (d.action === "hold") { notify(`${obs} → HOLD — ${d.reason || "doctrines handling it"}`); return; }
          apply(g, player, d.action, d.target, d.durationSec * TICK_HZ, `${d.action} (${d.reason || "field order"})`);
          notify(`${obs} → ${d.action.toUpperCase()} ${d.target} ${d.durationSec}s — ${d.reason}`);
        })
        .catch((err) => console.warn(`[fieldgeneral p${player}] skipped (${(err as Error).message})`))
        .finally(() => { inFlight = false; });
    },
  };
}
