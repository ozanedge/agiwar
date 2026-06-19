// agiwar web client: renders the server-authoritative snapshot and sends sparse commands.
import { Application, Container, Graphics, RenderTexture, Sprite, Text, Texture } from "pixi.js";
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
    if (msg.type === "state") { if (awaitingStart) { awaitingStart = false; document.getElementById("standby")?.remove(); } latestState = msg; render(msg); spawnShots(msg); }
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
let doctrineTimer: number | undefined;
let awaitingStart = false; // picked a doctrine, waiting for the (paused) sim to begin — dismissed on the first live state
function pickDoctrine(id: string) {
  clearInterval(doctrineTimer);
  sendCmd({ type: "chooseArmyDoctrine", id });
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
function showDoctrinePicker(current: string) {
  clearInterval(doctrineTimer);
  document.getElementById("doctrine")?.remove();
  const C = 2 * Math.PI * 18; // ring circumference for the spindown
  const el = document.createElement("div");
  el.id = "doctrine";
  el.innerHTML =
    `<div class="dpanel">` +
    `<svg class="dtimer" viewBox="0 0 44 44"><circle class="trk" cx="22" cy="22" r="18"/><circle class="ring" cx="22" cy="22" r="18"/><text id="dtnum" x="22" y="26.5">${DOCTRINE_SECONDS}</text></svg>` +
    `<h3>Choose your army doctrine</h3>` +
    `<div class="dsub">Your build identity for this match — pick how you want to win. Auto-selects Combined Arms when the timer runs out.</div>` +
    `<div class="dcards"></div></div>`;
  const cards = el.querySelector(".dcards")!;
  for (const d of ARMY_DOCTRINES) {
    const c = document.createElement("button");
    c.className = "dcard" + (d.id === current ? " cur" : "");
    c.innerHTML = `<div class="dl">${d.label}</div><div class="dh">${d.hint}</div><div class="db">${d.blurb}</div>`;
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
    g.on("pointertap", () => sendCmd({ type: "captureArtifact", id: a.id }));
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

// The LIT TOP CAP: the finest detail, drawn on the apex layer only (FORWARD = +x so the
// barrel/rifle/camera point along heading once the layer is rotated). The chassis volume
// itself is sculpted by the stacked cross-sections below — this is just the crown.
function drawBody(g: Graphics, type: UnitType, side: number, ln: { color: number; width: number; alpha: number }, acc: number) {
  const m = unitPalette(side);
  const rim = { color: side, width: 0.9, alpha: 0.85 }; // team rim light along the lit edge
  const pip = (x: number, y: number, r: number) => { g.circle(x, y, r + 0.7).fill({ color: acc, alpha: 0.25 }); g.circle(x, y, r).fill(acc); g.circle(x, y, r).stroke({ color: tint(acc, 0.5), width: 0.5, alpha: 0.8 }); };

  if (type === "tank") { // modern MBT: angular turret, thermal-sleeved gun w/ muzzle brake, bustle, cupola, sight
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
  } else if (type === "humvee") { // armored recon truck: raked windshield, roof RWS w/ MG, antennas, stowage
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
  } else if (type === "gunner") { // modern infantryman: plate carrier, ruck, NVG helmet (carbine = drawGunnerWeapon, at chest height)
    g.roundRect(-4, -2.4, 3, 4.8, 1).fill(m.steelDkr); // ruck (rear)
    g.roundRect(-2.2, -3, 4.8, 6, 2).fill(m.steel).stroke(ln); g.roundRect(-2, -2.6, 2.1, 5.2, 1).fill({ color: m.steelLt, alpha: 0.5 }); // plate carrier / shoulders
    g.circle(0.7, 0, 2.7).fill(m.steelLt).stroke(ln); g.arc(0.7, 0, 2.7, -1.1, 1.1).fill({ color: tint(m.steelLt, 0.3), alpha: 0.5 }); // helmet
    g.roundRect(2.7, -0.9, 1.5, 1.8, 0.5).fill(m.steelDk); // NVG mount (front)
    g.circle(-1.5, -2.5, 0.65).fill(side); // shoulder IR strobe
    pip(0.7, -0.2, 0.95);
  } else if (type === "drone") { // sleek quad: X-frame, motor nacelles + prop-blur discs, gimbal cam, LEDs
    for (const [rx, ry] of [[6.5, 6.5], [6.5, -6.5], [-6.5, 6.5], [-6.5, -6.5]]) g.moveTo(0, 0).lineTo(rx, ry).stroke({ color: tint(m.steel, -0.2), width: 2.2 });
    for (const [rx, ry] of [[6.5, 6.5], [6.5, -6.5], [-6.5, 6.5], [-6.5, -6.5]]) {
      g.circle(rx, ry, 3).fill({ color: side, alpha: 0.16 }); g.circle(rx, ry, 3).stroke({ color: tint(side, 0.3), width: 0.8, alpha: 0.6 }); // prop-blur disc
      g.circle(rx, ry, 1.4).fill(m.steelDk); // motor nacelle
    }
    g.roundRect(-3.5, -2.7, 7, 5.4, 2).fill(m.steel).stroke(ln); g.roundRect(-2.7, -2.1, 3, 4.2, 1).fill({ color: m.steelLt, alpha: 0.45 }); // fuselage
    g.circle(3.2, 0, 1.6).fill(m.glass); g.circle(3.4, 0, 0.75).fill({ color: side, alpha: 0.85 }); // gimbal camera (forward)
    g.circle(-2.5, -1.7, 0.6).fill(acc); g.circle(-2.5, 1.7, 0.6).fill(side); // status LEDs
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
  const lvl = -0.5 + t * 0.62; // dark at the base, lit toward the apex
  const m = unitPalette(side);
  const body = tint(m.steel, lvl);
  const trk = tint(m.rubber, lvl * 0.45);
  if (type === "tank") {
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
  } else if (type === "humvee") {
    if (t < 0.3) { // wheels + lower chassis
      for (const [wx, wy] of [[-6, -6.6], [6, -6.6], [-6, 6.6], [6, 6.6]]) g.circle(wx, wy, 2.9).fill(trk);
      g.poly([-9, -5.6, 7, -5.6, 10, -2.6, 10, 2.6, 7, 5.6, -9, 5.6]).fill(body);
    } else if (t < 0.56) { // hood line + body
      g.poly([-9, -5.5, 10, -5, 10, 5, -9, 5.5]).fill(body);
    } else { // armored cabin (set back from the hood)
      g.roundRect(-8, -5, 13.5, 10, 2.5).fill(body);
    }
  } else if (type === "gunner") {
    if (t < 0.34) { g.roundRect(-2.3, -3.3, 4, 2.7, 1.2).fill(body); g.roundRect(-1.2, 0.6, 4, 2.7, 1.2).fill(body); } // striding legs
    else if (t < 0.7) { g.roundRect(-3.6, -3.4, 4.8, 6.8, 2).fill(tint(body, -0.1)); g.roundRect(-1.8, -3, 5.4, 6, 2.2).fill(body); } // ruck + torso/armor
    else if (t < 0.86) g.roundRect(-1.9, -3.4, 5, 6.8, 2.4).fill(body); // shoulders
    else { const s = 1 - (t - 0.86) * 0.4; g.circle(0.6, 0, 2.6 * s).fill(body); } // helmet
  } else if (type === "drone") {
    g.circle(0, 0, 3.3 - t * 1.0).fill(body);
  } else { // turret: sloped pedestal → neck → head housing
    if (t < 0.4) { const s = 1 - t * 0.3; g.circle(0, 0, 7 * s).fill(body); }
    else if (t < 0.6) g.circle(0, 0, 4.4).fill(tint(body, -0.1));
    else { const s = 1 - (t - 0.6) * 0.4; g.roundRect(-5 * s, -4.2 * s, 11 * s, 8.4 * s, 2 * s).fill(body); }
  }
}
const UNIT_HEIGHT: Record<string, number> = { tank: 11, turret: 14, humvee: 9, gunner: 11, drone: 3 };

// Build a unit's visual art at the ORIGIN (no world position). A persistent per-unit holder carries
// the position, which the render ticker eases between cells so units glide instead of snapping.
function unitArt(u: StateMsg["units"][number], s: StateMsg): Container {
  const cont = new Container();
  const side = u.owner === s.you ? OWN_COLOR : ENEMY_COLOR;
  const acc = u.camp ? DOCTRINE_COLOR[u.camp] : 0x9aa6b2;
  const ln = { color: 0x05080b, width: 1, alpha: 0.55 };
  // footprint scale (length×width, applied to the rotated chassis) — tanks/humvees are much bigger
  // on the ground; height (the z-stack) is unchanged. Matches their larger gameplay footprint.
  const FOOT: Record<string, { x: number; y: number }> = { tank: { x: 1.6, y: 1.55 }, humvee: { x: 1.5, y: 1.48 } };
  const fp = FOOT[u.unit] ?? { x: 1, y: 1 };
  const rad = Math.round((u.unit === "tank" || u.unit === "turret" ? 10 : 8) * (fp.x + fp.y) / 2);
  const lift = u.unit === "drone" ? 14 : 2; // ground units sit on the deck; drone hovers

  const base = new Graphics(); // never rotates: shadow, glow, (turret ground ring)
  base.ellipse(0, 3, 11 * fp.x, 4.5 * fp.y).fill({ color: 0x000000, alpha: 0.3 });
  base.ellipse(0, 1, rad + 11, (rad + 11) * 0.5).fill({ color: side, alpha: 0.12 });
  base.ellipse(0, 1, rad + 6, (rad + 6) * 0.5).fill({ color: side, alpha: 0.14 });
  if (u.unit === "turret") base.ellipse(0, 3, 12, 6.5).fill(tint(side, -0.3)).stroke(ln);
  if (pinned && pinned.id === u.id) base.ellipse(0, 1, rad + 9, (rad + 9) * 0.5).stroke({ color: 0xffffff, width: 1.5, alpha: 0.85 }); // selection ring
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
    g.scale.set(fp.x, fp.y); // widen/lengthen the chassis (scale in local space, then rotate to heading)
    g.rotation = heading;
    if (i === H) drawBody(g, u.unit, side, ln, acc); // lit, detailed top cap
    else drawSilhouette(g, u.unit, side, t); // sculpted volume, dark base → lit top
    if (u.unit === "gunner" && i === Math.round(H * 0.6)) drawGunnerWeapon(g, side); // carbine at chest height
    wrap.addChild(g);
    cont.addChild(wrap);
  }

  const top = new Graphics(); // never rotates: hp bar + override ring, above the stacked volume
  const topY = lift + H * 1.3 + rad * 0.4;
  const frac = Math.max(0, u.hp / u.maxHp); // hp bar persists on every unit, green→yellow→orange→red
  top.rect(-rad, -topY - 6.5, rad * 2, 2.6).fill({ color: 0x05080b, alpha: 0.6 }); // track
  top.rect(-rad, -topY - 6.5, frac * rad * 2, 2.6).fill(hpColor(frac)); // spectrum fill
  if (u.overrideUntil > s.tick) top.circle(0, -topY, rad + 4).stroke({ color: 0xffd76b, width: 1.5, alpha: 0.5 + 0.5 * Math.sin(s.tick / 2) });
  cont.addChild(top);
  return cont;
}

// ---- smooth unit movement: a persistent holder per unit id, eased toward the latest server cell ----
interface UnitView { holder: Container; art: Container | null; gx: number; gy: number; tgx: number; tgy: number; vr: number; u: StateMsg["units"][number]; }
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
      e = { holder, art: null, gx: u.x, gy: u.y, tgx: u.x, tgy: u.y, vr: unitSight(u, s), u };
      const ev = e;
      holder.on("pointerover", () => { hovered = ev.u; updateReadout(); });
      holder.on("pointerout", () => { if (hovered?.id === ev.u.id) { hovered = null; updateReadout(); } });
      holder.on("pointertap", () => { pinned = ev.u; hovered = ev.u; unitTapped = true; updateReadout(); }); // click to pin inspect
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
  { id: "advisor", kind: "advisor", cls: "" },
  { id: "aggressive", kind: "camp", cls: "agg" },
  { id: "recon", kind: "camp", cls: "rec" },
  { id: "defensive", kind: "camp", cls: "def" },
  { id: "builder", kind: "camp", cls: "bld" },
  { id: "field", kind: "field", cls: "" },
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


