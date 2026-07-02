// agiwar web client: renders the server-authoritative snapshot and sends sparse commands.
import { Application, Container, Graphics, RenderTexture, Sprite, Text, Texture } from "pixi.js";
import type { Camp, DoctrineId, FieldGeneral, ServerMsg, StateMsg, UnitState } from "../../../shared/types.js";
import { UNIT_STATS, TRAINABLE, VISION_MULT, VISION_CAP, BASE_VISION, INVESTMENTS, investCost, GRID_SCALE, type UnitType, type Faction, FACTIONS, FACTION_META, FACTION_ROLE_UNIT, ultUnitFor } from "../../../shared/units.js";
import { ARMY_DOCTRINES, modsFor } from "../../../shared/doctrine.js";
import { heightAt, elevationAt, elevFromHeight, kindOf, highGroundBonus, CLIFF_SLOPE, type TerrainKind } from "../../../shared/terrain.js";
import { ARTIFACTS, ULTIMATES, ultimateFor } from "../../../shared/ultimates.js";

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
let latestActiveOrder: string | null = null; // the field general's active tactic label (cancellable), or null
let hovered: UnitState | null = null;
let pinned: UnitState | null = null; // click-to-inspect: persists until you click elsewhere
let unitTapped = false; // set when a unit was just clicked, so the map click-handler doesn't unpin

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
const entityLayer = new Container(); // bases + units, painter-sorted
entityLayer.sortableChildren = true;
const fxLayer = new Graphics(); // flying projectiles + impacts, drawn above units
const terrainBright = new Sprite(); // full-bright baked terrain, drawn DIRECTLY (no mask)
// Soft fog WITHOUT masking the (map-sized) terrain. Masking a huge sprite renders it through a
// filter into an intermediate texture whose size = the sprite's on-screen bounds; past ~1.4× zoom
// that exceeds the GPU max texture size and gets clamped → the map blacks out. Instead we draw the
// terrain directly (the GPU clips it to the viewport, no size limit) and lay a single FOG OVERLAY
// on top: a tinted sprite whose per-pixel ALPHA = darkness (1 = unexplored, ~0.4 = explored memory,
// 0 = currently visible). The overlay is composited in a FIXED, map-sized RenderTexture (fogRT,
// zoom-INDEPENDENT) by ERASE-blending the soft vision/explored blobs out of a tinted fill — so
// nothing huge ever passes through a mask/filter. Soft radial blobs → the elegant fade; visRT is
// re-composited every frame from the units' EASED positions → it glides.
const FOG_RES = 3; // fog overlay rendered at 1/FOG_RES resolution (smooth blobs don't need full res)
const SOFT_PX = 128;
const softTex = (() => {
  const c = document.createElement("canvas"); c.width = c.height = SOFT_PX;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(SOFT_PX / 2, SOFT_PX / 2, SOFT_PX * 0.06, SOFT_PX / 2, SOFT_PX / 2, SOFT_PX / 2);
  // gradual ramp that starts much closer to the center (small solid core, then a long even fade out)
  grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.15, "rgba(255,255,255,0.97)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.55)"); grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, SOFT_PX, SOFT_PX);
  return Texture.from(c);
})();
const FADE = 1.55; // oversize each blob so sight still reaches ~R despite the long inward fade
const FOG_TINT = 0x02060a; // overlay color (matches the canvas bg → seamless in unexplored areas)
const MEM_BRIGHT = 0.62; // explored-but-unseen terrain brightness (the rest = fog tint)
const visScene = new Container(), expScene = new Container(); // off-screen blob scenes (→ visRT/expRT)
visScene.scale.set(1 / FOG_RES); expScene.scale.set(1 / FOG_RES);
const fogScene = new Container(); // composites fogRT each frame (tinted fill, blobs erased out)
const fogSprite = new Sprite(); // the fog overlay, drawn directly over the terrain
let visRT: RenderTexture | null = null, expRT: RenderTexture | null = null, fogRT: RenderTexture | null = null;
let fogOX = 0, fogOY = 0;
world.addChild(terrainBright, fogSprite, entityLayer, fxLayer);
function blobScale(sp: Sprite, gx: number, gy: number, R: number) {
  sp.position.set(isoX(gx, gy) - fogOX, isoY(gx, gy) - fogOY); // world px relative to terrain origin
  sp.scale.set((R * TILE_W * 2 * FADE) / SOFT_PX, (R * TILE_H * 2 * FADE) / SOFT_PX); // iso-squashed disc
}
function softBlob(scene: Container, gx: number, gy: number, R: number) {
  const sp = new Sprite(softTex); sp.anchor.set(0.5); blobScale(sp, gx, gy, R); scene.addChild(sp);
}
// reusable pool for the per-frame current-vision blobs (gliding) — avoids allocating sprites at 60fps
const visPool: Sprite[] = [];
function setVisBlob(i: number, gx: number, gy: number, R: number) {
  let sp = visPool[i];
  if (!sp) { sp = new Sprite(softTex); sp.anchor.set(0.5); visPool[i] = sp; visScene.addChild(sp); }
  sp.visible = true; blobScale(sp, gx, gy, R);
}

const isoX = (gx: number, gy: number) => (gx - gy) * (TILE_W / 2);
const isoY = (gx: number, gy: number) => (gx + gy) * (TILE_H / 2);

