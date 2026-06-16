// agiwar web client: renders the server-authoritative snapshot and sends sparse commands.
import { Application, Container, Graphics } from "pixi.js";
import type { Camp, DoctrineId, FieldGeneral, ServerMsg, StateMsg, UnitState } from "../../../shared/types.js";
import { UNIT_STATS, TRAINABLE, BUILDINGS, type UnitType } from "../../../shared/units.js";
import { terrainAt, type TerrainKind } from "../../../shared/terrain.js";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:8787";
// Primary color = SIDE (all your units share it). Doctrine is shown as an accent outline.
const OWN_COLOR = 0x4aa3ff;
const ENEMY_COLOR = 0xff6a5a;
const DOCTRINE_COLOR: Record<DoctrineId, number> = { aggressive: 0xff6b6b, recon: 0x5aa9ff, defensive: 0x5ad17a };
const DOCTRINE_CLASS: Record<DoctrineId, string> = { aggressive: "agg", recon: "rec", defensive: "def" };
const BUDGET_NAME: Record<DoctrineId, string> = { aggressive: "Attack", recon: "Intelligence", defensive: "Defense" };
const DOCTRINES: DoctrineId[] = ["aggressive", "recon", "defensive"];

const stage = document.getElementById("stage")!;
const noticeEl = document.getElementById("notice")!;
const readoutEl = document.getElementById("readout")!;
const econEl = document.getElementById("econ")!;
const campsEl = document.getElementById("camps")!;

let latestState: StateMsg | null = null;
let latestCamps: Camp[] = [];
let hovered: UnitState | null = null;

const app = new Application();
await app.init({ background: 0x0a141d, resizeTo: stage, antialias: true, resolution: window.devicePixelRatio || 1, autoDensity: true });
stage.appendChild(app.canvas);

// ---- isometric world ----
const TILE_W = 36, TILE_H = 18; // 2:1 isometric diamond
const world = new Container(); // camera-transformed
app.stage.addChild(world);
const terrainLayer = new Graphics(); // built once per (seed, size)
const entityLayer = new Container(); // bases + units, painter-sorted
entityLayer.sortableChildren = true;
const ghostLayer = new Graphics(); // build-placement preview (range + validity)
world.addChild(terrainLayer, entityLayer, ghostLayer);
const CLIENT_BUILD_RADIUS = 32; // mirror server BUILD_RADIUS

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

const KIND_COLOR: Record<TerrainKind, number> = { water: 0x17506e, sand: 0xcdba83, grass: 0x3f7d3a, highland: 0x6f7e3c, rock: 0x8c8478 };
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
function buildTerrain(seed: number, W: number, H: number) {
  terrainLayer.clear();
  for (let sum = 0; sum <= W + H - 2; sum++) { // painter order: far tiles first
    for (let gx = Math.max(0, sum - (H - 1)); gx <= Math.min(W - 1, sum); gx++) {
      const gy = sum - gx;
      const t = terrainAt(gx, gy, seed, W, H);
      const col = tint(KIND_COLOR[t.kind], t.micro);
      const cx = isoX(gx, gy), cy = isoY(gx, gy) - t.elev;
      const groundY = isoY(gx, gy);
      if (t.elev > 4) { // earthy side walls for relief on raised ground
        terrainLayer.poly([cx - TILE_W / 2, cy, cx, cy + TILE_H / 2, cx, groundY + TILE_H / 2, cx - TILE_W / 2, groundY]).fill(tint(col, -0.4));
        terrainLayer.poly([cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx, groundY + TILE_H / 2, cx + TILE_W / 2, groundY]).fill(tint(col, -0.22));
      }
      terrainLayer.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill(col);
      decorate(terrainLayer, t.kind, gx, gy, seed, cx, cy);
    }
  }
  terrainKey = `${seed}:${W}:${H}`;
}

