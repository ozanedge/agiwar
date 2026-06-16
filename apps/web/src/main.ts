// agiwar web client: renders the server-authoritative snapshot and sends sparse commands.
import { Application, Container, Graphics } from "pixi.js";
import type { Camp, DoctrineId, FieldGeneral, ServerMsg, StateMsg, UnitState } from "../../../shared/types.js";
import { UNIT_STATS, TRAINABLE, BUILDINGS, type UnitType } from "../../../shared/units.js";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:8787";
// Primary color = SIDE (all your units share it). Doctrine is shown as an accent outline.
const OWN_COLOR = 0x4aa3ff;
const ENEMY_COLOR = 0xff6a5a;
const DOCTRINE_COLOR: Record<DoctrineId, number> = { aggressive: 0xff6b6b, recon: 0x5aa9ff, defensive: 0x5ad17a };
const DOCTRINE_CLASS: Record<DoctrineId, string> = { aggressive: "agg", recon: "rec", defensive: "def" };
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
await app.init({ background: 0x0a141d, resizeTo: stage, antialias: true });
stage.appendChild(app.canvas);

// ---- isometric world ----
const TILE_W = 36, TILE_H = 18; // 2:1 isometric diamond
const world = new Container(); // camera-transformed
app.stage.addChild(world);
const terrainLayer = new Graphics(); // built once per (seed, size)
const entityLayer = new Container(); // bases + units, painter-sorted
entityLayer.sortableChildren = true;
world.addChild(terrainLayer, entityLayer);

const isoX = (gx: number, gy: number) => (gx - gy) * (TILE_W / 2);
const isoY = (gx: number, gy: number) => (gx + gy) * (TILE_H / 2);

// Draw an isometric cuboid rising `h` px from ground center (x, yBase); hw/hh = top diamond half-extents.
function isoBox(g: Graphics, x: number, yBase: number, hw: number, hh: number, h: number, color: number) {
  g.poly([x - hw, yBase - h, x, yBase - h + hh, x, yBase + hh, x - hw, yBase]).fill(tint(color, -0.4)); // left face
  g.poly([x + hw, yBase - h, x, yBase - h + hh, x, yBase + hh, x + hw, yBase]).fill(tint(color, -0.22)); // right face
  g.poly([x, yBase - h - hh, x + hw, yBase - h, x, yBase - h + hh, x - hw, yBase - h]).fill(tint(color, 0.12)); // top
}