// Draw an isometric cuboid rising `h` px from ground center (x, yBase); hw/hh = top diamond half-extents.
function isoBox(g: Graphics, x: number, yBase: number, hw: number, hh: number, h: number, color: number) {
  g.poly([x - hw, yBase - h, x, yBase - h + hh, x, yBase + hh, x - hw, yBase]).fill(tint(color, -0.4)); // left face
  g.poly([x + hw, yBase - h, x, yBase - h + hh, x, yBase + hh, x + hw, yBase]).fill(tint(color, -0.22)); // right face
  g.poly([x, yBase - h - hh, x + hw, yBase - h, x, yBase - h + hh, x - hw, yBase - h]).fill(tint(color, 0.12)); // top
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255, br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
// health → green (full) · yellow · orange · red (empty)
function hpColor(f: number): number {
  f = Math.max(0, Math.min(1, f));
  return f < 0.5 ? lerpColor(0xe23b3b, 0xf2b134, f / 0.5) : lerpColor(0xf2b134, 0x3fdd6a, (f - 0.5) / 0.5);
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
// Decorative landscape continued BEYOND the playable grid: the terrain extends EDGE_MARGIN fine cells
// past every edge and ramps up into an encircling mountain range (EDGE_RISE added to height at the
// rim), so there's no hard diamond cutoff. Units never reach it; it stays permanently under the
// shroud, hazing into the background instead of stopping at a crisp line.
const EDGE_MARGIN = 56;
const EDGE_RISE = 1.2;

let terrainKey = "";
let terrainTex: import("pixi.js").Texture | null = null;
const exploredCoarse = new Set<number>(); // coarse cells whose vision is already stamped into expMask

// Bake the ENTIRE map's terrain ONCE into a single texture (top faces + side walls on raised
// ground). Painter-ordered by (gx+gy) so nearer tiles overlap correctly. Sheen/decoration are
// dropped — invisible at this tile size and far too many polys at 16× density. The two terrain
// sprites then just sample this texture (cheap), masked by vision — no per-tick tile redraw.
function bakeTerrain(seed: number, W: number, H: number) {
  const g = new Graphics();
  // precompute height + smooth elevation once over the playable grid PLUS an EDGE_MARGIN rim. Cells
  // outside the grid ramp up into an encircling range (the noise is continuous, so it joins seamlessly).
  const M = EDGE_MARGIN, WX = W + 2 * M, HX = H + 2 * M, N = WX * HX, Hh = new Float32Array(N), E = new Float32Array(N);
  const outset = (x: number, y: number) => Math.max(x < 0 ? -x : x >= W ? x - (W - 1) : 0, y < 0 ? -y : y >= H ? y - (H - 1) : 0);
  for (let ly = 0; ly < HX; ly++) for (let lx = 0; lx < WX; lx++) {
    const x = lx - M, y = ly - M;
    let h = heightAt(x, y, seed, W, H);
    const o = outset(x, y);
    if (o > 0) { const t = Math.min(1, o / M); h += t * t * EDGE_RISE; } // rise into the rim range
    const i = ly * WX + lx; Hh[i] = h; E[i] = elevFromHeight(h);
  }
  const half = TILE_W / 2, hh = TILE_H / 2, D = GRID_SCALE;
  // index by WORLD cell (x,y), clamped into the [-M, W-1+M] × [-M, H-1+M] extended range
  const li = (x: number, y: number) => { const lx = x + M, ly = y + M; return (lx < 0 ? 0 : lx >= WX ? WX - 1 : lx) + (ly < 0 ? 0 : ly >= HX ? HX - 1 : ly) * WX; };
  const eAt = (x: number, y: number) => E[li(x, y)];
  const hgt = (x: number, y: number) => Hh[li(x, y)];
  for (let d = 0; d <= (WX - 1) + (HX - 1); d++) {
    for (let lx = Math.max(0, d - (HX - 1)); lx <= Math.min(WX - 1, d); lx++) {
      const ly = d - lx, gx = lx - M, gy = ly - M, i = ly * WX + lx, h = Hh[i], e = E[i];
      const kind = kindOf(h);
      // steep land = impassable cliff → render as bare rock
      const slope = Math.max(Math.abs(hgt(gx + D, gy) - hgt(gx - D, gy)), Math.abs(hgt(gx, gy + D) - hgt(gx, gy - D))) / (2 * D);
      const blocked = kind === "rock" || (kind !== "water" && slope > CLIFF_SLOPE); // never true for water
      const baseCol = blocked ? KIND_COLOR.rock : KIND_COLOR[kind];
      // smooth hill-shade: surface descending toward the camera catches light, up-slopes shade (gentle)
      const shade = Math.max(-0.16, Math.min(0.16, ((eAt(gx - 1, gy) + eAt(gx, gy - 1)) / 2 - e) * 0.13));
      let col = tint(baseCol, shade);
      // RIM SHROUD: bake the fade into the decorative margin so it hazes into the background no matter
      // what live vision does (the dynamic fog can't darken this thin a band — sight bleeds across it).
      const o = outset(gx, gy);
      if (o > 0) { const t = Math.min(1, o / M); col = lerpColor(col, FOG_TINT, t * t * (3 - 2 * t)); }
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
  terrainBright.texture = terrainTex; terrainBright.position.set(b.minX, b.minY);
  g.destroy();
  // (re)create the fog RenderTextures sized to the terrain bounds (downscaled by FOG_RES). These are
  // FIXED-size and zoom-independent — the source of the soft fade, never a per-zoom intermediate.
  fogOX = b.minX; fogOY = b.minY;
  const fw = Math.max(1, Math.ceil(b.width / FOG_RES)), fh = Math.max(1, Math.ceil(b.height / FOG_RES));
  for (const rt of [visRT, expRT, fogRT]) if (rt) rt.destroy(true);
  visRT = RenderTexture.create({ width: fw, height: fh }); // white soft vision blobs (per frame)
  expRT = RenderTexture.create({ width: fw, height: fh }); // white soft explored blobs (on growth)
  fogRT = RenderTexture.create({ width: fw, height: fh }); // composited darkness overlay (per frame)
  // fogScene: a tinted fill with the vision/explored blobs ERASE-blended out → alpha = darkness.
  for (const c of fogScene.removeChildren()) c.destroy();
  const fill = new Graphics().rect(0, 0, fw, fh).fill({ color: FOG_TINT, alpha: 1 }); // unexplored
  const expErase = new Sprite(expRT); expErase.blendMode = "erase"; expErase.alpha = MEM_BRIGHT; // → memory
  const visErase = new Sprite(visRT); visErase.blendMode = "erase"; // → fully revealed
  fogScene.addChild(fill, expErase, visErase);
  fogSprite.texture = fogRT; fogSprite.position.set(b.minX, b.minY); fogSprite.scale.set(FOG_RES);
}

function resetFog(seed: number, W: number, H: number) {
  exploredCoarse.clear();
  for (const c of expScene.removeChildren()) c.destroy();
  for (const sp of visPool) sp.visible = false;
  bakeTerrain(seed, W, H); // (re)creates the fog RenderTextures + compositing scene
  if (expRT) app.renderer.render({ container: expScene, target: expRT, clear: true }); // clear explored
  terrainKey = `${seed}:${W}:${H}`;
}

// a unit's sight = base range + HIGH-GROUND bonus (matches server), capped, ×doctrine
function unitSight(u: StateMsg["units"][number], s: StateMsg): number {
  return Math.min(VISION_CAP, (UNIT_STATS[u.unit].range + highGroundBonus(heightAt(u.x, u.y, s.seed, s.gridW, s.gridH))) * VISION_MULT) * modsFor(s.armyDoctrine).visionMult;
}

// Current-vision blobs — rebuilt EVERY FRAME from the units' EASED (glide) positions + eased radii
// (pooled radial-gradient blobs) into visRT, then the fog overlay (fogRT) is re-composited, so the
// soft shroud GLIDES smoothly with the units instead of snapping at the 5Hz server rate.
function rebuildVisionMask() {
  if (!latestState || !visRT || !fogRT) return;
  const s = latestState;
  const vm = modsFor(s.armyDoctrine).visionMult;
  let i = 0;
  for (const b of s.bases) if (b.owner === s.you) { setVisBlob(i, b.x, b.y, BASE_VISION * vm); i++; }
  for (const e of unitViews.values()) if (e.u.owner === s.you) { setVisBlob(i, e.gx, e.gy, e.vr); i++; }
  for (let j = i; j < visPool.length; j++) visPool[j].visible = false;
  app.renderer.render({ container: visScene, target: visRT, clear: true });
  app.renderer.render({ container: fogScene, target: fogRT, clear: true }); // tint − vision − explored
}

// Explored "memory" mask — grows discretely as you scout (a soft blob per new coarse cell, persisted
// in expRT; only re-rendered when it actually grows).
function renderFog(s: StateMsg) {
  if (!expRT) return;
  const vm = modsFor(s.armyDoctrine).visionMult;
  let grew = false;
  const stamp = (gx: number, gy: number, R: number) => {
    const key = (gx >> 5) * 100003 + (gy >> 5);
    if (exploredCoarse.has(key)) return;
    exploredCoarse.add(key); softBlob(expScene, gx, gy, R); grew = true;
  };
  for (const b of s.bases) if (b.owner === s.you) stamp(b.x, b.y, BASE_VISION * vm);
  for (const u of s.units) if (u.owner === s.you) stamp(u.x, u.y, unitSight(u, s));
  if (grew) app.renderer.render({ container: expScene, target: expRT, clear: true });
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
let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0;
app.canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = downX = e.clientX; lastY = downY = e.clientY; unitTapped = false; });
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  world.x += e.clientX - lastX; world.y += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener("pointerup", (e) => {
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (dragging && moved < 5 && !unitTapped && pinned) { pinned = null; updateReadout(); } // click on empty map → release pin
  unitTapped = false; dragging = false;
});
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
let soloAfterConnect = false; // set when "New game" wants an immediate bot match on reconnect
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { if (soloAfterConnect) { soloAfterConnect = false; sendCmd({ type: "skipToBot" }); } else showMatchmaking(); };
  ws.onmessage = (ev) => {
    const msg: ServerMsg = JSON.parse(ev.data);
    if (msg.type === "state" || msg.type === "camps") hideMatchmaking(); // a room exists → matched
    if (msg.type === "state") { if (awaitingStart) { awaitingStart = false; document.getElementById("standby")?.remove(); } latestState = msg; render(msg); spawnShots(msg); spawnUfx(msg); updateSandstorm(msg); updateInventory(msg); }
    else if (msg.type === "camps") { latestCamps = msg.camps; latestTurretBudget = msg.turretBudget; latestField = msg.fieldGeneral; latestAdvisor = msg.advisor; latestActiveOrder = msg.activeOrder ?? null; syncCommanders(); }
    else if (msg.type === "notice") { showNotice(msg.text, msg.level); }
    else if (msg.type === "fieldlog") { addLog(msg.text, msg.tick); }
    else if (msg.type === "gameover") { showEndscreen(msg.won); }
    else if (msg.type === "doctrineOffer") { showDoctrinePicker(msg.current, msg.faction); }
    else if (msg.type === "decision") { showDecision(msg); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
// ---- SANDSTORM overlay: a drifting sand veil + countdown while the board-clearing storm scours the field ----
let sandstormEl: HTMLDivElement | null = null;
function updateSandstorm(s: StateMsg) {
  const st = s.sandstorm;
  if (!st) { if (sandstormEl) sandstormEl.style.opacity = "0"; return; }
  if (!sandstormEl) {
    const style = document.createElement("style");
    style.textContent = "@keyframes sand-drift{0%{background-position:0 0,0 0}100%{background-position:240px -90px,-160px 60px}}";
    document.head.appendChild(style);
    sandstormEl = document.createElement("div");
    sandstormEl.id = "sandstorm";
    sandstormEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:50;opacity:0;transition:opacity .5s ease;" +
      "background:" +
      "repeating-linear-gradient(108deg,rgba(222,188,120,0) 0,rgba(222,188,120,.14) 7px,rgba(166,126,66,.07) 17px)," +
      "radial-gradient(ellipse at 50% 38%,rgba(206,166,104,.18),rgba(150,108,54,.6));" +
      "background-size:300px 300px,cover;animation:sand-drift 1.1s linear infinite;";
    const banner = document.createElement("div");
    banner.id = "sandstorm-banner";
    banner.style.cssText = "position:absolute;top:13%;left:50%;transform:translateX(-50%);text-align:center;" +
      "color:#2e2008;text-shadow:0 1px 0 rgba(255,232,182,.7);letter-spacing:.18em;font-weight:700;white-space:nowrap;";
    sandstormEl.appendChild(banner);
    document.body.appendChild(sandstormEl);
  }
  sandstormEl.style.opacity = String(0.3 + 0.55 * st.progress); // veil thickens as the storm peaks
  (sandstormEl.firstChild as HTMLDivElement).innerHTML =
    `<div style="font-size:32px">⛈ SANDSTORM</div>` +
    `<div style="font-size:13px;font-weight:500;opacity:.9;letter-spacing:.12em">the field is being scoured — all units perish · ${st.secsLeft}s</div>`;
}

// ---- ARTIFACT INVENTORY + FORGE (right panel) ----
const invGrid = document.getElementById("inv-grid")!;
const forgeEl = document.getElementById("forge")!;
const ultsEl = document.getElementById("ults")!;
const hexCss = (n: number) => "#" + (n & 0xffffff).toString(16).padStart(6, "0");
// a distinct illustrated icon per artifact (currentColor = the artifact's colour, with a glow)
const ART_ICON: Record<string, string> = {
  sky: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2 L19 9 L12 22 L5 9 Z" fill="currentColor" opacity=".85"/><path d="M12 2 L19 9 L12 12 Z" fill="currentColor"/><path d="M5 9 L12 12 L12 2 Z" fill="currentColor" opacity=".55"/><path d="M5 9 H19" stroke="#fff" stroke-opacity=".45" stroke-width="1"/></svg>`,
  iron: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2 L20 7 V17 L12 22 L4 17 V7 Z" fill="currentColor" opacity=".85" stroke="#fff" stroke-opacity=".3" stroke-width="1"/><circle cx="12" cy="12" r="4.4" fill="#0a0f16"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="3" width="12" height="18" rx="2" fill="currentColor" opacity=".22" stroke="currentColor" stroke-width="1.2"/><path d="M13 5 L8 13 H11 L10 19 L16 10 H12 Z" fill="currentColor"/></svg>`,
  bloom: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 21 V11" stroke="currentColor" stroke-width="2"/><path d="M12 12 C12 7 8 5 4 6 C5 11 9 13.5 12 12 Z" fill="currentColor" opacity=".8"/><path d="M12 14 C12 9 16 7 20 8 C19 13 15 15.5 12 14 Z" fill="currentColor"/></svg>`,
  void: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="currentColor" opacity=".18"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1"/><path d="M12 3 A9 9 0 0 1 21 12 A6 6 0 0 0 12 6 A3 3 0 0 1 15 9" fill="currentColor" opacity=".75"/><circle cx="12" cy="12" r="2.6" fill="#0a0f16"/></svg>`,
};
// a distinct icon per ULTIMATE (keyed by sorted pair id) — drawn in currentColor (purple via CSS)
const ULT_ICON: Record<string, string> = {
  "0-0": `<svg viewBox="0 0 24 24" fill="none"><path d="M22 12 L8 7 L12 12 L8 17 Z" fill="currentColor"/><path d="M2 12 H8" stroke="currentColor" stroke-width="1.6"/></svg>`,
  "1-1": `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="10" width="14" height="6" rx="1" fill="currentColor"/><rect x="7" y="6" width="6" height="4" rx="1" fill="currentColor"/><rect x="12" y="7" width="9" height="1.6" fill="currentColor"/><g fill="currentColor"><circle cx="6" cy="18" r="1.4"/><circle cx="10" cy="18" r="1.4"/><circle cx="14" cy="18" r="1.4"/></g></svg>`,
  "2-2": `<svg viewBox="0 0 24 24" fill="none"><path d="M13 2 L6 13 H10 L8 22 L18 9 H12 Z" fill="currentColor"/></svg>`,
  "3-3": `<svg viewBox="0 0 24 24" fill="none"><g fill="currentColor"><circle cx="7" cy="8" r="2"/><circle cx="14" cy="6" r="1.6"/><circle cx="17" cy="12" r="2.2"/><circle cx="10" cy="14" r="2"/><circle cx="15" cy="17" r="1.6"/><circle cx="6" cy="16" r="1.5"/></g></svg>`,
  "4-4": `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1"/><path d="M12 3 A9 9 0 0 1 21 12 A6 6 0 0 0 12 6 A3 3 0 0 1 15 9" fill="currentColor" opacity=".8"/><circle cx="12" cy="12" r="2.6" fill="#0a0f16"/></svg>`,
  "0-1": `<svg viewBox="0 0 24 24" fill="none"><ellipse cx="11" cy="14" rx="6" ry="3" fill="currentColor"/><path d="M3 9 H21" stroke="currentColor" stroke-width="1.6"/><path d="M12 9 V11" stroke="currentColor" stroke-width="1.4"/><path d="M17 14 H22 V16" stroke="currentColor" stroke-width="1.4"/></svg>`,
  "0-2": `<svg viewBox="0 0 24 24" fill="none"><path d="M22 12 L9 7 L13 12 L9 17 Z" fill="currentColor"/><path d="M6 4 L2 12 H5 L3 20 L10 10 H6 Z" fill="currentColor" opacity=".85"/></svg>`,
  "0-3": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 7 l2 2 l2 -2"/><path d="M11 5 l2 2 l2 -2"/><path d="M15 11 l2 2 l2 -2"/><path d="M8 13 l2 2 l2 -2"/><path d="M13 17 l2 2 l2 -2"/></svg>`,
  "0-4": `<svg viewBox="0 0 24 24" fill="none"><path d="M21 6 L9 10 L12.5 12 L10.5 15.5 Z" fill="currentColor"/><path d="M2 21 L11.5 11.5" stroke="currentColor" stroke-width="1.6"/></svg>`,
  "1-2": `<svg viewBox="0 0 24 24" fill="none"><rect x="8" y="10" width="8" height="7" rx="1" fill="currentColor"/><path d="M9 17 L7 21 M15 17 L17 21" stroke="currentColor" stroke-width="1.6"/><path d="M12 2 L9 8 H12 L11 12 L15 6 H12 Z" fill="currentColor"/></svg>`,
  "1-3": `<svg viewBox="0 0 24 24" fill="none"><rect x="8" y="7" width="8" height="11" rx="2" fill="currentColor"/><circle cx="12" cy="5" r="2" fill="currentColor"/><path d="M19 8 V12 M17 10 H21" stroke="currentColor" stroke-width="1.7"/></svg>`,
  "1-4": `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="8" width="16" height="6" rx="1" fill="currentColor"/><rect x="3" y="15" width="18" height="4" rx="2" fill="currentColor" opacity=".7"/><rect x="9" y="5" width="6" height="3" fill="currentColor"/></svg>`,
  "2-3": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="2.4" fill="currentColor"/><circle cx="5" cy="8" r="1.8"/><circle cx="19" cy="9" r="1.8"/><circle cx="8" cy="19" r="1.8"/><circle cx="17" cy="18" r="1.8"/><path d="M12 12 L5 8 M12 12 L19 9 M12 12 L8 19 M12 12 L17 18"/></svg>`,
  "2-4": `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2 V22 M2 12 H22 M5 5 L19 19 M19 5 L5 19"/></svg>`,
  "3-4": `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="10" r="6" fill="currentColor"/><circle cx="10" cy="9.5" r="1.3" fill="#0a0f16"/><circle cx="14" cy="9.5" r="1.3" fill="#0a0f16"/><rect x="9.2" y="15" width="5.6" height="4" rx="1" fill="currentColor"/></svg>`,
};
// ---- FORGE BENCH: two slots; click a card to drop it in a slot, click a slot to clear it ----
let slotA: number | null = null, slotB: number | null = null;
const usedOf = (t: number) => (slotA === t ? 1 : 0) + (slotB === t ? 1 : 0);
export function resetForge() { slotA = null; slotB = null; }
function clickArt(i: number, inv: number[]) {
  if ((inv[i] ?? 0) <= usedOf(i)) return; // you've no spare of this artifact to bench
  if (slotA === null) slotA = i;
  else if (slotB === null) slotB = i;
  else { slotA = i; slotB = null; } // both full → start a fresh pair with this one
  if (latestState) updateInventory(latestState);
}
function clearSlot(which: 0 | 1) { if (which === 0) slotA = null; else slotB = null; if (latestState) updateInventory(latestState); }

// diff-based: only rebuild the cards/bench when inventory or selection changes (no per-frame churn);
// the active-ultimate clocks tick every frame but only their width/text update (cheap).
let lastCardSig = "", lastUltSig = "";
const ultRows: { bar: HTMLElement; secs: HTMLElement }[] = [];
function updateInventory(s: StateMsg) {
  const inv = s.artifacts ?? [0, 0, 0, 0, 0];
  const sig = inv.join(",") + "|" + slotA + "," + slotB;
  if (sig !== lastCardSig) { lastCardSig = sig; renderCards(inv); renderForge(inv); }
  const us = s.ultimates ?? [];
  const usig = us.map((u) => u.id).join(",");
  if (usig !== lastUltSig) { lastUltSig = usig; renderUlts(us); }
  for (let i = 0; i < us.length; i++) {
    const r = ultRows[i]; if (!r) continue;
    const cd = us[i].cooldown ?? 0, ult = ULTIMATES[us[i].id];
    r.bar.style.width = Math.round(cd * 100) + "%";
    r.secs.textContent = Math.max(0, Math.ceil((1 - cd) * (ult?.intervalSec ?? 60))) + "s";
  }
}
function renderCards(inv: number[]) {
  invGrid.replaceChildren();
  ARTIFACTS.forEach((a, i) => {
    const have = inv[i] ?? 0, used = usedOf(i), avail = have - used;
    const el = document.createElement("div");
    el.className = "art" + (used ? " sel" : "") + (have === 0 ? " empty" : "");
    el.innerHTML = `<div class="art-img" style="background:radial-gradient(circle at 50% 38%, ${hexCss(a.color)}33, #070c12 76%)">`
      + `<span class="ico" style="color:${hexCss(a.color)}">${ART_ICON[a.key] ?? ""}</span>`
      + `<span class="ct">${avail}</span></div>`
      + `<div class="meta"><span class="nm">${a.name}</span><span class="tg">${a.tag}</span></div>`;
    el.onclick = () => clickArt(i, inv);
    invGrid.appendChild(el);
  });
}
function slotHtml(t: number | null): string {
  if (t === null) return `<div class="slot empty">+</div>`;
  const a = ARTIFACTS[t];
  return `<div class="slot filled" style="color:${hexCss(a.color)}">${ART_ICON[a.key] ?? ""}</div>`;
}
// the forging player's faction (live state if present, else the in-picker choice)
const myFaction = (): Faction => (latestState?.faction ?? pickedFaction ?? "anthropic");
// an ultimate's display name = the faction-specific unit it summons (e.g. Mammoth Tank vs Tiberium Behemoth).
function ultDisplayName(ult: { effect: { kind: string; unit?: UnitType; count?: number }; name: string } | undefined): string {
  if (!ult) return "?";
  const eff = ult.effect;
  if (eff.kind === "spawn" && eff.unit) { const label = UNIT_STATS[ultUnitFor(eff.unit, myFaction())].label; return (eff.count ?? 1) > 1 ? `${label} ×${eff.count}` : label; }
  return ult.name;
}
function renderForge(_inv: number[]) {
  forgeEl.replaceChildren();
  const bench = document.createElement("div"); bench.className = "bench";
  bench.innerHTML = slotHtml(slotA) + `<span class="plus">+</span>` + slotHtml(slotB);
  const slots = bench.querySelectorAll(".slot");
  slots[0]?.addEventListener("click", () => clearSlot(0));
  slots[1]?.addEventListener("click", () => clearSlot(1));
  const prev = document.createElement("div"); prev.className = "forge-prev";
  const btn = document.createElement("button"); btn.className = "send"; btn.textContent = "⚡ Forge";
  if (slotA !== null && slotB !== null) {
    const ult = ultimateFor(slotA, slotB);
    prev.innerHTML = `<span class="fhead"><span class="fico">${ULT_ICON[ult?.id ?? ""] ?? ""}</span><span class="fn">${ultDisplayName(ult)}</span></span><span class="fb">${ult?.blurb ?? ""}</span>`;
    btn.disabled = false;
    btn.onclick = () => { sendCmd({ type: "forgeUltimate", a: slotA, b: slotB }); resetForge(); if (latestState) updateInventory(latestState); };
  } else {
    prev.innerHTML = `<span class="fb">Tap two artifact cards (same or different) to preview an ultimate.</span>`;
    btn.disabled = true;
  }
  forgeEl.append(bench, prev, btn);
}
function renderUlts(us: StateMsg["ultimates"]) {
  ultsEl.replaceChildren(); ultRows.length = 0;
  for (const act of us) {
    const ult = ULTIMATES[act.id];
    const el = document.createElement("div"); el.className = "ult";
    el.innerHTML = `<span class="uico">${ULT_ICON[act.id] ?? ""}</span><span class="un">${ult ? ultDisplayName(ult) : act.id}</span><span class="uc"><i></i></span><span class="us"></span>`;
    ultsEl.appendChild(el);
    ultRows.push({ bar: el.querySelector(".uc i") as HTMLElement, secs: el.querySelector(".us") as HTMLElement });
  }
}

// ---- ULTIMATE EFFECT FX (drawn on fxLayer, after projectiles) ----
interface Ufx { kind: string; gx: number; gy: number; t0: number; }
const ufxList: Ufx[] = [];
// every ultimate reads as PURPLE — only the motion (mode) differs between them
const UFX_STYLE: Record<string, { color: number; mode: string }> = {
  jet: { color: 0xc98bff, mode: "jet" }, gunship: { color: 0xc98bff, mode: "gunship" },
  meteor: { color: 0xb26bff, mode: "fall" }, orbital: { color: 0xc98bff, mode: "beam" },
  ion: { color: 0xd0a0ff, mode: "bolts" }, singularity: { color: 0x9b30ff, mode: "implode" },
  locust: { color: 0xb26bff, mode: "cloud" }, plague: { color: 0xb26bff, mode: "cloud" },
  stasis: { color: 0xd0a0ff, mode: "bubble" }, nanite: { color: 0xc98bff, mode: "bloom" },
  swarm: { color: 0xb26bff, mode: "bloom" }, spawn: { color: 0xc98bff, mode: "bloom" },
};
const UFX_IMPACT: Record<string, number> = { jet: 0.46, gunship: 0.32, fall: 0.6, beam: 0.12 }; // when the strike lands → when the purple burst plays
function spawnUfx(s: StateMsg) {
  for (const f of s.ufx ?? []) { if (ufxList.length > 60) break; ufxList.push({ kind: f.kind, gx: f.x, gy: f.y, t0: performance.now() }); }
}
// a clearly-readable fighter jet pointing along +dir (a swept dart with wings, tail, canopy)
function drawJet(cx: number, cy: number, dir: number, col: number, a: number) {
  const d = dir;
  fxLayer.poly([cx - d * 11, cy - 9, cx - d * 4, cy, cx - d * 11, cy]).fill({ color: col, alpha: a * 0.85 }); // upper wing
  fxLayer.poly([cx - d * 11, cy + 9, cx - d * 4, cy, cx - d * 11, cy]).fill({ color: col, alpha: a * 0.85 }); // lower wing
  fxLayer.poly([cx - d * 7, cy, cx - d * 11, cy - 5, cx - d * 6, cy ]).fill({ color: col, alpha: a * 0.85 }); // tail fin
  fxLayer.poly([cx + d * 13, cy, cx - d * 9, cy - 2.6, cx - d * 9, cy + 2.6]).fill({ color: col, alpha: a }); // fuselage
  fxLayer.circle(cx + d * 4, cy, 1.7).fill({ color: 0xffffff, alpha: a * 0.7 }); // canopy
}
// a clearly-readable gunship/helicopter (fuselage, tail boom + fin, spinning rotor, skids)
function drawHeli(cx: number, cy: number, col: number, a: number, tick: number) {
  fxLayer.rect(cx - 19, cy - 1, 13, 2).fill({ color: col, alpha: a }); // tail boom
  fxLayer.poly([cx - 19, cy - 1, cx - 22, cy - 7, cx - 17, cy + 1]).fill({ color: col, alpha: a }); // tail fin
  fxLayer.ellipse(cx, cy, 9, 5).fill({ color: col, alpha: a }); // fuselage
  fxLayer.ellipse(cx + 4, cy - 1, 3.5, 2.4).fill({ color: 0xffffff, alpha: a * 0.45 }); // canopy
  fxLayer.rect(cx - 0.8, cy - 8, 1.6, 4).fill({ color: col, alpha: a }); // mast
  const rx = Math.abs(Math.cos(tick * 0.9)) * 17 + 3; // rotor seen edge-on (length oscillates as it spins)
  fxLayer.moveTo(cx - rx, cy - 8).lineTo(cx + rx, cy - 8).stroke({ color: col, width: 1.8, alpha: a * 0.75 });
  fxLayer.rect(cx - 7, cy + 5, 14, 1.3).fill({ color: col, alpha: a * 0.8 }); // skids
}
// the big PURPLE signature burst (k 0..1) — plays when the strike actually lands
function magicBurst(x: number, y: number, k: number, phase: number) {
  if (k <= 0) return;
  const cf0 = Math.max(0, 1 - k * 3);
  fxLayer.circle(x, y, 18 + k * 64).fill({ color: 0x7a1fd0, alpha: 0.2 * (1 - k) });
  fxLayer.circle(x, y, 8 + k * 70).stroke({ color: 0x9b30ff, width: 6 * (1 - k), alpha: 0.95 * (1 - k) });
  fxLayer.circle(x, y, 4 + k * 44).stroke({ color: 0xc98bff, width: 3.5 * (1 - k), alpha: 0.9 * (1 - k) });
  fxLayer.circle(x, y, 24 * cf0).fill({ color: 0x9b30ff, alpha: 0.55 * cf0 });
  fxLayer.circle(x, y, 11 * cf0).fill({ color: 0xe6c8ff, alpha: 0.9 * cf0 });
  for (let p = 0; p < 12; p++) {
    const ang = (p / 12) * TAU + phase, dist = k * 74, len = (1 - k) * 12;
    const px = x + Math.cos(ang) * dist, py = y + Math.sin(ang) * dist * 0.6;
    fxLayer.moveTo(px, py).lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len * 0.6).stroke({ color: p % 2 ? 0x9b30ff : 0xc98bff, width: 2.2 * (1 - k), alpha: 0.9 * (1 - k) });
  }
}
// draw all active ultimate FX. Called from INSIDE the projectile ticker (after its fxLayer.clear),
// so the purple bursts survive the per-frame clear instead of being wiped by it.
function drawUfx(s: StateMsg, now: number) {
  for (let i = ufxList.length - 1; i >= 0; i--) {
    const f = ufxList[i], st = UFX_STYLE[f.kind] ?? { color: 0xc98bff, mode: "bloom" };
    const air = st.mode === "jet" || st.mode === "gunship";
    const ms = air ? 1600 : 1000; // aircraft linger so you can actually watch them cross the map
    const el = now - f.t0;
    if (el >= ms) { ufxList.splice(i, 1); continue; }
    const k = el / ms, C = st.color;
    const x = isoX(f.gx, f.gy), y = isoY(f.gx, f.gy) - elevAt(f.gx, f.gy, s.seed, s.gridW, s.gridH) - 6;
    const phase = f.gx * 0.7 + f.gy * 1.3;
    const impactK = UFX_IMPACT[st.mode] ?? 0; // 0 = burst plays immediately (effect already at the target)
    const blast = (R: number, bk: number) => { fxLayer.circle(x, y, R * 0.3 + bk * R).stroke({ color: C, width: 3 * (1 - bk), alpha: 0.8 * (1 - bk) }); };

    if (st.mode === "jet") {
      const px = x - 560 + k * 1120, py = y - 64; // streaks left→right, passing over the target ~k 0.5
      const fade = Math.min(1, Math.min(k, 1 - k) * 7);
      fxLayer.moveTo(px - 70, py).lineTo(px - 12, py).stroke({ color: C, width: 2, alpha: 0.22 * fade }); // contrail
      drawJet(px, py, 1, C, 0.95 * fade);
      if (k >= 0.4 && k <= 0.5) fxLayer.moveTo(px, py).lineTo(x, y).stroke({ color: 0xe6c8ff, width: 2, alpha: 0.9 }); // missile down
    } else if (st.mode === "gunship") {
      const gx2 = k < 0.25 ? x - 460 + (k / 0.25) * 460 : k < 0.72 ? x : x + ((k - 0.72) / 0.28) * 460; // in → hover → out
      const gy2 = y - 54;
      const fade = Math.min(1, Math.min(k, 1 - k) * 7);
      drawHeli(gx2, gy2, C, 0.95 * fade, s.tick);
      if (k >= 0.3 && k <= 0.68) for (let r = 0; r < 2; r++) { const tx = x + (Math.random() - 0.5) * 22; fxLayer.moveTo(gx2, gy2 + 4).lineTo(tx, y).stroke({ color: 0xe6c8ff, width: 1.6, alpha: 0.85 }); } // rains fire
    } else if (st.mode === "fall") {
      const t = Math.min(1, k / 0.6), mx = x + 240 - t * 240, my = y - 560 + t * 560; // meteor drops from upper-right
      if (k < 0.6) { fxLayer.moveTo(mx + 30, my - 46).lineTo(mx, my).stroke({ color: 0xb26bff, width: 4, alpha: 0.9 }); fxLayer.circle(mx, my, 4).fill({ color: 0xe6c8ff, alpha: 0.95 }); }
    } else if (st.mode === "beam") {
      if (k < 0.35) fxLayer.moveTo(x, y - 700).lineTo(x, y).stroke({ color: C, width: 7 * (1 - k * 2.6), alpha: 0.9 }); // orbital column
    } else if (st.mode === "bolts") {
      for (let b = 0; b < 6; b++) { const ang = (b / 6) * TAU + k * 3, r = 8 + k * 30; let px = x, py = y; for (let seg = 1; seg <= 3; seg++) { const rr = (r * seg) / 3, jx = x + Math.cos(ang) * rr + (seg % 2 ? 6 : -6), jy = y + Math.sin(ang) * rr * 0.6; fxLayer.moveTo(px, py).lineTo(jx, jy).stroke({ color: C, width: 1.6 * (1 - k), alpha: 0.85 * (1 - k) }); px = jx; py = jy; } }
    } else if (st.mode === "implode") {
      const r = 44 * (1 - k); fxLayer.circle(x, y, r).stroke({ color: C, width: 2, alpha: 0.8 * (1 - k) });
      fxLayer.circle(x, y, r * 0.5).stroke({ color: C, width: 1.5, alpha: 0.6 * (1 - k) });
      fxLayer.circle(x, y, 6 * (1 - Math.abs(k - 0.5) * 2)).fill({ color: 0x1a1024, alpha: 0.7 });
    } else if (st.mode === "bubble") {
      const r = 34 * Math.min(1, k * 3); fxLayer.circle(x, y, r).stroke({ color: C, width: 2.5 * (1 - k), alpha: 0.7 * (1 - k) });
      fxLayer.circle(x, y, r).fill({ color: C, alpha: 0.1 * (1 - k) });
    } else if (st.mode === "cloud") {
      for (let p = 0; p < 8; p++) { const ang = (p / 8) * TAU + f.t0, rr = 10 + k * 26; fxLayer.circle(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr * 0.6, 5 * (1 - k)).fill({ color: C, alpha: 0.4 * (1 - k) }); }
    } else { // bloom (heal / spawn)
      fxLayer.circle(x, y, 8 + k * 30).stroke({ color: C, width: 2.5 * (1 - k), alpha: 0.7 * (1 - k) });
      fxLayer.circle(x, y, 8 + k * 24).fill({ color: C, alpha: 0.12 * (1 - k) });
    }
    // SIGNATURE PURPLE BURST at the target — timed to when the strike actually lands
    if (k >= impactK) { const bk = (k - impactK) / (1 - impactK); magicBurst(x, y, bk, phase); blast(40, bk); }
  }
}

function sendCmd(cmd: unknown) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd)); }
connect();

// ---- projectiles: each shot from the server flies with a WEAPON-SPECIFIC look (per firing unit),
//      then resolves to an impact (hit) or a wide whiff (miss). Animated on the render ticker; cosmetic.
//   • gunner  — white straight dashed tracer, near-hitscan, tiny spark on hit
//   • humvee  — rapid warm-amber dashed tracer (light autocannon)
//   • tank    — slow arcing shell with an ember trail that EXPLODES on impact (fireball + shockwave + debris)
//   • turret  — smaller explosive autocannon round
interface ShotStyle { arc: number; travelMult: number; dashed: boolean; core: number; mid: number; glow: number; width: number; explode: boolean; scale: number; dash?: number; gap?: number; alpha?: number; }
const SHOT_STYLES: Record<string, ShotStyle> = {
  gunner: { arc: 0, travelMult: 0.5, dashed: true, core: 0xc8ced6, mid: 0xeaf2ff, glow: 0xdfeaff, width: 0.8, explode: false, scale: 0.85, dash: 13, gap: 9, alpha: 0.62 },
  rocket: { arc: 1.5, travelMult: 1.1, dashed: false, core: 0xffe6b0, mid: 0xff8a3a, glow: 0xff4d10, width: 1.8, explode: true, scale: 1.1 }, // anti-armor rocket
  nod_rocket: { arc: 1.5, travelMult: 1.1, dashed: false, core: 0xffe6b0, mid: 0xff8a3a, glow: 0xff4d10, width: 1.8, explode: true, scale: 1.1 },
  humvee: { arc: 0, travelMult: 0.45, dashed: true, core: 0xfff0c0, mid: 0xffd070, glow: 0xffae3a, width: 0.9, explode: false, scale: 0.8, dash: 7, gap: 6 },
  tank: { arc: 5, travelMult: 1.5, dashed: false, core: 0xffe39a, mid: 0xff7a1a, glow: 0xff2d00, width: 3.2, explode: true, scale: 1.75 },
  turret: { arc: 2.5, travelMult: 1.1, dashed: false, core: 0xffe39a, mid: 0xff9a2a, glow: 0xff4d10, width: 2.4, explode: true, scale: 1.2 },
  jet: { arc: 0, travelMult: 2.1, dashed: false, core: 0xfff0c0, mid: 0xff8a3a, glow: 0xff4d10, width: 1.7, explode: true, scale: 1.05 }, // fast straight air-to-ground missile
  gunship: { arc: 0, travelMult: 1.3, dashed: true, core: 0xfff0c0, mid: 0xffb24a, glow: 0xff7a1a, width: 1.2, explode: false, scale: 0.95, dash: 8, gap: 5, alpha: 0.7 }, // rapid autocannon burst
  nod_dronewing: { arc: 0, travelMult: 1.4, dashed: true, core: 0xfff0c0, mid: 0xffd070, glow: 0xffae3a, width: 2.0, explode: false, scale: 1.2, dash: 10, gap: 5, alpha: 0.85 }, // heavy gunship: big-caliber rear MG
  drone: { arc: 0, travelMult: 1.6, dashed: false, core: 0xbfefff, mid: 0x6fd0ff, glow: 0x2f9fe0, width: 1.0, explode: false, scale: 0.7 }, // small cyan energy bolt
  mech: { arc: 1.4, travelMult: 1.0, dashed: false, core: 0xffe39a, mid: 0xff9a2a, glow: 0xff4d10, width: 2.0, explode: true, scale: 1.0 }, // heavy autocannon shell
  walker: { arc: 0, travelMult: 3.0, dashed: false, core: 0xeaf6ff, mid: 0x9fd0ff, glow: 0x4090ff, width: 2.6, explode: true, scale: 1.5 }, // hypervelocity railgun slug
  tesla: { arc: 0, travelMult: 2.6, dashed: true, core: 0xeaffff, mid: 0x9fe8ff, glow: 0x4fb8ff, width: 1.3, explode: false, scale: 0.9, dash: 5, gap: 4, alpha: 0.9 }, // crackling electric arc
  swarmling: { arc: 2, travelMult: 0.9, dashed: false, core: 0xd6ff9a, mid: 0x8fe04a, glow: 0x4fa01a, width: 1.3, explode: false, scale: 0.85 }, // lobbed acid glob
  orb: { arc: 0, travelMult: 1.2, dashed: false, core: 0xe6c8ff, mid: 0xb26bff, glow: 0x7a1fd0, width: 2.0, explode: true, scale: 1.2 }, // void bolt
};
interface Proj { ax: number; ay: number; bx: number; by: number; t0: number; travel: number; hit: boolean; st: ShotStyle; seed: number; ox: number; oy: number; mox: number; moy: number;
  homing?: boolean; tid?: number; hx?: number; hy?: number; mh?: number; lastT?: number; boomAt?: number; trail?: number[]; boom?: { x: number; y: number }; lastTgt?: { x: number; y: number }; }
const projectiles: Proj[] = [];
// visual family for a unit type — several summon types share an art/shot/muzzle family.
const famOf = (t: string): string => (UNIT_STATS as Record<string, { family?: string }>)[t]?.family ?? t;
// planes reshape by speed: faster (lower moveEvery) → longer pointed nose + narrow, hard-swept wings;
// slower → shorter nose + wide, shallow-swept wings. 0 = wide/blunt, 1 = sharp/pointed.
const planeSharp = (t: string): number => {
  const me = (UNIT_STATS as Record<string, { moveEvery?: number }>)[t]?.moveEvery ?? 2;
  return Math.max(0, Math.min(1, 2 - me)); // moveEvery 1 → 1.0 (sharp dagger), ≥2 → 0 (wide body)
};
const planeSpan = (sh: number): number => 9.5 - 6.5 * sh;  // wingtip half-span: 9.5 (wide-body, slow) → 3.0 (fast)
const planeTipX = (sh: number): number => -5.5 - 4.5 * sh; // wingtip sweep: near-straight (slow) → hard-swept back (fast)
const isDart = (t: string): boolean => t === "jet" || t === "nod_jet"; // Fighter Jet role → small hypersonic-dart sprite
const isDartShape = (t: string): boolean => isDart(t) || t === "nod_interceptor"; // units drawn as the hypersonic dart (Banshee too)

// ---- INTERCEPTOR sprite: ported from the high-quality top-down reference model (SVG 200-canvas, nose-up) ----
// Agiwar art-local space is FORWARD = +x, centred on the origin, so rotate the reference 90°:
//   x = (100 − sy)·S (forward),  y = (sx − 100)·S (lateral).  S scales the 200-canvas down to sprite size.
const ITC_S = 0.17;
const itcXY = (sx: number, sy: number): [number, number] => [(100 - sy) * ITC_S, (sx - 100) * ITC_S];
const itcPoly = (...sv: number[]): number[] => { const o: number[] = []; for (let i = 0; i < sv.length; i += 2) o.push((100 - sv[i + 1]) * ITC_S, (sv[i] - 100) * ITC_S); return o; };
const itcPolyS = (sc: number, ...sv: number[]): number[] => itcPoly(...sv).map((v) => v * sc); // scaled about centre (volume taper)
const ITC_WINGTIP = { x: (100 - 152) * ITC_S, y: (180 - 100) * ITC_S }; // outer (right) wingtip; left mirrors on y
// muzzle reach per FAMILY, in art-local forward (+x) units = where the barrel/nozzle tip sits relative
// to the unit centre. Scaled by footprint × the unit's render scale, then projected so shots leave the nozzle.
const MUZZLE: Record<string, number> = { gunner: 11, humvee: 12.5, tank: 25, turret: 18, jet: 13, gunship: 10, drone: 4, mech: 9, walker: 22, tesla: 0, swarmling: 6, orb: 0 };
// extra screen-up per flying FAMILY so their fire leaves the aircraft at altitude.
const FLY_LIFT: Record<string, number> = { jet: 16, gunship: 13, drone: 12, orb: 14 };
const TAU = Math.PI * 2;
// dashed straight line A→B (Pixi has no native dash) — short segments, used for rifle/MG tracers
function dashLine(x1: number, y1: number, x2: number, y2: number, dash: number, gap: number, style: { color: number; width: number; alpha: number }) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len < 0.001) return;
  const ux = dx / len, uy = dy / len;
  for (let d = 0; d < len; d += dash + gap) {
    const e = Math.min(len, d + dash);
    fxLayer.moveTo(x1 + ux * d, y1 + uy * d).lineTo(x1 + ux * e, y1 + uy * e).stroke(style);
  }
}
// ---- DEATH FX: vehicles explode with shrapnel; gunners fall over (handled in reconcileUnits) ----
interface DeathBlast { gx: number; gy: number; t0: number; scale: number; seed: number; }
const deathBlasts: DeathBlast[] = [];
const DEATH_MS = 600;
const DEATH_BLAST_SCALE: Record<string, number> = { tank: 2.4, turret: 2.1, humvee: 1.6, drone: 1.1, jet: 1.5, gunship: 2.0, mech: 2.0, walker: 1.7, tesla: 1.3, swarmling: 0.9, orb: 1.8 };
function spawnDeathBlast(gx: number, gy: number, kind: string, uscale = 1) {
  if (deathBlasts.length > 120) return;
  // bigger units leave a bigger blast — fold the unit's render scale into the base family blast size.
  deathBlasts.push({ gx, gy, t0: performance.now(), scale: (DEATH_BLAST_SCALE[famOf(kind)] ?? 1.4) * (0.6 + 0.4 * uscale), seed: Math.random() * TAU });
}

