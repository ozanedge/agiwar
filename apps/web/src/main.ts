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
const DOCTRINE_COLOR: Record<DoctrineId, number> = { aggressive: 0xff5d73, recon: 0x5ab0ff, defensive: 0x2fe0bd };
const DOCTRINE_CLASS: Record<DoctrineId, string> = { aggressive: "agg", recon: "rec", defensive: "def" };
const BUDGET_NAME: Record<DoctrineId, string> = { aggressive: "Attack", recon: "Intel", defensive: "Defense" };
const DOCTRINES: DoctrineId[] = ["aggressive", "recon", "defensive"];

const stage = document.getElementById("stage")!;
const noticeEl = document.getElementById("notice")!;
const readoutEl = document.getElementById("readout")!;
const econEl = document.getElementById("econ")!;
const campsEl = document.getElementById("camps")!;

let latestState: StateMsg | null = null;
let latestCamps: Camp[] = [];
let latestTurretBudget = 0;
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
  if (!dim) decorate(layer, t.kind, gx, gy, seed, cx, cy);
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
    else if (msg.type === "camps") { latestCamps = msg.camps; latestTurretBudget = msg.turretBudget; syncCamps(msg.camps); syncFieldGeneral(msg.fieldGeneral); }
    else if (msg.type === "notice") { showNotice(msg.text, msg.level); }
    else if (msg.type === "fieldlog") { addLog(msg.text, msg.tick); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
function sendCmd(cmd: unknown) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd)); }
connect();

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

