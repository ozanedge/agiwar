// The Investment Advisor: a prompt-driven economic agent. Like the field general, it's
// event-gated + Haiku-backed, so it's cheap. It reads the player's economic doctrine and
// the current economy, then sets the budget allocation and buys investments.
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { INVESTMENTS, UNIT_STATS, UnitType, trainableFor } from "../../shared/units.js";
import { stubAdvise } from "../../shared/spec.js";
import { budgetFor } from "../../shared/doctrine.js";
import { GameState, INCOME_PER_TICK, playerBonus, DEFAULT_ADVISOR_PROMPT } from "./sim.js";

// the chosen army doctrine's opening allocation, mapped to the advisor's camp keys — the economy's
// default stance, so each doctrine drives a drastically different budget (even with the LLM offline).
const docBudget = (id: string) => { const b = budgetFor(id); return { attack: b.aggressive, intel: b.recon, defense: b.defensive, builder: b.builder, turret: b.turret }; };
import { latestOrder } from "./compiler.js";

const ENABLED = (process.env.ADVISOR ?? "on") !== "off";
const MIN_INTERVAL_MS = Number(process.env.ADVISOR_MIN_INTERVAL_MS ?? 20_000);
const REGION = process.env.AWS_REGION ?? "us-west-2";
const MODEL_ID = process.env.ADVISOR_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);

let client: BedrockRuntimeClient | null = null;
const bedrock = () => (client ??= new BedrockRuntimeClient({ region: REGION }));

const SYSTEM = `You are the INVESTMENT ADVISOR for one side in a real-time strategy game. You run the war \
economy AND set the army's production. Faithfully follow the player's doctrine. Respond with ONLY JSON:
{
  "attack": integer 0..100, "intel": integer 0..100, "defense": integer 0..100,
  "builder": integer 0..100, "turret": integer 0..100,   // % of income per budget; rest banks as savings. Keep the sum <= 100.
  "mix": { "attack": UNITS|null, "intel": UNITS|null, "defense": UNITS|null, "builder": UNITS|null } | null,
  "reason": "<= 8 words"
}
where UNITS = an object of unit-key→weight. Use ONLY the exact unit keys listed under "Trainable units" in the report below — they differ by faction.
Each budget is a CAMP (a behavior doctrine) that can train ANY of the army's unit types — they are independent. \
"attack"=aggressive doctrine, "intel"=recon doctrine, "defense"=defensive doctrine, "builder"=engineers (claim outposts), "turret"=auto-built defenses.
"mix" sets each camp's unit composition SEPARATELY. Obey composition orders precisely (using the army's own unit keys):
 - "<unit> only" => set EVERY camp to {"<unitKey>":100}
 - "attack heavies, intel scouts" => set each named camp to {"<that unit's key>":100}
Omit a camp to leave it unchanged; mix=null leaves all camps as-is.`;

interface Summary { text: string; sig: string }

function summarize(g: GameState, player: number): Summary {
  const p = g.players[player];
  const own = g.units.filter((u) => u.owner === player);
  const base = g.bases[player];
  const baseHp = Math.round((base.hp / base.maxHp) * 100);
  const arts = g.outposts.filter((a) => a.owner === player).length;
  const neutralArts = g.outposts.filter((a) => a.owner < 0).length;
  const incomeS = INCOME_PER_TICK * TICK_HZ + playerBonus(g, player).income;
  const camp = (id: string) => p.camps.find((c) => c.id === id)!.production.budgetPct;
  const budgets = `attack ${camp("aggressive")}% intel ${camp("recon")}% defense ${camp("defensive")}% builder ${camp("builder")}% turret ${p.turretBudget}%`;
  const inv = INVESTMENTS.map((i) => `${i.label} Lv${p.invest[i.kind]}`).join(", ");
  const TR = trainableFor(p.faction);
  const comp = TR.map((u) => `${u} ${own.filter((o) => o.unit === u).length}`).join(", ");
  const mixStr = (id: string) => { const m = p.camps.find((c) => c.id === id)!.production.mix; const parts = TR.filter((u) => m[u]).map((u) => `${u}${m[u]}`); return parts.length ? parts.join("/") : "—"; };
  const roster = TR.map((u) => `${u} (${UNIT_STATS[u].label}: ${UNIT_STATS[u].blurb})`).join(", ");
  const text =
    `Faction: ${p.faction === "openai" ? "OpenAI" : "Anthropic"}. Trainable units: ${roster}. ` +
    `Banked resources: ${Math.floor(p.resources)}. Income ~${incomeS}/s. Army: ${own.length} units (${comp}). ` +
    `Home base hp: ${baseHp}%. Outposts held: ${arts} (${neutralArts} unclaimed on map). ` +
    `Current budgets: ${budgets}. Current camp production — attack:${mixStr("aggressive")} intel:${mixStr("recon")} defense:${mixStr("defensive")} builder:${mixStr("builder")}. Upgrades: ${inv}.`;
  const sig = [Math.round(p.resources / 200), Math.round(own.length / 4), Math.round(baseHp / 25), arts, Math.min(3, neutralArts)].join("/");
  return { text, sig };
}

const clampPct = (n: any) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

interface Allocation { attack: number; intel: number; defense: number; builder: number; turret: number; mixes: Record<string, Record<string, number>>; reason: string; }

