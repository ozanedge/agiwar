// agiwar web client: renders the server-authoritative snapshot and sends sparse commands.
import { Application, Container, Graphics, Text } from "pixi.js";
import type { Camp, DoctrineId, FieldGeneral, ServerMsg, StateMsg, UnitState } from "../../../shared/types.js";
import { UNIT_STATS, TRAINABLE, VISION_MULT, BASE_VISION, INVESTMENTS, investCost, type UnitType } from "../../../shared/units.js";
import { terrainAt, type TerrainKind } from "../../../shared/terrain.js";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:8787";
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
const TILE_W = 36, TILE_H = 18; // 2:1 isometric diamond
const world = new Container(); // camera-transformed
app.stage.addChild(world);
// Three fog states: unexplored = nothing drawn (black bg) · explored = dim "memory" terrain ·
// currently visible = bright terrain on top.
const exploredLayer = new Graphics(); // dim terrain you've seen before (persists)
const revealLayer = new Graphics(); // bright terrain where you currently have vision
const entityLayer = new Container(); // bases + units, painter-sorted
entityLayer.sortableChildren = true;
world.addChild(exploredLayer, revealLayer, entityLayer);

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
// small deterministic hash for decoration placement
const dhash = (a: number, b: number) => { let n = (Math.imul(a, 2654435761) ^ Math.imul(b, 40503)) >>> 0; n ^= n >>> 15; return (n >>> 0) / 4294967296; };

// darker, desaturated/teal-shifted terrain so neon units + cyan HUD pop on top
const KIND_COLOR: Record<TerrainKind, number> = { water: 0x06303d, sand: 0x5b5638, grass: 0x163a2a, highland: 0x2b3a28, rock: 0x2e3848 };
const elevAt = (gx: number, gy: number, seed: number, W: number, H: number) => terrainAt(gx, gy, seed, W, H).elev;

function decorate(g: Graphics, kind: TerrainKind, gx: number, gy: number, seed: number, cx: number, cy: number) {
  const r = dhash(gx * 7 + 1, gy * 13 + 3);
  if (kind === "rock") { // mountain crag
    g.poly([cx, cy - TILE_H * 0.9, cx + 6, cy - TILE_H * 0.1, cx - 6, cy - TILE_H * 0.1]).fill(tint(0x9a9488, 0.15));
    g.poly([cx + 2, cy - TILE_H * 1.1, cx + 8, cy - TILE_H * 0.2, cx, cy - TILE_H * 0.2]).fill(tint(0x6f6a60, -0.05));
  } else if ((kind === "grass" || kind === "highland") && r < 0.07) { // tree
    g.rect(cx - 1, cy - 7, 2, 7).fill(0x5a4326);
    g.circle(cx, cy - 10, 5).fill(tint(0x2e6b34, (r - 0.035) * 2));
    g.circle(cx + 2, cy - 7, 3.5).fill(0x357a3c);
  } else if (kind === "sand" && r > 0.96) { // occasional desert rock
    g.circle(cx, cy - 2, 2.5).fill(0xb6a273);
  }
}

let terrainKey = "";
const explored = new Set<number>(); // tile keys ever seen (fog-of-war memory)
let exploredDrawn = 0; // last count rendered into exploredLayer (throttle rebuilds)

function drawTile(layer: Graphics, gx: number, gy: number, seed: number, W: number, H: number, dim = false) {
  const t = terrainAt(gx, gy, seed, W, H);
  const base = tint(KIND_COLOR[t.kind], t.micro);
  const col = dim ? tint(base, -0.6) : base; // dim = explored "memory" look
  const cx = isoX(gx, gy), cy = isoY(gx, gy) - t.elev;
  const groundY = isoY(gx, gy);
  if (!dim && t.elev > 4) { // side walls + detail only on the bright (current-vision) layer
    layer.poly([cx - TILE_W / 2, cy, cx, cy + TILE_H / 2, cx, groundY + TILE_H / 2, cx - TILE_W / 2, groundY]).fill(tint(col, -0.4));
    layer.poly([cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx, groundY + TILE_H / 2, cx + TILE_W / 2, groundY]).fill(tint(col, -0.22));
  }
  layer.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill(col);
  if (!dim) {
    // soft top sheen so tiles read as lit surfaces rather than flat blocks
    layer.poly([cx, cy - TILE_H * 0.34, cx + TILE_W * 0.34, cy - TILE_H * 0.04, cx, cy + TILE_H * 0.18, cx - TILE_W * 0.34, cy - TILE_H * 0.04]).fill({ color: tint(col, 0.18), alpha: 0.4 });
    decorate(layer, t.kind, gx, gy, seed, cx, cy);
  }
}

