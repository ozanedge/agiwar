// agiwar realtime game server: stateful, server-authoritative, fixed-tick.
// Each match is a Room with its own GameState, tick loop, and per-player field generals.
// Matchmaking pairs two humans into a PvP room; a solo player gets a bot opponent.
import { WebSocketServer, WebSocket } from "ws";
import type { Camp, ClientMsg, ServerMsg } from "../../shared/types.js";
import { GameState, GRID_W, GRID_H, INCOME_PER_TICK, applyArmyDoctrine, applyFieldOrder, clearFieldOrder, computeVisibleState, visibleShots, visibleDeaths, visibleUfx, forgeUltimate, boosterCost, newGame, playerBonus, spawnUnit, setFaction, step } from "./sim.js";
import { ULTIMATES } from "../../shared/ultimates.js";
import { UNIT_STATS, INVESTMENTS, investCost, GRID_SCALE, type Faction, type UnitType, FACTIONS, FACTION_TURRET, trainableFor } from "../../shared/units.js";
import { isPassable } from "../../shared/terrain.js";
import { compilePolicy } from "./compiler.js";
import { FieldGeneralRunner, createFieldGeneral } from "./fieldgeneral.js";
import { AdvisorRunner, createAdvisor } from "./advisor.js";
import { DecisionRunner, createDecisionRunner } from "./decisions.js";
import { ARMY_DOCTRINES } from "../../shared/doctrine.js";

const PORT = Number(process.env.PORT ?? 8787);
const TICK_HZ = Number(process.env.TICK_HZ ?? 10);
const NET_HZ = Number(process.env.NET_HZ ?? 5); // broadcast rate (<= TICK_HZ) — caps egress
const NET_EVERY = Math.max(1, Math.round(TICK_HZ / NET_HZ));
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 3 * 60 * 1000); // 3-minute prompt cooldown
const BOT_WAIT_MS = Number(process.env.BOT_WAIT_MS ?? 60_000); // wait this long for a human, then fall back to a bot
// DEV art review: DEV_SPAWN=tank,nod_jet,… spawns those unit types for every human at battle start (defensive camp, near base).
const DEV_SPAWN = (process.env.DEV_SPAWN ?? "").split(",").map((t) => t.trim()).filter((t) => t in UNIT_STATS) as UnitType[];
// DEV_ENEMY=… spawns those types for the opponent just beyond the DEV_SPAWN grid (aggressive), so a fight starts at once.
const DEV_ENEMY = (process.env.DEV_ENEMY ?? "").split(",").map((t) => t.trim()).filter((t) => t in UNIT_STATS) as UnitType[];
const DOCTRINE_WAIT_MS = Number(process.env.DOCTRINE_WAIT_MS ?? 20_000); // backstop: auto-start if a human hasn't picked a doctrine (client picker is 15s)
const BUILD_RADIUS = Number(process.env.BUILD_RADIUS ?? 32 * GRID_SCALE); // buildings must be placed within this many tiles of your base

// Date.now() is banned inside the sim, but cooldowns are wall-clock UX, not sim state.
const epoch0 = Date.now() - Number(process.hrtime.bigint() / 1_000_000n);
const wallClock = () => Number(process.hrtime.bigint() / 1_000_000n) + epoch0;

interface Member { ws: WebSocket; player: number }
interface Room {
  id: number;
  game: GameState;
  members: Member[];
  runners: (FieldGeneralRunner | null)[]; // index = player; null for the bot
  advisors: (AdvisorRunner | null)[]; // investment advisor per player
  decisions: (DecisionRunner | null)[]; // strategic-fork engine per player
  bot: boolean;
  netTick: number;
  over: boolean;
  started: boolean; // the sim is PAUSED until every human has picked an army doctrine (or the backstop fires)
  chosen: boolean[]; // per player: has an army doctrine been selected? (bots are pre-chosen)
  startTimer: ReturnType<typeof setTimeout> | null; // server backstop: auto-start if a human stalls on the picker
  interval: ReturnType<typeof setInterval>;
}

const rooms = new Set<Room>();
const roomOf = new Map<WebSocket, Room>();
let roomSeq = 1;
let waiting: { ws: WebSocket; timer: ReturnType<typeof setTimeout> } | null = null;

