// agiwar realtime game server: stateful, server-authoritative, fixed-tick.
// Each match is a Room with its own GameState, tick loop, and per-player field generals.
// Matchmaking pairs two humans into a PvP room; a solo player gets a bot opponent.
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMsg, ServerMsg } from "../../shared/types.js";
import { GameState, GRID_W, GRID_H, INCOME_PER_TICK, applyFieldOrder, computeVisibleState, newGame, spawnUnit, step } from "./sim.js";
import { UNIT_STATS } from "../../shared/units.js";
import { isPassable } from "../../shared/terrain.js";
import { compilePolicy } from "./compiler.js";
import { FieldGeneralRunner, createFieldGeneral } from "./fieldgeneral.js";

const PORT = Number(process.env.PORT ?? 8787);
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);
const NET_HZ = Number(process.env.NET_HZ ?? 5); // broadcast rate (<= TICK_HZ) — caps egress
const NET_EVERY = Math.max(1, Math.round(TICK_HZ / NET_HZ));
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 3 * 60 * 1000); // 3-minute prompt cooldown
const BOT_WAIT_MS = Number(process.env.BOT_WAIT_MS ?? 6000); // wait this long for a human, then give a bot
const BUILD_RADIUS = Number(process.env.BUILD_RADIUS ?? 32); // buildings must be placed within this many tiles of your base

// Date.now() is banned inside the sim, but cooldowns are wall-clock UX, not sim state.
const epoch0 = Date.now() - Number(process.hrtime.bigint() / 1_000_000n);
const wallClock = () => Number(process.hrtime.bigint() / 1_000_000n) + epoch0;

interface Member { ws: WebSocket; player: number }
interface Room {
  id: number;
  game: GameState;
  members: Member[];
  runners: (FieldGeneralRunner | null)[]; // index = player; null for the bot
  bot: boolean;
  netTick: number;
  over: boolean;
  interval: ReturnType<typeof setInterval>;
}

const rooms = new Set<Room>();
const roomOf = new Map<WebSocket, Room>();
let roomSeq = 1;
let waiting: { ws: WebSocket; timer: ReturnType<typeof setTimeout> } | null = null;

const send = (ws: WebSocket, msg: ServerMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
const sendState = (ws: WebSocket, g: GameState, player: number) =>
  send(ws, {
    type: "state", tick: g.tick, gridW: GRID_W, gridH: GRID_H, seed: g.seed,
    resources: Math.floor(g.players[player].resources), incomePerSec: INCOME_PER_TICK * TICK_HZ,
    ...computeVisibleState(g, player), you: player,
  });
const sendOwnCamps = (ws: WebSocket, g: GameState, player: number) =>
  send(ws, { type: "camps", camps: g.players[player].camps, fieldGeneral: g.players[player].fieldGeneral });

function seed(g: GameState, player: number, bot: boolean) {
  const b = g.bases[player];
  spawnUnit(g, player, null, "turret", { x: b.x + (player === 0 ? 1 : -1) * 3, y: b.y }); // starting strongpoint
  if (bot) { for (let i = 0; i < 4; i++) spawnUnit(g, player, "aggressive"); return; }
  for (const c of ["aggressive", "recon", "defensive"] as const) { spawnUnit(g, player, c); spawnUnit(g, player, c); }
}

function createRoom(humans: WebSocket[], bot: boolean) {
  const mapSeed = ((roomSeq + 1) * 2654435761) >>> 0; // varied per match, stable within it
  const game = newGame(mapSeed);
  seed(game, 0, false);
  seed(game, 1, bot);
  const members: Member[] = humans.map((ws, i) => ({ ws, player: i }));
  const runners: (FieldGeneralRunner | null)[] = [createFieldGeneral(0), bot ? null : createFieldGeneral(1)];

  const room: Room = {
    id: roomSeq++, game, members, runners, bot, netTick: 0, over: false,
    interval: setInterval(() => tickRoom(room), 1000 / TICK_HZ),
  };
  rooms.add(room);
  for (const m of members) {
    roomOf.set(m.ws, room);
    send(m.ws, { type: "notice", level: "info", text: `Matched — you are Player ${m.player + 1} (vs ${bot ? "bot" : "human"}).` });
    sendOwnCamps(m.ws, game, m.player);
    sendState(m.ws, game, m.player);
  }
  console.log(`[room ${room.id}] started · ${bot ? "vs bot" : "PvP"} · ${rooms.size} active`);
}

function tickRoom(room: Room) {
  if (room.over) return;
  const g = room.game;
  step(g);

  // each human player's field general evaluates (event-gated); notices go only to that player
  for (const m of room.members) {
    const fg = room.runners[m.player];
    fg?.maybe(g, applyFieldOrder, (text) => send(m.ws, { type: "notice", level: "info", text }));
  }

  // win check
  const dead = g.bases.find((b) => b.hp <= 0);
  if (dead) {
    room.over = true;
    const winner = dead.owner === 0 ? 1 : 0;
    for (const m of room.members) {
      sendState(m.ws, g, m.player);
      send(m.ws, { type: "notice", level: "info", text: m.player === winner ? "Victory — enemy base destroyed." : "Defeat — your base fell." });
    }
    clearInterval(room.interval);
    console.log(`[room ${room.id}] over · player ${winner + 1} won`);
    return;
  }

  if (++room.netTick % NET_EVERY === 0) for (const m of room.members) sendState(m.ws, g, m.player); // egress: NET_HZ, fogged per player
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  // matchmaking: pair with a waiting human, else wait briefly then fall back to a bot room
  if (waiting && waiting.ws !== ws && waiting.ws.readyState === WebSocket.OPEN) {
    clearTimeout(waiting.timer);
    const other = waiting.ws;
    waiting = null;
    createRoom([other, ws], false);
  } else {
    send(ws, { type: "notice", level: "info", text: "Searching for an opponent…" });
    waiting = { ws, timer: setTimeout(() => { if (waiting?.ws === ws) { waiting = null; createRoom([ws], true); } }, BOT_WAIT_MS) };
  }

  ws.on("close", () => handleClose(ws));
  ws.on("message", async (raw) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // never let a single malformed/unexpected message crash the process (and every room with it)
    try { await handle(ws, msg); } catch (err) { console.warn(`[handle] ${(err as Error).message}`); }
  });
});

