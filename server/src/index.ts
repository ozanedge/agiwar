// agiwar realtime game server: stateful, server-authoritative, fixed-tick.
// One process owns the simulation; clients send sparse commands and receive snapshots.
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMsg, DoctrineId, ServerMsg } from "../../shared/types.js";
import { GameState, applyFieldOrder, newGame, spawnUnit, step } from "./sim.js";
import { compilePolicy } from "./compiler.js";

const PORT = Number(process.env.PORT ?? 8787);
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 3 * 60 * 1000); // 3-minute prompt cooldown

const game: GameState = newGame();
const clients = new Set<WebSocket>();

// Seed a few units per side so behavior is visible immediately.
for (const c of ["aggressive", "recon", "defensive"] as DoctrineId[]) {
  spawnUnit(game, 0, c);
  spawnUnit(game, 0, c);
}
for (let i = 0; i < 4; i++) spawnUnit(game, 1, "aggressive"); // simple bot opponent

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastSnapshot() {
  const base = {
    type: "snapshot" as const,
    tick: game.tick,
    gridW: 48,
    gridH: 32,
    units: game.units,
    bases: game.bases,
    camps: game.camps,
  };
  for (const ws of clients) send(ws, { ...base, you: 0 });
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[ws] client connected (${clients.size} total)`);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (raw) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    await handle(ws, msg);
  });
});

async function handle(ws: WebSocket, msg: ClientMsg) {
  if (msg.type === "spawn") {
    spawnUnit(game, 0, msg.camp);
    return;
  }
  if (msg.type === "fieldOrder") {
    const o = msg.order;
    applyFieldOrder(game, 0, o.kind, o.target, o.durationTicks, o.label);
    send(ws, { type: "notice", level: "info", text: `Field order: ${o.label} (${o.durationTicks} ticks)` });
    return;
  }
  if (msg.type === "editPrompt") {
    const camp = game.camps.find((c) => c.id === msg.camp);
    if (!camp) return;
    const now = wallClock();
    if (now < camp.cooldownUntil) {
      const secs = Math.ceil((camp.cooldownUntil - now) / 1000);
      send(ws, { type: "notice", level: "error", text: `${camp.label} is on cooldown — ${secs}s until you can retrain.` });
      return;
    }
    camp.compiling = true;
    camp.prompt = msg.prompt;
    const { spec, source } = await compilePolicy(msg.prompt);
    camp.spec = spec;
    camp.compiling = false;
    camp.cooldownUntil = wallClock() + COOLDOWN_MS; // start cooldown only on a successful compile
    send(ws, { type: "notice", level: "info", text: `${camp.label} retrained via ${source}. Cooldown ${COOLDOWN_MS / 1000}s.` });
  }
}

// Date.now() is banned inside the sim, but cooldowns are wall-clock UX, not sim state.
function wallClock(): number { return Number(process.hrtime.bigint() / 1_000_000n) + epoch0; }
const epoch0 = Date.now() - Number(process.hrtime.bigint() / 1_000_000n);

setInterval(() => {
  step(game);
  // keep the bot supplied so there's always something to react to
  if (game.tick % 80 === 0 && game.units.filter((u) => u.owner === 1).length < 6) spawnUnit(game, 1, "aggressive");
  broadcastSnapshot();
}, 1000 / TICK_HZ);

console.log(`agiwar server on :${PORT} @ ${TICK_HZ}Hz · cooldown ${COOLDOWN_MS / 1000}s · model ${process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6"}`);
