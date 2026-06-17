// agiwar web client: renders the server-authoritative snapshot and sends sparse commands.
import { Application, Container, Graphics, Sprite, Text } from "pixi.js";
import type { Camp, DoctrineId, FieldGeneral, ServerMsg, StateMsg, UnitState } from "../../../shared/types.js";
import { UNIT_STATS, TRAINABLE, VISION_MULT, VISION_CAP, BASE_VISION, INVESTMENTS, investCost, GRID_SCALE, type UnitType } from "../../../shared/units.js";
import { ARMY_DOCTRINES, modsFor } from "../../../shared/doctrine.js";
import { heightAt, elevationAt, elevFromHeight, kindOf, highGroundBonus, CLIFF_SLOPE, type TerrainKind } from "../../../shared/terrain.js";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:8787";
const MM_SECONDS = 60; // how long we look for a live opponent before single-player (matches server)
// Skynetops mission-control palette. Primary color = SIDE (yours cyan, enemy danger-red);
// doctrine is shown as an accent outline.
const OWN_COLOR = 0x00ffd1;
const ENEMY_COLOR = 0xff3860;
const DOCTRINE_COLOR: Record<DoctrineId, number> = { aggressive: 0xff5d73, recon: 0x5ab0ff, defensive: 0x2fe0bd, builder: 0xffb547 };
const DOCTRINE_CLASS: Record<DoctrineId, string> = { aggressive: "agg", recon: "rec", defensive: "def", builder: "bld" };
const BUDGET_NAME: Record<DoctrineId, string> = { aggressive: "Attack", recon: "Intel", defensive: "Defense", builder: "Builder" };
const DOCTRINES: DoctrineId[] = ["aggressive", "recon", "defensive", "builder"];

const stage = document.getElementById("stage")!;
const noticeEl = document.getElementById("notice")!;
const readoutEl = document.getElementById("readout")!;
const econEl = document.getElementById("econ")!;

let latestState: StateMsg | null = null;
let latestCamps: Camp[] = [];
let latestTurretBudget = 0;
let latestField: FieldGeneral | null = null;
let latestAdvisor: FieldGeneral | null = null;
let hovered: UnitState | null = null;

const app = new Application();
await app.init({ background: 0x02060a, resizeTo: stage, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true });
stage.appendChild(app.canvas);

// ---- isometric world ----
const TILE_W = 36 / GRID_SCALE, TILE_H = 18 / GRID_SCALE; // fine 2:1 diamond (16× cell density, same physical map)
const world = new Container(); // camera-transformed
app.stage.addChild(world);
// Terrain is BAKED ONCE into a texture (no per-tick tile redraw). Fog is a cheap, resolution-
// independent VISION-MASK overlay: unexplored = stage bg shows through · explored = dim terrain
// (expMask) · currently visible = bright terrain (visMask) drawn on top.
const terrainDim = new Sprite(); // baked terrain, darkened — shown where ever-explored
const terrainBright = new Sprite(); // baked terrain, full — shown where currently visible
terrainDim.tint = 0x44505c; // explored "memory" shading
const entityLayer = new Container(); // bases + units, painter-sorted
entityLayer.sortableChildren = true;
const fxLayer = new Graphics(); // flying projectiles + impacts, drawn above units
const expMask = new Graphics(); // union of all explored vision (persists across the match)
const visMask = new Graphics(); // union of current vision (rebuilt every tick)
terrainDim.mask = expMask;
terrainBright.mask = visMask;
world.addChild(terrainDim, terrainBright, entityLayer, fxLayer, expMask, visMask);

const isoX = (gx: number, gy: number) => (gx - gy) * (TILE_W / 2);
const isoY = (gx: number, gy: number) => (gx + gy) * (TILE_H / 2);

// Draw an isometric cuboid rising `h` px from ground center (x, yBase); hw/hh = top diamond half-extents.
function isoBox(g: Graphics, x: number, yBase: number, hw: number, hh: number, h: number, color: number) {
  g.poly([x - hw, yBase - h, x, yBase - h + hh, x, yBase + hh, x - hw, yBase]).fill(tint(color, -0.4)); // left face
  g.poly([x + hw, yBase - h, x, yBase - h + hh, x, yBase + hh, x + hw, yBase]).fill(tint(color, -0.22)); // right face
  g.poly([x, yBase - h - hh, x + hw, yBase - h, x, yBase - h + hh, x - hw, yBase - h]).fill(tint(color, 0.12)); // top
}

function tint(hex: number, f: number): number {
  let r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}
// darker, desaturated/teal-shifted terrain so neon units + cyan HUD pop on top
const KIND_COLOR: Record<TerrainKind, number> = { water: 0x06303d, sand: 0x5b5638, grass: 0x163a2a, highland: 0x2b3a28, rock: 0x5c564d }; // rock = warm stone-grey (was bluish)
const elevAt = elevationAt; // cheap render-lift lookup (no cliff slope sampling)

let terrainKey = "";
let terrainTex: import("pixi.js").Texture | null = null;
const exploredCoarse = new Set<number>(); // coarse cells whose vision is already stamped into expMask

// Bake the ENTIRE map's terrain ONCE into a single texture (top faces + side walls on raised
// ground). Painter-ordered by (gx+gy) so nearer tiles overlap correctly. Sheen/decoration are
// dropped — invisible at this tile size and far too many polys at 16× density. The two terrain
// sprites then just sample this texture (cheap), masked by vision — no per-tick tile redraw.
function bakeTerrain(seed: number, W: number, H: number) {
  const g = new Graphics();
  // precompute height + smooth elevation once; the draw loop reads neighbors from these arrays
  const N = W * H, Hh = new Float32Array(N), E = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const h = heightAt(x, y, seed, W, H); const i = y * W + x; Hh[i] = h; E[i] = elevFromHeight(h); }
  const half = TILE_W / 2, hh = TILE_H / 2, D = GRID_SCALE;
  const ix = (x: number, y: number) => (x < 0 ? 0 : x >= W ? W - 1 : x) + (y < 0 ? 0 : y >= H ? H - 1 : y) * W;
  const eAt = (x: number, y: number) => E[ix(x, y)];
  const hgt = (x: number, y: number) => Hh[ix(x, y)];
  for (let d = 0; d <= W - 1 + (H - 1); d++) {
    for (let gx = Math.max(0, d - (H - 1)); gx <= Math.min(W - 1, d); gx++) {
      const gy = d - gx, i = gy * W + gx, h = Hh[i], e = E[i];
      const kind = kindOf(h);
      // steep land = impassable cliff → render as bare rock
      const slope = Math.max(Math.abs(hgt(gx + D, gy) - hgt(gx - D, gy)), Math.abs(hgt(gx, gy + D) - hgt(gx, gy - D))) / (2 * D);
      const blocked = kind === "rock" || (kind !== "water" && slope > CLIFF_SLOPE); // never true for water
      const baseCol = blocked ? KIND_COLOR.rock : KIND_COLOR[kind];
      // smooth hill-shade: surface descending toward the camera catches light, up-slopes shade (gentle)
      const shade = Math.max(-0.16, Math.min(0.16, ((eAt(gx - 1, gy) + eAt(gx, gy - 1)) / 2 - e) * 0.13));
      const col = tint(baseCol, shade);
      const cx = isoX(gx, gy), cy = isoY(gx, gy) - e, baseY = isoY(gx, gy);
      // side faces fill ONLY the drop to the downhill front neighbors — seamless on gentle slopes,
      // tall on steep ground (no stair-step columns to a flat baseline).
      const eFL = eAt(gx, gy + 1), eFR = eAt(gx + 1, gy);
      if (e - eFL > 0.4) g.poly([cx - half, cy, cx, cy + hh, cx, baseY + hh - eFL, cx - half, baseY - eFL]).fill(tint(col, -0.28));
      if (e - eFR > 0.4) g.poly([cx + half, cy, cx, cy + hh, cx, baseY + hh - eFR, cx + half, baseY - eFR]).fill(tint(col, -0.15));
      g.poly([cx, cy - hh, cx + half, cy, cx, cy + hh, cx - half, cy]).fill(col); // top
    }
  }
  const b = g.getLocalBounds();
  if (terrainTex) terrainTex.destroy(true);
  terrainTex = app.renderer.generateTexture({ target: g, resolution: 1 });
  for (const sp of [terrainDim, terrainBright]) { sp.texture = terrainTex; sp.position.set(b.minX, b.minY); }
  g.destroy();
}