// ---- investments (permanent army upgrades) ----
const investEl = document.getElementById("invest")!;
let investBuilt = false;
function syncInvest(levels: Record<string, number>) {
  if (!investBuilt) {
    for (const inv of INVESTMENTS) {
      const b = document.createElement("button");
      b.innerHTML = `<span>${inv.label} <span class="sub">${inv.effect}</span></span><span id="invc-${inv.kind}"></span>`;
      b.onclick = () => sendCmd({ type: "invest", kind: inv.kind });
      investEl.appendChild(b);
    }
    investBuilt = true;
  }
  for (const inv of INVESTMENTS) {
    const lvl = levels[inv.kind] || 0;
    const cost = investCost(inv.base, lvl);
    const el = document.getElementById(`invc-${inv.kind}`)!;
    el.textContent = `Lv${lvl} · ⛃${cost}`;
    (el.closest("button") as HTMLButtonElement).disabled = !latestState || latestState.resources < cost;
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

function makeUnit(u: StateMsg["units"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(u.x, u.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(u.x, u.y), cy = isoY(u.x, u.y) - elev;
  const side = u.owner === s.you ? OWN_COLOR : ENEMY_COLOR; // primary = side
  const dark = tint(side, -0.28), light = tint(side, 0.28);
  const acc = u.camp ? DOCTRINE_COLOR[u.camp] : 0x9aa6b2; // accent outline = doctrine (neutral for buildings)
  const ln = { color: 0x05080b, width: 1, alpha: 0.55 };
  g.ellipse(cx, cy + 2, 9, 4).fill({ color: 0x000000, alpha: 0.32 }); // ground shadow
  const rad = u.unit === "tank" || u.unit === "turret" ? 9 : 7;
  g.ellipse(cx, cy + 1, rad + 6, (rad + 6) * 0.5).fill({ color: side, alpha: 0.16 }); // neon glow

  if (u.unit === "tank") {
    const by = cy - 5;
    g.roundRect(cx - 9, by - 5, 18, 10, 2).fill(side).stroke(ln);            // hull
    g.rect(cx - 9, by + 3, 18, 2).fill(dark);                                  // tread shadow
    g.roundRect(cx - 5, by - 9, 10, 7, 2).fill(light).stroke(ln);             // turret
    g.rect(cx + 4, by - 7, 11, 2).fill(dark);                                  // barrel
    g.circle(cx, by - 6, 1.5).fill(acc);                                       // doctrine pip
  } else if (u.unit === "humvee") {
    const by = cy - 4;
    g.roundRect(cx - 8, by - 4, 16, 8, 2).fill(side).stroke(ln);             // body
    g.roundRect(cx - 2, by - 7, 7, 5, 1).fill(light);                         // cabin
    g.circle(cx - 5, by + 4, 1.8).fill(0x111417); g.circle(cx + 5, by + 4, 1.8).fill(0x111417); // wheels
    g.circle(cx + 6, by - 4, 1.4).fill(acc);                                   // doctrine pip
  } else if (u.unit === "gunner") {
    const by = cy - 6;
    g.ellipse(cx, by + 5, 6, 3).fill(dark);                                    // boots/base
    g.roundRect(cx - 3, by - 4, 6, 9, 2).fill(side).stroke(ln);              // torso
    g.circle(cx, by - 6, 3).fill(light).stroke(ln);                           // head
    g.rect(cx + 2, by - 3, 8, 1.6).fill(dark);                                 // rifle
    g.circle(cx - 4, by - 3, 1.4).fill(acc);                                   // doctrine pip
  } else if (u.unit === "drone") {
    const by = cy - 11; // hovers above its shadow
    g.rect(cx - 6, by - 0.5, 12, 1).fill(dark); g.rect(cx - 0.5, by - 5, 1, 10).fill(dark); // arms
    for (const [ox, oy] of [[-6, -5], [6, -5], [-6, 5], [6, 5]]) g.circle(cx + ox, by + oy, 1.7).fill(light); // rotors
    g.circle(cx, by, 3).fill(side).stroke(ln);                                 // body
    g.circle(cx, by, 1.2).fill(acc);                                           // doctrine pip
  } else { // turret building: ringed base + rotating gun + barrel
    const by = cy - 5;
    g.ellipse(cx, by + 4, 11, 6).fill(dark).stroke(ln);                        // emplacement ring
    g.circle(cx, by, 6).fill(side).stroke(ln);                                 // gun housing
    g.rect(cx - 1, by - 14, 2, 14).fill(tint(side, -0.1));                      // tall barrel up
    g.circle(cx, by, 2).fill(acc);
  }
  if (u.hp < u.maxHp) g.rect(cx - rad, cy - rad - 9, (u.hp / u.maxHp) * rad * 2, 2).fill(0xeaf2fb);
  if (u.overrideUntil > s.tick) g.circle(cx, cy - rad, rad + 3).stroke({ color: 0xffd76b, width: 1.5, alpha: 0.5 + 0.5 * Math.sin(s.tick / 2) });
  g.eventMode = "static";
  g.cursor = "pointer";
  g.on("pointerover", () => { hovered = u; updateReadout(); });
  g.on("pointerout", () => { if (hovered?.id === u.id) { hovered = null; updateReadout(); } });
  g.zIndex = u.x + u.y;
  return g;
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

// ---- camp panels: doctrine editor only (budget/unit live in the Sankey chart) ----
let built = false;

function syncCamps(camps: Camp[]) {
  if (!built) { buildCamps(camps); built = true; }
  for (const c of camps) {
    const now = Date.now();
    const remain = Math.max(0, Math.ceil((c.cooldownUntil - now) / 1000));
    const btn = document.getElementById(`btn-${c.id}`) as HTMLButtonElement;
    btn.disabled = c.compiling || remain > 0;
    document.getElementById(`cool-${c.id}`)!.textContent = c.compiling ? "compiling…" : remain > 0 ? `cooldown: ${remain}s` : "";
    document.getElementById(`spec-${c.id}`)!.textContent =
      `agg ${c.spec.aggression.toFixed(2)} · engage ${c.spec.engageRange} · retreat<${(c.spec.retreatHealthPct * 100) | 0}% · explore ${c.spec.explorationBias.toFixed(2)} · leash ${c.spec.defendRadius ?? "none"}`;
  }
  if (!dragId()) renderSankey();
}
function buildCamps(camps: Camp[]) {
  campsEl.innerHTML = "";
  for (const c of camps) {
    const div = document.createElement("div");
    div.className = "camp";
    div.innerHTML =
      `<h4 class="${DOCTRINE_CLASS[c.id]}">${c.label}</h4>` +
      `<textarea id="ta-${c.id}">${c.prompt}</textarea>` +
      `<div class="row"><button id="btn-${c.id}">Retrain</button><span class="cool" id="cool-${c.id}"></span></div>` +
      `<div class="spec" id="spec-${c.id}"></div>`;
    campsEl.appendChild(div);
    (document.getElementById(`btn-${c.id}`) as HTMLButtonElement).onclick = () =>
      sendCmd({ type: "editPrompt", camp: c.id, prompt: (document.getElementById(`ta-${c.id}`) as HTMLTextAreaElement).value });
  }
}
setInterval(() => { if (latestCamps.length) syncCamps(latestCamps); }, 250); // live cooldown countdown

// ---- interactive Sankey: Income → Attack/Intel/Defense/Savings → unit outputs ----
const NS = "http://www.w3.org/2000/svg";
const sankeyEl = document.getElementById("sankey") as unknown as SVGSVGElement;
const HEXCSS: Record<DoctrineId, string> = { aggressive: "#ff5d73", recon: "#5ab0ff", defensive: "#2fe0bd" };
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
  const CAMP_MIN = 13, UNIT_MIN = 8, n = TRAINABLE.length, NB = 5;
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
    const node = mk("rect", { x: campX, y, width: campW, height: h, rx: 2, fill: b.col, "fill-opacity": on ? 0.92 : 0.34, class: b.drag ? "band" : "" }, sankeyEl);
    if (b.drag) node.setAttribute("data-band", b.id);
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
        const un = mk("rect", { x: unitX, y: ySeg, width: unitW, height: segH, rx: 2, fill: b.col, "fill-opacity": onu ? 0.95 : 0.34, class: "band" }, sankeyEl);
        un.setAttribute("data-mix", `${b.camp.id}:${u}`);
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

// ---- field general doctrine editor ----
let fgBuilt = false;
function syncFieldGeneral(fg: FieldGeneral) {
  document.getElementById("fg-label")!.textContent = fg.label;
  const ta = document.getElementById("fg-prompt") as HTMLTextAreaElement;
  if (!fgBuilt) { ta.value = fg.prompt; fgBuilt = true; } // set once; don't clobber active typing
}
(document.getElementById("fg-rebrief") as HTMLButtonElement).onclick = () =>
  sendCmd({ type: "editFieldGeneral", prompt: (document.getElementById("fg-prompt") as HTMLTextAreaElement).value });

// ---- field general manual override buttons ----
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-order]")) {
  btn.onclick = () => {
    const kind = btn.dataset.order as "push" | "defend";
    sendCmd({ type: "fieldOrder", order: { kind, target: "all", durationTicks: 100, label: kind === "push" ? "Push enemy base" : "Defend base" } });
  };
}

