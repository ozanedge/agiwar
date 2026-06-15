// Policy compiler: natural-language general style -> clamped BehaviorSpec.
// Tries Bedrock (Sonnet 4.6); falls back to the deterministic keyword stub so the
// game is always playable even with no AWS credentials.
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { BehaviorSpec } from "../../shared/types.js";
import { SPEC_SCHEMA_HINT, clampSpec, stubCompile } from "../../shared/spec.js";

const REGION = process.env.AWS_REGION ?? "us-west-2";
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-sonnet-4-6";

// Lazily constructed so the server boots even without AWS configured.
let client: BedrockRuntimeClient | null = null;
function bedrock(): BedrockRuntimeClient {
  if (!client) client = new BedrockRuntimeClient({ region: REGION });
  return client;
}

const SYSTEM = `You are the doctrine compiler for a real-time strategy game. A player's "general" \
describes, in plain language, how their troops should behave. Translate that style into a behavior \
spec the game engine can execute. Be faithful to the described intent. ${SPEC_SCHEMA_HINT}`;

export interface CompileResult {
  spec: BehaviorSpec;
  source: "bedrock" | "stub";
}

export async function compilePolicy(prompt: string): Promise<CompileResult> {
  try {
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: "user", content: `General's style:\n"""${prompt}"""\n\nReturn only the JSON spec.` }],
    };
    const res = await bedrock().send(
      new InvokeModelCommand({ modelId: MODEL_ID, contentType: "application/json", accept: "application/json", body: JSON.stringify(body) })
    );
    const decoded = JSON.parse(new TextDecoder().decode(res.body));
    const text: string = decoded?.content?.[0]?.text ?? "";
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { spec: clampSpec(json), source: "bedrock" };
  } catch (err) {
    // Network/credentials/parse failure -> deterministic fallback, never breaks play.
    console.warn(`[compiler] Bedrock unavailable, using stub: ${(err as Error).message}`);
    return { spec: stubCompile(prompt), source: "stub" };
  }
}