function spawnShots(s: StateMsg) {
  for (const sh of s.shots ?? []) {
    if (projectiles.length > 400) break;
    const cells = Math.max(Math.abs(sh.ax - sh.bx), Math.abs(sh.ay - sh.by));
    const fam = famOf(sh.kind);
    const st = SHOT_STYLES[sh.kind] ?? SHOT_STYLES[fam] ?? SHOT_STYLES.gunner;
    // a miss veers wide of the target by a few px in a random direction
    const a = Math.random() * Math.PI * 2, r = 7 + Math.random() * 8;
    // muzzle offset: push the start to the weapon nozzle — same transform the art uses (rotate the
    // forward barrel by heading, scale by footprint × render scale, iso-squash y) so the tracer leaves the barrel tip.
    const heading = Math.atan2(sh.by - sh.ay, sh.bx - sh.ax) + Math.PI / 4;
    const mLen = (MUZZLE[fam] ?? 0) * (FOOT[fam]?.x ?? 1) * (sh.scale ?? 1);
    const fly = (FLY_LIFT[fam] ?? 0) * (sh.scale ?? 1); // flying units fire from altitude
    // AIRCRAFT fire HOMING MISSILES on a hit: they track the target's live position and explode on it.
    const homing = !!(UNIT_STATS as Record<string, { flying?: boolean }>)[sh.kind]?.flying && sh.kind !== "nod_dronewing" && sh.hit && sh.tid != null; // heavy gunship fires a big MG, not missiles
    projectiles.push({
      ax: sh.ax, ay: sh.ay, bx: sh.bx, by: sh.by, t0: performance.now(),
      travel: Math.max(40, Math.min(360, 90 + cells * 6) * st.travelMult), hit: sh.hit, st, seed: Math.random() * TAU,
      ox: sh.hit ? 0 : Math.cos(a) * r, oy: sh.hit ? 0 : Math.sin(a) * r * 0.6,
      mox: Math.cos(heading) * mLen, moy: Math.sin(heading) * mLen * 0.62 - fly,
      homing, tid: sh.tid, boomAt: -1,
    });
  }
}
// Homing missile: flies from the muzzle and STEERS toward the target unit's LIVE position each frame
// (curving tracer + exhaust trail), then detonates ON the unit. Returns true when it's finished.
function updateHomingMissile(s: StateMsg, p: Proj, st: ShotStyle, sx: number, sy: number, ex: number, ey: number, unitById: Map<number, StateMsg["units"][number]> | null, now: number): boolean {
  // live target screen position (tracks the moving unit); fall back to last-known / the fire-time point
  const tu = p.tid != null ? unitById?.get(p.tid) : undefined;
  const tgt = tu
    ? { x: isoX(tu.x, tu.y), y: isoY(tu.x, tu.y) - elevAt(tu.x, tu.y, s.seed, s.gridW, s.gridH) - 6 }
    : p.lastTgt ?? { x: ex, y: ey };
  p.lastTgt = tgt;
  if (p.hx == null) { p.hx = sx; p.hy = sy; p.mh = Math.atan2(tgt.y - sy, tgt.x - sx); p.trail = []; p.lastT = now; } // launch from the nozzle
  const dt = Math.min(64, now - (p.lastT ?? now)); p.lastT = now;

  if ((p.boomAt ?? -1) < 0) {
    // steer toward the target with a capped turn rate → a homing curve, not an instant snap
    let diff = Math.atan2(tgt.y - p.hy!, tgt.x - p.hx!) - p.mh!;
    while (diff > Math.PI) diff -= TAU; while (diff < -Math.PI) diff += TAU;
    const maxTurn = 0.013 * dt; p.mh! += Math.max(-maxTurn, Math.min(maxTurn, diff));
    const spd = 0.6 * dt; // px/ms — faster than any unit so it always runs the target down
    p.hx! += Math.cos(p.mh!) * spd; p.hy! += Math.sin(p.mh!) * spd;
    const tr = p.trail!; tr.push(p.hx!, p.hy!); if (tr.length > 18) tr.splice(0, tr.length - 18);
    // detonate ON the unit: on contact, or a fuse so it always resolves onto the target
    if (Math.hypot(tgt.x - p.hx!, tgt.y - p.hy!) <= 7 || now - p.t0 > 2400) { p.boomAt = now; p.boom = tgt; }
    // draw exhaust/tracer trail (fades toward the tail) + a bright hot head
    const t2 = p.trail!;
    for (let j = 2; j < t2.length; j += 2) {
      const f = j / t2.length;
      fxLayer.moveTo(t2[j - 2], t2[j - 1]).lineTo(t2[j], t2[j + 1]).stroke({ color: st.glow, width: (st.width + 1.4) * f, alpha: 0.5 * f });
      fxLayer.moveTo(t2[j - 2], t2[j - 1]).lineTo(t2[j], t2[j + 1]).stroke({ color: st.core, width: st.width * f, alpha: 0.9 * f });
    }
    fxLayer.circle(p.hx!, p.hy!, st.width * 3).fill({ color: st.glow, alpha: 0.3 }); // glow
    fxLayer.circle(p.hx!, p.hy!, st.width * 1.5).fill({ color: 0xffffff, alpha: 0.95 }); // hot head
    return false;
  }
  // EXPLOSION centered on the unit itself (shockwave + fireball + flung embers)
  const b = p.boom!, k = (now - p.boomAt!) / 380;
  if (k >= 1) return true;
  fxLayer.circle(b.x, b.y, st.scale * 4 + k * st.scale * 22).stroke({ color: st.glow, width: 3 * (1 - k), alpha: 0.8 * (1 - k) });
  fxLayer.circle(b.x, b.y, st.scale * 2 + k * st.scale * 13).stroke({ color: st.mid, width: 2 * (1 - k), alpha: 0.7 * (1 - k) });
  const cf = Math.max(0, 1 - k * 2.2);
  fxLayer.circle(b.x, b.y, st.scale * 9 * cf).fill({ color: st.mid, alpha: 0.6 * cf });
  fxLayer.circle(b.x, b.y, st.scale * 6 * cf).fill({ color: st.core, alpha: 0.95 * cf });
  for (let e = 0; e < 9; e++) { const ang = (e / 9) * TAU + p.seed, dist = k * st.scale * 21; fxLayer.circle(b.x + Math.cos(ang) * dist, b.y + Math.sin(ang) * dist * 0.6, (1 - k) * st.scale * 1.5).fill({ color: e % 2 ? st.core : st.mid, alpha: 0.9 * (1 - k) }); }
  return false;
}
// ---- WRAITH WINGTIP WINDSTREAMS: white vortices trailing off the outer wingtips, fading to transparent over 5s ----
interface WindPuff { x: number; y: number; t0: number; vx: number; vy: number; r: number; }
const windPuffs: WindPuff[] = []; // wide-body (wraith) vortex bubbles
interface TrailPt { x: number; y: number; t0: number; }
const windTrails = new Map<string, { w: number; pts: TrailPt[] }>(); // fast-jet skinny-line contrails, keyed by `${unitId}:${sign}`
const WIND_MS = 5000;      // full dissipation time
const WIND_EMIT_MS = 38;   // spacing between emitted puffs (per wingtip)
const WIND_MAX = 1000;     // hard cap (drop oldest) to bound per-frame draw cost
let lastWindEmit = 0;

// world-space position of a wraith's outer wingtip (sign = +1 / −1), replicating the drawBody top-cap
// transform: footprint scale → heading rotate → iso squash (0.62) → lift → holder position/scale.
// world position of an art-local point (pre-footprint-scale) on a flyer's apex sprite: footprint scale →
// heading rotate → iso squash (0.62) → lift → holder position/scale. Shared by wingtip + tail emitters.
function artPointWorld(e: UnitView, ax: number, ay: number): { x: number; y: number } {
  const u = e.u;
  const { fp, lift, H, sc } = unitDims(u);
  const h = Math.atan2(u.dy, u.dx) + Math.PI / 4;
  const px = ax * fp.x, py = ay * fp.y;
  const c = Math.cos(h), si = Math.sin(h);
  const rx = px * c - py * si, ry = px * si + py * c;
  const hs = u.scale ?? 1;
  return { x: e.holder.x + (rx + 1.6 * sc) * hs, y: e.holder.y + (ry * 0.62 - (lift + H * 1.25 * sc)) * hs };
}
function wingtipWorld(e: UnitView, sign: number): { x: number; y: number } {
  if (e.u.unit === "interceptor") return artPointWorld(e, ITC_WINGTIP.x, sign * ITC_WINGTIP.y); // real sprite wingtip
  const sh = planeSharp(e.u.unit);
  return artPointWorld(e, planeTipX(sh), sign * planeSpan(sh));
}

function emitWind(now: number) {
  if (now - lastWindEmit < WIND_EMIT_MS) return;
  lastWindEmit = now;
  for (const e of unitViews.values()) {
    const type = e.u.unit;
    if (type === "nod_dronewing") { // Heavy Gunship: two foam wakes trailing off the outside wing tips
      const h = Math.atan2(e.u.dy, e.u.dx) + Math.PI / 4;
      const fx = Math.cos(h), fy = Math.sin(h), perpx = -fy, perpy = fx;
      for (const s of [-1, 1]) {
        const p = artPointWorld(e, -3, s * 13); // outside wing tip
        windPuffs.push({ x: p.x, y: p.y, t0: now, vx: perpx * s * 5 - fx * 6, vy: perpy * s * 5 - fy * 6, r: 3.0 });
      }
      while (windPuffs.length > WIND_MAX) windPuffs.shift();
      continue;
    }
    if (famOf(type) !== "jet") continue; // only planes stream
    if (isDartShape(type)) { // Fighter Jet + Banshee: ONE contrail centered behind the tail
      const p = artPointWorld(e, -8.5, 0);
      const key = `${e.u.id}:c`;
      let tr = windTrails.get(key);
      if (!tr) { tr = { w: 0.7, pts: [] }; windTrails.set(key, tr); }
      tr.pts.push({ x: p.x, y: p.y, t0: now });
      continue;
    }
    const fast = planeSharp(type) >= 0.5; // interceptor → skinny wingtip lines; wide-body wraith → bubbles
    for (const sign of [-1, 1]) {
      const p = wingtipWorld(e, sign);
      if (fast) {
        const key = `${e.u.id}:${sign}`;
        let tr = windTrails.get(key);
        if (!tr) { tr = { w: 0.55, pts: [] }; windTrails.set(key, tr); }
        tr.pts.push({ x: p.x, y: p.y, t0: now }); // append to this wingtip's contrail path
      } else {
        windPuffs.push({ x: p.x, y: p.y, t0: now, vx: (Math.random() - 0.5) * 6, vy: -4 - Math.random() * 5, r: 1.6 + Math.random() * 0.8 });
        if (windPuffs.length > WIND_MAX) windPuffs.shift();
      }
    }
  }
}

function drawWind(now: number) {
  // wide-body wraith: vortex bubbles that spread + fade
  for (let i = windPuffs.length - 1; i >= 0; i--) {
    const p = windPuffs[i], age = now - p.t0;
    if (age >= WIND_MS) { windPuffs.splice(i, 1); continue; }
    const k = age / WIND_MS;             // 0→1 across the 5s life
    const t = age / 1000;                // seconds, for drift
    const x = p.x + p.vx * t, y = p.y + p.vy * t; // drift up/out as it dissipates
    const a = (1 - k) * 0.7;             // fade to fully transparent
    const r = p.r + k * 4.5;             // spread out as it thins
    fxLayer.circle(x, y, r + 1.6).fill({ color: 0xffffff, alpha: a * 0.3 }); // soft halo
    fxLayer.circle(x, y, r).fill({ color: 0xffffff, alpha: a });             // bright core
  }
  // fast jets: super-skinny contrail lines, each segment fading to transparent by its age
  for (const [key, tr] of windTrails) {
    const pts = tr.pts;
    while (pts.length && now - pts[0].t0 >= WIND_MS) pts.shift(); // drop expired points from the tail
    if (pts.length < 2) { if (!pts.length) windTrails.delete(key); continue; }
    for (let i = 1; i < pts.length; i++) {
      const a0 = pts[i - 1], a1 = pts[i];
      const a = (1 - (now - a1.t0) / WIND_MS) * 0.85; // newer end of the segment sets its opacity
      if (a <= 0) continue;
      fxLayer.moveTo(a0.x, a0.y).lineTo(a1.x, a1.y).stroke({ color: 0xffffff, width: tr.w, alpha: a });
    }
  }
}

app.ticker.add(() => {
  if (!latestState) return;
  const s = latestState, now = performance.now();
  emitWind(now); // wraiths keep streaming even when nothing else is on the fx layer
  const idle = !projectiles.length && !deathBlasts.length && !ufxList.length && !windPuffs.length && windTrails.size === 0;
  if (idle) { fxLayer.clear(); return; }
  fxLayer.clear();
  drawWind(now); // contrails first, under projectiles/explosions
  const unitById = projectiles.some((p) => p.homing) ? new Map(s.units.map((u) => [u.id, u])) : null; // live target lookup for homing missiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i], st = p.st;
    const el = now - p.t0;
    const impactMs = st.explode ? 380 : 130;
    const sx = isoX(p.ax, p.ay) + p.mox, sy = isoY(p.ax, p.ay) - elevAt(p.ax, p.ay, s.seed, s.gridW, s.gridH) - 9 + p.moy;
    const ex = isoX(p.bx, p.by) + p.ox, ey = isoY(p.bx, p.by) - elevAt(p.bx, p.by, s.seed, s.gridW, s.gridH) - 6 + p.oy;
    if (p.homing) { if (updateHomingMissile(s, p, st, sx, sy, ex, ey, unitById, now)) projectiles.splice(i, 1); continue; }
    if (el >= p.travel + impactMs) { projectiles.splice(i, 1); continue; }
    if (el < p.travel) {
      const t = el / p.travel, tt = Math.max(0, t - 0.16);
      const cx = sx + (ex - sx) * t, cy = sy + (ey - sy) * t - Math.sin(t * Math.PI) * st.arc;
      if (st.dashed) {
        // skinny long-dashed straight tracer streaking out from the muzzle to the current head
        const dash = st.dash ?? 12, gap = st.gap ?? 8, a = st.alpha ?? 0.95;
        dashLine(sx, sy, cx, cy, dash, gap, { color: st.glow, width: st.width + 0.7, alpha: a * 0.15 }); // faint glow
        dashLine(sx, sy, cx, cy, dash, gap, { color: st.core, width: st.width, alpha: a }); // crisp skinny dashes
        fxLayer.circle(cx, cy, st.width * 1.1).fill({ color: st.core, alpha: a }); // small head
      } else {
        // arcing shell with a fiery ember trail
        const px = sx + (ex - sx) * tt, py = sy + (ey - sy) * tt - Math.sin(tt * Math.PI) * st.arc;
        fxLayer.moveTo(px, py).lineTo(cx, cy).stroke({ color: st.glow, width: st.width * 1.5, alpha: 0.35 });
        fxLayer.moveTo(px, py).lineTo(cx, cy).stroke({ color: st.mid, width: st.width, alpha: 0.9 });
        fxLayer.circle(cx, cy, st.scale * 1.7).fill({ color: st.core, alpha: 0.95 }); // hot round
        fxLayer.circle(cx, cy, st.scale * 3).fill({ color: st.glow, alpha: 0.26 }); // bloom
      }
    } else {
      const k = (el - p.travel) / impactMs; // 0→1 impact progress
      if (st.explode) {
        if (p.hit) {
          // EXPLOSION: shockwave rings + fireball + flung embers + lingering smoke
          fxLayer.circle(ex, ey, st.scale * 4 + k * st.scale * 22).stroke({ color: st.glow, width: 3 * (1 - k), alpha: 0.8 * (1 - k) });
          fxLayer.circle(ex, ey, st.scale * 2 + k * st.scale * 13).stroke({ color: st.mid, width: 2 * (1 - k), alpha: 0.7 * (1 - k) });
          const cf = Math.max(0, 1 - k * 2.2); // fireball flashes then dies fast
          fxLayer.circle(ex, ey, st.scale * 9 * cf).fill({ color: st.mid, alpha: 0.6 * cf });
          fxLayer.circle(ex, ey, st.scale * 6 * cf).fill({ color: st.core, alpha: 0.95 * cf });
          for (let e = 0; e < 9; e++) { // ember debris
            const ang = (e / 9) * TAU + p.seed, dist = k * st.scale * 21;
            fxLayer.circle(ex + Math.cos(ang) * dist, ey + Math.sin(ang) * dist * 0.6, (1 - k) * st.scale * 1.5).fill({ color: e % 2 ? st.core : st.mid, alpha: 0.9 * (1 - k) });
          }
          fxLayer.circle(ex, ey - k * 4, st.scale * 5 + k * st.scale * 12).fill({ color: 0x141210, alpha: 0.16 * (1 - k) }); // smoke
        } else {
          fxLayer.circle(ex, ey, st.scale * 3 + k * 9).stroke({ color: st.mid, width: 1.4 * (1 - k), alpha: 0.4 * (1 - k) }); // ground burst
          fxLayer.circle(ex, ey, st.scale * 3 + k * 11).fill({ color: 0x141210, alpha: 0.12 * (1 - k) }); // dust
        }
      } else if (p.hit) {
        // bullet hit: small bright spark + a few flung sparks
        fxLayer.circle(ex, ey, 2 + k * 7).stroke({ color: st.core, width: 1.2 * (1 - k), alpha: 0.8 * (1 - k) });
        fxLayer.circle(ex, ey, 2.5 * (1 - k)).fill({ color: st.core, alpha: 0.95 * (1 - k) });
        for (let e = 0; e < 4; e++) { const ang = (e / 4) * TAU + p.seed, len = (1 - k) * 7; fxLayer.moveTo(ex, ey).lineTo(ex + Math.cos(ang) * len, ey + Math.sin(ang) * len * 0.6).stroke({ color: st.core, width: 1, alpha: 0.7 * (1 - k) }); }
      } else {
        fxLayer.circle(ex, ey, 3 + k * 5).stroke({ color: st.mid, width: 1, alpha: 0.3 * (1 - k) }); // whiff puff
      }
    }
  }
  // vehicle DEATH explosions: shockwave + fireball + SHRAPNEL (steel + ember streaks flung outward) + smoke
  for (let i = deathBlasts.length - 1; i >= 0; i--) {
    const d = deathBlasts[i], el = now - d.t0;
    if (el >= DEATH_MS) { deathBlasts.splice(i, 1); continue; }
    const k = el / DEATH_MS, S = d.scale;
    const x = isoX(d.gx, d.gy), y = isoY(d.gx, d.gy) - elevAt(d.gx, d.gy, s.seed, s.gridW, s.gridH) - 6;
    fxLayer.circle(x, y, S * 5 + k * S * 30).stroke({ color: 0xff6a1a, width: 3 * (1 - k), alpha: 0.8 * (1 - k) }); // shockwave
    fxLayer.circle(x, y, S * 3 + k * S * 18).stroke({ color: 0xffd23a, width: 2 * (1 - k), alpha: 0.6 * (1 - k) });
    const cf = Math.max(0, 1 - k * 2.4); // fireball flashes then dies
    fxLayer.circle(x, y, S * 10 * cf).fill({ color: 0xff7a1a, alpha: 0.6 * cf });
    fxLayer.circle(x, y, S * 6 * cf).fill({ color: 0xffe39a, alpha: 0.95 * cf });
    for (let p = 0; p < 14; p++) { // shrapnel streaks
      const ang = (p / 14) * TAU + d.seed + p * 0.7, sp = 0.5 + (p % 3) * 0.3, dist = k * S * 34 * sp, len = (1 - k) * S * 5;
      const x1 = x + Math.cos(ang) * dist, y1 = y + Math.sin(ang) * dist * 0.6;
      fxLayer.moveTo(x1, y1).lineTo(x1 + Math.cos(ang) * len, y1 + Math.sin(ang) * len * 0.6).stroke({ color: p % 2 ? 0x9aa6b2 : 0xffb24a, width: 1.4 * (1 - k), alpha: 0.9 * (1 - k) });
    }
    fxLayer.circle(x, y - k * 6, S * 5 + k * S * 14).fill({ color: 0x16130f, alpha: 0.18 * (1 - k) }); // smoke
  }
  if (ufxList.length) drawUfx(s, now); // ULTIMATE FX drawn last, on the freshly-cleared layer
});