function handleClose(ws: WebSocket) {
  if (waiting?.ws === ws) { clearTimeout(waiting.timer); waiting = null; return; }
  const room = roomOf.get(ws);
  if (!room) return;
  roomOf.delete(ws);
  room.members = room.members.filter((m) => m.ws !== ws);
  for (const m of room.members) send(m.ws, { type: "notice", level: "info", text: "Opponent left the match." });
  if (room.members.length === 0) { clearInterval(room.interval); rooms.delete(room); console.log(`[room ${room.id}] closed · ${rooms.size} active`); }
}

async function handle(ws: WebSocket, msg: ClientMsg) {
  const room = roomOf.get(ws);
  if (!room || room.over) return;
  const member = room.members.find((m) => m.ws === ws);
  if (!member) return;
  const g = room.game;
  const player = member.player;

  if (msg.type === "setProduction") {
    const camp = g.players[player].camps.find((c) => c.id === msg.camp);
    const stats = UNIT_STATS[msg.unit];
    if (!camp || !stats || stats.building) return; // trainable units only
    camp.production.unit = msg.unit;
    camp.production.budgetPct = Math.max(0, Math.min(100, Math.round(msg.budgetPct) || 0));
    sendOwnCamps(ws, g, player);
    return;
  }

  if (msg.type === "build") {
    const stats = UNIT_STATS[msg.unit];
    if (!stats || !stats.building) return; // buildings only
    const x = Math.round(msg.x), y = Math.round(msg.y);
    if (!(x >= 0 && x < GRID_W && y >= 0 && y < GRID_H)) return;
    if (!isPassable(x, y, g.seed, GRID_W, GRID_H)) {
      send(ws, { type: "notice", level: "error", text: "Can't build on water or mountains." });
      return;
    }
    const myBase = g.bases[player];
    if (Math.max(Math.abs(x - myBase.x), Math.abs(y - myBase.y)) > BUILD_RADIUS) {
      send(ws, { type: "notice", level: "error", text: `Build closer to your base (within ${BUILD_RADIUS} tiles).` });
      return;
    }
    const p = g.players[player];
    if (p.resources < stats.cost) {
      send(ws, { type: "notice", level: "error", text: `Not enough resources for ${stats.label} — need ${stats.cost}, have ${Math.floor(p.resources)}.` });
      return;
    }
    p.resources -= stats.cost;
    spawnUnit(g, player, null, msg.unit, { x, y });
    send(ws, { type: "notice", level: "info", text: `${stats.label} placed.` });
    return;
  }

  if (msg.type === "editFieldGeneral") {
    g.players[player].fieldGeneral.prompt = msg.prompt;
    room.runners[player]?.resetGate(); // apply on next decision (still bounded by 30s floor)
    sendOwnCamps(ws, g, player);
    send(ws, { type: "notice", level: "info", text: `${g.players[player].fieldGeneral.label} re-briefed. Applies on next field decision.` });
    return;
  }

  if (msg.type === "fieldOrder") {
    const o = msg.order;
    applyFieldOrder(g, player, o.kind, o.target, o.durationTicks, o.label);
    send(ws, { type: "notice", level: "info", text: `Field order: ${o.label}` });
    return;
  }

  if (msg.type === "editPrompt") {
    const camp = g.players[player].camps.find((c) => c.id === msg.camp);
    if (!camp) return;
    const now = wallClock();
    if (now < camp.cooldownUntil) {
      send(ws, { type: "notice", level: "error", text: `${camp.label} is on cooldown — ${Math.ceil((camp.cooldownUntil - now) / 1000)}s.` });
      return;
    }
    camp.compiling = true;
    camp.prompt = msg.prompt;
    sendOwnCamps(ws, g, player); // reflect "compiling…"
    const { spec, source } = await compilePolicy(msg.prompt);
    camp.spec = spec;
    camp.compiling = false;
    camp.cooldownUntil = wallClock() + COOLDOWN_MS;
    sendOwnCamps(ws, g, player);
    send(ws, { type: "notice", level: "info", text: `${camp.label} retrained via ${source}. Cooldown ${COOLDOWN_MS / 1000}s.` });
  }
}

console.log(
  `agiwar server on :${PORT} · sim ${TICK_HZ}Hz · net ${NET_HZ}Hz · cooldown ${COOLDOWN_MS / 1000}s · bot-wait ${BOT_WAIT_MS / 1000}s · ` +
    `compiler ${process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6"} · ` +
    `field-general ${process.env.FIELD_GENERAL === "off" ? "OFF" : "event-gated/" + (process.env.FG_MODEL_ID ?? "haiku-4-5")}`
);
