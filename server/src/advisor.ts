// The Investment Advisor: a prompt-driven economic agent. Like the field general, it's
// event-gated + Haiku-backed, so it's cheap. It reads the player's economic doctrine and
// the current economy, then sets the budget allocation and buys investments.
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { INVESTMENTS, TRAINABLE, UnitType } from "../../shared/units.js";
import { GameState, INCOME_PER_TICK, playerBonus } from "./sim.js";
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
  "mix": { "gunner": int, "tank": int, "humvee": int, "drone": int } | null,
  "reason": "<= 8 words"
}
Budgets: attack=offensive units, intel=recon drones, defense=defensive units, builder=engineers that claim artifacts, turret=auto-built defenses.
"mix" sets the WHOLE ARMY's unit composition (relative weights). USE IT to obey composition orders: \
"tanks only" => {"tank":100}; "more drones" => boost drone; etc. null = leave each camp's current choice. \
ALSO bias budgets toward the camp that fields the requested unit (tanks=defense, drones=intel, gunners=attack, humvees=builder).
Unit types: gunner=balanced infantry, tank=strong/slow, humvee=fast/weak, drone=unarmed scout (huge vision).`;

interface Summary { text: string; sig: string }

function summarize(g: GameState, player: number): Summary {
  const p = g.players[player];
  const own = g.units.filter((u) => u.owner === player);
  const base = g.bases[player];
  const baseHp = Math.round((base.hp / base.maxHp) * 100);
  const arts = g.artifacts.filter((a) => a.owner === player).length;
  const neutralArts = g.artifacts.filter((a) => a.owner < 0).length;
  const incomeS = INCOME_PER_TICK * TICK_HZ + playerBonus(g, player).income;
  const camp = (id: string) => p.camps.find((c) => c.id === id)!.production.budgetPct;
  const budgets = `attack ${camp("aggressive")}% intel ${camp("recon")}% defense ${camp("defensive")}% builder ${camp("builder")}% turret ${p.turretBudget}%`;
  const inv = INVESTMENTS.map((i) => `${i.label} Lv${p.invest[i.kind]}`).join(", ");
  const comp = TRAINABLE.map((u) => `${u} ${own.filter((o) => o.unit === u).length}`).join(", ");
  const text =
    `Banked resources: ${Math.floor(p.resources)}. Income ~${incomeS}/s. Army: ${own.length} units (${comp}). ` +
    `Home base hp: ${baseHp}%. Artifacts held: ${arts} (${neutralArts} unclaimed on map). ` +
    `Current budgets: ${budgets}. Upgrades: ${inv}.`;
  const sig = [Math.round(p.resources / 200), Math.round(own.length / 4), Math.round(baseHp / 25), arts, Math.min(3, neutralArts)].join("/");
  return { text, sig };
}

const clampPct = (n: any) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

async function decide(summaryText: string, doctrine: string) {
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 200,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Economic doctrine (chronological):\n"""${doctrine}"""\n\nThe player's MOST RECENT directive — weight it heavily; it overrides earlier notes on conflict:\n"${latestOrder(doctrine)}"\n\nEconomic report:\n${summaryText}\n\nYour allocation (JSON only):` }],
  };
  const res = await bedrock().send(
    new InvokeModelCommand({ modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) })
  );
  const decoded = JSON.parse(new TextDecoder().decode(res.body));
  const t: string = decoded?.content?.[0]?.text ?? "";
  const raw = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  // army-wide unit mix (weights over trainable types); null if the advisor leaves camps as-is
  let mix: Partial<Record<UnitType, number>> | null = null;
  if (raw.mix && typeof raw.mix === "object") {
    const m: Partial<Record<UnitType, number>> = {}; let tot = 0;
    for (const u of TRAINABLE) { const w = Math.max(0, Math.round(Number((raw.mix as any)[u]) || 0)); if (w > 0) { m[u] = w; tot += w; } }
    if (tot > 0) mix = m;
  }
  return {
    attack: clampPct(raw.attack), intel: clampPct(raw.intel), defense: clampPct(raw.defense),
    builder: clampPct(raw.builder), turret: clampPct(raw.turret), mix,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 60) : "",
  };
}

export interface AdvisorRunner {
  maybe(g: GameState, notify: (text: string) => void, onChange: () => void): void;
  resetGate(): void;
}

export function createAdvisor(player: number): AdvisorRunner {
  let lastSig: string | null = null, lastCallMs = 0, inFlight = false;
  return {
    resetGate() { lastSig = null; },
    maybe(g, notify, onChange) {
      if (!ENABLED || inFlight) return;
      const sum = summarize(g, player);
      const now = Date.now();
      if (sum.sig === lastSig) return; // event-gated: no material economic change -> no call
      if (now - lastCallMs < MIN_INTERVAL_MS) return;
      lastCallMs = now; lastSig = sum.sig; inFlight = true;
      decide(sum.text, g.players[player].advisor.prompt)
        .then((d) => {
          const p = g.players[player];
          // scale so total allocation never exceeds 100 (remainder = savings)
          const total = d.attack + d.intel + d.defense + d.builder + d.turret;
          const s = total > 100 ? 100 / total : 1;
          const set = (id: string, v: number) => { const c = p.camps.find((c) => c.id === id); if (c) c.production.budgetPct = Math.round(v * s); };
          set("aggressive", d.attack); set("recon", d.intel); set("defensive", d.defense); set("builder", d.builder);
          p.turretBudget = Math.round(d.turret * s);
          // army-wide production: if the advisor chose a mix, retool every camp to it (so a "tanks
          // only" order actually builds tanks). Upgrades remain the player's call (queued upgrades).
          let mixNote = "";
          if (d.mix) { for (const c of p.camps) c.production.mix = { ...d.mix }; mixNote = ` · mix ${TRAINABLE.filter((u) => d.mix![u]).map((u) => u).join("/")}`; }
          notify(`Advisor: A${Math.round(d.attack * s)} I${Math.round(d.intel * s)} D${Math.round(d.defense * s)} B${Math.round(d.builder * s)} T${Math.round(d.turret * s)}${mixNote} — ${d.reason}`);
          onChange(); // push the new allocation to the client's Sankey
        })
        .catch((err) => console.warn(`[advisor p${player}] skipped (${(err as Error).message})`))
        .finally(() => { inFlight = false; });
    },
  };
}