// gunners fall over and die: keep the unit's art briefly and tip it over, fading, then drop it.
interface Dying { holder: Container; t0: number; }
const dyingUnits: Dying[] = [];
const DEATH_FALL_MS = 650;
function startFallOver(v: UnitView) {
  v.topG?.clear(); // no hp bar on a corpse
  dyingUnits.push({ holder: v.holder, t0: performance.now() });
}
app.ticker.add(() => {
  if (!dyingUnits.length) return;
  const now = performance.now();
  for (let i = dyingUnits.length - 1; i >= 0; i--) {
    const d = dyingUnits[i], k = (now - d.t0) / DEATH_FALL_MS;
    if (k >= 1) { d.holder.destroy({ children: true }); dyingUnits.splice(i, 1); continue; }
    const e = 1 - (1 - k) * (1 - k); // ease-out
    d.holder.rotation = e * 1.35; // tip over
    d.holder.alpha = 1 - e; // fade
    d.holder.scale.set(1, 1 - 0.25 * e); // slight collapse
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
  el.innerHTML =
    `<div class="big">${won ? "VICTORY" : "DEFEAT"}</div>` +
    `<div class="end2">${won ? "Enemy base destroyed" : "Your base has fallen"}</div>` +
    `<div class="endbtns"><button id="end-solo">▸ New game</button><button id="end-online">⚔ Find online opponent</button></div>`;
  el.className = "show " + (won ? "win" : "lose"); // re-set class so the entrance animation replays
  (document.getElementById("end-solo") as HTMLButtonElement).onclick = () => restart(true);
  (document.getElementById("end-online") as HTMLButtonElement).onclick = () => restart(false);
}
// reconnect fresh for a new match: solo=true → immediate bot game, else → online matchmaking
function restart(solo: boolean) {
  soloAfterConnect = solo;
  const el = document.getElementById("endscreen")!;
  el.className = ""; // hide the endscreen
  try { ws.onclose = null; ws.close(); } catch {} // drop the dead room without auto-reconnecting twice
  connect();
}

// ---- army doctrine picker (once per match, #4): your build identity ----
const DOCTRINE_SECONDS = 15;
// HUGE per-doctrine icons so each build identity reads instantly (line-art, inherits currentColor)
const DOCTRINE_SVG: Record<string, string> = {
  // Combined Arms — shield + star: all-around, no weakness
  balanced: `<path d="M32 5 L55 14 V30 C55 47 32 60 32 60 C32 60 9 47 9 30 V14 Z" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M32 17 L36.5 27.5 L48 29 L39.5 37 L42 48.5 L32 42.5 L22 48.5 L24.5 37 L16 29 L27.5 27.5 Z" fill="currentColor" fill-opacity=".55"/>`,
  // Vanguard — three racing chevrons: fast blitz
  vanguard: `<g fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 19 L27 32 L11 45"/><path d="M26 19 L42 32 L26 45" opacity=".7"/><path d="M41 19 L53 32 L41 45" opacity=".42"/></g>`,
  // Bastion — crenellated fortress + gate: turtle/turrets
  bastion: `<path d="M11 27 H18 V22 H25 V27 H32 V22 H39 V27 H46 V22 H53 V27 H53 V53 H11 Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M27 53 V42 a5 5 0 0 1 10 0 V53 Z" fill="currentColor" fill-opacity=".5"/>`,
  // Phantom — eye + crosshair: see first, strike, fade
  phantom: `<path d="M6 32 C20 17 44 17 58 32 C44 47 20 47 6 32 Z" fill="currentColor" fill-opacity=".1" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><circle cx="32" cy="32" r="7.5" fill="currentColor" fill-opacity=".6"/><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="32" y1="12" x2="32" y2="18"/><line x1="32" y1="46" x2="32" y2="52"/></g>`,
  // Highland — mountain peaks + summit flag: own the heights
  highland: `<path d="M5 53 L23 21 L34 39 L44 17 L59 53 Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M19 29 L23 21 L27 29 Z" fill="#eafffb" fill-opacity=".55"/><line x1="44" y1="17" x2="44" y2="6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M44 6 L55 9.5 L44 13 Z" fill="currentColor" fill-opacity=".7"/>`,
  // Industry — cog + core: eco/tech engine
  industry: `<g stroke="currentColor" stroke-width="4.5" stroke-linecap="round"><line x1="46" y1="32" x2="53" y2="32"/><line x1="42" y1="42" x2="47" y2="47"/><line x1="32" y1="46" x2="32" y2="53"/><line x1="22" y1="42" x2="17" y2="47"/><line x1="18" y1="32" x2="11" y2="32"/><line x1="22" y1="22" x2="17" y2="17"/><line x1="32" y1="18" x2="32" y2="11"/><line x1="42" y1="22" x2="47" y2="17"/></g><circle cx="32" cy="32" r="14" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="3"/><circle cx="32" cy="32" r="6" fill="currentColor" fill-opacity=".55"/>`,
};
const doctrineIconSVG = (id: string) => `<svg class="dico-svg" viewBox="0 0 64 64" aria-hidden="true">${DOCTRINE_SVG[id] ?? DOCTRINE_SVG.balanced}</svg>`;
let doctrineTimer: number | undefined;
let awaitingStart = false; // picked a doctrine, waiting for the (paused) sim to begin — dismissed on the first live state
let pickedFaction: Faction = "anthropic"; // chosen in the picker; sent with the doctrine
function pickDoctrine(id: string) {
  clearInterval(doctrineTimer);
  sendCmd({ type: "chooseArmyDoctrine", id, faction: pickedFaction });
  document.getElementById("doctrine")?.remove();
  // the sim is paused server-side until everyone has picked — show a standby cue until it starts
  awaitingStart = true;
  if (!document.getElementById("standby")) {
    const s = document.createElement("div");
    s.id = "standby";
    s.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:40;background:rgba(2,6,10,.55);backdrop-filter:blur(2px)";
    s.innerHTML = `<div style="padding:18px 26px;border:1px solid var(--accent);border-radius:10px;background:var(--bg-panel);color:#eafffb;font-weight:600;letter-spacing:.04em;box-shadow:0 0 26px rgba(0,255,209,.2)">▸ Standing by — waiting for the battle to begin…</div>`;
    stage.appendChild(s);
  }
}
function factionRosterText(f: Faction): string {
  const roles: [string, string][] = [["aggressive", "Attack"], ["defensive", "Defense"], ["builder", "Builder"], ["recon", "Recon"]];
  return roles.map(([r, lbl]) => `${lbl}: ${UNIT_STATS[FACTION_ROLE_UNIT[f][r as keyof typeof FACTION_ROLE_UNIT["anthropic"]]].label}`).join(" · ");
}
function showDoctrinePicker(current: string, faction: Faction = "anthropic") {
  clearInterval(doctrineTimer);
  document.getElementById("doctrine")?.remove();
  pickedFaction = faction;
  const C = 2 * Math.PI * 18; // ring circumference for the spindown
  const el = document.createElement("div");
  el.id = "doctrine";
  el.innerHTML =
    `<div class="dpanel">` +
    `<svg class="dtimer" viewBox="0 0 44 44"><circle class="trk" cx="22" cy="22" r="18"/><circle class="ring" cx="22" cy="22" r="18"/><text id="dtnum" x="22" y="26.5">${DOCTRINE_SECONDS}</text></svg>` +
    `<h3>Choose your army</h3>` +
    `<div class="dsub">First your faction, then your doctrine. Auto-selects Anthropic · Combined Arms when the timer runs out.</div>` +
    `<div class="facrow"></div>` +
    `<div class="facros"></div>` +
    `<div class="dcards"></div></div>`;
  const facrow = el.querySelector(".facrow") as HTMLElement;
  const facros = el.querySelector(".facros") as HTMLElement;
  for (const f of FACTIONS) {
    const meta = FACTION_META[f];
    const b = document.createElement("button");
    b.className = "facbtn" + (f === pickedFaction ? " sel" : "");
    b.dataset.f = f;
    b.style.setProperty("--fac", hexCss(meta.color));
    b.innerHTML = `<span class="facn">${meta.label}</span><span class="facb">${meta.blurb}</span>`;
    b.onclick = () => {
      pickedFaction = f;
      facrow.querySelectorAll(".facbtn").forEach((x) => x.classList.toggle("sel", (x as HTMLElement).dataset.f === f));
      facros.textContent = factionRosterText(f);
      el.style.setProperty("--accent", hexCss(meta.color));
    };
    facrow.appendChild(b);
  }
  facros.textContent = factionRosterText(pickedFaction);
  const cards = el.querySelector(".dcards")!;
  for (const d of ARMY_DOCTRINES) {
    const c = document.createElement("button");
    c.className = "dcard" + (d.id === current ? " cur" : "");
    c.innerHTML = `<div class="dicon">${doctrineIconSVG(d.id)}</div><div class="dl">${d.label}</div><div class="dh">${d.hint}</div><div class="db">${d.blurb}</div>`;
    c.onclick = () => pickDoctrine(d.id);
    cards.appendChild(c);
  }
  stage.appendChild(el);
  // 15s circular spindown → auto-pick Combined Arms (balanced) on timeout
  const ring = el.querySelector(".ring") as SVGCircleElement;
  ring.style.strokeDasharray = `${C}`;
  ring.style.strokeDashoffset = "0";
  ring.style.transition = `stroke-dashoffset ${DOCTRINE_SECONDS}s linear`;
  requestAnimationFrame(() => { ring.style.strokeDashoffset = `${C}`; });
  const num = el.querySelector("#dtnum")!;
  let left = DOCTRINE_SECONDS;
  doctrineTimer = window.setInterval(() => {
    left -= 1;
    num.textContent = String(Math.max(0, left));
    if (left <= 0) pickDoctrine("balanced");
  }, 1000);
}

// ---- strategic fork banner (#1/#5): a commander asks; you answer (or it auto-resolves) ----
let decisionTimer: number | undefined;
interface DecisionMsg { id: number; fromLabel: string; question: string; options: { key: string; label: string; detail: string }[]; expiresInSec: number }
function showDecision(d: DecisionMsg) {
  document.getElementById("decision")?.remove();
  const el = document.createElement("div");
  el.id = "decision";
  el.innerHTML = `<div class="dtitle">${d.fromLabel}</div><div class="dquestion">${d.question}</div><div class="dopts"></div><div class="dcd"><i></i></div>`;
  const opts = el.querySelector(".dopts")!;
  const choose = (key: string) => { sendCmd({ type: "decide", id: d.id, key }); el.remove(); clearTimeout(decisionTimer); };
  for (const o of d.options) {
    const b = document.createElement("button");
    b.className = "dopt";
    b.innerHTML = `<b>${o.label}</b><small>${o.detail}</small>`;
    b.onclick = () => choose(o.key);
    opts.appendChild(b);
  }
  // explicit opt-out — dismiss the fork and take NO action (won't auto-resolve to a default)
  const skip = document.createElement("button");
  skip.className = "dopt dopt-skip";
  skip.innerHTML = `<b>Stand by</b><small>No action — dismiss</small>`;
  skip.onclick = () => choose("dismiss");
  opts.appendChild(skip);
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

// ---- field-general feed: the command-log panel was replaced by the Artifacts inventory, so
// commander chatter surfaces as transient toasts instead. ----
function addLog(text: string, _tick: number) { showNotice(text, "info"); }

// ---- upgrades panel (player-driven: click to QUEUE; all other spending pauses to save up) ----
const investEl = document.getElementById("invest")!;
// crisp themed line-art icons (inherit `currentColor`), drawn large for clarity instead of tiny glyphs
const svgIcon = (inner: string, cls = "svgico") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const UP_SVG: Record<string, string> = {
  damage: `<path d="M12 2.5 L15.5 8 V15 H8.5 V8 Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="8.5" y="15" width="7" height="5.2" rx="1" fill="currentColor" fill-opacity=".55"/>`,
  hp: `<rect x="4" y="4" width="16" height="16" rx="4.5" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="1.5"/><path d="M12 8 V16 M8 12 H16" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`,
  armor: `<path d="M12 2.8 L19 5.6 V11 C19 16.2 12 20.9 12 20.9 C12 20.9 5 16.2 5 11 V5.6 Z" fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8.8 11.6 L11.2 14 L15.4 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  range: `<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="2.3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="12" y1="2.4" x2="12" y2="5.6"/><line x1="12" y1="18.4" x2="12" y2="21.6"/><line x1="2.4" y1="12" x2="5.6" y2="12"/><line x1="18.4" y1="12" x2="21.6" y2="12"/></g>`,
  speed: `<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6 L10 12 L4 18"/><path d="M11 6 L17 12 L11 18" opacity=".65"/></g>`,
  income: `<circle cx="12" cy="12" r="3.4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="12" y1="2.6" x2="12" y2="5.4"/><line x1="12" y1="18.6" x2="12" y2="21.4"/><line x1="2.6" y1="12" x2="5.4" y2="12"/><line x1="18.6" y1="12" x2="21.4" y2="12"/><line x1="5.6" y1="5.6" x2="7.6" y2="7.6"/><line x1="16.4" y1="16.4" x2="18.4" y2="18.4"/><line x1="16.4" y1="5.6" x2="18.4" y2="7.6"/><line x1="5.6" y1="18.4" x2="7.6" y2="16.4"/></g>`,
};
const upIconSVG = (kind: string) => svgIcon(UP_SVG[kind] ?? "");
// a stack-of-coins money icon for the resource readout
const MONEY_SVG =
  `<ellipse cx="12" cy="16.4" rx="8" ry="3.2" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.3"/>` +
  `<ellipse cx="12" cy="13" rx="8" ry="3.2" fill="currentColor" fill-opacity=".34" stroke="currentColor" stroke-width="1.3"/>` +
  `<ellipse cx="12" cy="9.4" rx="8" ry="3.2" fill="currentColor" fill-opacity=".6" stroke="currentColor" stroke-width="1.5"/>` +
  `<ellipse cx="9.6" cy="8.7" rx="2.6" ry="0.9" fill="#eafffb" fill-opacity=".55"/>`;
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
        `<span class="ico">${upIconSVG(inv.kind)}</span>` +
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
    resetForge(); lastCardSig = ""; lastUltSig = ""; // new match → reset forge bench + force a fresh render
  }
  renderFog(s); // unexplored = black · explored = dim memory · visible = bright
  // transient entities (rebuilt each state); units are persistent + interpolated, so don't wipe them
  for (const c of transientFx) c.destroy({ children: true });
  transientFx.length = 0;
  const addT = (g: Container) => { entityLayer.addChild(g); transientFx.push(g); };
  if (s.rally) addT(makeRally(s.rally, s));
  for (const a of s.outposts) addT(makeOutpost(a, s));
  for (const d of s.drops ?? []) addT(makeDrop(d, s));
  for (const b of s.bases) addT(makeBase(b, s));
  reconcileUnits(s); // create/update/remove persistent unit holders; the ticker glides them
  if (hovered) hovered = s.units.find((u) => u.id === hovered!.id) ?? null;
  if (pinned) pinned = s.units.find((u) => u.id === pinned!.id) ?? null; // drop the pin if the unit died
  updateReadout();
  const allocPct = latestCamps.reduce((a, c) => a + c.production.budgetPct, 0) + latestTurretBudget;
  const spend = Math.round((s.incomePerSec * Math.min(100, allocPct)) / 100);
  const b = s.bonuses;
  const bonusBits = [b.income && `+${b.income}⛃`, b.range && `+${b.range}rng`, b.hp && `+${b.hp}hp`, b.damage && `+${b.damage}dmg`, b.armor && `−${b.armor}dmg⛨`, b.speed && `+${b.speed * 10}%spd`].filter(Boolean).join(" ");
  econEl.innerHTML =
    `<span class="econ-ico">${svgIcon(MONEY_SVG)}</span>` +
    `<span class="econ-amt">${s.resources}</span>` +
    `<span class="econ-sub">+${s.incomePerSec}/s · spend ~${spend}/s · save ${Math.max(0, 100 - allocPct)}%${bonusBits ? " · ⬡ " + bonusBits : ""}</span>`;
  syncInvest(s);
  syncMorale(s);
}

// ---- morale meter + booster ("send meals & entertainment to units") ----
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
  mboost.innerHTML = `🍱 Send meals &amp; entertainment to units · ⛃${s.boosterCost ?? "—"}`;
  mboost.disabled = (s.resources ?? 0) < (s.boosterCost ?? Infinity);
}