const send = (ws: WebSocket, msg: ServerMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
const sendState = (ws: WebSocket, g: GameState, player: number, includeShots = false) => {
  const b = playerBonus(g, player);
  send(ws, {
    type: "state", tick: g.tick, gridW: GRID_W, gridH: GRID_H, seed: g.seed,
    resources: Math.floor(g.players[player].resources), incomePerSec: INCOME_PER_TICK * TICK_HZ * b.income,
    bonuses: b, invest: g.players[player].invest, queuedInvest: g.players[player].queuedInvest,
    morale: g.players[player].morale, boosterCost: boosterCost(g, player),
    armyDoctrine: g.players[player].armyDoctrine,
    faction: g.players[player].faction, factions: g.players.map((p) => p.faction),
    rally: g.players[player].rally ? { x: g.players[player].rally!.x, y: g.players[player].rally!.y } : null,
    sandstorm: g.sandstorm
      ? { progress: Math.min(1, (g.tick - g.sandstorm.from) / Math.max(1, g.sandstorm.until - g.sandstorm.from)), secsLeft: Math.ceil((g.sandstorm.until - g.tick) / TICK_HZ) }
      : null,
    shots: includeShots ? visibleShots(g, player) : [],
    deaths: includeShots ? visibleDeaths(g, player) : [],
    ufx: includeShots ? visibleUfx(g, player) : [],
    drops: g.drops.filter((d) => d.owner === player), // you only see (and can harvest) your own
    artifacts: g.players[player].artifacts.slice(),
    ultimates: g.players[player].ultimates.map((a) => {
      const iv = (ULTIMATES[a.id]?.intervalSec ?? 15) * TICK_HZ;
      return { id: a.id, cooldown: Math.max(0, Math.min(1, 1 - (a.nextFire - g.tick) / iv)) };
    }),
    ...computeVisibleState(g, player), you: player,
  });
};
const sendOwnCamps = (ws: WebSocket, g: GameState, player: number) =>
  send(ws, { type: "camps", camps: g.players[player].camps, fieldGeneral: g.players[player].fieldGeneral, advisor: g.players[player].advisor, turretBudget: g.players[player].turretBudget, activeOrder: g.players[player].fieldOrder?.label ?? null });

// every user message APPENDS to a commander's memory (kept to the last ~14 lines)
const appendMemory = (cur: string, msg: string): string => {
  const add = msg.trim();
  if (!add) return cur;
  return (cur + "\n• " + add).split("\n").map((s) => s.trim()).filter(Boolean).slice(-14).join("\n");
};

// (re)compile one camp general from its full memory → native doctrine spec + unit mix. Cooldown-gated
// by the caller; this just runs the compile and pushes the result. Used by both the single-camp edit
// and the broadcast "command" (which recompiles every off-cooldown camp).
async function recompileCamp(ws: WebSocket, g: GameState, player: number, camp: Camp, cooldownMs = COOLDOWN_MS) {
  camp.compiling = true;
  sendOwnCamps(ws, g, player); // reflect "compiling…"
  try {
    const trainable = trainableFor(g.players[player].faction);
    const { spec, mix, source } = await compilePolicy(camp.prompt, trainable);
    camp.spec = spec;
    // only accept a mix that actually trains this faction's units (a stub/foreign mix would zero production)
    if (mix && trainable.some((u) => (mix[u] ?? 0) > 0)) camp.production.mix = mix;
    send(ws, { type: "notice", level: "info", text: `${camp.label} retrained via ${source}.` });
  } catch (err) {
    send(ws, { type: "notice", level: "error", text: `${camp.label} retrain failed (${(err as Error).message}).` });
  } finally {
    camp.compiling = false;
    camp.cooldownUntil = wallClock() + cooldownMs;
    sendOwnCamps(ws, g, player);
  }
}

// Spawn a player's opening forces — uses their (already-set) faction's turret + roster units.
function seed(g: GameState, player: number, bot: boolean) {
  const b = g.bases[player];
  spawnUnit(g, player, null, FACTION_TURRET[g.players[player].faction], { x: b.x, y: b.y + (player === 0 ? -1 : 1) * 3 * GRID_SCALE }); // starting strongpoint, toward the field
  if (bot) { for (let i = 0; i < 4; i++) spawnUnit(g, player, "aggressive"); return; }
  for (const c of ["aggressive", "recon", "defensive"] as const) { spawnUnit(g, player, c); spawnUnit(g, player, c); }
}
const randFaction = (): Faction => FACTIONS[Math.floor(Math.random() * FACTIONS.length)];

function createRoom(humans: WebSocket[], bot: boolean) {
  const mapSeed = (Math.floor(Math.random() * 0x100000000) ^ ((roomSeq + 1) * 2654435761)) >>> 0; // fresh per match (random + room counter), stable within it
  const game = newGame(mapSeed);
  const members: Member[] = humans.map((ws, i) => ({ ws, player: i }));
  const runners: (FieldGeneralRunner | null)[] = [createFieldGeneral(0), bot ? null : createFieldGeneral(1)];
  const advisors: (AdvisorRunner | null)[] = [createAdvisor(0), bot ? null : createAdvisor(1)];
  const decisions: (DecisionRunner | null)[] = [createDecisionRunner(0), bot ? null : createDecisionRunner(1)];

  // the sim stays PAUSED until every HUMAN picks a doctrine + faction; non-human (bot) slots are pre-chosen.
  const isHuman = [false, false];
  for (const m of members) isHuman[m.player] = true;
  const chosen = [0, 1].map((i) => !isHuman[i]);
  // Bots get a random faction + opening forces now; humans are seeded when they pick (see chooseArmyDoctrine).
  for (const i of [0, 1]) if (!isHuman[i]) { setFaction(game, i, randFaction()); seed(game, i, true); }

  const room: Room = {
    id: roomSeq++, game, members, runners, advisors, decisions, bot, netTick: 0, over: false,
    started: false, chosen, startTimer: null,
    interval: setInterval(() => tickRoom(room), 1000 / TICK_HZ),
  };
  // backstop: if a human never picks, force-start shortly after the client's 15s picker would auto-pick
  room.startTimer = setTimeout(() => startMatch(room), DOCTRINE_WAIT_MS);
  rooms.add(room);
  for (const m of members) {
    roomOf.set(m.ws, room);
    send(m.ws, { type: "notice", level: "info", text: `Matched — you are Player ${m.player + 1} (vs ${bot ? "bot" : "human"}). Pick your doctrine to begin.` });
    sendOwnCamps(m.ws, game, m.player);
    sendState(m.ws, game, m.player);
    send(m.ws, { type: "doctrineOffer", current: game.players[m.player].armyDoctrine, faction: game.players[m.player].faction }); // pick a faction + build identity (sim is paused until chosen)
  }
  console.log(`[room ${room.id}] created · ${bot ? "vs bot" : "PvP"} · awaiting doctrine pick · ${rooms.size} active`);
}

// Begin the match once doctrines are locked in — unpauses the sim loop. Idempotent.
function startMatch(room: Room) {
  if (room.started || room.over) return;
  // backstop: any human who never picked gets seeded now with the default faction so they aren't empty.
  const human = [false, false]; for (const m of room.members) human[m.player] = true;
  for (let i = 0; i < room.chosen.length; i++) if (human[i] && !room.chosen[i]) { seed(room.game, i, false); room.chosen[i] = true; }
  room.started = true;
  if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
  for (const m of room.members) DEV_SPAWN.forEach((t, i) => { // laid out in a grid out in the open, in front of the base
    const b = room.game.bases[m.player], dir = m.player === 0 ? -1 : 1;
    const x = Math.max(0, Math.min(GRID_W - 1, Math.round(b.x + ((i % 6) - 2.5) * 4 * GRID_SCALE)));
    const y = Math.max(0, Math.min(GRID_H - 1, Math.round(b.y + dir * (12 + Math.floor(i / 6) * 4) * GRID_SCALE)));
    spawnUnit(room.game, m.player, null, t, { x, y });
  });
  for (const m of room.members) DEV_ENEMY.forEach((t, i) => {
    const b = room.game.bases[m.player], dir = m.player === 0 ? -1 : 1, foe = 1 - m.player;
    const x = Math.max(0, Math.min(GRID_W - 1, Math.round(b.x + ((i % 6) - 2.5) * 4 * GRID_SCALE)));
    const y = Math.max(0, Math.min(GRID_H - 1, Math.round(b.y + dir * (30 + Math.floor(i / 6) * 4) * GRID_SCALE)));
    spawnUnit(room.game, foe, "aggressive", t, { x, y });
  });
  for (const m of room.members) send(m.ws, { type: "notice", level: "info", text: "▸ Doctrine locked — battle begins." });
  console.log(`[room ${room.id}] battle begins`);
}

function tickRoom(room: Room) {
  if (room.over || !room.started) return; // PAUSED until doctrines are picked — sim does not advance
  const g = room.game;
  step(g);

  // each human player's field general evaluates (event-gated); notices go only to that player
  for (const m of room.members) {
    const log = (text: string) => send(m.ws, { type: "fieldlog", text, tick: g.tick });
    const refresh = () => sendOwnCamps(m.ws, g, m.player);
    room.runners[m.player]?.maybe(g, applyFieldOrder, log);
    room.advisors[m.player]?.maybe(g, log, refresh);
    room.decisions[m.player]?.maybe(g, (d) => send(m.ws, d), log, refresh);
  }

  // win check
  const dead = g.bases.find((b) => b.hp <= 0);
  if (dead) {
    room.over = true;
    const winner = dead.owner === 0 ? 1 : 0;
    for (const m of room.members) {
      sendState(m.ws, g, m.player);
      send(m.ws, { type: "gameover", won: m.player === winner });
    }
    clearInterval(room.interval);
    console.log(`[room ${room.id}] over · player ${winner + 1} won`);
    return;
  }

  if (++room.netTick % NET_EVERY === 0) {
    for (const m of room.members) sendState(m.ws, g, m.player, true); // egress: NET_HZ, fogged per player (incl. shots)
    g.shots.length = 0; // shots consumed by this broadcast
    g.deaths.length = 0; // deaths consumed by this broadcast
    g.ufx.length = 0; // ultimate FX consumed by this broadcast
  }
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws, req) => {
  // ?solo → straight into a bot match, never paired with a waiting human (dev/testing clients)
  const solo = new URL(req.url ?? "/", "http://localhost").searchParams.has("solo");
  if (solo) createRoom([ws], true);
  // matchmaking: pair with a waiting human, else wait briefly then fall back to a bot room
  else if (waiting && waiting.ws !== ws && waiting.ws.readyState === WebSocket.OPEN) {
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
  if (room.members.length === 0) { clearInterval(room.interval); if (room.startTimer) clearTimeout(room.startTimer); rooms.delete(room); console.log(`[room ${room.id}] closed · ${rooms.size} active`); }
}

async function handle(ws: WebSocket, msg: ClientMsg) {
  // skip the matchmaking wait → start a single-player bot match immediately
  if (msg.type === "skipToBot") {
    if (waiting?.ws === ws) { clearTimeout(waiting.timer); waiting = null; createRoom([ws], true); }
    return;
  }
  const room = roomOf.get(ws);
  if (!room || room.over) return;
  const member = room.members.find((m) => m.ws === ws);
  if (!member) return;
  const g = room.game;
  const player = member.player;

  if (msg.type === "setBudget") {
    const camp = g.players[player].camps.find((c) => c.id === msg.camp);
    if (!camp) return;
    camp.production.budgetPct = Math.max(0, Math.min(100, Math.round(msg.budgetPct) || 0));
    sendOwnCamps(ws, g, player);
    return;
  }
  if (msg.type === "setTurretBudget") {
    g.players[player].turretBudget = Math.max(0, Math.min(100, Math.round(msg.budgetPct) || 0));
    sendOwnCamps(ws, g, player);
    return;
  }
  if (msg.type === "setMix") {
    const camp = g.players[player].camps.find((c) => c.id === msg.camp);
    const stats = UNIT_STATS[msg.unit];
    if (!camp || !stats || stats.building) return; // trainable units only
    camp.production.mix[msg.unit] = Math.max(0, Math.min(100, Math.round(msg.weight) || 0));
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

  if (msg.type === "invest") {
    const inv = INVESTMENTS.find((i) => i.kind === msg.kind);
    if (!inv) return;
    const p = g.players[player];
    const level = p.invest[inv.kind];
    const cost = investCost(inv.base, level);
    if (p.resources < cost) {
      send(ws, { type: "notice", level: "error", text: `Not enough resources for ${inv.label} Lv${level + 1} — need ${cost}.` });
      return;
    }
    p.resources -= cost;
    p.invest[inv.kind] = level + 1;
    send(ws, { type: "notice", level: "info", text: `Invested in ${inv.label} → Lv${level + 1} (${inv.effect}).` });
    return;
  }

  if (msg.type === "queueInvest") {
    const inv = INVESTMENTS.find((i) => i.kind === msg.kind);
    if (!inv) return;
    const p = g.players[player];
    p.queuedInvest = inv.kind;
    const cost = investCost(inv.base, p.invest[inv.kind]);
    sendState(ws, g, player);
    send(ws, { type: "notice", level: "info", text: `Queued ${inv.label} Lv${p.invest[inv.kind] + 1} (${cost}) — pausing other spending to save up.` });
    return;
  }

  if (msg.type === "buyBooster") {
    const p = g.players[player];
    const cost = boosterCost(g, player);
    if (p.resources < cost) {
      send(ws, { type: "notice", level: "error", text: `Not enough resources to rally the troops — need ${cost}, have ${Math.floor(p.resources)}.` });
      return;
    }
    p.resources -= cost;
    p.moraleBoost = Math.min(0.45, p.moraleBoost + 0.35); // temporary lift (decays over ~30s)
    send(ws, { type: "notice", level: "info", text: "Morale booster deployed — the troops rally!" });
    return;
  }

  if (msg.type === "cancelInvest") {
    g.players[player].queuedInvest = null;
    sendState(ws, g, player);
    send(ws, { type: "notice", level: "info", text: "Upgrade queue cleared — spending resumed." });
    return;
  }

  if (msg.type === "captureOutpost") {
    const a = g.outposts.find((a) => a.id === msg.id);
    if (!a || a.owner !== -1) return; // neutral only
    g.players[player].rally = { x: a.x, y: a.y, until: g.tick + 40 * TICK_HZ }; // send forces to channel the capture
    send(ws, { type: "notice", level: "info", text: `Capturing ${a.bonus.label} — a builder must channel on it for a few seconds.` });
    return;
  }

  if (msg.type === "editAdvisor") {
    const a = g.players[player].advisor;
    a.prompt = appendMemory(a.prompt, msg.prompt);
    room.advisors[player]?.resetGate();
    sendOwnCamps(ws, g, player);
    send(ws, { type: "notice", level: "info", text: `${a.label} noted it — applies on next economic review.` });
    return;
  }

  if (msg.type === "editFieldGeneral") {
    const fgn = g.players[player].fieldGeneral;
    fgn.prompt = appendMemory(fgn.prompt, msg.prompt);
    room.runners[player]?.resetGate(); // apply on next decision (still bounded by 30s floor)
    sendOwnCamps(ws, g, player);
    send(ws, { type: "notice", level: "info", text: `${fgn.label} noted it — applies on next field decision.` });
    return;
  }

  if (msg.type === "fieldOrder") {
    const o = msg.order;
    applyFieldOrder(g, player, o.kind, o.target, o.durationTicks, o.label);
    sendOwnCamps(ws, g, player); // surface the active tactic in the field general's card
    send(ws, { type: "notice", level: "info", text: `Field order: ${o.label}` });
    return;
  }

  if (msg.type === "cancelFieldOrder") {
    clearFieldOrder(g, player);
    sendOwnCamps(ws, g, player);
    send(ws, { type: "notice", level: "info", text: `${g.players[player].fieldGeneral.label}: tactic cancelled — back to doctrine.` });
    return;
  }

  if (msg.type === "chooseArmyDoctrine") {
    const d = ARMY_DOCTRINES.find((x) => x.id === msg.id);
    if (!d) return;
    const firstPick = !room.chosen[player]; // seed opening forces once, on the first pick
    if (msg.faction === "anthropic" || msg.faction === "openai") setFaction(g, player, msg.faction); // faction BEFORE seeding/doctrine so the roster is right
    applyArmyDoctrine(g, player, d.id); // sets build identity AND seeds the opening budget to match
    if (firstPick) seed(g, player, false); // spawn this human's faction-correct opening forces
    // single-player: force the bot to the OPPOSITE faction (so the matchup is always visibly asymmetric,
    // not a same-color mirror). Re-seed its opening forces since the match is still paused (no ticks yet).
    if (firstPick && room.bot) {
      const foe = player === 0 ? 1 : 0;
      if (!room.members.some((m) => m.player === foe)) {
        setFaction(g, foe, g.players[player].faction === "anthropic" ? "openai" : "anthropic");
        g.units = g.units.filter((u) => u.owner !== foe); // drop the bot's random-faction seed units
        seed(g, foe, true); // reseed with the opposite faction's roster
      }
    }
    sendState(ws, g, player);
    sendOwnCamps(ws, g, player); // push the doctrine-aligned camp budgets so the Sankey reflects them
    const fac = g.players[player].faction === "openai" ? "OpenAI" : "Anthropic";
    send(ws, { type: "notice", level: "info", text: `${fac} · ${d.label} — ${d.hint}.` });
    // gate: the match only begins once EVERY human has locked a doctrine (solo → just this player;
    // PvP → both). Until then the sim stays paused in tickRoom.
    room.chosen[player] = true;
    if (!room.started && room.chosen.every(Boolean)) startMatch(room);
    return;
  }

  if (msg.type === "decide") {
    const log = (text: string) => send(ws, { type: "fieldlog", text, tick: g.tick });
    room.decisions[player]?.answer(g, msg.id, msg.key, log, () => sendOwnCamps(ws, g, player));
    return;
  }

  if (msg.type === "setRally") {
    const x = Math.round(msg.x), y = Math.round(msg.y);
    if (!(x >= 0 && x < GRID_W && y >= 0 && y < GRID_H)) return;
    g.players[player].rally = { x, y, until: g.tick + 30 * TICK_HZ }; // manual rally lasts 30s
    send(ws, { type: "notice", level: "info", text: "Rally point set — forces will concentrate there." });
    return;
  }

  if (msg.type === "forgeUltimate") {
    const ult = ULTIMATES[`${Math.min(msg.a, msg.b)}-${Math.max(msg.a, msg.b)}`];
    if (forgeUltimate(g, player, msg.a, msg.b)) {
      sendState(ws, g, player); // refresh inventory + ultimates
      send(ws, { type: "notice", level: "info", text: `⚡ Forged ULTIMATE: ${ult?.name ?? "?"}.` });
      // single-player: 5s later the bot opponent forges a RANDOM ultimate from its own army, so the AI keeps pace.
      const foe = player === 0 ? 1 : 0;
      if (room.bot && !room.members.some((m) => m.player === foe)) {
        setTimeout(() => {
          if (room.over) return;
          const a = Math.floor(Math.random() * 5), b = Math.floor(Math.random() * 5); // any of the 15 artifact pairs
          const fp = g.players[foe];
          fp.artifacts[a] = Math.max(fp.artifacts[a], a === b ? 2 : 1); // top up so the bot can always forge
          fp.artifacts[b] = Math.max(fp.artifacts[b], 1);
          forgeUltimate(g, foe, a, b);
        }, 5000);
      }
    } else {
      send(ws, { type: "notice", level: "error", text: "Not enough artifacts to forge that ultimate." });
    }
    return;
  }

  if (msg.type === "editPrompt") {
    const camp = g.players[player].camps.find((c) => c.id === msg.camp);
    if (!camp) return;
    camp.prompt = appendMemory(camp.prompt, msg.prompt); // always add to memory
    const now = wallClock();
    if (now < camp.cooldownUntil) {
      sendOwnCamps(ws, g, player); // memory updated; recompile deferred
      send(ws, { type: "notice", level: "info", text: `Noted for ${camp.label} — doctrine recompiles in ${Math.ceil((camp.cooldownUntil - now) / 1000)}s.` });
      return;
    }
    await recompileCamp(ws, g, player, camp);
    return;
  }

  // ONE order → the whole staff. Each commander gets the order in its memory and applies the parts
  // relevant to its own role: the field general & advisor on their next event-gated decision, and
  // every camp general recompiles its doctrine now (those still on cooldown just bank the memory and
  // recompile when it lifts). This is the single command box the player types into.
  if (msg.type === "command") {
    const text = String(msg.text ?? "").trim();
    if (!text) return;
    const p = g.players[player];
    p.advisor.prompt = appendMemory(p.advisor.prompt, text); room.advisors[player]?.resetGate(); // economy + production mix re-decide next tick
    p.fieldGeneral.prompt = appendMemory(p.fieldGeneral.prompt, text); room.runners[player]?.resetGate(); // field tactics re-decide next tick
    for (const camp of p.camps) camp.prompt = appendMemory(camp.prompt, text);
    sendOwnCamps(ws, g, player); // memory now visible on every commander card
    send(ws, { type: "notice", level: "info", text: `▸ EXECUTIVE ORDER to all commanders: "${text.length > 70 ? text.slice(0, 70) + "…" : text}"` });
    // EXECUTIVE ORDER = instant. Every camp general recompiles its doctrine + unit mix RIGHT NOW
    // (bypassing the cooldown), so production, ratios, and field tactics all shift at once.
    for (const camp of p.camps) void recompileCamp(ws, g, player, camp, 0);
    return;
  }
}

console.log(
  `agiwar server on :${PORT} · sim ${TICK_HZ}Hz · net ${NET_HZ}Hz · cooldown ${COOLDOWN_MS / 1000}s · bot-wait ${BOT_WAIT_MS / 1000}s · ` +
    `compiler ${process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6"} · ` +
    `field-general ${process.env.FIELD_GENERAL === "off" ? "OFF" : "event-gated/" + (process.env.FG_MODEL_ID ?? "haiku-4-5")}`
);
