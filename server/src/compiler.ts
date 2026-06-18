// Policy compiler: natural-language general style -> clamped BehaviorSpec.
// Tries Bedrock (Sonnet 4.6); falls back to the deterministic keyword stub so the
// game is always playable even with no AWS credentials.
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BehaviorSpec } from "../../shared/types.js";
import { SPEC_SCHEMA_HINT, clampSpec, stubCompile, stubMix } from "../../shared/spec.js";
import { TRAINABLE, UnitType } from "../../shared/units.js";

// pull a clean unit mix (weights over trainable types) out of whatever the LLM returned
function parseMix(raw: any): Partial<Record<UnitType, number>> | null {
  const m = raw?.mix;
  if (!m || typeof m !== "object") return null;
  const out: Partial<Record<UnitType, number>> = {};
  let total = 0;
  for (const u of TRAINABLE) { const w = Math.max(0, Math.round(Number(m[u]) || 0)); if (w > 0) { out[u] = w; total += w; } }
  return total > 0 ? out : null;
}

const REGION = process.env.AWS_REGION ?? "us-west-2";
// Newer Claude models on Bedrock require a cross-region INFERENCE PROFILE id
// (the "us." prefix), not the bare foundation-model id.
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6";

// Lazily constructed so the server boots even without AWS configured.
let client: BedrockRuntimeClient | null = null;
function bedrock(): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region: REGION });
  return client;
}

const SYSTEM = `You are the doctrine compiler for a real-time strategy game. A player's "general" \
describes, in plain language, how their troops should behave. Translate that style into a behavior \
spec the game engine can execute. The notes are in chronological order; the player's MOST RECENT order \
carries the most weight and OVERRIDES earlier notes wherever they conflict — make the spec clearly \
reflect that latest order. ${SPEC_SCHEMA_HINT}`;

/** The most recent command line from a commander's accumulated memory (latest = highest priority). */
export const latestOrder = (mem: string) => {
  const lines = mem.trim().split("\n").map((l) => l.replace(/^[•\-\s]+/, "").trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
};

export interface CompileResult {
  spec: BehaviorSpec;
  mix: Partial<Record<UnitType, number>> | null; // unit composition the general wants trained
  source: "bedrock" | "stub";
}

export async function compilePolicy(prompt: string): Promise<CompileResult> {
  try {
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 320,
      system: SYSTEM,
      messages: [{ role: "user", content: `General's accumulated style (chronological):\n"""${prompt}"""\n\nMOST RECENT ORDER (top priority — make the spec clearly obey this, overriding earlier notes on conflict):\n"${latestOrder(prompt)}"\n\nReturn only the JSON spec.` }],
    };
    const res = await bedrock().send(
      new InvokeModelCommand({ modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) })
    );
    const decoded = JSON.parse(new TextDecoder().decode(res.body));
    const text: string = decoded?.content?.[0]?.text ?? "";
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { spec: clampSpec(json), mix: parseMix(json), source: "bedrock" };
  } catch (err) {
    // Network/credentials/parse failure -> deterministic fallback, never breaks play.
    console.warn(`[compiler] Bedrock unavailable, using stub: ${(err as Error).message}`);
    const latest = latestOrder(prompt) || prompt; // weight the most recent order in the fallback too
    return { spec: stubCompile(latest), mix: stubMix(latest) ?? stubMix(prompt), source: "stub" };
  }
}