// deterministic value-noise terrain (matches the server-provided seed)
function h2(x: number, y: number, seed: number): number {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) >>> 0;
  n = (n ^ (n >>> 13)) >>> 0; n = Math.imul(n, 1274126177) >>> 0;
  return (n >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, seed), b = h2(xi + 1, yi, seed), c = h2(xi, yi + 1, seed), d = h2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x: number, y: number, seed: number): number {
  let sum = 0, amp = 0.55, f = 1;
  for (let o = 0; o < 4; o++) { sum += amp * vnoise(x * f, y * f, seed + o * 131); f *= 2; amp *= 0.5; }
  return sum;
}
function tint(hex: number, f: number): number {
  let r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  else { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}
function biome(gx: number, gy: number, seed: number): { col: number; elev: number } {
  const h = fbm(gx / 16, gy / 16, seed);
  const micro = (h2(gx, gy, seed + 777) - 0.5) * 0.14;
  if (h < 0.34) return { col: tint(0x17506e, micro * 0.4), elev: 0 };       // water
  if (h < 0.39) return { col: tint(0xcdba83, micro), elev: 1 };             // sand
  if (h < 0.62) return { col: tint(0x3f7d3a, micro), elev: 2 + (h - 0.39) * 34 }; // grass
  if (h < 0.77) return { col: tint(0x6f7e3c, micro), elev: 2 + (h - 0.39) * 34 }; // highland
  return { col: tint(0x8c8478, micro), elev: 2 + (h - 0.39) * 34 };          // rock
}
const elevAt = (gx: number, gy: number, seed: number) => biome(gx, gy, seed).elev;

let terrainKey = "";
function buildTerrain(seed: number, W: number, H: number) {
  terrainLayer.clear();
  for (let sum = 0; sum <= W + H - 2; sum++) { // painter order: far tiles first
    for (let gx = Math.max(0, sum - (H - 1)); gx <= Math.min(W - 1, sum); gx++) {
      const gy = sum - gx;
      const { col, elev } = biome(gx, gy, seed);
      const cx = isoX(gx, gy), cy = isoY(gx, gy) - elev;
      const groundY = isoY(gx, gy);
      if (elev > 2) { // earthy side walls for relief
        terrainLayer.poly([cx - TILE_W / 2, cy, cx, cy + TILE_H / 2, cx, groundY + TILE_H / 2, cx - TILE_W / 2, groundY]).fill(tint(col, -0.4));
        terrainLayer.poly([cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx, groundY + TILE_H / 2, cx + TILE_W / 2, groundY]).fill(tint(col, -0.22));
      }
      terrainLayer.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill(col);
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
  econEl.textContent = `⛃ ${s.resources}  ·  +${s.incomePerSec}/s`;
  refreshTroop();
}

function makeBase(b: StateMsg["bases"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(b.x, b.y, s.seed);
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
  const elev = elevAt(u.x, u.y, s.seed);
  const cx = isoX(u.x, u.y), cy = isoY(u.x, u.y) - elev;
  const side = u.owner === s.you ? OWN_COLOR : ENEMY_COLOR; // primary = side
  const acc = u.camp ? DOCTRINE_COLOR[u.camp] : 0x9aa6b2; // accent outline = doctrine (neutral for buildings)
  const r = u.unit === "tank" || u.unit === "turret" ? 8 : u.unit === "gunner" ? 6 : 5; // shape/size = type
  g.ellipse(cx, cy + 2, r * 1.25, r * 0.6).fill({ color: 0x000000, alpha: 0.3 }); // ground shadow
  const by = cy - r - 1; // body stands above the tile
  if (u.unit === "tank") g.rect(cx - r, by - r, r * 2, r * 2).fill(side).stroke({ color: acc, width: 2 });
  else if (u.unit === "gunner") g.circle(cx, by, r).fill(side).stroke({ color: acc, width: 2 });
  else if (u.unit === "humvee") g.poly([cx, by - r, cx + r, by + r, cx - r, by + r]).fill(side).stroke({ color: acc, width: 2 });
  else { // turret: walled square base + barrel
    g.rect(cx - r, by - r, r * 2, r * 2).fill(tint(side, -0.18)).stroke({ color: acc, width: 2 });
    g.circle(cx, by, r * 0.55).fill(tint(side, 0.3));
  }
  if (u.hp < u.maxHp) g.rect(cx - r, by - r - 4, (u.hp / u.maxHp) * r * 2, 1.5).fill(0xeaf2fb);
  if (u.overrideUntil > s.tick) g.circle(cx, by, r + 3).stroke({ color: 0xffd76b, width: 1.5, alpha: 0.5 + 0.5 * Math.sin(s.tick / 2) });
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

// ---- camp doctrine editors ----
let built = false;
function syncCamps(camps: Camp[]) {
  if (!built) { buildCamps(camps); built = true; }
  for (const c of camps) {
    const cool = document.getElementById(`cool-${c.id}`)!;
    const now = Date.now();
    const remain = Math.max(0, Math.ceil((c.cooldownUntil - now) / 1000));
    const btn = document.getElementById(`btn-${c.id}`) as HTMLButtonElement;
    btn.disabled = c.compiling || remain > 0;
    cool.textContent = c.compiling ? "compiling doctrine…" : remain > 0 ? `cooldown: ${remain}s` : "";
    const spec = document.getElementById(`spec-${c.id}`)!;
    spec.textContent =
      `aggression ${c.spec.aggression.toFixed(2)} · engage ${c.spec.engageRange} · ` +
      `retreat<${(c.spec.retreatHealthPct * 100) | 0}% · explore ${c.spec.explorationBias.toFixed(2)} · ` +
      `leash ${c.spec.defendRadius ?? "none"}`;
  }
}
function buildCamps(camps: Camp[]) {
  campsEl.innerHTML = "";
  for (const c of camps) {
    const div = document.createElement("div");
    div.className = "camp";
    div.innerHTML =
      `<h4 class="${DOCTRINE_CLASS[c.id]}">${c.label}</h4>` +
      `<textarea id="ta-${c.id}">${c.prompt}</textarea>` +
      `<div class="row"><button id="btn-${c.id}">Retrain doctrine</button><span class="cool" id="cool-${c.id}"></span></div>` +
      `<div class="spec" id="spec-${c.id}"></div>`;
    campsEl.appendChild(div);
    (document.getElementById(`btn-${c.id}`) as HTMLButtonElement).onclick = () =>
      sendCmd({ type: "editPrompt", camp: c.id, prompt: (document.getElementById(`ta-${c.id}`) as HTMLTextAreaElement).value });
  }
}
setInterval(() => { if (latestCamps.length) syncCamps(latestCamps); }, 250); // live cooldown countdown

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

// ---- train unit: pick a (trainable) unit type + a training camp, then deploy ----
let selType: UnitType = "gunner";
let selCamp: DoctrineId = "aggressive";
const unitTypesEl = document.getElementById("unit-types")!;
const troopCampsEl = document.getElementById("troop-camps")!;
const troopSelEl = document.getElementById("troop-sel")!;
for (const t of TRAINABLE) {
  const b = document.createElement("button");
  b.dataset.unit = t;
  b.textContent = `${UNIT_STATS[t].label.replace(" Infantry", "")} ⛃${UNIT_STATS[t].cost}`;
  b.onclick = () => { selType = t; refreshTroop(); };
  unitTypesEl.appendChild(b);
}
for (const d of DOCTRINES) {
  const b = document.createElement("button");
  b.dataset.tcamp = d;
  b.textContent = d;
  b.className = DOCTRINE_CLASS[d];
  b.onclick = () => { selCamp = d; refreshTroop(); };
  troopCampsEl.appendChild(b);
}
const deployBtn = document.getElementById("deploy") as HTMLButtonElement;
function refreshTroop() {
  for (const b of unitTypesEl.querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.unit === selType);
  for (const b of troopCampsEl.querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.tcamp === selCamp);
  const st = UNIT_STATS[selType];
  const afford = !latestState || latestState.resources >= st.cost;
  deployBtn.disabled = !afford;
  deployBtn.textContent = afford ? `Deploy ⛃${st.cost} ▸` : `Need ⛃${st.cost}`;
  troopSelEl.textContent = `${st.label} — ${st.blurb}, ${st.maxHp}hp → ${selCamp} doctrine`;
}
deployBtn.onclick = () => sendCmd({ type: "spawn", camp: selCamp, unit: selType });
refreshTroop();

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
  for (const b of buildTypesEl.querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("active", b.dataset.build === t);
  app.canvas.style.cursor = t ? "crosshair" : "";
  buildHintEl.textContent = t ? `click the map to place ${UNIT_STATS[t].label} (⛃${UNIT_STATS[t].cost}) · Esc to cancel` : "select a building, then click the map";
}
window.addEventListener("keydown", (e) => { if (e.key === "Escape") setArmed(null); });