// the player's rally/commitment marker — a HEAVENLY ORDER cast as a large glowing magic circle:
// a wide iso ring (≈ the rally gather radius) whose entire interior is a soft, shimmering magical
// haze, ringed by slow-rotating runes, with expanding pulses and rising motes. All FILLED shapes
// (no moveTo/lineTo) so no stray line leaks to the world origin.
function makeRally(p: { x: number; y: number }, s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(p.x, p.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(p.x, p.y), cy = isoY(p.x, p.y) - elev + 2;
  const C = OWN_COLOR, W = 0xffffff, TAU = Math.PI * 2;
  const Rc = 3.4 * GRID_SCALE; // gather-zone radius in fine cells (~where forces converge)
  const rx = Rc * TILE_W, ry = Rc * TILE_H; // iso-squashed disc

  // 1) the magical haze — many concentric ellipses, denser toward the center, with an outward
  //    shimmer wave so the whole interior glows and breathes.
  const N = 14;
  for (let i = N; i >= 1; i--) {
    const f = i / N; // 1 = ring edge, →0 = center
    const shimmer = 0.6 + 0.4 * Math.sin(s.tick / 7 - i * 0.5);
    g.ellipse(cx, cy, rx * f, ry * f).fill({ color: C, alpha: (0.018 + 0.05 * (1 - f)) * shimmer });
  }
  // soft wisps swirling inside (a few offset blobs orbiting the center)
  for (let i = 0; i < 5; i++) {
    const a = s.tick / 30 + (i / 5) * TAU, rr = 0.55 * (0.6 + 0.3 * Math.sin(s.tick / 13 + i));
    g.ellipse(cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr, rx * 0.16, ry * 0.16).fill({ color: W, alpha: 0.05 });
  }

  // 2) the ring(s) + slow-rotating runes around the rim
  const spin = (s.tick % 360) / 360 * TAU;
  g.ellipse(cx, cy, rx, ry).stroke({ color: C, width: 2.6, alpha: 0.85 });
  g.ellipse(cx, cy, rx * 0.86, ry * 0.86).stroke({ color: C, width: 1.1, alpha: 0.35 });
  for (let i = 0; i < 16; i++) {
    const a = spin + (i / 16) * TAU, big = i % 4 === 0;
    g.circle(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, big ? 3 : 1.6).fill({ color: big ? W : C, alpha: big ? 0.9 : 0.7 });
  }

  // 3) expanding holy pulses sweeping outward to the rim
  for (let i = 0; i < 2; i++) {
    const t = (((s.tick % 44) / 44) + i * 0.5) % 1, k = 0.45 + t * 0.55;
    g.ellipse(cx, cy, rx * k, ry * k).stroke({ color: W, width: 2 * (1 - t), alpha: 0.5 * (1 - t) });
  }

  // 4) rising motes — little sparks drifting up out of the haze (magic ascending)
  for (let i = 0; i < 10; i++) {
    const t = ((s.tick / 22) + i / 10) % 1, a = (i / 10) * TAU;
    g.circle(cx + Math.cos(a) * rx * 0.66, cy + Math.sin(a) * ry * 0.66 - t * 30, 1.6 * (1 - t)).fill({ color: W, alpha: 0.6 * (1 - t) });
  }

  // 5) a calm bright heart (not a tall beam) marking the exact point
  g.ellipse(cx, cy, rx * 0.16, ry * 0.16).fill({ color: W, alpha: 0.1 });
  g.ellipse(cx, cy, 5, 2.5).fill({ color: W, alpha: 0.7 });

  g.zIndex = 1 << 20; // a divine order draws above all units/buildings
  return g;
}

// a collectible artifact: a floating, glowing gem in the artifact's colour (+ a ring while picking up)
function makeDrop(d: StateMsg["drops"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(d.x, d.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(d.x, d.y), cy = isoY(d.x, d.y) - elev;
  const col = (ARTIFACTS[d.type] ?? ARTIFACTS[0]).color;
  const pulse = 0.5 + 0.5 * Math.sin(s.tick / 5);
  const gy = cy - (9 + 2 * Math.sin(s.tick / 7)); // bob in the air
  g.ellipse(cx, cy + 2, 8, 4).fill({ color: 0x000000, alpha: 0.3 }); // shadow
  g.ellipse(cx, cy + 1, 12 + 4 * pulse, 6 + 2 * pulse).fill({ color: col, alpha: 0.12 + 0.1 * pulse }); // ground glow
  g.poly([cx, gy - 7, cx + 5, gy, cx, gy + 7, cx - 5, gy]).fill({ color: col, alpha: 0.95 }).stroke({ color: 0xffffff, width: 0.8, alpha: 0.5 }); // gem
  g.poly([cx, gy - 7, cx + 5, gy, cx, gy]).fill({ color: tint(col, 0.35), alpha: 0.85 }); // lit facet
  g.circle(cx, gy, 1.6).fill({ color: 0xffffff, alpha: 0.6 + 0.4 * pulse }); // sparkle
  if (d.harvestAt > s.tick) g.circle(cx, gy, 10 + 3 * pulse).stroke({ color: 0xffffff, width: 1.2, alpha: 0.5 }); // harvesting
  return g;
}

function makeOutpost(a: StateMsg["outposts"][number], s: StateMsg): Graphics {
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

  // capture SPINDOWN: a circular progress ring while a builder is channeling the claim
  const capping = neutral && a.capProgress > 0;
  const ringY = beaconY - 16;
  if (capping) {
    const cc = a.capOwner === s.you ? OWN_COLOR : a.capOwner >= 0 ? ENEMY_COLOR : 0xffd76b;
    g.circle(cx, ringY, 9).stroke({ color: 0x05080b, width: 3.2, alpha: 0.55 }); // track
    g.circle(cx, ringY, 9).stroke({ color: cc, width: 1, alpha: 0.25 }); // faint full ring
    // progress arc — moveTo the arc START first, else Pixi draws a connector line from (0,0) (the "laser")
    const a0 = -Math.PI / 2;
    g.moveTo(cx + 9 * Math.cos(a0), ringY + 9 * Math.sin(a0)).arc(cx, ringY, 9, a0, a0 + a.capProgress * Math.PI * 2).stroke({ color: cc, width: 3.2, alpha: 0.95 });
  }
  const label = neutral ? (capping ? `${a.bonus.label}  ⟳ ${Math.round(a.capProgress * 100)}%` : `${a.bonus.label}  ▸ send a builder`) : a.bonus.label;
  const t = new Text({ text: label, style: { fill: accent, fontFamily: "JetBrains Mono, monospace", fontSize: 10 } });
  t.anchor.set(0.5, 1); t.x = cx; t.y = (capping ? ringY - 12 : beaconY) - (a.owner >= 0 && a.hp < a.maxHp ? 16 : 8); g.addChild(t);
  g.zIndex = a.x + a.y; // sits with terrain depth
  if (neutral) { // click to direct forces to capture it
    g.eventMode = "static"; g.cursor = "pointer";
    g.on("pointertap", () => sendCmd({ type: "captureOutpost", id: a.id }));
  }
  return g;
}

function makeBase(b: StateMsg["bases"][number], s: StateMsg): Graphics {
  const g = new Graphics();
  const elev = elevAt(b.x, b.y, s.seed, s.gridW, s.gridH);
  const cx = isoX(b.x, b.y), cy = isoY(b.x, b.y) - elev;
  const team = b.owner === s.you ? OWN_COLOR : ENEMY_COLOR;
  // natural materials; team color only for accents (lit windows / lights / neon edges / flag / field)
  const concrete = 0x646973, conc2 = 0x70757f, steel = 0x474d57, steelDk = 0x2b3038, deckC = 0x3a3f48, deck2 = 0x434956, pad = 0x171b21, mark = 0xd2d8de;
  const lit = tint(team, 0.5), white = 0xeafffb;
  const pulse = 0.5 + 0.5 * Math.sin(s.tick / 6);
  const BW = TILE_W * GRID_SCALE * 1.35, BH = TILE_H * GRID_SCALE * 1.35; // big landmark

  // rim-lit iso cuboid: a shaded box + a glowing team-colored neon outline on its top + near edge
  const box = (x: number, yBase: number, hw: number, hh: number, h: number, color: number) => {
    isoBox(g, x, yBase, hw, hh, h, color);
    const t = yBase - h;
    g.poly([x, t - hh, x + hw, t, x, t + hh, x - hw, t]).stroke({ color: team, width: 1, alpha: 0.32 }); // top edge neon
    g.moveTo(x, t + hh).lineTo(x, yBase + hh).stroke({ color: team, width: 1, alpha: 0.2 }); // near vertical edge
  };
  // lit windows following a building's face slant — varied (lit / bright / dark)
  const windows = (x: number, t: number, hw: number, hh: number, h: number, rows: number, cols: number, ww = 3, wh = 3.6) => {
    for (let r = 0; r < rows; r++) for (let c = 1; c <= cols; c++) {
      const u = c / (cols + 1), v = (r + 0.6) / rows, wy = t + hh * (1 - u) + v * h - wh / 2, m = (r * 5 + c * 3) % 7;
      const col = m === 0 ? white : lit, aR = m >= 5 ? 0.12 : 0.55 + 0.4 * ((r + c) & 1), aL = m >= 5 ? 0.08 : 0.32 + 0.25 * ((r + c) & 1);
      g.rect(x + u * hw - ww / 2, wy, ww, wh).fill({ color: col, alpha: aR });
      g.rect(x - u * hw - ww / 2, wy, ww, wh).fill({ color: col, alpha: aL });
    }
  };
  const building = (x: number, y: number, hw: number, hh: number, h: number, rows: number, cols: number, col = concrete) => {
    box(x, y, hw, hh, h, col);
    windows(x, y - h, hw, hh, h, rows, cols);
  };
  // hemisphere dome via stacked ellipses (lit top), neon base ring + meridian + perimeter lights
  const dome = (x: number, y: number, r: number) => {
    g.ellipse(x, y + 1.5, r * 1.05, r * 0.55).fill({ color: 0x000000, alpha: 0.22 });
    for (let i = 0; i < 9; i++) { const t0 = i / 9, rr = r * Math.cos(t0 * Math.PI / 2); g.ellipse(x, y - t0 * r * 0.92, rr, rr * 0.5).fill(tint(concrete, -0.07 + t0 * 0.26)); }
    g.rect(x - 0.7, y - r * 0.92, 1.4, r * 0.92).fill({ color: team, alpha: 0.3 }); // meridian glow
    g.ellipse(x, y, r, r * 0.5).stroke({ color: team, width: 1.2, alpha: 0.5 });
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.circle(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.5, 0.9).fill({ color: team, alpha: 0.6 }); }
    g.circle(x, y - r * 0.88, 1.8).fill({ color: team, alpha: 0.5 + 0.5 * pulse });
  };
  // tall chunky corner bastion: body + flush cap + beacon + windows
  const bastion = (x: number, y: number, h: number) => {
    box(x, y, BW * 0.5, BH * 0.5, h, concrete);
    const t = y - h;
    box(x, t + BH * 0.5, BW * 0.62, BH * 0.62, BH * 0.7, steel); // overhanging battlement cap
    windows(x, t, BW * 0.5, BH * 0.5, h, 3, 2, 2.4, 3);
    g.circle(x, t - BH * 0.55, 1.8).fill({ color: team, alpha: 0.5 + 0.5 * pulse });
  };
  const dish = (x: number, y: number, sz = 1) => { // satellite dish on a pedestal
    box(x, y, BW * 0.32, BH * 0.32, BH * 0.95, steel);
    const my = y - BH * 0.95;
    g.rect(x - 1.8 * sz, my - 9 * sz, 3.6 * sz, 12 * sz).fill(steel);
    g.ellipse(x + 8 * sz, my - 13 * sz, 14 * sz, 9 * sz).fill(conc2).stroke({ color: team, width: 1.5, alpha: 0.6 });
    g.ellipse(x + 8 * sz, my - 13 * sz, 9.5 * sz, 6 * sz).fill(tint(concrete, -0.22));
    g.ellipse(x + 8 * sz, my - 13 * sz, 4 * sz, 2.6 * sz).fill(steelDk);
    g.moveTo(x + 8 * sz, my - 13 * sz).lineTo(x + 17 * sz, my - 20 * sz).stroke({ color: steel, width: 1.8 });
    g.circle(x + 17 * sz, my - 20 * sz, 2.2).fill({ color: team, alpha: 0.55 + 0.45 * pulse });
  };
  const tank = (x: number, y: number, r: number, h: number) => { // cylindrical storage w/ hazard band
    g.ellipse(x, y, r, r * 0.5).fill({ color: 0x000000, alpha: 0.22 });
    g.rect(x - r, y - h, r * 2, h).fill(conc2);
    g.rect(x - r, y - h, r * 0.55, h).fill(tint(conc2, 0.12)); g.rect(x + r * 0.45, y - h, r * 0.55, h).fill(tint(conc2, -0.22));
    g.rect(x - r, y - h * 0.55, r * 2, 1.8).fill({ color: team, alpha: 0.32 });
    g.ellipse(x, y - h, r, r * 0.5).fill(tint(conc2, 0.2)).stroke({ color: team, width: 1, alpha: 0.45 });
  };
  const cooling = (x: number, y: number, r: number, h: number) => { // tapered cooling tower w/ glowing vent
    g.ellipse(x, y, r, r * 0.5).fill({ color: 0x000000, alpha: 0.22 });
    g.poly([x - r, y, x - r * 0.62, y - h, x + r * 0.62, y - h, x + r, y]).fill(conc2); // tapered body
    g.poly([x - r, y, x - r * 0.62, y - h, x - r * 0.22, y - h, x - r * 0.4, y]).fill(tint(conc2, 0.12)); // lit edge
    g.ellipse(x, y - h, r * 0.62, r * 0.31).fill(steelDk).stroke({ color: team, width: 1.2, alpha: 0.6 }); // glowing vent
    g.ellipse(x, y - h - 3, r * 0.5, r * 0.25).fill({ color: team, alpha: 0.12 + 0.08 * pulse }); // steam glow
  };
  const radarArray = (x: number, y: number) => { // 3 small dishes on a low frame
    box(x, y, BW * 0.7, BH * 0.7, BH * 0.5, steel);
    const ry = y - BH * 0.5;
    for (const ox of [-BW * 0.42, 0, BW * 0.42]) { g.rect(x + ox - 0.8, ry - 7, 1.6, 7).fill(steel); g.ellipse(x + ox + 2, ry - 8, 5, 3.2).fill(conc2).stroke({ color: team, width: 1, alpha: 0.6 }); g.ellipse(x + ox + 2, ry - 8, 2, 1.3).fill(steelDk); }
  };
  const antenna = (x: number, y: number, h: number) => {
    g.moveTo(x, y - h).lineTo(x - 9, y).stroke({ color: steel, width: 0.8, alpha: 0.5 });
    g.moveTo(x, y - h).lineTo(x + 9, y).stroke({ color: steel, width: 0.8, alpha: 0.5 });
    g.rect(x - 1, y - h, 2, h).fill(steel);
    for (let i = 1; i <= 3; i++) g.moveTo(x - 3, y - h * i / 3.5).lineTo(x + 3, y - h * i / 3.5).stroke({ color: steel, width: 1, alpha: 0.6 }); // crossbars
    g.circle(x, y - h, 2).fill({ color: team, alpha: 0.45 + 0.55 * pulse });
  };
  const chopper = (x: number, y: number) => { // parked helicopter silhouette
    g.ellipse(x, y - 2, 11, 4).fill({ color: team, alpha: 0.12 + 0.06 * pulse }); // rotor wash disc
    g.ellipse(x, y - 3, 5.5, 3).fill(steel); // body
    g.rect(x + 3, y - 4, 9, 1.6).fill(steel); // tail boom
    g.rect(x + 11, y - 6, 1.4, 4).fill(steel); // tail fin
    g.rect(x - 8, y - 3.6, 16, 1).fill({ color: mark, alpha: 0.5 }); // rotor blades
    g.circle(x, y - 3.6, 1).fill(team); // hub
  };
  const helipad = (x: number, y: number, rw: number, rh: number) => {
    const sc = rw / (BW * 1.0);
    g.ellipse(x, y, rw, rh).fill(pad);
    g.ellipse(x, y, rw, rh).stroke({ color: team, width: 1.6, alpha: 0.6 });
    g.ellipse(x, y, rw * 0.78, rh * 0.78).stroke({ color: mark, width: 1, alpha: 0.4 });
    g.rect(x - 5.5 * sc, y - 6 * sc, 2 * sc, 12 * sc).fill(mark); g.rect(x + 3.5 * sc, y - 6 * sc, 2 * sc, 12 * sc).fill(mark); g.rect(x - 5.5 * sc, y - 1 * sc, 9 * sc, 2 * sc).fill(mark); // "H"
    for (const [hx, hy] of [[-rw * 0.85, 0], [rw * 0.85, 0], [0, -rh * 0.85], [0, rh * 0.85]] as [number, number][]) g.circle(x + hx, y + hy, 1.4).fill({ color: team, alpha: 0.45 + 0.55 * pulse });
  };

  // ---- shadow + energy field (layered glow + a pulsing scan ring) ----
  g.ellipse(cx, cy + BH * 1.9, BW * 4.4, BH * 3.0).fill({ color: 0x000000, alpha: 0.34 });
  g.ellipse(cx, cy + BH * 1.7, BW * 4.8, BH * 3.4).fill({ color: team, alpha: 0.07 });
  g.ellipse(cx, cy + BH * 1.7, BW * 4.0, BH * 2.8).fill({ color: team, alpha: 0.07 });
  g.ellipse(cx, cy + BH * 1.7, BW * (3.6 + 0.6 * pulse), BH * (2.5 + 0.42 * pulse)).stroke({ color: team, width: 1.5, alpha: 0.22 * (1 - pulse) + 0.05 });

  // ---- stepped concrete deck (3 tiers) with neon rim + runway lights ----
  isoBox(g, cx, cy + BH * 2.05, BW * 3.5, BH * 3.5, BH * 0.5, steelDk);
  isoBox(g, cx, cy + BH * 1.8, BW * 3.15, BH * 3.15, BH * 0.5, deckC);
  isoBox(g, cx, cy + BH * 1.55, BW * 2.8, BH * 2.8, BH * 0.45, deck2);
  const dT = (cy + BH * 1.55) - BH * 0.45, PW = BW * 2.8, PH = BH * 2.8;
  g.poly([cx, dT - PH, cx + PW, dT, cx, dT + PH, cx - PW, dT]).stroke({ color: team, width: 1.2, alpha: 0.3 }); // deck neon rim
  for (let i = 1; i < 9; i++) { const t = i / 9; // runway lights along the two front edges
    g.circle(cx + PW * (1 - t), dT + PH * t, 1).fill({ color: team, alpha: 0.5 });
    g.circle(cx - PW * (1 - t), dT + PH * t, 1).fill({ color: team, alpha: 0.5 });
  }

  // ===== structures: back (up-screen) → front =====
  radarArray(cx - BW * 1.1, cy - BH * 0.7);
  cooling(cx + BW * 0.7, cy - BH * 0.7, BW * 0.4, BH * 1.7);
  cooling(cx + BW * 1.35, cy - BH * 0.5, BW * 0.36, BH * 1.5);
  dome(cx + BW * 1.95, cy - BH * 0.2, BW * 0.7); // reactor dome
  antenna(cx - BW * 0.2, cy - BH * 0.9, BH * 5.4);
  bastion(cx - BW * 2.55, cy - BH * 0.1, BH * 4.0);
  bastion(cx + BW * 2.55, cy - BH * 0.1, BH * 4.0);
  building(cx - BW * 1.9, cy + BH * 0.7, BW * 1.05, BH * 1.05, BH * 2.1, 2, 3); // air-control building
  helipad(cx - BW * 1.9, (cy + BH * 0.7) - BH * 2.1, BW * 0.92, BH * 0.92);
  chopper(cx - BW * 1.9, (cy + BH * 0.7) - BH * 2.1 - 1);
  building(cx + BW * 1.85, cy + BH * 0.6, BW * 0.82, BH * 0.82, BH * 2.5, 3, 2); // lab block
  dome(cx + BW * 1.85, cy + BH * 0.6 - BH * 2.5, BW * 0.55);

  // central tiered HQ spire (4 stepped tiers + flag)
  const hqY = cy + BH * 1.0;
  box(cx, hqY, BW * 1.35, BH * 1.35, BH * 2.5, concrete); windows(cx, hqY - BH * 2.5, BW * 1.35, BH * 1.35, BH * 2.5, 4, 3);
  const y2 = hqY - BH * 2.5; box(cx, y2, BW * 1.02, BH * 1.02, BH * 2.2, conc2); windows(cx, y2 - BH * 2.2, BW * 1.02, BH * 1.02, BH * 2.2, 3, 3);
  const y3 = y2 - BH * 2.2; box(cx, y3, BW * 0.7, BH * 0.7, BH * 1.8, tint(conc2, 0.05)); windows(cx, y3 - BH * 1.8, BW * 0.7, BH * 0.7, BH * 1.8, 3, 2);
  const y4 = y3 - BH * 1.8; box(cx, y4, BW * 0.42, BH * 0.42, BH * 1.2, tint(conc2, 0.1)); windows(cx, y4 - BH * 1.2, BW * 0.42, BH * 0.42, BH * 1.2, 2, 1);
  const top = y4 - BH * 1.2;
  g.rect(cx - 1.4, top - 28, 2.8, 28).fill(0xcfd8e3); // flag pole
  g.poly([cx + 1.4, top - 28, cx + 22, top - 21, cx + 1.4, top - 14]).fill(tint(team, 0.4)); // banner
  g.circle(cx, top, 2.6).fill({ color: team, alpha: 0.6 + 0.4 * pulse }); g.circle(cx, top, 6).fill({ color: team, alpha: 0.12 }); // beacon + glow

  // ---- front row (drawn last so it overlaps) ----
  dish(cx - BW * 0.6, cy + BH * 1.7, 0.85);
  tank(cx + BW * 1.5, cy + BH * 2.05, BW * 0.44, BH * 1.6);
  tank(cx + BW * 2.1, cy + BH * 1.85, BW * 0.36, BH * 1.25);
  tank(cx + BW * 1.95, cy + BH * 2.3, BW * 0.32, BH * 1.05);
  bastion(cx - BW * 2.5, cy + BH * 1.75, BH * 3.4);
  bastion(cx + BW * 2.5, cy + BH * 1.75, BH * 3.4);

  // ---- hp bar above the spire ----
  g.rect(cx - BW, top - 40, BW * 2, 4).fill({ color: 0x000000, alpha: 0.4 });
  g.rect(cx - BW, top - 40, (b.hp / b.maxHp) * BW * 2, 4).fill(hpColor(b.hp / b.maxHp));
  g.zIndex = b.x + b.y;
  return g;
}

// Shared material palette — natural gunmetal/steel, lightly tinted toward the team color so own/
// enemy read at a glance while the body stays "real military". Team color itself is reserved for
// HEAVY accents (rim lights, lenses, marker lights, doctrine pips). `tk` (team-tinted steel) keys
// every metal tone off the side color; gun/glass/rubber stay neutral.
function unitPalette(side: number) {
  const tk = (base: number, k: number) => lerpColor(base, side, k); // steel hue-shifted toward team
  return {
    steelLt: tk(0x7b838e, 0.16), steel: tk(0x586069, 0.14), steelMd: tk(0x444b54, 0.12),
    steelDk: tk(0x31373f, 0.1), steelDkr: tk(0x22272d, 0.08),
    gun: 0x2a2f36, gunLt: 0x49515b, glass: 0x0a141d, rubber: 0x14171b,
  };
}

// High-quality Interceptor top-cap, ported from the reference sprite (nose-up SVG → forward-+x art),
// faction-tinted via unitPalette(side): swept-delta wings w/ rim-lit leading edges, curved fuselage
// spindle, tinted canopy, tailplanes, engine nozzles, afterburner glow.
function drawInterceptor(g: Graphics, side: number, acc: number) {
  const m = unitPalette(side);
  const dark = m.steelDk, mid = m.steel, light = m.steelLt;
  const burn = 0xffd070; // afterburner
  const P = itcXY;

  // afterburner glow (rear, behind hull): soft bloom + bright core per nozzle
  for (const off of [-3.5, 3.5]) {
    const [bx, by] = P(100 + off, 182);
    g.ellipse(bx, by, 20 * ITC_S, 10 * ITC_S).fill({ color: burn, alpha: 0.22 });
    g.ellipse(bx, by, 12 * ITC_S, 6 * ITC_S).fill({ color: burn, alpha: 0.85 });
  }
  // swept-delta wings (dark) + lit upper faces (mid)
  g.poly(itcPoly(97, 96, 20, 152, 47, 166, 99, 130)).fill(dark);
  g.poly(itcPoly(103, 96, 180, 152, 153, 166, 101, 130)).fill(dark);
  g.poly(itcPoly(97, 101, 41, 148, 54, 156, 99, 128)).fill(mid);
  g.poly(itcPoly(103, 101, 159, 148, 146, 156, 101, 128)).fill(mid);
  // leading-edge rim light
  g.poly(itcPoly(97, 96, 20, 152, 26, 152, 98, 100)).fill({ color: 0xffffff, alpha: 0.18 });
  g.poly(itcPoly(103, 96, 180, 152, 174, 152, 102, 100)).fill({ color: 0xffffff, alpha: 0.18 });
  // team accent stripes
  g.poly(itcPoly(60, 132, 44, 149, 52, 154, 67, 138)).fill(side);
  g.poly(itcPoly(140, 132, 156, 149, 148, 154, 133, 138)).fill(side);
  // tailplanes
  g.poly(itcPoly(97, 150, 67, 182, 81, 187, 99, 164)).fill(dark);
  g.poly(itcPoly(103, 150, 133, 182, 119, 187, 101, 164)).fill(dark);

  // fuselage (mid) — curved spindle
  g.moveTo(...P(100, 20)).bezierCurveTo(...P(108, 42), ...P(110, 76), ...P(108, 114))
    .lineTo(...P(106, 170)).bezierCurveTo(...P(105, 181), ...P(95, 181), ...P(94, 170))
    .lineTo(...P(92, 114)).bezierCurveTo(...P(90, 76), ...P(92, 42), ...P(100, 20)).fill(mid);
  // side shade
  g.moveTo(...P(100, 20)).bezierCurveTo(...P(108, 42), ...P(110, 76), ...P(108, 114))
    .lineTo(...P(106, 170)).bezierCurveTo(...P(105.5, 175), ...P(103, 178), ...P(100, 178))
    .lineTo(...P(100, 20)).fill({ color: dark, alpha: 0.45 });
  // spine highlight
  g.moveTo(...P(100, 30)).bezierCurveTo(...P(104, 48), ...P(105, 78), ...P(104, 114))
    .lineTo(...P(103, 160)).bezierCurveTo(...P(102.6, 165), ...P(97.4, 165), ...P(97, 160))
    .lineTo(...P(96, 114)).bezierCurveTo(...P(95, 78), ...P(96, 48), ...P(100, 30)).fill({ color: light, alpha: 0.85 });
  // nose rim light
  g.moveTo(...P(100, 20)).bezierCurveTo(...P(104, 30), ...P(105.6, 40), ...P(105.6, 48))
    .lineTo(...P(94.4, 48)).bezierCurveTo(...P(94.4, 40), ...P(96, 30), ...P(100, 20)).fill({ color: 0xffffff, alpha: 0.4 });

  // panel lines
  const panel = { color: 0x000000, width: 0.5, alpha: 0.22 };
  g.moveTo(...P(96, 92)).lineTo(...P(104, 92)).stroke(panel);
  g.moveTo(...P(95, 128)).lineTo(...P(105, 128)).stroke(panel);
  g.moveTo(...P(97, 150)).lineTo(...P(103, 150)).stroke(panel);

  // canopy: dark frame → tinted glass → highlight
  g.moveTo(...P(100, 50)).bezierCurveTo(...P(106.5, 55), ...P(106.5, 80), ...P(100, 86))
    .bezierCurveTo(...P(93.5, 80), ...P(93.5, 55), ...P(100, 50)).fill(0x0c1622);
  g.moveTo(...P(100, 53)).bezierCurveTo(...P(105, 57), ...P(105, 79), ...P(100, 83))
    .bezierCurveTo(...P(95, 79), ...P(95, 57), ...P(100, 53)).fill(0x6fd2ff);
  g.moveTo(...P(100, 55)).bezierCurveTo(...P(103.4, 58), ...P(103.8, 68), ...P(101.5, 73))
    .bezierCurveTo(...P(100, 69), ...P(99, 62), ...P(100, 55)).fill({ color: 0xffffff, alpha: 0.55 });

  // engine nozzles (dark housings + hot cores). SVG rect (x,y,w,h) → axis-aligned art rect (90° rotation).
  const nozzle = (rx: number, ry: number, rw: number, rh: number, col: number, alpha = 1) =>
    g.roundRect((100 - (ry + rh)) * ITC_S, (rx - 100) * ITC_S, rh * ITC_S, rw * ITC_S, 1.2 * ITC_S).fill({ color: col, alpha });
  nozzle(94, 167, 4.4, 11, 0x12161c);
  nozzle(101.6, 167, 4.4, 11, 0x12161c);
  nozzle(94.7, 169, 3, 7, burn, 0.85);
  nozzle(102.3, 169, 3, 7, burn, 0.85);

  // doctrine pip (agiwar camp cue) on the spine, behind the canopy
  const [px, py] = P(100, 104);
  g.circle(px, py, 1.5).fill({ color: acc, alpha: 0.25 });
  g.circle(px, py, 1.0).fill(acc);
}

// Fighter Jet "hypersonic dart": super-narrow, long needle nose, hard-swept delta wings with glowing tips,
// small canopy + V-tail, single centered afterburner. Faction-tinted; authored small (scaled again by footprint).
function drawFighterJet(g: Graphics, side: number, acc: number, banshee = false) {
  const m = unitPalette(side);
  const dark = banshee ? 0x15171b : m.steelDk;      // near-black charcoal hull for the Banshee
  const mid = banshee ? 0x24272d : m.steel;
  const light = banshee ? 0xccd0d6 : m.steelLt;     // bright silver nose/spine
  const accent = banshee ? 0xff2e2e : side;          // glowing wingtips (red for the Banshee)
  const canopyFrame = banshee ? 0x2a0709 : 0x0c1622;
  const canopy = banshee ? 0xff2e2e : 0x6fd2ff;
  const burn = banshee ? 0xff5a3c : 0xffd070;

  // afterburner bloom (single, centered behind the tail)
  g.ellipse(-10, 0, 3.0, 1.5).fill({ color: burn, alpha: 0.18 });

  // hard-swept delta wings (dark) + lit upper faces
  g.poly([2.5, -0.8, -4.5, -6.6, -6.5, -6.0, -2.0, -1.0]).fill(dark);
  g.poly([2.5, 0.8, -4.5, 6.6, -6.5, 6.0, -2.0, 1.0]).fill(dark);
  g.poly([2.2, -0.7, -4.1, -6.0, -5.6, -5.6, -1.9, -0.95]).fill({ color: mid, alpha: 0.9 });
  g.poly([2.2, 0.7, -4.1, 6.0, -5.6, 5.6, -1.9, 0.95]).fill({ color: mid, alpha: 0.9 });
  // glowing wingtips (accent)
  g.poly([-4.5, -6.6, -6.5, -6.0, -5.5, -5.2]).fill(accent);
  g.poly([-4.5, 6.6, -6.5, 6.0, -5.5, 5.2]).fill(accent);
  g.circle(-5.3, -5.9, 0.7).fill({ color: tint(accent, 0.5), alpha: 0.9 });
  g.circle(-5.3, 5.9, 0.7).fill({ color: tint(accent, 0.5), alpha: 0.9 });

  // small V-tail fins at the rear
  g.poly([-6.5, -0.4, -9, -2.0, -7.6, -0.2]).fill(dark);
  g.poly([-6.5, 0.4, -9, 2.0, -7.6, 0.2]).fill(dark);

  // slender fuselage + long needle nose
  g.poly([6, -1.15, -7, -1.25, -9, 0, -7, 1.25, 6, 1.15]).fill(mid);
  g.poly([13.5, 0, 6, -1.0, 6, 1.0]).fill(light);                        // needle nose (bright)
  g.poly([13.5, 0, 6, -1.0, 6, 0]).fill({ color: 0xffffff, alpha: 0.5 }); // nose rim light (one edge)
  g.poly([9, 0, -6, -0.5, -6, 0.5]).fill({ color: light, alpha: 0.6 });   // spine highlight

  // canopy: long thin tinted teardrop
  g.ellipse(3.4, 0, 3.0, 0.95).fill(canopyFrame);
  g.ellipse(3.4, 0, 2.5, 0.72).fill(canopy);
  g.ellipse(4.1, 0, 1.0, 0.32).fill({ color: 0xffffff, alpha: 0.5 });

  // single centered engine nozzle + hot core
  g.roundRect(-9.6, -0.9, 2.0, 1.8, 0.6).fill(0x12161c);
  g.ellipse(-8.9, 0, 1.4, 0.8).fill({ color: burn, alpha: 0.9 });

  // doctrine pip on the spine
  g.circle(-1.2, 0, 0.85).fill({ color: acc, alpha: 0.25 });
  g.circle(-1.2, 0, 0.55).fill(acc);
}

// Heavy Gunship: a big twin-boom hull — central fuselage pod + canopy, broad swept wings with cyan tips,
// two long engine booms joined by a rear crossbar, and a BIG rear-facing autocannon barrel (points aft, −x).
function drawHeavyGunship(g: Graphics, side: number, acc: number) {
  const m = unitPalette(side);
  const dark = m.steelDk, mid = m.steel, light = m.steelLt;
  const accent = 0x6fd2ff;  // cyan tech accents
  const exhaust = 0x8fe6ff; // engine glow

  // twin engine exhausts (rear, glowing) — behind everything
  for (const sy of [-7, 7]) {
    g.ellipse(-15.5, sy, 3.4, 2.3).fill({ color: exhaust, alpha: 0.2 });
    g.ellipse(-14.8, sy, 1.8, 1.2).fill({ color: exhaust, alpha: 0.85 });
  }
  // broad swept wings (dark) + lit faces + cyan tips
  g.poly([4, -2, -2, -13.5, -4.5, -13, -3, -2.5]).fill(dark);
  g.poly([4, 2, -2, 13.5, -4.5, 13, -3, 2.5]).fill(dark);
  g.poly([3.4, -1.9, -1.6, -12.3, -3.6, -12, -2.6, -2.2]).fill({ color: mid, alpha: 0.9 });
  g.poly([3.4, 1.9, -1.6, 12.3, -3.6, 12, -2.6, 2.2]).fill({ color: mid, alpha: 0.9 });
  g.poly([-2, -13.5, -4.5, -13, -3.4, -11.6]).fill(accent);
  g.poly([-2, 13.5, -4.5, 13, -3.4, 11.6]).fill(accent);

  // twin booms + rear crossbar (the twin-boom hull)
  for (const sy of [-7, 7]) {
    g.roundRect(-15, sy - 1.35, 21, 2.7, 1.1).fill(dark);
    g.roundRect(-15, sy - 1.35, 21, 1.0, 1.0).fill({ color: light, alpha: 0.32 }); // top sheen
    g.circle(6, sy, 1.45).fill(mid); // boom nose cap
  }
  g.roundRect(-15.6, -7, 2.7, 14, 1).fill(dark); // crossbar linking the boom tails

  // big-caliber REAR autocannon (points aft, −x)
  g.roundRect(-17.5, -1.1, 6, 2.2, 0.6).fill(tint(m.gun, 0.06));
  g.circle(-17.5, 0, 1.2).fill(0x0b0e11);

  // central fuselage pod + pointed nose + spine
  g.ellipse(1, 0, 11, 3.3).fill(mid).stroke(UNIT_LN);
  g.poly([13.8, 0, 6, -1.8, 6, 1.8]).fill(light);
  g.poly([13.8, 0, 6, -1.8, 6, 0]).fill({ color: 0xffffff, alpha: 0.4 });
  g.ellipse(-1, 0, 8, 2.1).fill({ color: light, alpha: 0.4 });
  g.rect(-7, -0.9, 3.2, 1.8).fill(accent); // rear cyan accent bar

  // canopy (cyan teardrop, front)
  g.ellipse(5, 0, 2.8, 1.5).fill(0x0c1622);
  g.ellipse(5, 0, 2.2, 1.1).fill(accent);
  g.ellipse(5.6, 0, 1.0, 0.5).fill({ color: 0xffffff, alpha: 0.5 });

  // doctrine pip
  g.circle(-3, 0, 1.0).fill({ color: acc, alpha: 0.25 });
  g.circle(-3, 0, 0.62).fill(acc);
}

// The LIT TOP CAP: the finest detail, drawn on the apex layer only (FORWARD = +x so the
// barrel/rifle/camera point along heading once the layer is rotated). The chassis volume
// itself is sculpted by the stacked cross-sections below — this is just the crown.
function drawBody(g: Graphics, type: UnitType, side: number, ln: { color: number; width: number; alpha: number }, acc: number) {
  const m = unitPalette(side);
  const rim = { color: side, width: 0.9, alpha: 0.85 }; // team rim light along the lit edge
  const pip = (x: number, y: number, r: number) => { g.circle(x, y, r + 0.7).fill({ color: acc, alpha: 0.25 }); g.circle(x, y, r).fill(acc); g.circle(x, y, r).stroke({ color: tint(acc, 0.5), width: 0.5, alpha: 0.8 }); };
  const fam = famOf(type); // summon types share an art family (e.g. mammoth/siege → "tank")

  if (type === "interceptor") { drawInterceptor(g, side, acc); return; } // dedicated high-quality sprite
  if (isDartShape(type)) { drawFighterJet(g, side, acc, type === "nod_interceptor"); return; } // hypersonic dart (Banshee = red)
  if (type === "nod_dronewing") { drawHeavyGunship(g, side, acc); return; } // twin-boom heavy gunship

  if (fam === "tank") { // modern MBT: angular turret, thermal-sleeved gun w/ muzzle brake, bustle, cupola, sight
    const turret = [-9, -3.4, -6.6, -5, 4, -5, 7, -2.3, 7, 2.3, 4, 5, -6.6, 5, -9, 3.4];
    g.roundRect(-11.2, -3.7, 3.2, 7.4, 0.7).fill(m.steelDkr); // stowage bustle (rear)
    for (let i = -3; i <= 3; i += 1.4) g.rect(-11, i - 0.1, 2.8, 0.5).fill({ color: 0x000000, alpha: 0.28 }); // mesh
    g.poly(turret).fill(m.steel).stroke(ln); // angular turret top
    g.poly([-6.4, -4.6, 3.6, -4.6, 6.2, -2.1, 4.2, -1.4, -6.4, -1.4]).fill({ color: m.steelLt, alpha: 0.6 }); // top-lit sheen
    g.roundRect(4.6, -2.7, 4.2, 5.4, 1).fill(m.steelDk).stroke(ln); // mantlet
    g.rect(7, -3.5, 7.5, 1).fill(tint(m.gun, -0.08)); // coaxial MG
    g.rect(8, -1.75, 11.5, 3.5).fill(m.gun); g.rect(8, -1.75, 11.5, 1).fill({ color: m.gunLt, alpha: 0.6 }); // thermal sleeve + glint
    g.rect(19, -1.2, 4, 2.4).fill(tint(m.gun, 0.05)); // barrel
    g.roundRect(22.6, -1.7, 2.6, 3.4, 0.6).fill(tint(m.gun, 0.12)); g.circle(24.2, 0, 0.95).fill(0x0b0e11); // muzzle brake + bore
    g.circle(-2.6, 1.7, 2.1).fill(m.steelLt).stroke(ln); g.arc(-2.6, 1.7, 2.1, -1, 1).fill({ color: tint(m.steelLt, 0.25), alpha: 0.5 }); g.circle(-2.6, 1.7, 0.85).fill(m.steelDk); // commander cupola
    g.roundRect(0, -3.5, 3, 2.5, 0.6).fill(m.steelDk).stroke(ln); g.circle(2.5, -2.3, 0.85).fill(side); // gunner's sight + team lens
    for (const sy of [-3.4, 3.4]) for (let k = 0; k < 3; k++) g.rect(1.8 + k * 1.1, sy - 0.45, 0.9, 0.9).fill(tint(m.gun, 0.06)); // smoke launchers
    g.rect(-7, -4.7, 0.7, 5).fill(m.gun); // antenna
    g.poly([-9, -3.4, -6.6, -5, 4, -5, 7, -2.3]).stroke(rim); // team rim
    pip(-0.6, 0, 1.5); // doctrine
  } else if (fam === "humvee") { // armored recon truck: raked windshield, roof RWS w/ MG, antennas, stowage
    g.roundRect(-8, -5, 15, 10, 2.5).fill(m.steel).stroke(ln); // roof/body
    g.roundRect(-7, -4.3, 5.5, 8.6, 1.6).fill({ color: m.steelLt, alpha: 0.42 }); // sheen
    g.roundRect(7, -4.4, 3.6, 8.8, 1.2).fill(tint(m.steel, -0.1)); // hood (front)
    g.roundRect(4.4, -4, 3, 8, 1).fill(m.glass); g.rect(4.5, -4, 0.7, 8).fill({ color: side, alpha: 0.5 }); // raked windshield + team glint
    g.roundRect(-7.6, -3.6, 3, 7.2, 0.6).fill(m.steelDkr); for (let i = -3; i <= 3; i += 1.5) g.rect(-7.4, i - 0.1, 2.6, 0.5).fill({ color: 0x000000, alpha: 0.24 }); // roof stowage
    g.circle(-1, 0, 2.7).fill(m.steelDk).stroke(ln); g.roundRect(-3.3, -1.5, 3, 3, 0.6).fill(tint(m.steelDk, 0.05)); // RWS ring + ammo can
    g.rect(1, -0.75, 9, 1.5).fill(m.gun); g.rect(10, -0.55, 2.6, 1.1).fill(tint(m.gun, 0.08)); // MG barrel (forward)
    g.rect(-6, -5.7, 0.7, 4).fill(m.gun); g.rect(-4, -5.3, 0.7, 3.4).fill(m.gun); // antennas
    g.circle(6.2, -3.5, 0.7).fill(side); // marker light
    pip(-4.7, 0, 1.3);
  } else if (fam === "gunner") { // modern infantryman: plate carrier, ruck, NVG helmet (carbine = drawGunnerWeapon, at chest height)
    g.roundRect(-4, -2.4, 3, 4.8, 1).fill(m.steelDkr); // ruck (rear)
    g.roundRect(-2.2, -3, 4.8, 6, 2).fill(m.steel).stroke(ln); g.roundRect(-2, -2.6, 2.1, 5.2, 1).fill({ color: m.steelLt, alpha: 0.5 }); // plate carrier / shoulders
    g.circle(0.7, 0, 2.7).fill(m.steelLt).stroke(ln); g.arc(0.7, 0, 2.7, -1.1, 1.1).fill({ color: tint(m.steelLt, 0.3), alpha: 0.5 }); // helmet
    g.roundRect(2.7, -0.9, 1.5, 1.8, 0.5).fill(m.steelDk); // NVG mount (front)
    g.circle(-1.5, -2.5, 0.65).fill(side); // shoulder IR strobe
    pip(0.7, -0.2, 0.95);
  } else if (fam === "drone") { // sleek quad: X-frame, motor nacelles + prop-blur discs, gimbal cam, LEDs
    for (const [rx, ry] of [[6.5, 6.5], [6.5, -6.5], [-6.5, 6.5], [-6.5, -6.5]]) g.moveTo(0, 0).lineTo(rx, ry).stroke({ color: tint(m.steel, -0.2), width: 2.2 });
    for (const [rx, ry] of [[6.5, 6.5], [6.5, -6.5], [-6.5, 6.5], [-6.5, -6.5]]) {
      g.circle(rx, ry, 3).fill({ color: side, alpha: 0.16 }); g.circle(rx, ry, 3).stroke({ color: tint(side, 0.3), width: 0.8, alpha: 0.6 }); // prop-blur disc
      g.circle(rx, ry, 1.4).fill(m.steelDk); // motor nacelle
    }
    g.roundRect(-3.5, -2.7, 7, 5.4, 2).fill(m.steel).stroke(ln); g.roundRect(-2.7, -2.1, 3, 4.2, 1).fill({ color: m.steelLt, alpha: 0.45 }); // fuselage
    g.circle(3.2, 0, 1.6).fill(m.glass); g.circle(3.4, 0, 0.75).fill({ color: side, alpha: 0.85 }); // gimbal camera (forward)
    g.circle(-2.5, -1.7, 0.6).fill(acc); g.circle(-2.5, 1.7, 0.6).fill(side); // status LEDs
  } else if (fam === "jet") { // swept-wing fighter: pointed nose (+x), delta wings, canted twin tails, afterburner
    const sh = planeSharp(type); // faster → sharper/narrower, slower → wider/blunter
    const span = planeSpan(sh);    // wingtip half-span: very wide when slow, tucked when fast
    const rootY = 3.6 - 2.7 * sh;  // wing-root width: broad delta when slow, pinched when fast
    const tipX = planeTipX(sh);    // wingtips: near-straight when slow → hard-swept back when fast
    const rootX = 3 - 1.5 * sh;    // wing root sits forward when slow (stubbier planform)
    const noseX = 9 + 7 * sh;      // short blunt nose when slow → long pointed nose when fast
    const fw = 3.3 - 1.5 * sh;     // fuselage half-width: fat when slow, slim when fast
    g.poly([tipX, -span, rootX, -rootY, rootX, rootY, tipX, span]).fill(m.steelDk).stroke(ln); // delta wings (rear)
    g.poly([noseX, 0, -3, -fw, -7.5, -1.5, -7.5, 1.5, -3, fw]).fill(m.steel).stroke(ln); // fuselage w/ nose
    g.poly([noseX, 0, 3, -1.1, 3, 1.1]).fill({ color: m.steelLt, alpha: 0.7 }); // top-lit nose sheen
    g.poly([-6, -2.6, -9, -4.2, -7, -1.8]).fill(m.steelDk); g.poly([-6, 2.6, -9, 4.2, -7, 1.8]).fill(m.steelDk); // canted twin tails
    g.roundRect(2, -1, 4.4, 2, 0.8).fill(m.glass); g.circle(3.6, 0, 0.7).fill({ color: side, alpha: 0.9 }); // canopy + team glint
    g.circle(-7.2, 0, 1.5).fill(acc); g.circle(-8.6, 0, 1.1).fill({ color: 0xffd070, alpha: 0.9 }); // afterburner glow
    pip(-1.2, 0, 1.1); // doctrine
  } else if (fam === "gunship") { // attack helo: nose (+x), tail boom (−x), rotor disc, stub wings w/ pods, skids
    g.rect(-17, -1.1, 12, 2.2).fill(m.steelDk).stroke(ln); // tail boom
    g.poly([-16.5, -1, -20, -5.5, -15, 0.5]).fill(m.steelDk); // tail rotor fin
    g.roundRect(-2.4, -7.5, 4.8, 15, 1.4).fill(m.steelDk); // stub wings (span along y)
    for (const wy of [-6.6, 6.6]) { g.roundRect(-2, wy - 1.3, 6, 2.6, 0.9).fill(m.gun); g.circle(4.2, wy, 1).fill(acc); } // weapon pods + team tips
    g.ellipse(0, 0, 10, 5).fill(m.steel).stroke(ln); // fuselage
    g.poly([10.5, 0, 3.5, -3.3, 3.5, 3.3]).fill({ color: m.steelLt, alpha: 0.6 }); // nose taper sheen
    g.ellipse(5.2, 0, 3, 2.1).fill(m.glass); g.circle(6.1, 0, 0.85).fill({ color: side, alpha: 0.85 }); // cockpit canopy + team glint
    g.rect(-7, 6.6, 14, 1.2).fill(m.gun); g.rect(-7, -7.8, 14, 1.2).fill(m.gun); // skids
    g.circle(0, 0, 1.7).fill(m.steelLt).stroke(ln); // rotor hub (blades are a separate spinning overlay)
    pip(-1, 0, 1.1); // doctrine
  } else if (fam === "mech") { // bipedal battle mech: broad torso, cockpit, twin shoulder cannons (+x), back thrusters
    g.poly([-5, -6.5, -8, -3, -5, 0]).fill(m.steelDkr); g.poly([-5, 6.5, -8, 3, -5, 0]).fill(m.steelDkr); // back thrusters
    g.roundRect(-5, -6.5, 11, 13, 3).fill(m.steel).stroke(ln); // torso (broad along y)
    g.roundRect(-3, -3.4, 7, 6.8, 2).fill({ color: m.steelLt, alpha: 0.5 }); // chest sheen
    for (const sy of [-6.5, 6.5]) { g.roundRect(-1, sy - 1.7, 10, 3.4, 1).fill(m.gun); g.rect(8.5, sy - 0.9, 2.4, 1.8).fill(tint(m.gun, 0.1)); g.circle(7, sy, 0.9).fill(acc); } // shoulder cannons + muzzles
    g.roundRect(2.6, -2.2, 4, 4.4, 1.2).fill(m.glass); g.circle(4, 0, 0.95).fill({ color: side, alpha: 0.85 }); // cockpit + team glint
    pip(-0.6, 0, 1.3); // doctrine
  } else if (fam === "walker") { // artillery walker: small high body, very long railgun barrel (+x), splayed legs, sensor
    for (const [lx, ly, ex, ey] of [[-3, -4, -7, -8], [-3, 4, -7, 8], [2, -4.5, 5, -9], [2, 4.5, 5, 9]]) g.moveTo(lx, ly).lineTo(ex, ey).stroke({ color: tint(m.steelDk, 0.05), width: 2 }); // splayed legs
    g.ellipse(-1, 0, 5.5, 4.6).fill(m.steel).stroke(ln); // body pod
    g.ellipse(-2, -1, 3, 2.2).fill({ color: m.steelLt, alpha: 0.5 }); // sheen
    g.rect(2, -1.4, 18, 2.8).fill(m.gun); g.rect(2, -1.4, 18, 0.9).fill({ color: m.gunLt, alpha: 0.5 }); // long railgun
    g.roundRect(19.5, -1.9, 3, 3.8, 0.7).fill(tint(m.gun, 0.12)); g.circle(21, 0, 1).fill(0x0b0e11); // muzzle + bore
    g.rect(6, -2.3, 4, 1).fill(0x9fd0ff); g.rect(6, 1.3, 4, 1).fill(0x9fd0ff); // charge coils glow
    g.circle(-3.5, 0, 1.7).fill(m.steelDk); g.circle(-3.5, 0, 0.9).fill({ color: side, alpha: 0.85 }); // sensor
    pip(-1.5, 0, 1.1);
  } else if (fam === "tesla") { // tesla coil: ringed base, glowing orb, crackling arcs
    g.circle(0, 0, 5.5).fill(m.steel).stroke(ln); g.circle(0, 0, 4).fill(m.steelDk); // base ring
    for (let i = 0; i < 5; i++) { const ang = (i / 5) * TAU + 0.4; g.moveTo(0, -1).lineTo(Math.cos(ang) * 6, Math.sin(ang) * 6 - 1).stroke({ color: 0x9fe8ff, width: 1, alpha: 0.7 }); } // arcs
    g.circle(0, -1.5, 2.8).fill({ color: 0x4fb8ff, alpha: 0.5 }); g.circle(0, -1.5, 1.6).fill(0xeaffff); // glowing orb
    g.circle(0, 3.5, 0.9).fill(acc); // doctrine pip on base
  } else if (fam === "swarmling") { // small bio crawler: carapace, mandible head (+x), spindly legs
    for (const ly of [-3, 3]) { g.moveTo(0, ly).lineTo(3, ly + (ly < 0 ? -2.4 : 2.4)).stroke({ color: m.gun, width: 1 }); g.moveTo(-1.5, ly).lineTo(-3.5, ly + (ly < 0 ? -2.2 : 2.2)).stroke({ color: m.gun, width: 1 }); } // legs
    g.ellipse(-0.4, 0, 4.4, 3.2).fill(m.steel).stroke(ln); // carapace
    g.ellipse(-1.4, -0.4, 2, 1.4).fill({ color: acc, alpha: 0.55 }); // glowing back sac
    g.poly([4.6, 0, 2.2, -1.8, 2.2, 1.8]).fill(m.steelDk); g.circle(5, 0, 0.7).fill({ color: side, alpha: 0.9 }); // mandible head + eye
  } else if (fam === "orb") { // floating gravity well: dark void core, bright rim, accretion ring + debris
    g.ellipse(0, 0, 11, 3.4).stroke({ color: 0x9b30ff, width: 1.3, alpha: 0.7 }); // accretion ring
    for (let i = 0; i < 4; i++) { const a2 = (i / 4) * TAU; g.circle(Math.cos(a2) * 11, Math.sin(a2) * 3.4, 0.9).fill(0xc9a0ff); } // ring debris
    g.circle(0, 0, 6.2).fill(0x140a22).stroke({ color: 0x9b30ff, width: 1.3, alpha: 0.85 }); // void core
    g.circle(0, 0, 3.2).fill(0x2a1248); g.circle(-1.6, -1.6, 1.5).fill({ color: 0xc9a0ff, alpha: 0.6 }); // inner + highlight
  } else { // automated defense turret: angular head, twin autocannon, sensor dome, ammo drum
    const head = [-6, -4, 2, -4.4, 5, -2, 5, 2, 2, 4.4, -6, 4];
    g.poly(head).fill(m.steel).stroke(ln);
    g.poly([-5.6, -3.4, 1.6, -3.6, 4, -1.6, -5.6, -1.6]).fill({ color: m.steelLt, alpha: 0.5 });
    g.rect(4, -2.3, 12, 1.6).fill(m.gun); g.rect(4, 0.7, 12, 1.6).fill(m.gun); g.rect(4, -2.3, 12, 0.6).fill({ color: m.gunLt, alpha: 0.5 }); // twin barrels
    g.rect(15.5, -2.3, 2.6, 1.6).fill(tint(m.gun, 0.1)); g.rect(15.5, 0.7, 2.6, 1.6).fill(tint(m.gun, 0.1)); // muzzles
    g.circle(-3.6, -3.2, 1.8).fill(tint(m.steelDk, 0.05)); // ammo drum
    g.circle(-2, 0, 1.9).fill(m.steelDk); g.circle(-2, 0, 1).fill({ color: side, alpha: 0.85 }); // sensor dome + team lens
    g.poly([-6, -4, 2, -4.4, 5, -2]).stroke(rim);
    pip(-2.6, 2.7, 1.1);
  }
}

// The gunner's carbine — drawn on a MID-HEIGHT layer (chest, where the hands are) instead of the
// apex, so the rifle reads as held across the body rather than poking out of the helmet. forward = +x.
// rocket trooper: a launcher tube over EACH shoulder (both sides), pointing forward (+x), at chest height.
function drawRocketWeapon(g: Graphics, side: number) {
  const m = unitPalette(side);
  const tube = tint(m.gun, 0.06);
  for (const sy of [-2.3, 2.3]) {
    g.roundRect(-1.4, sy - 0.75, 7, 1.5, 0.7).fill(tube); // launcher tube
    g.rect(-2.6, sy - 0.9, 1.5, 1.8).fill(m.gunLt); // rear grip/block
    g.circle(5.6, sy, 0.9).fill(0x12161c); // muzzle bore
    g.circle(5.6, sy, 0.9).stroke({ color: tint(side, 0.4), width: 0.4, alpha: 0.8 }); // team ring
  }
}
function drawGunnerWeapon(g: Graphics, side: number) {
  const m = unitPalette(side);
  const gy = -1.6; // shouldered slightly to one side
  g.rect(-2.8, gy - 0.4, 3.8, 1.4).fill(tint(m.gun, -0.05)); // stock + receiver
  g.rect(1, gy - 0.35, 8, 1.25).fill(m.gun); // handguard / barrel
  g.roundRect(2.1, gy - 1.4, 2.5, 1.2, 0.4).fill(m.gunLt); // optic
  g.rect(4.6, gy + 0.9, 1.2, 1.7).fill(tint(m.gun, -0.1)); // foregrip
  g.roundRect(9, gy - 0.7, 2.7, 1.7, 0.7).fill(tint(m.gun, 0.1)); // suppressor
}

// Cross-section of the unit at height fraction t (0 = ground, 1 = apex). Varying the shape
// with t SCULPTS a real 3D volume out of the stack: a tank rises tracks → hull → angular turret,
// a soldier rises legs → plate-carrier torso → helmet, a turret tapers tower → head. forward = +x.
function drawSilhouette(g: Graphics, type: UnitType, side: number, t: number) {
  const lvl = -0.62 + Math.pow(t, 0.8) * 0.92; // ambient-occluded base → bright key-lit apex (eased) for a stronger sculpted volume
  const m = unitPalette(side);
  const body = tint(m.steel, lvl);
  const trk = tint(m.rubber, lvl * 0.45);
  const fam = famOf(type); // summon types share an art family
  if (isDartShape(type)) { // dart (fighter jets + Banshee): underside planform (unitArt insets it)
    g.poly([13.5, 0, -4.5, -6.6, -6.5, -6.0, -9, 0, -6.5, 6.0, -4.5, 6.6]).fill(body);
  } else if (type === "interceptor") { // underside planform (unitArt insets it)
    g.poly(itcPolyS(1, 100, 20, 180, 152, 153, 166, 133, 182, 100, 178, 67, 182, 47, 166, 20, 152)).fill(body);
  } else if (type === "nod_dronewing") { // heavy gunship underside: fuselage + wings + twin booms (unitArt insets it)
    g.ellipse(1, 0, 11, 3.3).fill(body);
    g.poly([4, -2, -2, -13.5, -4.5, -13, -3, -2.5]).fill(body);
    g.poly([4, 2, -2, 13.5, -4.5, 13, -3, 2.5]).fill(body);
    for (const sy of [-7, 7]) g.roundRect(-15, sy - 1.35, 21, 2.7, 1.1).fill(body);
    g.roundRect(-15.6, -7, 2.7, 14, 1).fill(body);
  } else if (fam === "tank") {
    if (t < 0.16) { // running gear + side skirts (widest, sloped glacis front)
      g.poly([-10.5, -7.6, 6, -7.6, 11, -4, 11, 4, 6, 7.6, -10.5, 7.6, -12, 3.6, -12, -3.6]).fill(trk); // track shoes
      g.poly([-9.6, -6, 6.5, -6, 10, -3, 10, 3, 6.5, 6, -9.6, 6]).fill(body); // hull pan
    } else if (t < 0.5) { // hull + glacis
      g.poly([-9.6, -6, 6, -6, 10, -3, 10, 3, 6, 6, -9.6, 6]).fill(body);
    } else if (t < 0.64) { // turret ring
      g.poly([-8, -5, 5, -5.5, 7.5, -2.5, 7.5, 2.5, 5, 5.5, -8, 5]).fill(body);
    } else { // angular turret, narrowing, with rear bustle
      const s = 1 - (t - 0.64) * 0.7;
      g.poly([-9.5 * s, -3.6 * s, -6.6 * s, -5 * s, 4 * s, -5 * s, 7 * s, -2.4 * s, 7 * s, 2.4 * s, 4 * s, 5 * s, -6.6 * s, 5 * s, -9.5 * s, 3.6 * s]).fill(body);
    }
  } else if (fam === "humvee") {
    if (t < 0.3) { // wheels + lower chassis
      for (const [wx, wy] of [[-6, -6.6], [6, -6.6], [-6, 6.6], [6, 6.6]]) g.circle(wx, wy, 2.9).fill(trk);
      g.poly([-9, -5.6, 7, -5.6, 10, -2.6, 10, 2.6, 7, 5.6, -9, 5.6]).fill(body);
    } else if (t < 0.56) { // hood line + body
      g.poly([-9, -5.5, 10, -5, 10, 5, -9, 5.5]).fill(body);
    } else { // armored cabin (set back from the hood)
      g.roundRect(-8, -5, 13.5, 10, 2.5).fill(body);
    }
  } else if (fam === "gunner") {
    if (t < 0.34) g.roundRect(-1.7, -1.6, 3.4, 3.2, 1.2).fill(body); // hips/pelvis (legs are an animated overlay)
    else if (t < 0.7) { g.roundRect(-3.6, -3.4, 4.8, 6.8, 2).fill(tint(body, -0.1)); g.roundRect(-1.8, -3, 5.4, 6, 2.2).fill(body); } // ruck + torso/armor
    else if (t < 0.86) g.roundRect(-1.9, -3.4, 5, 6.8, 2.4).fill(body); // shoulders
    else { const s = 1 - (t - 0.86) * 0.4; g.circle(0.6, 0, 2.6 * s).fill(body); } // helmet
  } else if (fam === "drone") {
    g.circle(0, 0, 3.3 - t * 1.0).fill(body);
  } else if (fam === "jet") { // flat wing plane at the base, thin fuselage spine above
    const sh = planeSharp(type); // faster → sharper/narrower, slower → wider/blunter (matches drawBody)
    const span = 10 - 6.8 * sh;  // wingtip half-span at the base: 10 (wide, slow) → 3.2 (fast)
    const rearX = -6 - 4 * sh;   // wingtips swept further back when fast
    const noseX = 9 + 7 * sh;    // short blunt nose when slow → long pointed nose when fast
    if (t < 0.5) g.poly([noseX, 0, -3, -0.85 * span, rearX, -span, rearX, span, -3, 0.85 * span]).fill(body); // wings + nose
    else { const s = 1 - (t - 0.5) * 0.9; g.poly([(noseX - 2) * s, 0, -7 * s, -1.8 * s, -7 * s, 1.8 * s]).fill(body); } // fuselage spine
  } else if (fam === "gunship") { // fuselage + tail boom low, narrowing cabin, rotor mast at apex
    if (t < 0.55) { g.ellipse(0, 0, 9.5 - t * 2, 4.6 - t).fill(body); g.rect(-17, -1.3, 12, 2.6).fill(body); } // fuselage + tail boom
    else if (t < 0.82) { const s = 1 - (t - 0.55) * 0.8; g.ellipse(0.5, 0, 6 * s, 3 * s).fill(body); } // cabin roof
    else g.circle(0, 0, 1.6).fill(body); // rotor mast hub
  } else if (fam === "mech") { // legs → broad torso → head
    if (t < 0.32) { for (const ly of [-3.6, 3.6]) g.roundRect(-2.2, ly - 1.7, 7, 3.4, 1).fill(body); } // striding legs
    else if (t < 0.82) g.roundRect(-5, -6.5, 11, 13, 3).fill(body); // torso
    else { const s = 1 - (t - 0.82) * 0.5; g.roundRect(-2.6 * s, -2.6 * s, 5.2 * s, 5.2 * s, 1.4 * s).fill(body); } // head
  } else if (fam === "walker") { // splayed legs → small body pod → barrel mount
    if (t < 0.4) { g.ellipse(-1, 0, 7 - t * 4, 5.4 - t * 2).fill(body); }
    else { const s = 1 - (t - 0.4) * 0.5; g.ellipse(-1, 0, 5.4 * s, 4.4 * s).fill(body); }
  } else if (fam === "tesla") { // pedestal → coil → orb
    if (t < 0.4) { const s = 1 - t * 0.4; g.circle(0, 0, 5.5 * s).fill(body); }
    else { const s = 1 - (t - 0.4) * 0.5; g.circle(0, -t * 2, 2.8 * s).fill(body); }
  } else if (fam === "swarmling") { // little rounded carapace
    g.circle(0, 0, 3.6 - t * 1.6).fill(body);
  } else if (fam === "orb") { // floating sphere
    g.circle(0, 0, Math.max(0, 6.2 - Math.abs(t - 0.5) * 8)).fill(body);
  } else { // turret: sloped pedestal → neck → head housing
    if (t < 0.4) { const s = 1 - t * 0.3; g.circle(0, 0, 7 * s).fill(body); }
    else if (t < 0.6) g.circle(0, 0, 4.4).fill(tint(body, -0.1));
    else { const s = 1 - (t - 0.6) * 0.4; g.roundRect(-5 * s, -4.2 * s, 11 * s, 8.4 * s, 2 * s).fill(body); }
  }
}
const UNIT_HEIGHT: Record<string, number> = { tank: 11, turret: 14, humvee: 9, gunner: 11, drone: 3, jet: 5, gunship: 8, mech: 13, walker: 12, tesla: 10, swarmling: 4, orb: 8 };
// hover lift per family (flyers float well above ground); ground units sit near 2.
const UNIT_LIFT: Record<string, number> = { drone: 14, jet: 18, gunship: 15, orb: 14 };

// per-FAMILY dimensions (footprint scale, ring radius, hover lift, z-stack height), then everything
// is multiplied by the unit's render scale (u.scale) so elites visibly tower / swarms read as small.
const FOOT: Record<string, { x: number; y: number }> = { tank: { x: 1.6, y: 1.55 }, humvee: { x: 1.5, y: 1.48 } };
function unitDims(u: StateMsg["units"][number]) {
  const fam = famOf(u.unit);
  const sc = u.scale ?? 1;
  const dart = isDart(u.unit);                  // Fighter Jet: small dart sprite (they fly in pairs)
  const banshee = u.unit === "nod_interceptor"; // Banshee: a slightly larger red dart
  const fp0 = dart ? { x: 0.72, y: 0.72 } : banshee ? { x: 0.9, y: 0.9 } : (FOOT[fam] ?? { x: 1, y: 1 });
  const fp = { x: fp0.x * sc, y: fp0.y * sc };
  const rad = Math.round((fam === "tank" || fam === "turret" ? 10 : 8) * (fp.x + fp.y) / 2);
  const H = (fam === "jet" || fam === "gunship") ? 1 : (UNIT_HEIGHT[fam] ?? 8); // all aircraft render flat — no z-stack slab under the body
  return { fp, rad, lift: (UNIT_LIFT[fam] ?? 2) * sc, H, sc };
}
const UNIT_LN = { color: 0x05080b, width: 1, alpha: 0.55 };
// unit BODY color = faction (Anthropic orange / OpenAI light grey); GLOW = allegiance (green ally / red enemy).
const factionColorOf = (u: StateMsg["units"][number], s: StateMsg): number => FACTION_META[((s.factions?.[u.owner] ?? "anthropic") as Faction)].color;
const GLOW_OWN = 0x37e07a, GLOW_ENEMY = 0xff4646; // ground-glow: allied = green, enemy = red

// CHEAP per-tick bits (cleared + redrawn each state — a handful of shapes). The expensive z-stack
// geometry below is built ONCE and only rotated, so we don't churn thousands of Graphics per second.
function drawUnitBase(g: Graphics, u: StateMsg["units"][number], s: StateMsg) {
  g.clear();
  const { fp, rad } = unitDims(u);
  const ult = u.scale != null; // ULTIMATE-spawned unit → bright purple ring (below)
  const glow = u.owner === s.you ? GLOW_OWN : GLOW_ENEMY; // ground glow = allegiance (green ally / red enemy)
  const body = factionColorOf(u, s); // faction color (for the turret pedestal)
  // soft DIRECTIONAL contact shadow (key light upper-left → shadow falls down-right), layered for a
  // blurred penumbra → tight contact core, so the unit reads as grounded rather than a flat disc.
  g.ellipse(2.4, 5, 13 * fp.x, 5.2 * fp.y).fill({ color: 0x000000, alpha: 0.14 }); // outer penumbra
  g.ellipse(1.4, 4, 10 * fp.x, 4.2 * fp.y).fill({ color: 0x000000, alpha: 0.2 });
  g.ellipse(0.6, 3, 7.5 * fp.x, 3.2 * fp.y).fill({ color: 0x000000, alpha: 0.26 }); // contact core
  // ALLEGIANCE GROUND GLOW — every unit (allied = green, enemy = red)
  g.ellipse(0, 1, rad + 13, (rad + 13) * 0.5).fill({ color: glow, alpha: ult ? 0.22 : 0.14 });
  g.ellipse(0, 1, rad + 6, (rad + 6) * 0.5).fill({ color: glow, alpha: ult ? 0.32 : 0.22 });
  // ULTIMATE units: a bright PURPLE ring around the outside (both armies)
  if (ult) {
    const PR = 0xc24bff, pulse = 0.5 + 0.5 * Math.sin(s.tick / 5), rr = rad + 14 + 2 * pulse;
    g.ellipse(0, 1, rr + 3, (rr + 3) * 0.5).fill({ color: PR, alpha: 0.1 + 0.08 * pulse }); // soft halo
    g.ellipse(0, 1, rr, rr * 0.5).stroke({ color: PR, width: 2.8, alpha: 0.95 }); // crisp bright ring
  }
  if (famOf(u.unit) === "turret") g.ellipse(0, 3, 12, 6.5).fill(tint(body, -0.3)).stroke(UNIT_LN);
  if (pinned && pinned.id === u.id) g.ellipse(0, 1, rad + 9, (rad + 9) * 0.5).stroke({ color: 0xffffff, width: 1.5, alpha: 0.85 }); // selection ring
}
function drawUnitTop(g: Graphics, u: StateMsg["units"][number], s: StateMsg) {
  g.clear();
  const { rad, lift, H, sc } = unitDims(u);
  const topY = lift + H * 1.3 * sc + rad * 0.4;
  const frac = Math.max(0, u.hp / u.maxHp); // hp bar persists on every unit, green→yellow→orange→red
  g.rect(-rad, -topY - 6.5, rad * 2, 2.6).fill({ color: 0x05080b, alpha: 0.6 }); // track
  g.rect(-rad, -topY - 6.5, frac * rad * 2, 2.6).fill(hpColor(frac)); // spectrum fill
  if (u.overrideUntil > s.tick) g.circle(0, -topY, rad + 4).stroke({ color: 0xffd76b, width: 1.5, alpha: 0.5 + 0.5 * Math.sin(s.tick / 2) });
}

// Wide 4-arm helicopter rotor — drawn once, then SPUN each frame (see the animation ticker). Lives in an
// iso-squashed wrap at the apex so it reads as a top-down disc. Much larger area than the old r18 disc.
function drawRotor(g: Graphics, side: number) {
  const m = unitPalette(side);
  g.ellipse(0, 0, 30, 30).fill({ color: side, alpha: 0.06 }); // broad blur disc
  g.circle(0, 0, 28).stroke({ color: side, width: 2, alpha: 0.1 }); // faint tip-path ring
  const blade = { color: tint(m.steelLt, 0.2), width: 2, alpha: 0.6 };
  g.moveTo(-28, 0).lineTo(28, 0).stroke(blade);
  g.moveTo(0, -28).lineTo(0, 28).stroke(blade); // 4 arms
  g.circle(0, 0, 2).fill(m.steelLt); // hub cap
}
// Infantry legs — REDRAWN each frame with a stride phase so troops run while moving (feet together when idle).
// forward = +x (the ticker rotates the graphic to heading). The two legs swing fore/aft in anti-phase.
function drawRunLegs(g: Graphics, side: number, phase: number, moving: boolean) {
  g.clear();
  const col = tint(unitPalette(side).steel, -0.08);
  const amp = moving ? 2.6 : 0;
  const leg = (swing: number, ly: number) => g.roundRect(swing * amp - 1.7, ly - 1.0, 3.4, 2.0, 0.9).fill(col);
  leg(Math.sin(phase), -1.5);          // left leg
  leg(Math.sin(phase + Math.PI), 1.3); // right leg (anti-phase)
}

// Build a unit's STATIC art once (z-stack volume geometry + base/top placeholders). Returns the root
// container plus the rotatable layer graphics so the per-tick update can spin them to face heading
// without rebuilding geometry. A persistent holder carries the (eased) world position.
function unitArt(u: StateMsg["units"][number], s: StateMsg): { root: Container; rotors: Graphics[]; baseG: Graphics; topG: Graphics; spinner: Graphics | null; legsG: Graphics | null } {
  const cont = new Container();
  const ult = u.scale != null; // ULTIMATE-spawned unit → purple accents + purple ring (in drawUnitBase)
  const side = factionColorOf(u, s); // body = faction color (Anthropic orange / OpenAI light grey)
  const acc = ult ? 0xd6a8ff : u.camp ? DOCTRINE_COLOR[u.camp] : 0x9aa6b2;
  const fam = famOf(u.unit);
  const { fp, lift, H, sc } = unitDims(u);
  const baseG = new Graphics(); drawUnitBase(baseG, u, s); cont.addChild(baseG);

  // Volume via z-stacking: the iso footprint drawn many times, each ~1px higher (dark base → lit
  // top). Geometry is built ONCE; `rotors` are spun to heading each tick (no rebuild).
  const rotors: Graphics[] = [];
  const SP = 1.25 * sc; // layer spacing scales with the unit so big elites tower and swarms stay low
  for (let i = 0; i <= H; i++) {
    const t = i / H;
    const wrap = new Container();
    wrap.position.set(t * 1.6 * sc, -(lift + i * SP)); // screen-vertical rise + slight lit-side lean
    wrap.scale.set(1, 0.62); // iso ground squash
    const g = new Graphics();
    const inset = (fam === "jet" || fam === "gunship") && i !== H ? 0.82 : 1; // aircraft: tuck the single underside beneath the top sprite
    g.scale.set(fp.x * inset, fp.y * inset); // widen/lengthen the chassis (scaled in local space, then rotated to heading)
    if (i === H) drawBody(g, u.unit, side, UNIT_LN, acc); // lit, detailed top cap
    else drawSilhouette(g, u.unit, side, t); // sculpted volume
    if (u.unit === "gunner" && i === Math.round(H * 0.6)) drawGunnerWeapon(g, side); // carbine at chest height
    if ((u.unit === "rocket" || u.unit === "nod_rocket") && i === Math.round(H * 0.6)) drawRocketWeapon(g, side); // shoulder launchers
    rotors.push(g);
    wrap.addChild(g);
    cont.addChild(wrap);
  }

  // helicopter rotor: wide blades on an iso-squashed wrap at the apex, spun each frame by the animation ticker
  let spinner: Graphics | null = null;
  if (fam === "gunship" && u.unit !== "nod_dronewing") { // heavy gunship is a fixed-wing twin-boom, not a helicopter — no rotor
    const w = new Container(); w.position.set(1.6 * sc, -(lift + H * SP)); w.scale.set(1, 0.62);
    spinner = new Graphics(); spinner.scale.set(fp.x, fp.y); drawRotor(spinner, side);
    w.addChild(spinner); cont.addChild(w);
  }
  // infantry legs: an overlay at the feet, redrawn each frame with a stride phase while moving
  let legsG: Graphics | null = null;
  if (fam === "gunner") {
    const w = new Container(); w.position.set(0, -(lift + 0.2 * SP)); w.scale.set(1, 0.62);
    legsG = new Graphics(); legsG.scale.set(fp.x, fp.y); drawRunLegs(legsG, side, 0, false);
    w.addChild(legsG); cont.addChild(w);
  }

  const topG = new Graphics(); drawUnitTop(topG, u, s); cont.addChild(topG); // hp bar + override ring
  return { root: cont, rotors, baseG, topG, spinner, legsG };
}

// Cheap per-state refresh of an existing unit's art: rotate the prebuilt layers to the new heading
// and redraw only the small base/top graphics. No geometry rebuild → no per-frame allocation churn.
function updateUnitArt(v: UnitView, u: StateMsg["units"][number], s: StateMsg) {
  const heading = Math.atan2(u.dy, u.dx) + Math.PI / 4;
  for (const r of v.rotors) r.rotation = heading;
  if (v.baseG) drawUnitBase(v.baseG, u, s);
  if (v.topG) drawUnitTop(v.topG, u, s);
}

// ---- smooth unit movement: a persistent holder per unit id, eased toward the latest server cell ----
interface UnitView { holder: Container; art: Container | null; rotors: Graphics[]; baseG: Graphics | null; topG: Graphics | null; spinner: Graphics | null; legsG: Graphics | null; phase: number; pgx: number; pgy: number; gx: number; gy: number; tgx: number; tgy: number; vr: number; u: StateMsg["units"][number]; }
const unitViews = new Map<number, UnitView>();
const transientFx: Container[] = []; // bases/outposts/rally — rebuilt each state (no interpolation)

function placeHolder(e: UnitView, s: StateMsg) {
  e.holder.x = isoX(e.gx, e.gy);
  e.holder.y = isoY(e.gx, e.gy) - elevAt(e.gx, e.gy, s.seed, s.gridW, s.gridH);
  e.holder.zIndex = e.gx + e.gy;
}

function reconcileUnits(s: StateMsg) {
  const live = new Set<number>();
  const dyingNow = new Map<number, StateMsg["deaths"][number]>();
  for (const d of s.deaths ?? []) dyingNow.set(d.id, d);
  for (const u of s.units) {
    live.add(u.id);
    let e = unitViews.get(u.id);
    if (!e) {
      const holder = new Container();
      holder.eventMode = "static"; holder.cursor = "pointer";
      e = { holder, art: null, rotors: [], baseG: null, topG: null, spinner: null, legsG: null, phase: 0, pgx: u.x, pgy: u.y, gx: u.x, gy: u.y, tgx: u.x, tgy: u.y, vr: unitSight(u, s), u };
      const ev = e;
      holder.on("pointerover", () => { hovered = ev.u; updateReadout(); });
      holder.on("pointerout", () => { if (hovered?.id === ev.u.id) { hovered = null; updateReadout(); } });
      holder.on("pointertap", () => { pinned = ev.u; hovered = ev.u; unitTapped = true; updateReadout(); }); // click to pin inspect
      entityLayer.addChild(holder);
      unitViews.set(u.id, e);
      placeHolder(e, s); // place new units immediately (no glide from origin)
    }
    e.u = u; e.tgx = u.x; e.tgy = u.y; // server position is the glide target
    if (!e.art) { const a = unitArt(u, s); e.art = a.root; e.rotors = a.rotors; e.baseG = a.baseG; e.topG = a.topG; e.spinner = a.spinner; e.legsG = a.legsG; e.holder.addChild(a.root); } // build geometry ONCE
    updateUnitArt(e, u, s); // cheap per-state refresh: rotate to heading + redraw hp/ring (no rebuild)
    e.holder.scale.set(u.scale ?? 1); // ULTIMATE elites (mammoth/titan/crawler) render big
    e.holder.alpha = (u.disabledUntil ?? 0) > s.tick ? 0.55 : 1; // frozen by a Stasis Field
  }
  for (const [id, e] of unitViews) if (!live.has(id)) {
    const d = dyingNow.get(id);
    if (d && famOf(d.kind) === "gunner") startFallOver(e); // infantry: tip over + fade (keeps its art briefly)
    else if (d) { spawnDeathBlast(d.x, d.y, d.kind, d.scale ?? 1); e.holder.destroy({ children: true }); } // vehicle: explode w/ shrapnel
    else e.holder.destroy({ children: true }); // left vision (fog) — silent removal, no death FX
    unitViews.delete(id);
  }
}

// glide every holder toward its target cell each frame (frame-rate independent exponential ease)
const GLIDE_RATE = 9;
app.ticker.add(() => {
  if (!latestState) return;
  const s = latestState;
  const k = 1 - Math.exp(-Math.min(0.05, app.ticker.deltaMS / 1000) * GLIDE_RATE);
  for (const e of unitViews.values()) {
    e.gx += (e.tgx - e.gx) * k;
    e.gy += (e.tgy - e.gy) * k;
    e.vr += (unitSight(e.u, s) - e.vr) * k; // ease vision radius (high-ground changes it)
    placeHolder(e, s);
  }
  rebuildVisionMask(); // shroud glides with the eased unit positions + radii
});

// per-frame character animation: spin helicopter rotors continuously; run infantry legs while moving.
const ROTOR_SPD = 0.55; // radians per ~16ms frame (fast blade spin)
const RUN_RATE = 0.022; // stride phase advance per ms while moving
app.ticker.add(() => {
  if (!latestState) return;
  const s = latestState, dt = app.ticker.deltaMS;
  for (const e of unitViews.values()) {
    const moved = Math.hypot(e.gx - e.pgx, e.gy - e.pgy);
    e.pgx = e.gx; e.pgy = e.gy;
    if (e.spinner) e.spinner.rotation += ROTOR_SPD * (dt / 16.67);
    if (e.legsG) {
      const moving = moved > 0.02;
      if (moving) { // stride while gliding
        e.phase += RUN_RATE * dt;
        e.legsG.rotation = Math.atan2(e.u.dy, e.u.dx) + Math.PI / 4; // stride axis follows heading
        drawRunLegs(e.legsG, factionColorOf(e.u, s), e.phase, true);
      } else if (e.phase !== 0) { // just stopped → settle to a standing pose once, then idle (no per-frame redraw)
        e.phase = 0;
        drawRunLegs(e.legsG, factionColorOf(e.u, s), 0, false);
      }
    }
  }
});

// how each army upgrade modifies the inspected unit (income is economy-wide, not per-unit). Reuses
// the upgrades-panel UP_ICON for visual consistency.
const hex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;

function updateReadout() {
  const u = pinned ?? hovered; // pinned (clicked) takes precedence and persists
  if (!u || !latestState) { readoutEl.innerHTML = `<span class="sub">hover a unit to inspect · click to pin</span>`; return; }
  const s = latestState, st = UNIT_STATS[u.unit];
  const mine = u.owner === s.you;
  const b = mine ? s.bonuses : { income: 0, range: 0, hp: 0, damage: 0, armor: 0, speed: 0 }; // we only know OUR upgrades
  const lv = (k: string) => (mine ? s.invest[k as keyof typeof s.invest] || 0 : 0);
  const h = heightAt(u.x, u.y, s.seed, s.gridW, s.gridH);
  const hg = highGroundBonus(h); // high-ground range/sight bonus on this tile
  const ground = h >= 0.60 ? `<span class="hi">⛰ high ground</span> +${hg} rng/sight` : h < 0.40 ? `<span class="sub">↓ low ground</span>` : `level ground`;
  const effDmg = st.dmg + b.damage, effRange = st.range + b.range;
  const vision = Math.min(VISION_CAP, (effRange + hg) * VISION_MULT);
  const teamCol = mine ? "#00ffd1" : "#ff6b80";

  // a stat cell: shows the effective value, with the upgrade delta called out in accent when boosted
  const stat = (k: string, val: string, delta?: string) =>
    `<div class="uc-stat"><span class="uc-k">${k}</span><span class="uc-v">${val}${delta ? `<span class="uc-d">${delta}</span>` : ""}</span></div>`;

  // UPGRADES block — every army upgrade, its level, and exactly what it does to THIS unit. Active
  // ones are bright; un-purchased ones are dimmed so the picture is complete and unambiguous.
  const upEffect: Record<string, string> = {
    damage: b.damage ? `+${b.damage} damage` : "+ damage",
    hp: b.hp ? `+${b.hp} max HP` : "+ max HP",
    armor: b.armor ? `−${b.armor} damage taken` : "− damage taken",
    range: b.range ? `+${b.range} range & sight` : "+ range & sight",
    speed: b.speed ? `+${b.speed * 10}% move speed` : "+ move speed",
    income: "economy-wide (not this unit)",
  };
  const upRows = INVESTMENTS.map((inv) => {
    const level = lv(inv.kind), on = level > 0 && inv.kind !== "income";
    return `<div class="uc-up${on ? "" : " off"}"><span class="uc-upi">${upIconSVG(inv.kind)}</span>` +
      `<span class="uc-upn">${inv.label}</span><span class="uc-uplv">Lv${level}</span>` +
      `<span class="uc-upe">${on ? upEffect[inv.kind] : level > 0 ? upEffect[inv.kind] : "—"}</span></div>`;
  }).join("");

  const doctrine = u.camp
    ? (() => { const overridden = u.overrideUntil > s.tick; return `<span class="uc-doc ${DOCTRINE_CLASS[u.camp]}">${u.camp}</span>` + (overridden ? `<span class="uc-ovr">⚡ ${u.overrideLabel} · ${Math.ceil((u.overrideUntil - s.tick) / 10)}s</span>` : `<span class="sub"> native</span>`); })()
    : `<span class="uc-doc bld">building</span><span class="sub"> stationary</span>`;

  const frac = Math.max(0, u.hp / u.maxHp);
  readoutEl.innerHTML =
    `<div class="uc">` +
    `<div class="uc-hd"><span class="uc-name">${st.label}</span><span class="uc-id">#${u.id}</span>` +
    `<span class="uc-badge" style="color:${teamCol};border-color:${teamCol}">${mine ? "YOURS" : "ENEMY"}</span>` +
    `${pinned ? `<span class="uc-pin">📌 pinned</span>` : ""}</div>` +
    `<div class="uc-doctrine">${doctrine}</div>` +
    `<div class="uc-hpbar"><div class="uc-hpfill" style="width:${Math.round(frac * 100)}%;background:${hex(hpColor(frac))}"></div><span class="uc-hptxt">${u.hp} / ${u.maxHp} HP</span></div>` +
    `<div class="uc-stats">` +
    stat("Damage", String(effDmg), b.damage ? `+${b.damage}` : "") +
    stat("Range", String(effRange) + (hg ? ` <span class="hi">+${hg}</span>` : ""), b.range ? `+${b.range}` : "") +
    stat("Accuracy", st.accuracy > 0 ? Math.round(st.accuracy * 100) + "%" : "—") +
    stat("Vision", String(vision), b.range ? `+${b.range * VISION_MULT}` : "") +
    stat("Fire rate", st.attackEvery >= 9999 ? "—" : `every ${st.attackEvery}t`) +
    stat("Move", st.stationary ? "stationary" : `every ${st.moveEvery}t${st.flying ? " ✈" : ""}`, b.speed ? `+${b.speed * 10}%` : "") +
    `</div>` +
    `<div class="uc-ups"><div class="uc-ups-h">${mine ? "UPGRADES ON THIS UNIT" : "ENEMY — upgrades unknown"}</div>${mine ? upRows : ""}</div>` +
    `<div class="uc-foot">${ground} · cost ${st.cost} · @ ${u.x},${u.y}</div>` +
    `</div>`;
}

// ---- the 6 commanders: one cohesive bottom strip. Each shows its accumulated MEMORY above
//      a message box; sending a message appends to that commander's memory (server-side). ----
const controlsEl = document.getElementById("controls")!;
const COMMANDERS: { id: string; kind: "advisor" | "camp" | "field"; cls: string }[] = [
  { id: "field", kind: "field", cls: "" }, // leftmost — has the active-tactic control (cancellable)
  { id: "advisor", kind: "advisor", cls: "" },
  { id: "aggressive", kind: "camp", cls: "agg" },
  { id: "recon", kind: "camp", cls: "rec" },
  { id: "defensive", kind: "camp", cls: "def" },
  { id: "builder", kind: "camp", cls: "bld" },
];
let cmdBuilt = false;
const setText = (id: string, t: string) => { const e = document.getElementById(id); if (e) e.textContent = t; };

// procedural profile pictures: a unique "digital face" per commander, line-drawn in the role color
// (distinct headgear, eyes, mouth). No image assets needed; reads on-theme.
const AV_COLOR: Record<string, string> = {
  advisor: "#00ffd1", aggressive: "#ff5d73", recon: "#5ab0ff", defensive: "#2fe0bd", builder: "#ffb547", field: "#00ffd1",
};
// each returns the face's inner SVG (features) drawn in color `c`, within a 44×44 badge
const FACES: Record<string, (c: string) => string> = {
  advisor: (c) => // analyst: round glasses, side-parted hair, calm
    `<path d="M12 16 Q22 9 32 16" fill="none" stroke="${c}" stroke-width="1.4" opacity="0.7"/>` +
    `<rect x="13" y="14" width="18" height="22" rx="8" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.3"/>` +
    `<circle cx="18" cy="23" r="3.4" fill="none" stroke="${c}" stroke-width="1.2"/><circle cx="26" cy="23" r="3.4" fill="none" stroke="${c}" stroke-width="1.2"/>` +
    `<line x1="21.4" y1="23" x2="22.6" y2="23" stroke="${c}" stroke-width="1.2"/>` +
    `<circle cx="18" cy="23" r="1" fill="${c}"/><circle cx="26" cy="23" r="1" fill="${c}"/>` +
    `<line x1="18" y1="30.5" x2="26" y2="30.5" stroke="${c}" stroke-width="1.2" opacity="0.8"/>`,
  aggressive: (c) => // fierce: combat helmet, angry brows, slit eyes, grimace, cheek slash
    `<path d="M11 18 Q22 8 33 18" fill="${c}" fill-opacity="0.18" stroke="${c}" stroke-width="1.4"/>` +
    `<rect x="13" y="16" width="18" height="20" rx="7" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.3"/>` +
    `<line x1="15.5" y1="22" x2="20" y2="24" stroke="${c}" stroke-width="1.5"/><line x1="28.5" y1="22" x2="24" y2="24" stroke="${c}" stroke-width="1.5"/>` +
    `<line x1="16" y1="25.6" x2="20" y2="25.6" stroke="${c}" stroke-width="1.6"/><line x1="24" y1="25.6" x2="28" y2="25.6" stroke="${c}" stroke-width="1.6"/>` +
    `<path d="M17 31 L20 30 L24 31 L27 30" fill="none" stroke="${c}" stroke-width="1.3"/>` +
    `<line x1="29" y1="27" x2="31" y2="31" stroke="${c}" stroke-width="1" opacity="0.7"/>`,
  recon: (c) => // optics: antenna + big crosshair scope eye
    `<rect x="13" y="15" width="18" height="21" rx="8" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.3"/>` +
    `<line x1="22" y1="15" x2="22" y2="9" stroke="${c}" stroke-width="1.2"/><circle cx="22" cy="8.3" r="1.3" fill="${c}"/>` +
    `<circle cx="22" cy="24" r="5.2" fill="none" stroke="${c}" stroke-width="1.4"/><circle cx="22" cy="24" r="2.1" fill="${c}" fill-opacity="0.85"/>` +
    `<line x1="22" y1="17.6" x2="22" y2="19" stroke="${c}" stroke-width="1"/><line x1="22" y1="29" x2="22" y2="30.4" stroke="${c}" stroke-width="1"/>` +
    `<line x1="15.6" y1="24" x2="17" y2="24" stroke="${c}" stroke-width="1"/><line x1="27" y1="24" x2="28.4" y2="24" stroke="${c}" stroke-width="1"/>` +
    `<line x1="19" y1="32" x2="25" y2="32" stroke="${c}" stroke-width="1.1" opacity="0.7"/>`,
  defensive: (c) => // heavy helmet dome, square steady eyes, firm mouth
    `<path d="M10 22 Q10 10 22 10 Q34 10 34 22 Z" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="1.4"/>` +
    `<line x1="22" y1="10" x2="22" y2="22" stroke="${c}" stroke-width="1" opacity="0.5"/>` +
    `<path d="M13 22 L31 22 L31 30 Q31 36 22 36 Q13 36 13 30 Z" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.3"/>` +
    `<rect x="16.5" y="24" width="3.4" height="2.6" rx="0.6" fill="${c}"/><rect x="24.1" y="24" width="3.4" height="2.6" rx="0.6" fill="${c}"/>` +
    `<line x1="18" y1="31.5" x2="26" y2="31.5" stroke="${c}" stroke-width="1.4"/>`,
  builder: (c) => // hardhat + welding goggles, friendly smile
    `<path d="M12 17 Q22 9 32 17 Z" fill="${c}" fill-opacity="0.22" stroke="${c}" stroke-width="1.3"/>` +
    `<rect x="10" y="16.6" width="24" height="2.6" rx="1.3" fill="${c}" fill-opacity="0.5"/>` +
    `<rect x="13.5" y="19.5" width="17" height="16.5" rx="7" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.3"/>` +
    `<rect x="15.3" y="23" width="5.6" height="4" rx="1.4" fill="${c}" fill-opacity="0.85"/><rect x="23.1" y="23" width="5.6" height="4" rx="1.4" fill="${c}" fill-opacity="0.85"/>` +
    `<line x1="20.9" y1="25" x2="23.1" y2="25" stroke="${c}" stroke-width="1.2"/>` +
    `<line x1="16.3" y1="24" x2="17.8" y2="24" stroke="#ffffff" stroke-width="0.8" opacity="0.6"/>` +
    `<path d="M18 31 Q22 33.5 26 31" fill="none" stroke="${c}" stroke-width="1.2"/>`,
  field: (c) => // officer's peaked cap with star, steady gaze
    `<path d="M12 17 L32 17 Q33 10 22 10 Q11 10 12 17 Z" fill="${c}" fill-opacity="0.2" stroke="${c}" stroke-width="1.3"/>` +
    `<rect x="11.5" y="17" width="21" height="3" fill="${c}" fill-opacity="0.5"/>` +
    `<path d="M10 20.5 Q22 24.5 34 20.5" fill="none" stroke="${c}" stroke-width="1.6"/>` +
    `<text x="22" y="16" font-size="6" text-anchor="middle" fill="${c}">★</text>` +
    `<rect x="14" y="21" width="16" height="15" rx="6.5" fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="1.3"/>` +
    `<circle cx="18.5" cy="26.5" r="1.3" fill="${c}"/><circle cx="25.5" cy="26.5" r="1.3" fill="${c}"/>` +
    `<line x1="19" y1="32" x2="25" y2="32" stroke="${c}" stroke-width="1.2"/>`,
};
function avatarSVG(id: string): string {
  const c = AV_COLOR[id] ?? "#00ffd1";
  return `<svg class="av" viewBox="0 0 44 44" aria-hidden="true">` +
    `<rect x="1.5" y="1.5" width="41" height="41" rx="10" fill="#091018" stroke="${c}" stroke-opacity="0.8" stroke-width="1.5"/>` +
    (FACES[id] ?? FACES.field)(c) +
    `</svg>`;
}

function buildCommanders() {
  controlsEl.innerHTML = "";
  // ONE order box (bottom-left). Whatever you type is broadcast to your whole staff; each commander
  // applies the part relevant to its role. The six cards to the right are now display-only — they
  // show each commander and how the order landed in its memory + current doctrine.
  const orders = document.createElement("div");
  orders.className = "orders";
  orders.innerHTML =
    `<div class="ordhd">⌖ ORDERS <span class="ordsub">→ broadcast to your whole staff</span></div>` +
    `<textarea id="order-input" placeholder="Command your generals & advisors…  e.g. “push the east, tanks up front, save for armor”  (Enter to send)"></textarea>` +
    `<button class="send" id="order-send">Relay order ▸</button>`;
  controlsEl.appendChild(orders);
  const relay = () => {
    const inp = document.getElementById("order-input") as HTMLTextAreaElement;
    const text = inp.value.trim();
    if (!text) return;
    inp.value = "";
    sendCmd({ type: "command", text });
  };
  (document.getElementById("order-send") as HTMLButtonElement).onclick = relay;
  (document.getElementById("order-input") as HTMLTextAreaElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); relay(); } // Enter sends, Shift+Enter = newline
  });

  for (const c of COMMANDERS) {
    const div = document.createElement("div");
    div.className = "cmd";
    div.innerHTML =
      `<div class="cmdhd">${avatarSVG(c.id)}<h4 class="${c.cls}" id="lbl-${c.id}">…</h4></div>` +
      (c.kind === "field" ? `<div class="fgactive" id="fgactive"></div>` : "") + // active tactic chip (cancellable)
      `<div class="mem" id="mem-${c.id}"></div>` +
      (c.kind === "camp" ? `<div class="spec" id="spec-${c.id}"></div><span class="cool" id="cool-${c.id}"></span>` : "");
    controlsEl.appendChild(div);
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
  const fa = document.getElementById("fgactive");
  if (fa) {
    if (latestActiveOrder) {
      fa.className = "fgactive on";
      fa.innerHTML = `<span class="fgtag">⚡ ${latestActiveOrder}</span><button class="fgx" title="Cancel tactic — revert to doctrine">✕</button>`;
      (fa.querySelector(".fgx") as HTMLButtonElement).onclick = () => sendCmd({ type: "cancelFieldOrder" });
    } else { fa.className = "fgactive"; fa.innerHTML = `<span class="fgnone">no active tactic</span>`; }
  }
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