async function decide(summaryText: string, doctrine: string, armyDoctrine: string, trainable: UnitType[]): Promise<Allocation> {
  try {
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 200,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `Army doctrine for this match: "${armyDoctrine}" — its opening budget stance is ${JSON.stringify(docBudget(armyDoctrine))}; honor it unless the player's orders say otherwise.\n\nEconomic doctrine (chronological):\n"""${doctrine}"""\n\nThe player's MOST RECENT directive — weight it heavily; it overrides earlier notes on conflict:\n"${latestOrder(doctrine)}"\n\nEconomic report:\n${summaryText}\n\nYour allocation (JSON only):` }],
    };
    const res = await bedrock().send(
      new InvokeModelCommand({ modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) })
    );
    const decoded = JSON.parse(new TextDecoder().decode(res.body));
    const t: string = decoded?.content?.[0]?.text ?? "";
    const raw = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    // PER-CAMP unit mix: each budget is its own camp that can train any unit type independently
    const CAMP_OF: Record<string, string> = { attack: "aggressive", intel: "recon", defense: "defensive", builder: "builder" };
    const mixes: Record<string, Record<string, number>> = {};
    if (raw.mix && typeof raw.mix === "object") {
      for (const key of Object.keys(CAMP_OF)) {
        const mm = (raw.mix as any)[key];
        if (!mm || typeof mm !== "object") continue;
        const m: Record<string, number> = {}; let tot = 0;
        for (const u of trainable) { const w = Math.max(0, Math.round(Number(mm[u]) || 0)); if (w > 0) { m[u] = w; tot += w; } }
        if (tot > 0) mixes[CAMP_OF[key]] = m;
      }
    }
    return {
      attack: clampPct(raw.attack), intel: clampPct(raw.intel), defense: clampPct(raw.defense),
      builder: clampPct(raw.builder), turret: clampPct(raw.turret), mixes,
      reason: typeof raw.reason === "string" ? raw.reason.slice(0, 60) : "",
    };
  } catch (err) {
    // Bedrock down (e.g. no AWS creds) → deterministic offline advisor so orders still move the economy.
    // Defaults to the army doctrine's profile, so doctrine choice drives the economy even with no LLM.
    console.warn(`[advisor] Bedrock unavailable, using stub: ${(err as Error).message}`);
    // only keyword-match a REAL player order; with just the default prompt, follow the doctrine base
    // (the default prompt's own words like "attack"/"defense" must not masquerade as a player directive).
    const order = doctrine.trim() === DEFAULT_ADVISOR_PROMPT.trim() ? "" : latestOrder(doctrine);
    return stubAdvise(order, docBudget(armyDoctrine));
  }
}

export interface AdvisorRunner {
  maybe(g: GameState, notify: (text: string) => void, onChange: () => void): void;
  resetGate(): void;
}

export function createAdvisor(player: number): AdvisorRunner {
  let lastSig: string | null = null, lastCallMs = 0, inFlight = false;
  return {
    resetGate() { lastSig = null; lastCallMs = 0; }, // a new order applies NOW: drop the signature gate AND the min-interval floor
    maybe(g, notify, onChange) {
      if (!ENABLED || inFlight) return;
      const sum = summarize(g, player);
      const now = Date.now();
      if (sum.sig === lastSig) return; // event-gated: no material economic change -> no call
      if (now - lastCallMs < MIN_INTERVAL_MS) return;
      lastCallMs = now; lastSig = sum.sig; inFlight = true;
      decide(sum.text, g.players[player].advisor.prompt, g.players[player].armyDoctrine, trainableFor(g.players[player].faction))
        .then((d) => {
          const p = g.players[player];
          // scale so total allocation never exceeds 100 (remainder = savings)
          const total = d.attack + d.intel + d.defense + d.builder + d.turret;
          const s = total > 100 ? 100 / total : 1;
          const set = (id: string, v: number) => { const c = p.camps.find((c) => c.id === id); if (c) c.production.budgetPct = Math.round(v * s); };
          set("aggressive", d.attack); set("recon", d.intel); set("defensive", d.defense); set("builder", d.builder);
          p.turretBudget = Math.round(d.turret * s);
          // per-camp production: retool any camp the advisor specified (each camp can train any unit
          // type — "attack tanks, defense gunners" etc). Upgrades remain the player's call.
          let mixNote = "";
          for (const c of p.camps) if (d.mixes[c.id]) c.production.mix = { ...d.mixes[c.id] };
          const changed = p.camps.filter((c) => d.mixes[c.id]);
          if (changed.length) mixNote = " · " + changed.map((c) => `${c.id.slice(0, 3)}=${trainableFor(p.faction).filter((u) => d.mixes[c.id]![u]).map((u) => UNIT_STATS[u].label[0]).join("")}`).join(",");
          notify(`Advisor: A${Math.round(d.attack * s)} I${Math.round(d.intel * s)} D${Math.round(d.defense * s)} B${Math.round(d.builder * s)} T${Math.round(d.turret * s)}${mixNote} — ${d.reason}`);
          onChange(); // push the new allocation to the client's Sankey
        })
        .catch((err) => console.warn(`[advisor p${player}] skipped (${(err as Error).message})`))
        .finally(() => { inFlight = false; });
    },
  };
}
