// Sprite baker renderer: renders a procedural unit model from the game's exact isometric camera at
// N headings, supersampled, with a soft key-light shadow and a dark silhouette outline, then trims
// and shelf-packs the frames into atlas pages + a JSON frame index the client loads lazily.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { rootInv } from "./kit";

export const RES = 4;       // baked texels per art px (the client draws the sprite at scale 1/RES)
export const DIRS = 32;     // headings per sheet
const SS = 2;               // supersample factor
const PAGE_W = 2048, PAGE_MAX_H = 4096, PAD = 3;

export interface Model {
  root: THREE.Object3D;
  /** animation frames (e.g. infantry walk cycle); animate(k) poses the model for frame k. */
  frames?: number;
  animate?: (k: number) => void;
  /** flyers get their ground shadow baked as a separate sheet (the client draws it on the ground). */
  flyer?: boolean;
  /** art-space anchors the client uses (forward x, up y, lateral z — art px at unit scale 1). */
  meta?: ModelMeta;
}
export interface ModelMeta {
  /** helicopter main rotor hub [x, y, z] + blade radius — the client spins a rotor disc there. */
  rotor?: [number, number, number, number];
  /** outer wingtip [x, y, |z|] for contrails (mirrored on −z). */
  wingtip?: [number, number, number];
  /** primary weapon muzzle [x, y, z] — where shots/tracers leave the unit. */
  muzzle?: [number, number, number];
  /** walk cycle frames: [first, count]; frame 0 is the idle pose. */
  walk?: [number, number];
}

// ---- camera: true 2:1 dimetric matching the game's iso projection ----
// grid +x → world +X (screen right-down), grid +y → world +Z (screen left-down); camera sits at
// (+d, h, +d) looking at the origin with a 30° elevation so a ground circle squashes exactly 2:1.
const ELEV = Math.asin(0.5);
function makeCamera(half: number, cy: number) {
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 2000);
  const d = 500, horiz = Math.cos(ELEV) * d, h = Math.sin(ELEV) * d;
  cam.position.set(horiz / Math.SQRT2, cy + h, horiz / Math.SQRT2);
  cam.lookAt(0, cy, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true); // so Vector3.project() (the sprite anchor) sees the real view matrix
  return cam;
}

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene, key: THREE.DirectionalLight, catcher: THREE.Mesh;
function setup() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  // key light from screen upper-left (world −X, slightly −Z) → shadows fall screen right-down,
  // matching the legacy art's lighting and the baked terrain.
  key = new THREE.DirectionalLight(0xfff0d8, 3.6);
  key.position.set(-190, 210, 50);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 3;
  scene.add(key, key.target);
  const sky = new THREE.HemisphereLight(0xb8ccef, 0x2a241c, 0.42);
  const rim = new THREE.DirectionalLight(0xbfe2ff, 0.9); rim.position.set(-120, 80, -200); // cool back rim (screen top)
  const fill = new THREE.DirectionalLight(0xffe2c4, 0.18); fill.position.set(200, 90, 160); // warm bounce from camera side
  scene.add(sky, rim, fill);
  catcher = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ opacity: 0.5 }));
  catcher.rotation.x = -Math.PI / 2; catcher.receiveShadow = true;
  scene.add(catcher);
}

export interface Frame { x: number; y: number; w: number; h: number; tx: number; ty: number; page: number }
export interface Sheet { meta?: ModelMeta; type: string; res: number; dirs: number; frames: number; w: number; h: number; ax: number; ay: number; flyer: boolean; pages: string[]; f: Frame[]; sf?: Frame[]; spages?: string[]; sw?: number; sh?: number; sax?: number; say?: number }

function canvas(w: number, h: number) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

// Render the current scene to a W×H canvas (supersampled, then downscaled).
function snap(cam: THREE.Camera, W: number, H: number): HTMLCanvasElement {
  renderer!.setSize(W * SS, H * SS, false);
  renderer!.render(scene, cam);
  const c = canvas(W, H), ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(renderer!.domElement, 0, 0, W, H);
  return c;
}

// Dark 1–2px silhouette outline around the model (not its shadow), composited under the model.
function outline(model: HTMLCanvasElement, px = 1.6, color = [8, 10, 12], alpha = 0.62): HTMLCanvasElement {
  const W = model.width, H = model.height;
  const src = model.getContext("2d")!.getImageData(0, 0, W, H).data;
  const out = canvas(W, H), octx = out.getContext("2d")!, img = octx.createImageData(W, H), d = img.data;
  const R = Math.ceil(px);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let m = 0;
    for (let oy = -R; oy <= R && m < 255; oy++) for (let ox = -R; ox <= R; ox++) {
      const xx = x + ox, yy = y + oy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const dist = Math.hypot(ox, oy); if (dist > px + 0.5) continue;
      const a = src[(yy * W + xx) * 4 + 3] * Math.min(1, px + 0.5 - dist);
      if (a > m) m = a;
    }
    const o = (y * W + x) * 4; d[o] = color[0]; d[o + 1] = color[1]; d[o + 2] = color[2]; d[o + 3] = m * alpha;
  }
  octx.putImageData(img, 0, 0);
  octx.drawImage(model, 0, 0);
  return out;
}