function resetFog(seed: number, W: number, H: number) {
  exploredCoarse.clear();
  expMask.clear(); visMask.clear();
  bakeTerrain(seed, W, H);
  terrainKey = `${seed}:${W}:${H}`;
}

// Vision footprint for R cells around (gx,gy): an iso-squashed ELLIPSE (a circle lying on the
// tilted ground) so sight reads as a soft radius rather than a hard square/diamond. Cosmetic —
// the server fog-gates with the Chebyshev box, which this ellipse comfortably covers.
function visionMark(g: Graphics, gx: number, gy: number, R: number) {
  const cx = isoX(gx, gy), cy = isoY(gx, gy);
  g.ellipse(cx, cy, R * TILE_W, R * TILE_H).fill(0xffffff);
}

function renderFog(s: StateMsg) {
  // current vision (bright layer mask) — rebuilt every tick from your bases + units
  visMask.clear();
  const vm = modsFor(s.armyDoctrine).visionMult; // doctrine vision (Phantom sees farther)
  // a unit's sight = base range + HIGH-GROUND bonus (matches server), capped, ×doctrine
  const sight = (u: StateMsg["units"][number]) =>
    Math.min(VISION_CAP, (UNIT_STATS[u.unit].range + highGroundBonus(heightAt(u.x, u.y, s.seed, s.gridW, s.gridH))) * VISION_MULT);
  for (const b of s.bases) if (b.owner === s.you) visionMark(visMask, b.x, b.y, BASE_VISION * vm);
  for (const u of s.units) if (u.owner === s.you) visionMark(visMask, u.x, u.y, sight(u) * vm);
  // explored memory (dim layer mask) — stamp a diamond the first time a viewer enters a coarse
  // cell, so the seen-area grows as you scout without ever redrawing the whole mask.
  const stamp = (gx: number, gy: number, R: number) => {
    const key = (gx >> 5) * 100003 + (gy >> 5);
    if (exploredCoarse.has(key)) return;
    exploredCoarse.add(key);
    visionMark(expMask, gx, gy, R);
  };
  for (const b of s.bases) if (b.owner === s.you) stamp(b.x, b.y, BASE_VISION * vm);
  for (const u of s.units) if (u.owner === s.you) stamp(u.x, u.y, sight(u) * vm);
}

// ---- camera (pan + zoom), centered on your base ----
const cam = { scale: 1 };
function centerOnBase(s: StateMsg) {
  const mine = s.bases.find((b) => b.owner === s.you) ?? s.bases[0];
  if (!mine) return;
  cam.scale = 1; world.scale.set(1);
  world.x = app.screen.width / 2 - isoX(mine.x, mine.y);
  world.y = app.screen.height / 2 - isoY(mine.x, mine.y);
}
let dragging = false, lastX = 0, lastY = 0;
app.canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  world.x += e.clientX - lastX; world.y += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener("pointerup", () => { dragging = false; });
app.canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const ns = Math.max(0.4, Math.min(5, cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  const r = app.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  world.x = mx - (mx - world.x) * (ns / cam.scale); world.y = my - (my - world.y) * (ns / cam.scale);
  cam.scale = ns; world.scale.set(ns);
}, { passive: false });
// double-click the map to drop a RALLY/commitment point — forward units concentrate there (#5)
app.canvas.addEventListener("dblclick", (e) => {
  if (!latestState) return;
  const r = app.canvas.getBoundingClientRect();
  const wx = (e.clientX - r.left - world.x) / cam.scale, wy = (e.clientY - r.top - world.y) / cam.scale;
  const a = (2 * wx) / TILE_W, b = (2 * wy) / TILE_H; // invert iso: a = gx-gy, b = gx+gy
  const gx = Math.round((a + b) / 2), gy = Math.round((b - a) / 2);
  if (gx < 0 || gy < 0 || gx >= latestState.gridW || gy >= latestState.gridH) return;
  sendCmd({ type: "setRally", x: gx, y: gy });
});

// ---- networking ----
let ws: WebSocket;
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => showMatchmaking();
  ws.onmessage = (ev) => {
    const msg: ServerMsg = JSON.parse(ev.data);
    if (msg.type === "state" || msg.type === "camps") hideMatchmaking(); // a room exists → matched
    if (msg.type === "state") { latestState = msg; render(msg); spawnShots(msg); }
    else if (msg.type === "camps") { latestCamps = msg.camps; latestTurretBudget = msg.turretBudget; latestField = msg.fieldGeneral; latestAdvisor = msg.advisor; syncCommanders(); }
    else if (msg.type === "notice") { showNotice(msg.text, msg.level); }
    else if (msg.type === "fieldlog") { addLog(msg.text, msg.tick); }
    else if (msg.type === "gameover") { showEndscreen(msg.won); }
    else if (msg.type === "doctrineOffer") { showDoctrinePicker(msg.current); }
    else if (msg.type === "decision") { showDecision(msg); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
function sendCmd(cmd: unknown) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd)); }
connect();

