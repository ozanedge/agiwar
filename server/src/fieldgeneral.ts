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
import type { GameState } from "./sim.js";

const ENABLED = (process.env.FIELD_GENERAL ?? "on") !== "off";
const MIN_INTERVAL_MS = Number(process.env.FG_MIN_INTERVAL_MS ?? 30_000); // 30s floor
const REGION = process.env.AWS_REGION ?? "us-west-2";
const MODEL_ID = process.env.FG_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);
const SENSOR = 14;
const PLAYER = 0; // field general commands the human player's army

let client: BedrockRuntimeClient | null = null;
const bedrock = () => (client ??= new BedrockRuntimeClient({ region: REGION }));

// orchestration state (NOT sim state — wall-clock gating is fine here)
let lastSig: string | null = null;
let lastCallMs = 0;
let inFlight = false;

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
}

function summarize(g: GameState): Summary {
  const own = g.units.filter((u) => u.owner === PLAYER);
  const byCamp: Record<string, number> = { aggressive: 0, recon: 0, defensive: 0 };
  let hpSum = 0;
  for (const u of own) { byCamp[u.camp]++; hpSum += u.hp / u.maxHp; }
  const myBase = g.bases[PLAYER];
  // enemy units seen by any of my units
  const contacts = g.units.filter(
    (e) => e.owner !== PLAYER && own.some((u) => Math.max(Math.abs(u.x - e.x), Math.abs(u.y - e.y)) <= SENSOR)
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

  return { text, sig, ownCount: own.length };
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

async function decide(summaryText: string): Promise<FieldGeneralDecision> {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 150,
    // cache_control future-proofs the static prompt; only bites once the prefix exceeds
    // Bedrock's min cacheable size, so today's savings come from Haiku + gating, not this.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Battlefield report:\n${summaryText}\n\nYour order (JSON only):` }],
  };
  const res = await bedrock().send(
    new InvokeModelCommand({ modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) })
  );
  const decoded = JSON.parse(new TextDecoder().decode(res.body));
  const text: string = decoded?.content?.[0]?.text ?? "";
  return clampDecision(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
}

type ApplyFn = (g: GameState, owner: number, kind: "rally" | "defend" | "push", target: DoctrineId | "all", durationTicks: number, label: string) => void;

/** Called every sim tick. Cheap by design: usually returns after the gate check without
 *  touching the network. Fires the LLM (async, non-blocking) only on a material change. */
export function maybeRunFieldGeneral(g: GameState, apply: ApplyFn, notify: (text: string) => void): void {
  if (!ENABLED || inFlight) return;
  const { text, sig, ownCount } = summarize(g);
  if (ownCount === 0) return; // nothing to command

  const now = Date.now();
  const changed = sig !== lastSig;
  if (!changed) return; // EVENT GATE: no material change -> no LLM call, $0
  if (now - lastCallMs < MIN_INTERVAL_MS) return; // 30s floor even when things are changing

  lastCallMs = now;
  lastSig = sig;
  inFlight = true;
  decide(text)
    .then((d) => {
      if (d.action === "hold") { notify(`Field general: holding — ${d.reason || "doctrines holding"}`); return; }
      const ticks = d.durationSec * TICK_HZ;
      apply(g, PLAYER, d.action, d.target, ticks, `${d.action} (${d.reason || "field order"})`);
      notify(`Field general → ${d.action} ${d.target} for ${d.durationSec}s — ${d.reason}`);
    })
    .catch((err) => console.warn(`[fieldgeneral] skipped (${(err as Error).message})`))
    .finally(() => { inFlight = false; });
}