function trim(c: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
  const W = c.width, H = c.height, d = c.getContext("2d")!.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Shelf-pack trimmed frames into pages.
function pack(imgs: { c: HTMLCanvasElement; t: { x: number; y: number; w: number; h: number } }[]): { pages: HTMLCanvasElement[]; frames: Frame[] } {
  const frames: Frame[] = []; const placed: { page: number; x: number; y: number }[] = [];
  let page = 0, x = PAD, y = PAD, rowH = 0; const heights = [0];
  for (const { t } of imgs) {
    if (x + t.w + PAD > PAGE_W) { x = PAD; y += rowH + PAD; rowH = 0; }
    if (y + t.h + PAD > PAGE_MAX_H) { page++; x = PAD; y = PAD; rowH = 0; heights.push(0); }
    placed.push({ page, x, y }); x += t.w + PAD; rowH = Math.max(rowH, t.h); heights[page] = Math.max(heights[page], y + t.h + PAD);
  }
  const pages = heights.map((h) => canvas(PAGE_W, Math.min(PAGE_MAX_H, Math.ceil(h / 4) * 4)));
  imgs.forEach(({ c, t }, i) => {
    const p = placed[i];
    pages[p.page].getContext("2d")!.drawImage(c, t.x, t.y, t.w, t.h, p.x, p.y, t.w, t.h);
    frames.push({ x: p.x, y: p.y, w: t.w, h: t.h, tx: t.x, ty: t.y, page: p.page });
  });
  return { pages, frames };
}

function setMaterialsVisible(root: THREE.Object3D, visible: boolean) {
  root.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.colorWrite = visible; if (m && !visible) m.depthWrite = false; else if (m) m.depthWrite = !(m as THREE.MeshStandardMaterial).transparent; });
}

export async function bake(type: string, model: Model, onProgress?: (msg: string) => void): Promise<{ sheet: Sheet; pages: HTMLCanvasElement[]; spages: HTMLCanvasElement[]; preview: HTMLCanvasElement[] }> {
  setup();
  const root = model.root;
  const holder = new THREE.Group(); holder.add(root); scene.add(holder);
  // frame bounds from the model's bounding sphere about the vertical axis
  const box = new THREE.Box3().setFromObject(root);
  let r = 0; for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) r = Math.max(r, Math.hypot(x, z));
  const top = Math.max(1, box.max.y);
  const half = Math.max(r * 1.08 + 3, (top + r * 0.5) * 0.62 + 4);
  const cy = top * 0.35;
  const cam = makeCamera(half, cy);
  const W = Math.ceil(2 * half * RES / 2) * 2, H = W; // even, so the half-res shadow frame is exact
  // shadow camera fit
  const sc = key.shadow.camera as THREE.OrthographicCamera;
  const sr = r + top * 1.4 + 6; sc.left = -sr; sc.right = sr; sc.top = sr; sc.bottom = -sr; sc.near = 1; sc.far = 800; sc.updateProjectionMatrix();
  // origin → pixel anchor
  const o = new THREE.Vector3(0, 0, 0).project(cam);
  const ax = (o.x + 1) / 2, ay = (1 - o.y) / 2;

  const nAnim = model.frames ?? 1;
  const main: { c: HTMLCanvasElement; t: { x: number; y: number; w: number; h: number } }[] = [];
  const shad: { c: HTMLCanvasElement; t: { x: number; y: number; w: number; h: number } }[] = [];
  const preview: HTMLCanvasElement[] = [];
  for (let k = 0; k < nAnim; k++) {
    model.animate?.(k);
    for (let i = 0; i < DIRS; i++) {
      const th = (i / DIRS) * Math.PI * 2;
      holder.rotation.y = -th; // grid heading θ → world yaw −θ (forward +X turns toward +Z)
      holder.updateMatrixWorld(true);
      rootInv.value.copy(holder.matrixWorld).invert();
      // pass A: model only
      catcher.visible = false; setMaterialsVisible(root, true);
      const a = outline(snap(cam, W, H));
      // pass B: shadow only (model invisible but still casting)
      catcher.visible = true; setMaterialsVisible(root, false);
      const b = snap(cam, W, H);
      setMaterialsVisible(root, true);
      if (model.flyer) {
        main.push({ c: a, t: trim(a) });
        const bh = canvas(W / 2, H / 2), bctx = bh.getContext("2d")!; // soft shadow → half resolution is plenty
        bctx.imageSmoothingQuality = "high"; bctx.drawImage(b, 0, 0, W / 2, H / 2);
        shad.push({ c: bh, t: trim(bh) });
      } else {
        const c = canvas(W, H), ctx = c.getContext("2d")!; ctx.drawImage(b, 0, 0); ctx.drawImage(a, 0, 0);
        main.push({ c, t: trim(c) });
      }
      if (k === 0 && i % 4 === 0) preview.push(main[main.length - 1].c);
      if (i % 8 === 0) { onProgress?.(`${type}: frame ${k * DIRS + i + 1}/${nAnim * DIRS}`); await new Promise((r) => setTimeout(r, 0)); }
    }
  }
  scene.remove(holder);
  const pm = pack(main);
  const sheet: Sheet = { meta: model.meta, type, res: RES, dirs: DIRS, frames: nAnim, w: W, h: H, ax, ay, flyer: !!model.flyer, pages: pm.pages.map((_, i) => `${type}-${i}.webp`), f: pm.frames };
  let spages: HTMLCanvasElement[] = [];
  if (model.flyer) {
    const ps = pack(shad); spages = ps.pages;
    sheet.sf = ps.frames; sheet.spages = ps.pages.map((_, i) => `${type}-shadow-${i}.webp`);
    sheet.sw = W / 2; sheet.sh = H / 2; // shadow frames are baked at RES/2
  }
  return { sheet, pages: pm.pages, spages, preview };
}