// ---- projectiles: each shot from the server flies as a tracer, with an impact flash (hit) or a
//      wide whiff (miss). Animated on the render ticker (60fps); purely cosmetic. ----
interface Proj { ax: number; ay: number; bx: number; by: number; t0: number; travel: number; hit: boolean; color: number; big: boolean; ox: number; oy: number; }
const projectiles: Proj[] = [];
function spawnShots(s: StateMsg) {
  for (const sh of s.shots ?? []) {
    if (projectiles.length > 400) break;
    const cells = Math.max(Math.abs(sh.ax - sh.bx), Math.abs(sh.ay - sh.by));
    const big = sh.kind === "tank" || sh.kind === "turret";
    // a miss veers wide of the target by a few px in a random direction
    const a = Math.random() * Math.PI * 2, r = 7 + Math.random() * 8;
    projectiles.push({
      ax: sh.ax, ay: sh.ay, bx: sh.bx, by: sh.by, t0: performance.now(),
      travel: Math.min(360, 90 + cells * 6), hit: sh.hit, big,
      color: sh.owner === s.you ? OWN_COLOR : ENEMY_COLOR,
      ox: sh.hit ? 0 : Math.cos(a) * r, oy: sh.hit ? 0 : Math.sin(a) * r * 0.6,
    });
  }
}
const IMPACT_MS = 120;
// red-orange ember gradient: red glow → orange streak → hot yellow-white core
const TRACER_GLOW = 0xff2d00, TRACER_MID = 0xff7a1a, TRACER_CORE = 0xffe39a;
app.ticker.add(() => {
  if (!projectiles.length || !latestState) { if (!projectiles.length) fxLayer.clear(); return; }
  const s = latestState, now = performance.now();
  fxLayer.clear();
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    const el = now - p.t0;
    if (el >= p.travel + IMPACT_MS) { projectiles.splice(i, 1); continue; }
    const sx = isoX(p.ax, p.ay), sy = isoY(p.ax, p.ay) - elevAt(p.ax, p.ay, s.seed, s.gridW, s.gridH) - 9;
    const ex = isoX(p.bx, p.by) + p.ox, ey = isoY(p.bx, p.by) - elevAt(p.bx, p.by, s.seed, s.gridW, s.gridH) - 6 + p.oy;
    const lift = 2.5 + (p.big ? 1.5 : 0); // gentle, near-flat trajectory
    if (el < p.travel) {
      const t = el / p.travel, tt = Math.max(0, t - 0.16);
      const cx = sx + (ex - sx) * t, cy = sy + (ey - sy) * t - Math.sin(t * Math.PI) * lift;
      const px = sx + (ex - sx) * tt, py = sy + (ey - sy) * tt - Math.sin(tt * Math.PI) * lift;
      fxLayer.moveTo(px, py).lineTo(cx, cy).stroke({ color: TRACER_GLOW, width: p.big ? 4 : 2.6, alpha: 0.35 }); // red glow trail
      fxLayer.moveTo(px, py).lineTo(cx, cy).stroke({ color: TRACER_MID, width: p.big ? 2.2 : 1.3, alpha: 0.9 }); // orange streak
      fxLayer.circle(cx, cy, p.big ? 2.4 : 1.5).fill({ color: TRACER_CORE, alpha: 0.95 }); // hot core
      fxLayer.circle(cx, cy, p.big ? 4.2 : 2.8).fill({ color: TRACER_GLOW, alpha: 0.28 }); // bloom
    } else {
      const k = (el - p.travel) / IMPACT_MS; // 0→1 impact progress
      if (p.hit) {
        fxLayer.circle(ex, ey, (p.big ? 5 : 3) + k * (p.big ? 15 : 9)).stroke({ color: TRACER_GLOW, width: p.big ? 2 : 1.3, alpha: 0.85 * (1 - k) });
        fxLayer.circle(ex, ey, (p.big ? 4 : 2.5) * (1 - k)).fill({ color: TRACER_CORE, alpha: 0.9 * (1 - k) }); // flash
      } else {
        fxLayer.circle(ex, ey, (p.big ? 4 : 3) + k * 5).stroke({ color: TRACER_MID, width: 1, alpha: 0.35 * (1 - k) }); // faint puff
      }
    }
  }
});

// ---- matchmaking: look for a live opponent with a countdown; skip to single-player anytime ----
let mmTimer: number | undefined;
function showMatchmaking() {
  if (document.getElementById("matchmaking")) return; // already searching
  const el = document.createElement("div");
  el.id = "matchmaking";
  el.innerHTML =
    `<div class="mmpanel"><div class="mmspin"></div>` +
    `<h3>Searching for a live opponent…</h3>` +
    `<div class="mmtimer" id="mmtimer">${MM_SECONDS}</div>` +
    `<div class="mmsub">We'll pair you with another commander, or start a single-player skirmish.</div>` +
    `<button class="mmskip" id="mmskip">Skip to single player ▸</button></div>`;
  stage.appendChild(el);
  let left = MM_SECONDS;
  const tick = () => {
    const t = document.getElementById("mmtimer");
    if (t) t.textContent = String(Math.max(0, left));
    if (left <= 0) { clearInterval(mmTimer); sendCmd({ type: "skipToBot" }); return; } // time's up → single player
    left -= 1;
  };
  tick();
  mmTimer = window.setInterval(tick, 1000);
  document.getElementById("mmskip")!.onclick = () => {
    sendCmd({ type: "skipToBot" });
    const b = document.getElementById("mmskip") as HTMLButtonElement | null;
    if (b) { b.textContent = "Starting skirmish…"; b.disabled = true; }
  };
}
function hideMatchmaking() {
  clearInterval(mmTimer);
  document.getElementById("matchmaking")?.remove();
}

function showEndscreen(won: boolean) {
  const el = document.getElementById("endscreen")!;
  el.innerHTML = `<div class="big">${won ? "VICTORY" : "DEFEAT"}</div><div class="end2">${won ? "Enemy base destroyed" : "Your base has fallen"}</div>`;
  el.className = "show " + (won ? "win" : "lose"); // re-set class so the entrance animation replays
}

// ---- army doctrine picker (once per match, #4): your build identity ----
function showDoctrinePicker(current: string) {
  document.getElementById("doctrine")?.remove();
  const el = document.createElement("div");
  el.id = "doctrine";
  el.innerHTML = `<div class="dpanel"><h3>Choose your army doctrine</h3><div class="dsub">Your build identity for this match — pick how you want to win. You can play on without choosing (Combined Arms).</div><div class="dcards"></div></div>`;
  const cards = el.querySelector(".dcards")!;
  for (const d of ARMY_DOCTRINES) {
    const c = document.createElement("button");
    c.className = "dcard" + (d.id === current ? " cur" : "");
    c.innerHTML = `<div class="dl">${d.label}</div><div class="dh">${d.hint}</div><div class="db">${d.blurb}</div>`;
    c.onclick = () => { sendCmd({ type: "chooseArmyDoctrine", id: d.id }); el.remove(); };
    cards.appendChild(c);
  }
  stage.appendChild(el);
}

// ---- strategic fork banner (#1/#5): a commander asks; you answer (or it auto-resolves) ----
let decisionTimer: number | undefined;
interface DecisionMsg { id: number; fromLabel: string; question: string; options: { key: string; label: string; detail: string }[]; expiresInSec: number }
function showDecision(d: DecisionMsg) {
  document.getElementById("decision")?.remove();
  const el = document.createElement("div");
  el.id = "decision";
  el.innerHTML = `<div class="dq"><span class="dfrom">${d.fromLabel}</span>${d.question}</div><div class="dopts"></div><div class="dcd"><i></i></div>`;
  const opts = el.querySelector(".dopts")!;
  for (const o of d.options) {
    const b = document.createElement("button");
    b.className = "dopt";
    b.innerHTML = `<b>${o.label}</b><small>${o.detail}</small>`;
    b.onclick = () => { sendCmd({ type: "decide", id: d.id, key: o.key }); el.remove(); clearTimeout(decisionTimer); };
    opts.appendChild(b);
  }
  stage.appendChild(el);
  const bar = el.querySelector(".dcd i") as HTMLElement; // countdown drains over the answer window
  bar.style.transition = `width ${d.expiresInSec}s linear`;
  requestAnimationFrame(() => { bar.style.width = "0%"; });
  clearTimeout(decisionTimer);
  decisionTimer = window.setTimeout(() => el.remove(), d.expiresInSec * 1000);
}

let noticeTimer: number | undefined;
function showNotice(text: string, level: string) {
  noticeEl.textContent = text;
  noticeEl.style.borderColor = level === "error" ? "#7a2c2c" : "#243140";
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (noticeEl.textContent = ""), 4000);
}

// ---- field general command log (right panel) ----
const fglogEl = document.getElementById("fglog")!;
function addLog(text: string, tick: number) {
  const d = document.createElement("div");
  d.className = "logline";
  d.innerHTML = `<span class="t">t${Math.floor(tick / 10)}s · </span>${text.replace(/^(\d+u[^→]*→ )?/, (m) => m && `<b>${m}</b>`)}`;
  fglogEl.prepend(d);
  while (fglogEl.childElementCount > 60) fglogEl.lastElementChild?.remove();
}