function resetFog(seed: number, W: number, H: number) {
  explored.clear(); exploredDrawn = 0;
  exploredLayer.clear(); revealLayer.clear();
  terrainKey = `${seed}:${W}:${H}`;
}

let fogTick = 0;
function renderFog(s: StateMsg) {
  const vis = new Set<number>();
  const addBox = (cx: number, cy: number, R: number) => {
    for (let gx = Math.max(0, cx - R); gx <= Math.min(s.gridW - 1, cx + R); gx++)
      for (let gy = Math.max(0, cy - R); gy <= Math.min(s.gridH - 1, cy + R); gy++) vis.add(gy * s.gridW + gx);
  };
  for (const b of s.bases) if (b.owner === s.you) addBox(b.x, b.y, BASE_VISION);
  for (const u of s.units) if (u.owner === s.you) addBox(u.x, u.y, UNIT_STATS[u.unit].range * VISION_MULT);
  for (const k of vis) explored.add(k);

  // explored "memory" layer (dim) — rebuilt occasionally as the explored set grows
  if (explored.size > exploredDrawn && ++fogTick % 4 === 0) {
    exploredLayer.clear();
    for (const k of explored) drawTile(exploredLayer, k % s.gridW, Math.floor(k / s.gridW), s.seed, s.gridW, s.gridH, true);
    exploredDrawn = explored.size;
  }
  // currently-visible (bright) layer — every tick, painter order for correct elevation overlap
  revealLayer.clear();
  [...vis].sort((a, b) => (Math.floor(a / s.gridW) + (a % s.gridW)) - (Math.floor(b / s.gridW) + (b % s.gridW)))
    .forEach((k) => drawTile(revealLayer, k % s.gridW, Math.floor(k / s.gridW), s.seed, s.gridW, s.gridH, false));
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
  const ns = Math.max(0.4, Math.min(2.6, cam.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  const r = app.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  world.x = mx - (mx - world.x) * (ns / cam.scale); world.y = my - (my - world.y) * (ns / cam.scale);
  cam.scale = ns; world.scale.set(ns);
}, { passive: false });

// ---- networking ----
let ws: WebSocket;
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (ev) => {
    const msg: ServerMsg = JSON.parse(ev.data);
    if (msg.type === "state") { latestState = msg; render(msg); }
    else if (msg.type === "camps") { latestCamps = msg.camps; latestTurretBudget = msg.turretBudget; latestField = msg.fieldGeneral; latestAdvisor = msg.advisor; syncCommanders(); }
    else if (msg.type === "notice") { showNotice(msg.text, msg.level); }
    else if (msg.type === "fieldlog") { addLog(msg.text, msg.tick); }
    else if (msg.type === "gameover") { showEndscreen(msg.won); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
function sendCmd(cmd: unknown) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd)); }
connect();