// ---- camera (pan + zoom), centered on your base ----
const cam = { scale: 1 };
let armedBuilding: UnitType | null = null; // building selected for placement (build mode)
function centerOnBase(s: StateMsg) {
  const mine = s.bases.find((b) => b.owner === s.you) ?? s.bases[0];
  if (!mine) return;
  cam.scale = 1; world.scale.set(1);
  world.x = app.screen.width / 2 - isoX(mine.x, mine.y);
  world.y = app.screen.height / 2 - isoY(mine.x, mine.y);
}
let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, pressOnCanvas = false;
app.canvas.addEventListener("pointerdown", (e) => { dragging = true; pressOnCanvas = true; lastX = downX = e.clientX; lastY = downY = e.clientY; });
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  world.x += e.clientX - lastX; world.y += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener("pointerup", (e) => {
  // a click (not a drag) while a building is armed = place it
  if (pressOnCanvas && armedBuilding && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) < 6) {
    const { gx, gy } = screenToGrid(e.clientX, e.clientY);
    sendCmd({ type: "build", unit: armedBuilding, x: gx, y: gy });
  }
  dragging = false; pressOnCanvas = false;
});

// screen pixel -> grid cell (inverse iso; ignores elevation, close enough for placement)
function screenToGrid(clientX: number, clientY: number): { gx: number; gy: number } {
  const rect = app.canvas.getBoundingClientRect();
  const wx = (clientX - rect.left - world.x) / cam.scale;
  const wy = (clientY - rect.top - world.y) / cam.scale;
  const a = wx / (TILE_W / 2), b = wy / (TILE_H / 2); // a = gx-gy, b = gx+gy
  return { gx: Math.round((a + b) / 2), gy: Math.round((b - a) / 2) };
}

// build preview: range diamond + footprint at the hovered tile, green if placement is valid
function drawGhost(gx: number, gy: number) {
  ghostLayer.clear();
  if (!armedBuilding || !latestState) return;
  const s = latestState;
  const R = UNIT_STATS[armedBuilding].range;
  const base = s.bases.find((b) => b.owner === s.you);
  const inBounds = gx >= 0 && gy >= 0 && gx < s.gridW && gy < s.gridH;
  const inRadius = !!base && Math.max(Math.abs(gx - base.x), Math.abs(gy - base.y)) <= CLIENT_BUILD_RADIUS;
  const passable = inBounds && terrainAt(gx, gy, s.seed, s.gridW, s.gridH).passable;
  const col = inRadius && passable ? 0x5ad17a : 0xff6a5a;
  const corners = [[gx - R, gy - R], [gx + R, gy - R], [gx + R, gy + R], [gx - R, gy + R]];
  ghostLayer.poly(corners.flatMap(([x, y]) => [isoX(x, y), isoY(x, y)])).fill({ color: col, alpha: 0.1 }).stroke({ color: col, width: 2, alpha: 0.85 });
  const elev = elevAt(gx, gy, s.seed, s.gridW, s.gridH);
  const cx = isoX(gx, gy), cy = isoY(gx, gy) - elev;
  ghostLayer.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill({ color: col, alpha: 0.35 }).stroke({ color: col, width: 1.5 });
}
app.canvas.addEventListener("pointermove", (e) => { if (armedBuilding) drawGhost(screenToGrid(e.clientX, e.clientY).gx, screenToGrid(e.clientX, e.clientY).gy); });
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
    else if (msg.type === "camps") { latestCamps = msg.camps; syncCamps(msg.camps); syncFieldGeneral(msg.fieldGeneral); }
    else if (msg.type === "notice") { showNotice(msg.text, msg.level); }
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

// ---- rendering ----
function render(s: StateMsg) {
  if (terrainKey !== `${s.seed}:${s.gridW}:${s.gridH}`) { buildTerrain(s.seed, s.gridW, s.gridH); centerOnBase(s); }
  entityLayer.removeChildren();
  for (const b of s.bases) entityLayer.addChild(makeBase(b, s));
  for (const u of s.units) entityLayer.addChild(makeUnit(u, s));
  if (hovered) hovered = s.units.find((u) => u.id === hovered!.id) ?? null;
  updateReadout();
  const allocPct = latestCamps.reduce((a, c) => a + c.production.budgetPct, 0);
  const spend = Math.round((s.incomePerSec * Math.min(100, allocPct)) / 100);
  econEl.textContent = `⛃ ${s.resources}   ·   earning +${s.incomePerSec}/s   ·   spending ~${spend}/s   ·   saving ${Math.max(0, 100 - allocPct)}%`;
}