// ---- upgrades panel (player-driven: click to QUEUE; all other spending pauses to save up) ----
const investEl = document.getElementById("invest")!;
const UP_ICON: Record<string, string> = { damage: "◆", hp: "✚", armor: "⛨", range: "◎", speed: "»", income: "⛃" };
const UP_PIPS = 6;
let upgradesBuilt = false;
function syncInvest(s: StateMsg) {
  if (!upgradesBuilt) {
    for (const inv of INVESTMENTS) {
      const row = document.createElement("div");
      row.className = "up";
      row.id = `up-row-${inv.kind}`;
      row.title = "Click to queue — all other spending pauses while we save up. Click again to cancel.";
      row.innerHTML =
        `<span class="ico">${UP_ICON[inv.kind]}</span>` +
        `<span class="nm">${inv.label}<small>${inv.effect} per level</small></span>` +
        `<span class="meter" id="up-m-${inv.kind}">${Array.from({ length: UP_PIPS }, () => "<i></i>").join("")}</span>` +
        `<span class="lv" id="up-lv-${inv.kind}"></span>` +
        `<span class="upq" id="up-q-${inv.kind}"></span>`;
      row.onclick = () => sendCmd(latestState?.queuedInvest === inv.kind ? { type: "cancelInvest" } : { type: "queueInvest", kind: inv.kind });
      investEl.appendChild(row);
    }
    upgradesBuilt = true;
  }
  for (const inv of INVESTMENTS) {
    const lvl = s.invest[inv.kind] || 0;
    const cost = investCost(inv.base, lvl);
    const queued = s.queuedInvest === inv.kind;
    document.getElementById(`up-lv-${inv.kind}`)!.textContent = `Lv${lvl}`;
    const pips = document.getElementById(`up-m-${inv.kind}`)!.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle("on", i < lvl);
    const row = document.getElementById(`up-row-${inv.kind}`)!;
    row.classList.toggle("queued", queued);
    row.classList.toggle("paused", !!s.queuedInvest && !queued); // dimmed while saving for another
    const q = document.getElementById(`up-q-${inv.kind}`)!;
    if (queued) q.innerHTML = s.resources >= cost ? `buying…` : `⏳ ${s.resources}/${cost} <b>✕</b>`;
    else q.textContent = `⛃${cost}`;
  }
}

// ---- rendering ----
function render(s: StateMsg) {
  if (terrainKey !== `${s.seed}:${s.gridW}:${s.gridH}`) {
    resetFog(s.seed, s.gridW, s.gridH); centerOnBase(s);
    for (const e of unitViews.values()) e.holder.destroy({ children: true }); // new match → drop stale holders
    unitViews.clear();
  }
  renderFog(s); // unexplored = black · explored = dim memory · visible = bright
  // transient entities (rebuilt each state); units are persistent + interpolated, so don't wipe them
  for (const c of transientFx) c.destroy({ children: true });
  transientFx.length = 0;
  const addT = (g: Container) => { entityLayer.addChild(g); transientFx.push(g); };
  if (s.rally) addT(makeRally(s.rally, s));
  for (const a of s.artifacts) addT(makeArtifact(a, s));
  for (const b of s.bases) addT(makeBase(b, s));
  reconcileUnits(s); // create/update/remove persistent unit holders; the ticker glides them
  if (hovered) hovered = s.units.find((u) => u.id === hovered!.id) ?? null;
  updateReadout();
  const allocPct = latestCamps.reduce((a, c) => a + c.production.budgetPct, 0) + latestTurretBudget;
  const spend = Math.round((s.incomePerSec * Math.min(100, allocPct)) / 100);
  const b = s.bonuses;
  const bonusBits = [b.income && `+${b.income}⛃`, b.range && `+${b.range}rng`, b.hp && `+${b.hp}hp`, b.damage && `+${b.damage}dmg`, b.armor && `−${b.armor}dmg⛨`, b.speed && `+${b.speed * 10}%spd`].filter(Boolean).join(" ");
  econEl.textContent = `⛃ ${s.resources}   ·   +${s.incomePerSec}/s   ·   spend ~${spend}/s   ·   save ${Math.max(0, 100 - allocPct)}%${bonusBits ? "   ·   ⬡ " + bonusBits : ""}`;
  syncInvest(s);
  syncMorale(s);
}

// ---- morale meter + booster ("rally troops") ----
const mfill = document.getElementById("mfill") as HTMLElement;
const mpct = document.getElementById("mpct")!;
const mboost = document.getElementById("mboost") as HTMLButtonElement;
mboost.onclick = () => sendCmd({ type: "buyBooster" });
function syncMorale(s: StateMsg) {
  const m = s.morale ?? 0.7;
  mfill.style.width = `${Math.round(m * 100)}%`;
  const col = m > 0.66 ? "#2fe0bd" : m > 0.4 ? "#ffb547" : "#ff3860"; // high / shaky / breaking
  mfill.style.background = col; mfill.style.color = col;
  mpct.textContent = `${Math.round(m * 100)}% · ${m > 0.66 ? "steady" : m > 0.4 ? "shaky" : "breaking"}`;
  mboost.innerHTML = `⚑ Rally troops · ⛃${s.boosterCost ?? "—"}`;
  mboost.disabled = (s.resources ?? 0) < (s.boosterCost ?? Infinity);
}