function showEndscreen(won: boolean) {
  const el = document.getElementById("endscreen")!;
  el.innerHTML = `<div class="big">${won ? "VICTORY" : "DEFEAT"}</div><div class="end2">${won ? "Enemy base destroyed" : "Your base has fallen"}</div>`;
  el.className = "show " + (won ? "win" : "lose"); // re-set class so the entrance animation replays
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

// ---- upgrades panel (read-only; the Advisor buys them) ----
const investEl = document.getElementById("invest")!;
const UP_ICON: Record<string, string> = { damage: "◆", hp: "✚", range: "◎", income: "⛃" };
const UP_PIPS = 6;
let upgradesBuilt = false;
function syncInvest(levels: Record<string, number>) {
  if (!upgradesBuilt) {
    for (const inv of INVESTMENTS) {
      const row = document.createElement("div");
      row.className = "up";
      row.innerHTML =
        `<span class="ico">${UP_ICON[inv.kind]}</span>` +
        `<span class="nm">${inv.label}<small>${inv.effect} per level</small></span>` +
        `<span class="meter" id="up-m-${inv.kind}">${Array.from({ length: UP_PIPS }, () => "<i></i>").join("")}</span>` +
        `<span class="lv" id="up-lv-${inv.kind}"></span>`;
      investEl.appendChild(row);
    }
    upgradesBuilt = true;
  }
  for (const inv of INVESTMENTS) {
    const lvl = levels[inv.kind] || 0;
    document.getElementById(`up-lv-${inv.kind}`)!.textContent = `Lv${lvl}`;
    const pips = document.getElementById(`up-m-${inv.kind}`)!.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle("on", i < lvl);
  }
}

// ---- rendering ----
function render(s: StateMsg) {
  if (terrainKey !== `${s.seed}:${s.gridW}:${s.gridH}`) { resetFog(s.seed, s.gridW, s.gridH); centerOnBase(s); }
  renderFog(s); // unexplored = black · explored = dim memory · visible = bright
  entityLayer.removeChildren();
  for (const a of s.artifacts) entityLayer.addChild(makeArtifact(a, s));
  for (const b of s.bases) entityLayer.addChild(makeBase(b, s));
  for (const u of s.units) entityLayer.addChild(makeUnit(u, s));
  if (hovered) hovered = s.units.find((u) => u.id === hovered!.id) ?? null;
  updateReadout();
  const allocPct = latestCamps.reduce((a, c) => a + c.production.budgetPct, 0) + latestTurretBudget;
  const spend = Math.round((s.incomePerSec * Math.min(100, allocPct)) / 100);
  const b = s.bonuses;
  const bonusBits = [b.income && `+${b.income}⛃`, b.range && `+${b.range}rng`, b.hp && `+${b.hp}hp`, b.damage && `+${b.damage}dmg`].filter(Boolean).join(" ");
  econEl.textContent = `⛃ ${s.resources}   ·   +${s.incomePerSec}/s   ·   spend ~${spend}/s   ·   save ${Math.max(0, 100 - allocPct)}%${bonusBits ? "   ·   ⬡ " + bonusBits : ""}`;
  syncInvest(s.invest);
}

function makeArtifact(a: StateMsg["artifacts"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(a.x, a.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(a.x, a.y), cy = isoY(a.x, a.y) - elev;
  const neutral = a.owner < 0;
  const col = a.owner === s.you ? OWN_COLOR : a.owner >= 0 ? ENEMY_COLOR : 0xffd76b; // neutral = gold
  const pulse = 0.5 + 0.5 * Math.sin(s.tick / 6);
  g.ellipse(cx, cy + 3, 15, 8).fill({ color: col, alpha: 0.16 }); // glow pad
  g.poly([cx, cy - 20, cx + 9, cy - 4, cx, cy + 6, cx - 9, cy - 4]).fill({ color: col, alpha: 0.38 }).stroke({ color: col, width: 2, alpha: 0.6 + 0.4 * pulse }); // crystal
  g.poly([cx, cy - 13, cx + 4.5, cy - 4, cx, cy + 1, cx - 4.5, cy - 4]).fill({ color: tint(col, 0.45), alpha: 0.95 }); // core
  if (a.owner >= 0 && a.hp < a.maxHp) g.rect(cx - 11, cy - 26, (a.hp / a.maxHp) * 22, 2.5).fill(col); // hp
  const t = new Text({ text: neutral ? `${a.bonus.label}  ▸ claim` : a.bonus.label, style: { fill: col, fontFamily: "JetBrains Mono, monospace", fontSize: 10 } });
  t.anchor.set(0.5, 1); t.x = cx; t.y = cy - 22; g.addChild(t);
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
  // big iso fortress: shadow → team glow → stone platform → flanking towers → central keep → flag → hp
  g.ellipse(cx, cy + TILE_H * 1.0, TILE_W * 2.5, TILE_H * 1.7).fill({ color: 0x000000, alpha: 0.32 });
  g.ellipse(cx, cy + TILE_H * 0.9, TILE_W * 3.0, TILE_H * 2.1).fill({ color: team, alpha: 0.12 }); // team glow
  isoBox(g, cx, cy + TILE_H * 1.3, TILE_W * 2.0, TILE_H * 2.0, 11, 0x3a4250); // platform
  isoBox(g, cx - TILE_W * 1.25, cy + TILE_H * 0.5, TILE_W * 0.5, TILE_H * 0.5, TILE_H * 3.2, tint(team, -0.12)); // L tower
  isoBox(g, cx + TILE_W * 1.25, cy + TILE_H * 0.5, TILE_W * 0.5, TILE_H * 0.5, TILE_H * 3.2, tint(team, -0.12)); // R tower
  const keepH = TILE_H * 4.6, keepBaseY = cy + TILE_H * 0.2;
  isoBox(g, cx, keepBaseY, TILE_W * 0.95, TILE_H * 0.95, keepH, team); // central keep
  const topY = keepBaseY - keepH - TILE_H * 0.95;
  g.rect(cx - 1, topY - 18, 2, 18).fill(0xcfd8e3); // flag pole
  g.poly([cx + 1, topY - 18, cx + 15, topY - 13, cx + 1, topY - 8]).fill(tint(team, 0.35)); // banner
  g.rect(cx - TILE_W * 0.95, topY - 26, (b.hp / b.maxHp) * TILE_W * 1.9, 4).fill(team); // hp bar
  g.zIndex = b.x + b.y;
  return g;
}

// detailed sprite, drawn centered at (0,0) with FORWARD = +x; the container rotates it to face heading
function drawBody(g: Graphics, type: UnitType, side: number, ln: { color: number; width: number; alpha: number }, acc: number) {
  const dark = tint(side, -0.3), light = tint(side, 0.3), glass = 0x0b1620;
  if (type === "tank") {
    g.roundRect(-10, -7.5, 20, 4, 1.6).fill(dark); g.roundRect(-10, 3.5, 20, 4, 1.6).fill(dark); // treads
    for (let i = -8; i <= 8; i += 4) { g.rect(i, -7.5, 1, 4).fill(tint(dark, -0.25)); g.rect(i, 3.5, 1, 4).fill(tint(dark, -0.25)); } // tread links
    g.roundRect(-9, -5, 18, 10, 2.5).fill(side).stroke(ln); // hull
    g.roundRect(-8, -4, 15, 3, 1.5).fill({ color: light, alpha: 0.5 }); // hull sheen
    g.roundRect(-4.5, -4.5, 9, 9, 2.5).fill(light).stroke(ln); // turret
    g.roundRect(4, -1.4, 14, 2.8, 1.2).fill(tint(dark, 0.1)); g.circle(18, 0, 1.7).fill(dark); // barrel + muzzle
    g.circle(-0.5, 0, 2).fill(tint(side, -0.15)); g.circle(-0.5, 0, 1).fill(acc); // hatch + pip
  } else if (type === "humvee") {
    for (const [wx, wy] of [[-5.5, -6], [5.5, -6], [-5.5, 6], [5.5, 6]]) { g.circle(wx, wy, 2.4).fill(0x0c0f12); g.circle(wx, wy, 1.1).fill(0x2a2f33); }
    g.roundRect(-9, -5, 18, 10, 2.5).fill(side).stroke(ln); // chassis
    g.roundRect(2.5, -4.2, 6.5, 8.4, 1.5).fill(tint(side, -0.18)); // hood
    g.roundRect(-4.5, -4.5, 7.5, 9, 2).fill(light).stroke(ln); // cabin
    g.roundRect(0.5, -3.4, 2.4, 6.8, 1).fill(glass); // windshield (front)
    g.roundRect(-8.5, -1, 2, 2, 0.5).fill({ color: 0xffe9a8, alpha: 0.5 }); // tail light cluster
    g.circle(-6.5, 0, 1.2).fill(acc); // pip
  } else if (type === "gunner") {
    g.ellipse(-1, 0, 5, 4.2).fill(dark); // pack/base
    g.roundRect(-3.5, -3, 7.5, 6, 2.6).fill(side).stroke(ln); // torso
    g.roundRect(2.5, -0.8, 11, 1.7, 0.8).fill(0x15191c); g.rect(11, -1.3, 1.6, 2.6).fill(0x0d1013); // rifle + stock
    g.circle(2.3, 0, 2.7).fill(light).stroke(ln); // helmet (front)
    g.circle(2.3, 0, 1.1).fill({ color: glass, alpha: 0.8 }); // visor
    g.circle(-4.2, 0, 1.1).fill(acc); // pip
  } else if (type === "drone") {
    for (const [rx, ry] of [[6, 6], [6, -6], [-6, 6], [-6, -6]]) g.moveTo(0, 0).lineTo(rx, ry).stroke({ color: dark, width: 1.6 });
    for (const [rx, ry] of [[6, 6], [6, -6], [-6, 6], [-6, -6]]) { g.circle(rx, ry, 2.6).fill({ color: side, alpha: 0.25 }); g.circle(rx, ry, 2.6).stroke({ color: light, width: 0.9, alpha: 0.7 }); g.circle(rx, ry, 0.9).fill(dark); }
    g.circle(0, 0, 3.4).fill(side).stroke(ln); // body
    g.circle(3, 0, 1.5).fill(glass); // camera (front)
    g.circle(0, 0, 1.1).fill(acc);
  } else { // turret gun (the ground ring is drawn non-rotating in the base layer)
    g.circle(0, 0, 6).fill(side).stroke(ln); // housing
    g.circle(0, 0, 6).stroke({ color: tint(side, 0.3), width: 0.8, alpha: 0.6 });
    g.roundRect(0, -1.7, 16, 3.4, 1.3).fill(tint(dark, 0.1)); g.circle(16, 0, 1.9).fill(dark); // barrel + muzzle
    g.circle(0, 0, 2.4).fill(tint(side, 0.25)); g.circle(0, 0, 1.1).fill(acc);
  }
}

function makeUnit(u: StateMsg["units"][number], s: StateMsg): Container {
  const cont = new Container();
  const elev = elevAt(u.x, u.y, s.seed, s.gridW, s.gridH);
  cont.x = isoX(u.x, u.y); cont.y = isoY(u.x, u.y) - elev;
  cont.zIndex = u.x + u.y;
  const side = u.owner === s.you ? OWN_COLOR : ENEMY_COLOR;
  const acc = u.camp ? DOCTRINE_COLOR[u.camp] : 0x9aa6b2;
  const ln = { color: 0x05080b, width: 1, alpha: 0.55 };
  const rad = u.unit === "tank" || u.unit === "turret" ? 10 : 8;
  const lift = u.unit === "drone" ? 13 : u.unit === "turret" ? 5 : rad;

  const base = new Graphics(); // never rotates: shadow, glow, (turret ground ring)
  base.ellipse(0, 3, 11, 4.5).fill({ color: 0x000000, alpha: 0.3 });
  base.ellipse(0, 1, rad + 11, (rad + 11) * 0.5).fill({ color: side, alpha: 0.12 });
  base.ellipse(0, 1, rad + 6, (rad + 6) * 0.5).fill({ color: side, alpha: 0.14 });
  if (u.unit === "turret") base.ellipse(0, 3, 12, 6.5).fill(tint(side, -0.3)).stroke(ln);
  cont.addChild(base);

  const body = new Graphics(); // rotates to face heading (iso-projected)
  drawBody(body, u.unit, side, ln, acc);
  body.position.set(0, -lift);
  body.rotation = (u.dx || u.dy) ? Math.atan2((u.dx + u.dy) * (TILE_H / 2), (u.dx - u.dy) * (TILE_W / 2)) : 0;
  cont.addChild(body);

  const top = new Graphics(); // never rotates: hp bar + override ring
  if (u.hp < u.maxHp) top.rect(-rad, -lift - rad - 5, (u.hp / u.maxHp) * rad * 2, 2).fill(0xeaf2fb);
  if (u.overrideUntil > s.tick) top.circle(0, -lift, rad + 4).stroke({ color: 0xffd76b, width: 1.5, alpha: 0.5 + 0.5 * Math.sin(s.tick / 2) });
  cont.addChild(top);

  cont.eventMode = "static";
  cont.cursor = "pointer";
  cont.on("pointerover", () => { hovered = u; updateReadout(); });
  cont.on("pointerout", () => { if (hovered?.id === u.id) { hovered = null; updateReadout(); } });
  return cont;
}

function updateReadout() {
  if (!hovered || !latestState) { readoutEl.textContent = "hover a unit to inspect it"; return; }
  const u = hovered;
  const who = u.owner === latestState.you ? "yours" : "enemy";
  const header = `${UNIT_STATS[u.unit].label} #${u.id} · ${who} · hp ${u.hp}/${u.maxHp}`;
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
const S_TOP = 22; // room for the income label
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
  mk("text", { x: incX, y: S_TOP - 1, "font-size": 10 }, sankeyEl).textContent = `Income +${latestState.incomePerSec}/s`;

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