function makeBase(b: StateMsg["bases"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(b.x, b.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(b.x, b.y), cy = isoY(b.x, b.y) - elev;
  const team = b.owner === s.you ? OWN_COLOR : ENEMY_COLOR;
  // big iso fortress: shadow → stone platform → flanking towers → central keep → flag → hp
  g.ellipse(cx, cy + TILE_H * 1.0, TILE_W * 2.5, TILE_H * 1.7).fill({ color: 0x000000, alpha: 0.3 });
  isoBox(g, cx, cy + TILE_H * 1.3, TILE_W * 2.0, TILE_H * 2.0, 11, 0x5d6470); // platform
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
  g.ellipse(cx, cy + 2, 9, 4).fill({ color: 0x000000, alpha: 0.28 }); // ground shadow
  const rad = u.unit === "tank" || u.unit === "turret" ? 9 : 7;

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
const currentProdUnit = (id: DoctrineId): UnitType => (latestCamps.find((c) => c.id === id)?.production.unit ?? "gunner");

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
  if (!dragId) renderSankey();
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
const HEXCSS: Record<DoctrineId, string> = { aggressive: "#ff6b6b", recon: "#5aa9ff", defensive: "#5ad17a" };
let dragId: DoctrineId | null = null, dragStartY = 0, dragStartPct = 0, dragPct = 0;
const SANKEY_W = 344, SANKEY_H = 196, S_TOP = 8, S_BOT = 188, S_HC = S_BOT - S_TOP;

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
function pctOf(c: Camp): number { return dragId === c.id ? dragPct : c.production.budgetPct; }

function renderSankey() {
  if (!latestState || latestCamps.length < 3) return;
  while (sankeyEl.firstChild) sankeyEl.removeChild(sankeyEl.firstChild);
  const camps = DOCTRINES.map((d) => latestCamps.find((c) => c.id === d)!).filter(Boolean);
  const alloc = camps.reduce((a, c) => a + pctOf(c), 0);
  const savings = Math.max(0, 100 - alloc);
  const incomeX = 6, incomeW = 16, budX = 150, budW = 18, outX = 300, outW = 20, GAP = 5;

  mk("rect", { x: incomeX, y: S_TOP, width: incomeW, height: S_HC, rx: 2, fill: "#cdd6e0" }, sankeyEl);
  mk("text", { x: incomeX, y: S_TOP - 1, "font-size": 10 }, sankeyEl).textContent = `Income +${latestState.incomePerSec}/s`;

  type Band = { id: DoctrineId | "savings"; name: string; col: string; v: number; unit?: UnitType };
  const bands: Band[] = camps.map((c) => ({ id: c.id, name: BUDGET_NAME[c.id], col: HEXCSS[c.id], v: pctOf(c), unit: c.production.unit }));
  bands.push({ id: "savings", name: "Savings", col: "#8794a3", v: savings });

  let yInc = S_TOP, yBud = S_TOP;
  for (const b of bands) {
    const h = (b.v / 100) * S_HC;
    const hInc0 = yInc, hInc1 = yInc + h, hBud0 = yBud, hBud1 = yBud + h;
    // income -> budget ribbon
    mk("path", { d: ribbon(incomeX + incomeW, hInc0, hInc1, budX, hBud0, hBud1), fill: b.col, "fill-opacity": 0.28 }, sankeyEl);
    // budget node (draggable)
    const node = mk("rect", { x: budX, y: hBud0, width: budW, height: Math.max(0, h), rx: 2, fill: b.col, "fill-opacity": 0.9, class: b.id === "savings" ? "" : "band" }, sankeyEl);
    if (b.id !== "savings") node.setAttribute("data-band", b.id);
    if (h > 11) mk("text", { x: budX + budW + 4, y: hBud0 + h / 2 + 3, "font-size": 10 }, sankeyEl).textContent = `${b.name} ${Math.round(b.v)}%`;
    // budget -> output
    if (b.unit) {
      mk("path", { d: ribbon(budX + budW, hBud0, hBud1, outX, hBud0, hBud1), fill: b.col, "fill-opacity": 0.22 }, sankeyEl);
      const out = mk("rect", { x: outX, y: hBud0, width: outW, height: Math.max(0, h), rx: 2, fill: b.col, "fill-opacity": 0.95, class: "out" }, sankeyEl);
      out.setAttribute("data-out", b.id);
      if (h > 11) mk("text", { x: outX - 2, y: hBud0 + h / 2 + 3, "font-size": 10, "text-anchor": "end" }, sankeyEl).textContent = UNIT_STATS[b.unit].label.replace(" Infantry", "");
    } else if (h > 8) {
      mk("path", { d: ribbon(budX + budW, hBud0, hBud1, outX, hBud0, hBud1), fill: b.col, "fill-opacity": 0.15 }, sankeyEl);
      mk("text", { x: outX - 2, y: hBud0 + h / 2 + 3, "font-size": 10, "text-anchor": "end" }, sankeyEl).textContent = "→ turrets";
    }
    yInc = hInc1; yBud = hBud1 + GAP;
  }
}

// drag a budget band to reallocate (savings absorbs the remainder)
sankeyEl.addEventListener("pointerdown", (e) => {
  const t = e.target as Element;
  const band = t.getAttribute?.("data-band") as DoctrineId | null;
  if (!band) return;
  dragId = band; dragStartY = e.clientY; dragStartPct = latestCamps.find((c) => c.id === band)!.production.budgetPct; dragPct = dragStartPct;
  e.preventDefault();
});
window.addEventListener("pointermove", (e) => {
  if (!dragId) return;
  const others = latestCamps.filter((c) => c.id !== dragId).reduce((a, c) => a + c.production.budgetPct, 0);
  const raw = dragStartPct + ((dragStartY - e.clientY) / S_HC) * 100;
  dragPct = Math.max(0, Math.min(100 - others, Math.round(raw / 5) * 5));
  renderSankey();
});
window.addEventListener("pointerup", () => {
  if (!dragId) return;
  sendCmd({ type: "setProduction", camp: dragId, unit: currentProdUnit(dragId), budgetPct: dragPct });
  dragId = null;
});
// click an output to cycle that camp's produced unit type
sankeyEl.addEventListener("click", (e) => {
  const id = (e.target as Element).getAttribute?.("data-out") as DoctrineId | null;
  if (!id || id === ("savings" as any)) return;
  const cur = currentProdUnit(id);
  const next = TRAINABLE[(TRAINABLE.indexOf(cur) + 1) % TRAINABLE.length];
  const pct = latestCamps.find((c) => c.id === id)!.production.budgetPct;
  sendCmd({ type: "setProduction", camp: id, unit: next, budgetPct: pct });
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

// ---- build: pick a building, then click the map to place it (no doctrine) ----
const buildTypesEl = document.getElementById("build-types")!;
const buildHintEl = document.getElementById("build-hint")!;
for (const t of BUILDINGS) {
  const b = document.createElement("button");
  b.dataset.build = t;
  b.textContent = `${UNIT_STATS[t].label} ⛃${UNIT_STATS[t].cost}`;
  b.onclick = () => setArmed(armedBuilding === t ? null : t);
  buildTypesEl.appendChild(b);
}
function setArmed(t: UnitType | null) {
  armedBuilding = t;
  if (!t) ghostLayer.clear();
  for (const b of buildTypesEl.querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.build === t);
  app.canvas.style.cursor = t ? "crosshair" : "";
  buildHintEl.textContent = t ? `click the map to place ${UNIT_STATS[t].label} (⛃${UNIT_STATS[t].cost}) · Esc to cancel` : "select a building, then click the map";
}
window.addEventListener("keydown", (e) => { if (e.key === "Escape") setArmed(null); });