// the player's rally/commitment beacon — a pulsing flag forward units concentrate on
function makeRally(p: { x: number; y: number }, s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(p.x, p.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(p.x, p.y), cy = isoY(p.x, p.y) - elev;
  const pulse = 0.5 + 0.5 * Math.sin(s.tick / 5);
  g.ellipse(cx, cy + 3, 15 + 6 * pulse, 7.5 + 3 * pulse).stroke({ color: OWN_COLOR, width: 1.6, alpha: 0.3 + 0.45 * pulse });
  g.rect(cx - 1, cy - 28, 2, 28).fill(OWN_COLOR); // pole
  g.poly([cx + 1, cy - 28, cx + 15, cy - 22.5, cx + 1, cy - 17]).fill({ color: OWN_COLOR, alpha: 0.92 }); // banner
  g.circle(cx, cy + 2, 2).fill(OWN_COLOR);
  g.zIndex = p.x + p.y;
  return g;
}

function makeArtifact(a: StateMsg["artifacts"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(a.x, a.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(a.x, a.y), cy = isoY(a.x, a.y) - elev;
  const neutral = a.owner < 0;
  const accent = a.owner === s.you ? OWN_COLOR : a.owner >= 0 ? ENEMY_COLOR : 0xffd76b; // neutral = gold
  const body = neutral ? 0x615b48 : tint(accent, -0.5); // muted structure; accent = trim/lights/beacon
  const pulse = 0.5 + 0.5 * Math.sin(s.tick / 6);
  const gy = cy + 4; // building footing on the tile

  // shadow + capture-glow pad (stronger pulse while neutral, to read as "claimable")
  g.ellipse(cx, gy + 2, 18, 9).fill({ color: 0x000000, alpha: 0.32 });
  g.ellipse(cx, gy + 1, 15 + 4 * pulse, 7 + 2 * pulse).fill({ color: accent, alpha: neutral ? 0.1 + 0.14 * pulse : 0.12 });

  // a small iso depot: stone platform → main blockhouse → upper tier → rooftop beacon
  isoBox(g, cx, gy, 14, 7, 4, 0x39414e); // platform
  const mainY = gy - 3, mainH = 15;
  isoBox(g, cx, mainY, 9, 4.8, mainH, body); // main blockhouse
  // lit windows on the two visible faces (accent glow)
  const win = { color: accent, alpha: 0.85 };
  for (const dx of [3, 6]) { g.rect(cx + dx, mainY - 10, 1.6, 3).fill(win); g.rect(cx - dx - 1.6, mainY - 10, 1.6, 3).fill(win); }
  const topY = mainY - mainH;
  isoBox(g, cx, topY, 4.6, 2.5, 6, tint(body, 0.12)); // upper tier
  // rooftop beacon
  const beaconY = topY - 6 - 2.5;
  g.rect(cx - 0.6, beaconY, 1.2, 4).fill(tint(body, 0.2)); // mast
  g.circle(cx, beaconY, 2 + pulse * 1.2).fill({ color: accent, alpha: 0.95 });
  g.circle(cx, beaconY, 5 + pulse * 3).fill({ color: accent, alpha: 0.16 });

  if (a.owner >= 0 && a.hp < a.maxHp) g.rect(cx - 12, beaconY - 12, (a.hp / a.maxHp) * 24, 2.5).fill(accent); // hp
  const t = new Text({ text: neutral ? `${a.bonus.label}  ▸ claim` : a.bonus.label, style: { fill: accent, fontFamily: "JetBrains Mono, monospace", fontSize: 10 } });
  t.anchor.set(0.5, 1); t.x = cx; t.y = beaconY - (a.owner >= 0 && a.hp < a.maxHp ? 16 : 8); g.addChild(t);
  g.zIndex = a.x + a.y; // sits with terrain depth
  if (neutral) { // click to invest/claim
    g.eventMode = "static"; g.cursor = "pointer";
    g.on("pointertap", () => sendCmd({ type: "captureArtifact", id: a.id }));
  }
  return g;
}

function makeBase(b: StateMsg["bases"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(b.x, b.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(b.x, b.y), cy = isoY(b.x, b.y) - elev;
  const team = b.owner === s.you ? OWN_COLOR : ENEMY_COLOR;
  // base art is drawn in TILE units; tiles shrank by GRID_SCALE, so scale back up to keep the
  // fortress the same on-screen size as before (it spans more fine cells now, which is correct).
  const BW = TILE_W * GRID_SCALE, BH = TILE_H * GRID_SCALE;
  // big iso fortress: shadow → team glow → stone platform → flanking towers → central keep → flag → hp
  g.ellipse(cx, cy + BH * 1.0, BW * 2.5, BH * 1.7).fill({ color: 0x000000, alpha: 0.32 });
  g.ellipse(cx, cy + BH * 0.9, BW * 3.0, BH * 2.1).fill({ color: team, alpha: 0.12 }); // team glow
  isoBox(g, cx, cy + BH * 1.3, BW * 2.0, BH * 2.0, BH * 0.6, 0x3a4250); // platform
  isoBox(g, cx - BW * 1.25, cy + BH * 0.5, BW * 0.5, BH * 0.5, BH * 3.2, tint(team, -0.12)); // L tower
  isoBox(g, cx + BW * 1.25, cy + BH * 0.5, BW * 0.5, BH * 0.5, BH * 3.2, tint(team, -0.12)); // R tower
  const keepH = BH * 4.6, keepBaseY = cy + BH * 0.2;
  isoBox(g, cx, keepBaseY, BW * 0.95, BH * 0.95, keepH, team); // central keep
  const topY = keepBaseY - keepH - BH * 0.95;
  g.rect(cx - 1, topY - 18, 2, 18).fill(0xcfd8e3); // flag pole
  g.poly([cx + 1, topY - 18, cx + 15, topY - 13, cx + 1, topY - 8]).fill(tint(team, 0.35)); // banner
  g.rect(cx - BW * 0.95, topY - 26, (b.hp / b.maxHp) * BW * 1.9, 4).fill(team); // hp bar
  g.zIndex = b.x + b.y;
  return g;
}

// The LIT TOP CAP: the finest detail, drawn on the apex layer only (FORWARD = +x so the
// barrel/rifle/camera point along heading once the layer is rotated). The chassis volume
// itself is sculpted by the stacked cross-sections below — this is just the crown.
function drawBody(g: Graphics, type: UnitType, side: number, ln: { color: number; width: number; alpha: number }, acc: number) {
  const dark = tint(side, -0.3), light = tint(side, 0.34), lighter = tint(side, 0.6);
  const gun = 0x2b3138, glass = 0x0b1620;
  if (type === "tank") {
    g.roundRect(-5, -4.5, 10, 9, 3).fill(light).stroke(ln); // turret top face
    g.roundRect(-4, -4, 7.5, 2.4, 1.2).fill({ color: lighter, alpha: 0.55 }); // turret sheen
    g.roundRect(3, -1.5, 16, 3, 1.3).fill(gun); g.roundRect(3, -1.5, 16, 1, 0.5).fill({ color: 0x4a525a, alpha: 0.7 }); // barrel + glint
    g.circle(19, 0, 1.9).fill(0x14181c); // muzzle
    g.rect(-3.5, -5.5, 0.9, 4).fill(gun); // antenna
    g.circle(-0.5, 0, 2).fill(tint(side, -0.12)); g.circle(-0.5, 0, 1).fill(acc); // hatch + doctrine pip
  } else if (type === "humvee") {
    g.roundRect(-6.5, -4.5, 13, 9, 3).fill(light).stroke(ln); // roof
    g.roundRect(-5.5, -3.8, 5, 7.6, 1.5).fill({ color: lighter, alpha: 0.4 }); // roof sheen
    g.roundRect(3, -3.4, 3, 6.8, 1).fill(glass); // windshield (front)
    g.roundRect(-2, -3.6, 2.4, 7.2, 0.8).fill({ color: gun, alpha: 0.7 }); // roof rack
    g.rect(5.5, -4.5, 0.9, 3).fill(gun); // antenna
    g.circle(-4.5, 0, 1.2).fill(acc); // pip
  } else if (type === "gunner") {
    g.circle(0.4, 0, 2.8).fill(light).stroke(ln); // helmet dome
    g.arc(0.4, 0, 2.8, -1.0, 1.0).fill({ color: lighter, alpha: 0.5 }); // helmet sheen
    g.roundRect(2.2, -0.8, 12, 1.7, 0.8).fill(gun); g.rect(12.5, -1.3, 1.6, 2.6).fill(0x14181c); // rifle + stock
    g.circle(0.4, -1.4, 0.9).fill(acc); // pip
  } else if (type === "drone") { // full quad — it's a thin/flat airframe, so the cap carries it
    for (const [rx, ry] of [[6, 6], [6, -6], [-6, 6], [-6, -6]]) g.moveTo(0, 0).lineTo(rx, ry).stroke({ color: dark, width: 1.8 });
    for (const [rx, ry] of [[6, 6], [6, -6], [-6, 6], [-6, -6]]) { g.circle(rx, ry, 2.7).fill({ color: side, alpha: 0.22 }); g.circle(rx, ry, 2.7).stroke({ color: lighter, width: 1, alpha: 0.75 }); g.circle(rx, ry, 0.9).fill(dark); }
    g.circle(0, 0, 3.4).fill(light).stroke(ln); // body
    g.circle(3, 0, 1.5).fill(glass); // gimbal camera (front)
    g.circle(0, 0, 1.1).fill(acc);
  } else { // turret emplacement: gun mantlet + barrel
    g.circle(0, 0, 4.8).fill(light).stroke(ln);
    g.arc(0, 0, 4.8, -1.0, 1.0).fill({ color: lighter, alpha: 0.45 });
    g.roundRect(0, -1.8, 16, 3.6, 1.4).fill(gun); g.circle(16, 0, 2).fill(0x14181c); // barrel + muzzle
    g.circle(0, 0, 1.4).fill(acc);
  }
}

// Cross-section of the unit at height fraction t (0 = ground, 1 = apex). Varying the shape
// with t SCULPTS a real 3D volume out of the stack: a tank narrows into its turret dome,
// a soldier rises legs → torso → head, a turret tapers into a tower. forward = +x.
function drawSilhouette(g: Graphics, type: UnitType, color: number, t: number) {
  const dk = tint(color, -0.28);
  if (type === "tank") {
    if (t < 0.42) { // hull + tracks
      g.roundRect(-9, -6.5, 18, 13, 3).fill(color);
      g.roundRect(-10, -7.6, 20, 3.4, 1.4).fill(dk); g.roundRect(-10, 4.2, 20, 3.4, 1.4).fill(dk);
    } else if (t < 0.72) { // upper hull
      g.roundRect(-8.5, -5.5, 17, 11, 3).fill(color);
    } else { // turret dome, narrowing to the top cap
      const s = 1 - (t - 0.72) * 0.85;
      g.roundRect(-5.5 * s, -5 * s, 11 * s, 10 * s, 3 * s).fill(color);
    }
  } else if (type === "humvee") {
    if (t < 0.46) { // chassis + wheels
      g.roundRect(-9, -5.5, 18, 11, 3).fill(color);
      for (const [wx, wy] of [[-5.5, -6.2], [5.5, -6.2], [-5.5, 6.2], [5.5, 6.2]]) g.circle(wx, wy, 2.4).fill(dk);
    } else { // armored cabin, set back from a lower hood
      g.roundRect(-7, -5, 12, 10, 3).fill(color);
    }
  } else if (type === "gunner") {
    if (t < 0.34) { g.roundRect(-2, -3, 4, 2.5, 1).fill(color); g.roundRect(-2, 0.5, 4, 2.5, 1).fill(color); } // boots/legs
    else if (t < 0.74) g.roundRect(-2.6, -3.2, 6.4, 6.4, 2.4).fill(color); // torso + pack
    else { const s = 1 - (t - 0.74) * 0.5; g.circle(0.4, 0, 2.7 * s).fill(color); } // head
  } else if (type === "drone") {
    g.circle(0, 0, 3.4 - t * 1.3).fill(color);
  } else { // turret tower
    if (t < 0.55) { const s = 1 - t * 0.28; g.circle(0, 0, 6.6 * s).fill(color); }
    else { const s = 1 - (t - 0.55) * 0.55; g.circle(0, 0, 5 * s).fill(color); }
  }
}
const UNIT_HEIGHT: Record<string, number> = { tank: 9, turret: 13, humvee: 8, gunner: 9, drone: 3 };

// Build a unit's visual art at the ORIGIN (no world position). A persistent per-unit holder carries
// the position, which the render ticker eases between cells so units glide instead of snapping.
function unitArt(u: StateMsg["units"][number], s: StateMsg): Container {
  const cont = new Container();
  const side = u.owner === s.you ? OWN_COLOR : ENEMY_COLOR;
  const acc = u.camp ? DOCTRINE_COLOR[u.camp] : 0x9aa6b2;
  const ln = { color: 0x05080b, width: 1, alpha: 0.55 };
  const rad = u.unit === "tank" || u.unit === "turret" ? 10 : 8;
  const lift = u.unit === "drone" ? 14 : 2; // ground units sit on the deck; drone hovers

  const base = new Graphics(); // never rotates: shadow, glow, (turret ground ring)
  base.ellipse(0, 3, 11, 4.5).fill({ color: 0x000000, alpha: 0.3 });
  base.ellipse(0, 1, rad + 11, (rad + 11) * 0.5).fill({ color: side, alpha: 0.12 });
  base.ellipse(0, 1, rad + 6, (rad + 6) * 0.5).fill({ color: side, alpha: 0.14 });
  if (u.unit === "turret") base.ellipse(0, 3, 12, 6.5).fill(tint(side, -0.3)).stroke(ln);
  cont.addChild(base);

  // Volume via z-stacking: the iso-projected footprint is drawn many times, each ~1px higher
  // in screen space (dark base → lit top), with the detailed sprite as the top face. The
  // peeking rims of the lower layers read as the unit's sides — real iso height, no assets.
  const heading = Math.atan2(u.dy, u.dx) + Math.PI / 4; // grid heading rotated into iso space
  const H = UNIT_HEIGHT[u.unit], SP = 1.25;
  for (let i = 0; i <= H; i++) {
    const t = i / H; // height fraction: 0 = ground, 1 = apex
    const wrap = new Container();
    // each layer rises in true screen-vertical, with a slight rightward lean so one lit
    // side face is exposed (fakes a directional sun, like the reference's top-lit models)
    wrap.position.set(t * 1.6, -(lift + i * SP));
    wrap.scale.set(1, 0.62); // iso ground squash
    const g = new Graphics();
    g.rotation = heading;
    if (i === H) drawBody(g, u.unit, side, ln, acc); // lit, detailed top cap
    else drawSilhouette(g, u.unit, tint(side, -0.58 + t * 0.72), t); // sculpted volume, dark base → lit top
    wrap.addChild(g);
    cont.addChild(wrap);
  }

  const top = new Graphics(); // never rotates: hp bar + override ring, above the stacked volume
  const topY = lift + H * 1.3 + rad * 0.4;
  if (u.hp < u.maxHp) top.rect(-rad, -topY - 6, (u.hp / u.maxHp) * rad * 2, 2).fill(0xeaf2fb);
  if (u.overrideUntil > s.tick) top.circle(0, -topY, rad + 4).stroke({ color: 0xffd76b, width: 1.5, alpha: 0.5 + 0.5 * Math.sin(s.tick / 2) });
  cont.addChild(top);
  return cont;
}

// ---- smooth unit movement: a persistent holder per unit id, eased toward the latest server cell ----
interface UnitView { holder: Container; art: Container | null; gx: number; gy: number; tgx: number; tgy: number; u: StateMsg["units"][number]; }
const unitViews = new Map<number, UnitView>();
const transientFx: Container[] = []; // bases/artifacts/rally — rebuilt each state (no interpolation)

function placeHolder(e: UnitView, s: StateMsg) {
  e.holder.x = isoX(e.gx, e.gy);
  e.holder.y = isoY(e.gx, e.gy) - elevAt(e.gx, e.gy, s.seed, s.gridW, s.gridH);
  e.holder.zIndex = e.gx + e.gy;
}

function reconcileUnits(s: StateMsg) {
  const live = new Set<number>();
  for (const u of s.units) {
    live.add(u.id);
    let e = unitViews.get(u.id);
    if (!e) {
      const holder = new Container();
      holder.eventMode = "static"; holder.cursor = "pointer";
      e = { holder, art: null, gx: u.x, gy: u.y, tgx: u.x, tgy: u.y, u };
      const ev = e;
      holder.on("pointerover", () => { hovered = ev.u; updateReadout(); });
      holder.on("pointerout", () => { if (hovered?.id === ev.u.id) { hovered = null; updateReadout(); } });
      entityLayer.addChild(holder);
      unitViews.set(u.id, e);
      placeHolder(e, s); // place new units immediately (no glide from origin)
    }
    e.u = u; e.tgx = u.x; e.tgy = u.y; // server position is the glide target
    if (e.art) e.art.destroy({ children: true });
    e.art = unitArt(u, s);
    e.holder.addChild(e.art);
  }
  for (const [id, e] of unitViews) if (!live.has(id)) { e.holder.destroy({ children: true }); unitViews.delete(id); }
}

// glide every holder toward its target cell each frame (frame-rate independent exponential ease)
const GLIDE_RATE = 9;
app.ticker.add(() => {
  if (!latestState || !unitViews.size) return;
  const s = latestState;
  const k = 1 - Math.exp(-Math.min(0.05, app.ticker.deltaMS / 1000) * GLIDE_RATE);
  for (const e of unitViews.values()) {
    e.gx += (e.tgx - e.gx) * k;
    e.gy += (e.tgy - e.gy) * k;
    placeHolder(e, s);
  }
});

function updateReadout() {
  if (!hovered || !latestState) { readoutEl.textContent = "hover a unit to inspect it"; return; }
  const u = hovered;
  const who = u.owner === latestState.you ? "yours" : "enemy";
  // terrain elevation under the unit → high-ground combat edge (matches sim attack scaling)
  const th = heightAt(u.x, u.y, latestState.seed, latestState.gridW, latestState.gridH);
  const ground = th >= 0.60
    ? `<span style="color:#ffd76b">⛰ HIGH GROUND</span> · +dmg downhill`
    : th < 0.40 ? `<span style="color:#8aa">↓ low ground</span> · −dmg uphill` : `level ground`;
  const acc = UNIT_STATS[u.unit].accuracy;
  const accStr = acc > 0 ? ` · acc ${Math.round(acc * 100)}%` : "";
  const header = `${UNIT_STATS[u.unit].label} #${u.id} · ${who} · hp ${u.hp}/${u.maxHp}${accStr}<br><span class="sub">${ground}</span>`;
  if (!u.camp) { readoutEl.innerHTML = `${header}<br><b>Building</b> — stationary, no doctrine`; return; } // building
  const overridden = u.overrideUntil > latestState.tick;
  const secs = overridden ? Math.ceil((u.overrideUntil - latestState.tick) / 10) : 0;
  const cls = DOCTRINE_CLASS[u.camp];
  readoutEl.innerHTML =
    `${header}<br>` +
    `<b>Native:</b> <span class="${cls}">${u.camp}</span><br>` +
    `<b>Current:</b> ${overridden ? `<span style="color:#ffd76b">OVERRIDE — ${u.overrideLabel} (${secs}s, then reverts)</span>` : `<span class="${cls}">${u.camp} (native)</span>`}`;
}

// ---- the 6 commanders: one cohesive bottom strip. Each shows its accumulated MEMORY above
//      a message box; sending a message appends to that commander's memory (server-side). ----
const controlsEl = document.getElementById("controls")!;
const COMMANDERS: { id: string; kind: "advisor" | "camp" | "field"; cls: string }[] = [
  { id: "advisor", kind: "advisor", cls: "" },
  { id: "aggressive", kind: "camp", cls: "agg" },
  { id: "recon", kind: "camp", cls: "rec" },
  { id: "defensive", kind: "camp", cls: "def" },
  { id: "builder", kind: "camp", cls: "bld" },
  { id: "field", kind: "field", cls: "" },
];
let cmdBuilt = false;
const setText = (id: string, t: string) => { const e = document.getElementById(id); if (e) e.textContent = t; };

function buildCommanders() {
  controlsEl.innerHTML = "";
  for (const c of COMMANDERS) {
    const div = document.createElement("div");
    div.className = "cmd";
    div.innerHTML =
      `<h4 class="${c.cls}" id="lbl-${c.id}">…</h4>` +
      `<div class="mem" id="mem-${c.id}"></div>` +
      (c.kind === "camp" ? `<div class="spec" id="spec-${c.id}"></div><span class="cool" id="cool-${c.id}"></span>` : "") +
      `<div class="cmdrow"><input id="in-${c.id}" placeholder="message…"/><button class="send" id="send-${c.id}">Send</button></div>`;
    controlsEl.appendChild(div);
    const send = () => {
      const inp = document.getElementById(`in-${c.id}`) as HTMLInputElement;
      const text = inp.value.trim();
      if (!text) return;
      inp.value = "";
      if (c.kind === "camp") sendCmd({ type: "editPrompt", camp: c.id, prompt: text });
      else if (c.kind === "field") sendCmd({ type: "editFieldGeneral", prompt: text });
      else sendCmd({ type: "editAdvisor", prompt: text });
    };
    (document.getElementById(`send-${c.id}`) as HTMLButtonElement).onclick = send;
    (document.getElementById(`in-${c.id}`) as HTMLInputElement).addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  }
}
function syncCommanders() {
  if (!cmdBuilt) { buildCommanders(); cmdBuilt = true; }
  for (const c of latestCamps) {
    setText(`lbl-${c.id}`, c.label);
    setText(`mem-${c.id}`, c.prompt);
    setText(`spec-${c.id}`, `agg ${c.spec.aggression.toFixed(2)} · eng ${c.spec.engageRange} · expl ${c.spec.explorationBias.toFixed(2)} · leash ${c.spec.defendRadius ?? "—"}`);
    const remain = Math.max(0, Math.ceil((c.cooldownUntil - Date.now()) / 1000));
    setText(`cool-${c.id}`, c.compiling ? "compiling…" : remain > 0 ? `recompiles in ${remain}s` : "");
  }
  if (latestField) { setText("lbl-field", latestField.label); setText("mem-field", latestField.prompt); }
  if (latestAdvisor) { setText("lbl-advisor", latestAdvisor.label); setText("mem-advisor", latestAdvisor.prompt); }
  if (!dragId()) renderSankey();
}
setInterval(() => { if (latestCamps.length) syncCommanders(); }, 250); // live cooldown countdown

// ---- interactive Sankey: Income → Attack/Intel/Defense/Savings → unit outputs ----
const NS = "http://www.w3.org/2000/svg";
const sankeyEl = document.getElementById("sankey") as unknown as SVGSVGElement;
const HEXCSS: Record<DoctrineId, string> = { aggressive: "#ff5d73", recon: "#5ab0ff", defensive: "#2fe0bd", builder: "#ffb547" };
const S_TOP = 38; // room for the income label + a gap before the bars
let S_HC = 600; // usable chart height; recomputed from the panel each render
let sankeyPxPerPct = 3; // px of band height per 1% of budget (for drag mapping)
// two kinds of drag: a camp's budget share, or a unit's weight within a camp
let dragBudgetId: DoctrineId | "turret" | null = null, dragBudgetStartY = 0, dragBudgetStartPct = 0, dragBudgetPct = 0;
let dragMixId: DoctrineId | null = null, dragMixUnit: UnitType | null = null, dragMixStartY = 0, dragMixStartW = 0, dragMixW = 0;
const dragId = () => dragBudgetId || dragMixId; // any active drag (suppresses re-render from polling)

function mk(tag: string, attrs: Record<string, string | number>, parent: Element): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e as SVGElement;
}
function ribbon(xL: number, yL0: number, yL1: number, xR: number, yR0: number, yR1: number): string {
  const mx = (xL + xR) / 2;
  return `M${xL},${yL0} C${mx},${yL0} ${mx},${yR0} ${xR},${yR0} L${xR},${yR1} C${mx},${yR1} ${mx},${yL1} ${xL},${yL1} Z`;
}
const budgetOf = (c: Camp) => (dragBudgetId === c.id ? dragBudgetPct : c.production.budgetPct);
const mixOf = (c: Camp, u: UnitType) => (dragMixId === c.id && dragMixUnit === u ? dragMixW : c.production.mix[u] || 0);

// 3-layer Sankey: Income → Camp (Attack/Intel/Defense/Savings) → Unit type
function renderSankey() {
  if (!latestState || latestCamps.length < 3) return;
  S_HC = Math.max(80, sankeyEl.clientHeight - S_TOP - 10); // fill the panel's full height
  while (sankeyEl.firstChild) sankeyEl.removeChild(sankeyEl.firstChild);
  const camps = DOCTRINES.map((d) => latestCamps.find((c) => c.id === d)!).filter(Boolean);
  const campSum = camps.reduce((a, c) => a + budgetOf(c), 0);
  const turretPct = dragBudgetId === "turret" ? dragBudgetPct : latestTurretBudget;
  const savings = Math.max(0, 100 - campSum - turretPct);
  const incX = 4, incW = 14, campX = 74, campW = 18, unitX = 196, unitW = 18, GAP = 7;

  mk("rect", { x: incX, y: S_TOP, width: incW, height: S_HC, rx: 2, fill: "#cdd6e0" }, sankeyEl);
  mk("text", { x: incX, y: 13, "font-size": 10 }, sankeyEl).textContent = `Income +${latestState.incomePerSec}/s`; // pinned near the top, clear of the bars

  // Fit-based layout: 5 stacked bands (3 camps + turrets + savings) sum to `usable`, so the
  // chart never overflows. Each band = a floor + a share of the remainder by %.
  const CAMP_MIN = 12, UNIT_MIN = 7, n = TRAINABLE.length, NB = camps.length + 2; // camps + turret + savings
  const usable = Math.max(40, S_HC - (NB - 1) * GAP);
  const remainder = Math.max(1, usable - NB * CAMP_MIN);
  sankeyPxPerPct = remainder / 100;
  type Band = { id: DoctrineId | "turret" | "savings"; camp: Camp | null; pct: number; col: string; label: string; drag: boolean };
  const bands: Band[] = [
    ...camps.map((c) => ({ id: c.id, camp: c, pct: budgetOf(c), col: HEXCSS[c.id], label: `${BUDGET_NAME[c.id]} ${Math.round(budgetOf(c))}%`, drag: true })),
    { id: "turret", camp: null, pct: turretPct, col: "#9aa6b2", label: `Turrets ${Math.round(turretPct)}% → defenses`, drag: true },
    { id: "savings", camp: null, pct: savings, col: "#5b6b74", label: `Savings ${Math.round(savings)}% (banked)`, drag: false },
  ];
  let y = S_TOP;
  for (const b of bands) {
    const h = CAMP_MIN + (b.pct / 100) * remainder; // bands sum to `usable`
    const on = b.pct > 0.5;
    mk("path", { d: ribbon(incX + incW, y, y + h, campX, y, y + h), fill: b.col, "fill-opacity": on ? 0.26 : 0.08 }, sankeyEl);
    mk("rect", { x: campX, y, width: campW, height: h, rx: 2, fill: b.col, "fill-opacity": on ? 0.92 : 0.34 }, sankeyEl); // read-only (advisor sets it)
    mk("text", { x: 20, y: y + h / 2 + 3.5, "font-size": 10, "fill-opacity": on ? 1 : 0.6 }, sankeyEl).textContent = b.label;

    if (b.camp) {
      // split this camp band across unit types — sub-bands sum to the band height (fit)
      const W = TRAINABLE.reduce((a, u) => a + mixOf(b.camp!, u), 0);
      let ySeg = y;
      for (const u of TRAINABLE) {
        const w = mixOf(b.camp, u);
        const segH = W <= 0 ? h / n : h >= n * UNIT_MIN ? UNIT_MIN + (w / W) * (h - n * UNIT_MIN) : (w / W) * h;
        if (segH < 0.5) continue;
        const onu = w > 0;
        mk("path", { d: ribbon(campX + campW, ySeg, ySeg + segH, unitX, ySeg, ySeg + segH), fill: b.col, "fill-opacity": onu ? 0.2 : 0.07 }, sankeyEl);
        mk("rect", { x: unitX, y: ySeg, width: unitW, height: segH, rx: 2, fill: b.col, "fill-opacity": onu ? 0.95 : 0.34 }, sankeyEl);
        if (segH > 9) mk("text", { x: unitX + unitW + 5, y: ySeg + segH / 2 + 3.5, "font-size": 10, "fill-opacity": onu ? 1 : 0.55 }, sankeyEl).textContent =
          `${UNIT_STATS[u].label.replace(" Infantry", "")} ${Math.round((W > 0 ? w / W : 0) * 100)}%`;
        ySeg += segH;
      }
    }
    y += h + GAP;
  }
}

sankeyEl.addEventListener("pointerdown", (e) => {
  const a = (e.target as Element).getAttribute?.("data-band");
  const m = (e.target as Element).getAttribute?.("data-mix");
  if (a) {
    dragBudgetId = a as DoctrineId | "turret"; dragBudgetStartY = e.clientY;
    dragBudgetStartPct = a === "turret" ? latestTurretBudget : latestCamps.find((c) => c.id === a)!.production.budgetPct;
    dragBudgetPct = dragBudgetStartPct;
    e.preventDefault();
  } else if (m) {
    const [cid, u] = m.split(":");
    dragMixId = cid as DoctrineId; dragMixUnit = u as UnitType; dragMixStartY = e.clientY;
    dragMixStartW = latestCamps.find((c) => c.id === cid)!.production.mix[u as UnitType] || 0; dragMixW = dragMixStartW;
    e.preventDefault();
  }
});
window.addEventListener("pointermove", (e) => {
  if (dragBudgetId) {
    const campSum = latestCamps.reduce((a, c) => a + c.production.budgetPct, 0);
    const others = dragBudgetId === "turret"
      ? campSum // savings absorbs the rest
      : campSum - latestCamps.find((c) => c.id === dragBudgetId)!.production.budgetPct + latestTurretBudget;
    const raw = dragBudgetStartPct + (dragBudgetStartY - e.clientY) / sankeyPxPerPct;
    dragBudgetPct = Math.max(0, Math.min(100 - others, Math.round(raw / 5) * 5));
    renderSankey();
  } else if (dragMixId) {
    const raw = dragMixStartW + ((dragMixStartY - e.clientY) / S_HC) * 100;
    dragMixW = Math.max(0, Math.min(100, Math.round(raw / 5) * 5));
    renderSankey();
  }
});
window.addEventListener("pointerup", () => {
  if (dragBudgetId === "turret") { sendCmd({ type: "setTurretBudget", budgetPct: dragBudgetPct }); dragBudgetId = null; }
  else if (dragBudgetId) { sendCmd({ type: "setBudget", camp: dragBudgetId, budgetPct: dragBudgetPct }); dragBudgetId = null; }
  else if (dragMixId && dragMixUnit) { sendCmd({ type: "setMix", camp: dragMixId, unit: dragMixUnit, weight: dragMixW }); dragMixId = null; dragMixUnit = null; }
});


