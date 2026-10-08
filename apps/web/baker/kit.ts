// Modeling kit for the unit sprite baker. Units are authored in ART PX (the same space the legacy
// vector art used: 1 unit = 1 screen px at zoom 1), with FORWARD = +X, UP = +Y, and lateral = Z.
// Everything here is procedural: beveled boxes, lofted armor, extruded side profiles, cylinders.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export type V2 = [number, number];
export interface Place { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; sx?: number; sy?: number; sz?: number }

// One shared uniform: inverse of the model root's world matrix, refreshed before each frame. Every
// material samples its camo/AO in MODEL space through it, so patterns stay glued to the hull as it
// rotates through the 32 headings instead of swimming across it.
export const rootInv = { value: new THREE.Matrix4() };

function place<T extends THREE.Object3D>(o: T, p: Place = {}): T {
  o.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
  o.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
  o.scale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1);
  o.castShadow = true; o.receiveShadow = true;
  return o;
}

// ---------- materials ----------
export interface Palette {
  name: string;
  camo: number[];        // camo colors: base, mid, dark, (optional) fleck
  digital: boolean;      // pixelated digital camo vs. soft organic blobs
  camoScale: number;     // art px per pattern repeat
  marking: number;       // faction marking paint (stripes, chevrons, numbers)
  metal: number;         // bare/parkerized metal (guns, tracks)
  dust: number;          // grime color that creeps up from the ground
}

export const PALETTES: Record<"anthropic" | "openai", Palette> = {
  // Anthropic: desert-tan multi-tone camo, warm, heavy; orange faction markings.
  anthropic: { name: "anthropic", camo: [0xa88d61, 0x957c54, 0x7a6646, 0xb59c70], digital: false, camoScale: 34, marking: 0xff7a1a, metal: 0x34363a, dust: 0x6b5d45 },
  // OpenAI: urban light-grey digital camo, cool and clean; white faction markings.
  openai: { name: "openai", camo: [0x8b9298, 0x777e85, 0x5d646a, 0x9ea5ab], digital: true, camoScale: 26, marking: 0xf2f5f7, metal: 0x2f3337, dust: 0x50555a },
};

// Tileable fbm value noise for camo masks.
function makeNoise(size: number, cells: number, seed: number) {
  const rnd = (i: number, j: number) => {
    const s = Math.sin((((i % cells) + cells) % cells) * 127.1 + (((j % cells) + cells) % cells) * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x / size) * cells, fy = (y / size) * cells;
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const a = rnd(i, j), b = rnd(i + 1, j), c = rnd(i, j + 1), d = rnd(i + 1, j + 1);
    out[y * size + x] = a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  }
  return out;
}
function fbm(size: number, base: number, seed: number) {
  const o = new Float32Array(size * size);
  let amp = 1, tot = 0;
  for (let k = 0; k < 4; k++) {
    const n = makeNoise(size, base << k, seed + k * 13);
    for (let i = 0; i < o.length; i++) o[i] += n[i] * amp;
    tot += amp; amp *= 0.5;
  }
  for (let i = 0; i < o.length; i++) o[i] /= tot;
  return o;
}
const camoCache = new Map<string, THREE.Texture>();
export function camoTexture(p: Palette): THREE.Texture {
  const hit = camoCache.get(p.name); if (hit) return hit;
  const S = 512;
  const n1 = fbm(S, 3, 1), n2 = fbm(S, 4, 7), n3 = fbm(S, 6, 19), grain = fbm(S, 64, 3);
  const cv = document.createElement("canvas"); cv.width = cv.height = S;
  const ctx = cv.getContext("2d")!; const img = ctx.createImageData(S, S);
  const rgb = p.camo.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);
  const block = p.digital ? 8 : 1;
  const grime = fbm(S, 10, 41);
  const mix3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const ss = (e0: number, e1: number, v: number) => { const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const bx = Math.floor(x / block) * block, by = Math.floor(y / block) * block, k = by * S + bx;
    const soft = p.digital ? 0.001 : 0.035; // organic patterns blend softly; digital stays crisp
    let c = rgb[0];
    c = mix3(c, rgb[1], ss(0.53 - soft, 0.53 + soft, n1[k]));
    c = mix3(c, rgb[2], ss(0.62 - soft, 0.62 + soft, n2[k]));
    if (rgb[3]) c = mix3(c, rgb[3], ss(0.66 - soft, 0.66 + soft, n3[k]) * 0.8);
    // fine paint grain × weathering grime, baked straight into RGB (alpha stays opaque: a 2D canvas
    // stores premultiplied color, so a mask in alpha would wipe the paint wherever it's 0)
    const gr = Math.max(0, Math.min(1, (grime[y * S + x] - 0.3) * 2.2));
    const g = (0.96 + grain[y * S + x] * 0.08) * (1.04 - 0.24 * gr);
    const o = (y * S + x) * 4;
    img.data[o] = Math.min(255, c[0] * g); img.data[o + 1] = Math.min(255, c[1] * g); img.data[o + 2] = Math.min(255, c[2] * g);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  camoCache.set(p.name, t);
  return t;
}

interface MatOpts { color?: number; rough?: number; metal?: number; camo?: Palette; aoH?: number; dust?: number; emissive?: number; emissiveI?: number; env?: number }
// MeshStandardMaterial + model-space triplanar camo + height AO + ground grime, injected via onBeforeCompile.
export function mat(o: MatOpts): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: o.camo ? 0xffffff : (o.color ?? 0x808080), roughness: o.rough ?? 0.75, metalness: o.metal ?? 0.15,
    emissive: o.emissive ?? 0x000000, emissiveIntensity: o.emissiveI ?? 1, envMapIntensity: o.env ?? 0.55,
  });
  const camo = o.camo ? camoTexture(o.camo) : null;
  const dust = new THREE.Color(o.dust ?? 0x5a5040);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRootInv = rootInv;
    sh.uniforms.uCamo = { value: camo };
    sh.uniforms.uCamoS = { value: o.camo ? 1 / o.camo.camoScale : 0 };
    sh.uniforms.uAoH = { value: o.aoH ?? 6 };
    sh.uniforms.uDust = { value: dust };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform mat4 uRootInv; varying vec3 vMP; varying vec3 vMN;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n{ vec4 wp4 = modelMatrix * vec4(transformed, 1.0); vMP = (uRootInv * wp4).xyz; vMN = normalize(mat3(uRootInv) * mat3(modelMatrix) * objectNormal); }");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uCamo; uniform float uCamoS; uniform float uAoH; uniform vec3 uDust; varying vec3 vMP; varying vec3 vMN;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        if (uCamoS > 0.0) {
          vec3 w = pow(abs(vMN), vec3(4.0)); w /= (w.x + w.y + w.z + 1e-4);
          vec4 cx = texture2D(uCamo, vMP.zy * uCamoS);
          vec4 cy = texture2D(uCamo, vMP.xz * uCamoS);
          vec4 cz = texture2D(uCamo, vMP.xy * uCamoS);
          diffuseColor.rgb *= (cx * w.x + cy * w.y + cz * w.z).rgb;        // paint + baked weathering grime
        }
        float hAo = smoothstep(-0.5, uAoH, vMP.y);
        diffuseColor.rgb = mix(diffuseColor.rgb * 0.5, diffuseColor.rgb, hAo);            // occluded underside
        diffuseColor.rgb = mix(uDust, diffuseColor.rgb, 0.45 + 0.55 * smoothstep(0.0, uAoH * 0.55, vMP.y)); // dust creeping up
      `);
  };
  m.customProgramCacheKey = () => `kit-${o.camo?.name ?? "plain"}-${o.aoH ?? 6}`;
  return m;
}

// The standard material set for one faction.
export function materials(p: Palette) {
  return {
    camo: mat({ camo: p, rough: 0.62, metal: 0.18, dust: p.dust, aoH: 7 }),
    camoHi: mat({ camo: p, rough: 0.62, metal: 0.18, dust: p.dust, aoH: 3 }), // for tall parts (turrets) — less AO
    plain: mat({ color: p.camo[1], rough: 0.8, metal: 0.1, dust: p.dust }),
    dark: mat({ color: 0x3a3d40, rough: 0.6, metal: 0.45, dust: p.dust }),
    metal: mat({ color: p.metal, rough: 0.45, metal: 0.7, dust: p.dust }),
    steel: mat({ color: 0x8a9096, rough: 0.35, metal: 0.85, dust: p.dust }),
    rubber: mat({ color: 0x1c1d1f, rough: 0.92, metal: 0.0, dust: p.dust, aoH: 3 }),
    track: mat({ color: 0x2a2826, rough: 0.85, metal: 0.35, dust: p.dust, aoH: 4 }),
    glass: mat({ color: 0x0c1720, rough: 0.08, metal: 0.4, env: 1.4 }),
    lens: mat({ color: 0x0a0f14, rough: 0.05, metal: 0.2, emissive: 0x3fb8ff, emissiveI: 0.55, env: 1.2 }),
    marking: mat({ color: p.marking, rough: 0.6, metal: 0.05, dust: p.dust, aoH: 2 }),
    olive: mat({ color: 0x4e5238, rough: 0.85, metal: 0.0, dust: p.dust, aoH: 2 }),      // canvas, webbing, stowage
    skin: mat({ color: 0xb98a68, rough: 0.7, metal: 0.0, aoH: 0.5 }),
    redLight: mat({ color: 0x300000, emissive: 0xff2a1a, emissiveI: 2.2 }),
    greenLight: mat({ color: 0x002a10, emissive: 0x3aff7a, emissiveI: 2.2 }),
    whiteLight: mat({ color: 0x303030, emissive: 0xfff4d8, emissiveI: 2.5 }),
    burner: mat({ color: 0x402000, emissive: 0xffa040, emissiveI: 3.0 }),
    energy: mat({ color: 0x0a2030, emissive: 0x66d8ff, emissiveI: 2.6 }),
  };
}
export type Mats = ReturnType<typeof materials>;

// ---------- primitives ----------
export function box(w: number, h: number, d: number, m: THREE.Material, p: Place = {}, r = 0.3): THREE.Mesh {
  const rr = Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
  const g = rr > 0.02 ? new RoundedBoxGeometry(w, h, d, 2, rr) : new THREE.BoxGeometry(w, h, d);
  return place(new THREE.Mesh(g, m), p);
}
export function cyl(r: number, len: number, m: THREE.Material, p: Place = {}, axis: "x" | "y" | "z" = "y", seg = 18, r2?: number): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r2 ?? r, r, len, seg);
  if (axis === "x") g.rotateZ(-Math.PI / 2); // +y top → +x
  if (axis === "z") g.rotateX(Math.PI / 2);
  return place(new THREE.Mesh(g, m), p);
}
export function sphere(r: number, m: THREE.Material, p: Place = {}, seg = 18): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.6)), m), p);
}
export function torus(r: number, tube: number, m: THREE.Material, p: Place = {}): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 24), m), p);
}

// Side profile (x forward, y up) extruded symmetrically along Z with a small bevel.
export function prism(profile: V2[], width: number, m: THREE.Material, p: Place = {}, bevel = 0.3): THREE.Mesh {
  const s = new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const bv = Math.min(bevel, width / 4);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.01, width - 2 * bv), bevelEnabled: bv > 0, bevelThickness: bv, bevelSize: bv, bevelSegments: 1, curveSegments: 6 });
  g.translate(0, 0, -(width - 2 * bv) / 2);
  return place(new THREE.Mesh(g, m), p);
}
// Top-view outline (x forward, z lateral) extruded upward by h — for plates and planforms.
export function slab(outline: V2[], h: number, m: THREE.Material, p: Place = {}, bevel = 0.2): THREE.Mesh {
  const s = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
  const bv = Math.min(bevel, h / 3);
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.01, h - 2 * bv), bevelEnabled: bv > 0, bevelThickness: bv, bevelSize: bv, bevelSegments: 1, curveSegments: 8 });
  g.rotateX(-Math.PI / 2); // extrude dir (+z) → +y; shape y → -z, so pass -z above to keep +z lateral
  g.translate(0, bv, 0);
  return place(new THREE.Mesh(g, m), p);
}
// Tapered armor solid: bottom outline at yb lofted to a (same vertex count) top outline at yt.
// Flat-shaded so every facet catches the light like welded plate.
export function loft(bottom: V2[], yb: number, top: V2[], yt: number, m: THREE.Material, p: Place = {}): THREE.Mesh {
  // normalize to counter-clockwise (viewed from above) — reversing both outlines keeps the vertex pairing
  let wind = 0; for (let i = 0; i < bottom.length; i++) { const [x1, z1] = bottom[i], [x2, z2] = bottom[(i + 1) % bottom.length]; wind += x1 * -z2 - x2 * -z1; }
  if (wind < 0) { bottom = [...bottom].reverse(); top = [...top].reverse(); }
  const n = bottom.length, pos: number[] = [];
  const B = bottom.map(([x, z]) => new THREE.Vector3(x, yb, z)), T = top.map(([x, z]) => new THREE.Vector3(x, yt, z));
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  // ensure CCW when viewed from above (+y): signed area in (x, -z)
  let area = 0; for (let i = 0; i < n; i++) { const [x1, z1] = bottom[i], [x2, z2] = bottom[(i + 1) % n]; area += x1 * -z2 - x2 * -z1; }
  const ccw = area > 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (ccw) { tri(B[i], B[j], T[j]); tri(B[i], T[j], T[i]); } else { tri(B[i], T[j], B[j]); tri(B[i], T[i], T[j]); }
  }
  const capTri = (pts: V2[]) => THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, -z)), []);
  for (const [a, b, c] of capTri(top)) { if (ccw) tri(T[a], T[b], T[c]); else tri(T[a], T[c], T[b]); }
  for (const [a, b, c] of capTri(bottom)) { if (ccw) tri(B[a], B[c], B[b]); else tri(B[a], B[b], B[c]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return place(new THREE.Mesh(g, m), p);
}
// Lathe around X (nose → tail): fuselages, missiles, pods. prof = [x, radius] pairs.
export function lathe(prof: V2[], m: THREE.Material, p: Place = {}, seg = 20, sy = 1, sz = 1): THREE.Mesh {
  const g = new THREE.LatheGeometry(prof.map(([x, r]) => new THREE.Vector2(Math.max(0.001, r), x)), seg);
  g.rotateZ(-Math.PI / 2); // lathe axis y → x
  g.scale(1, sy, sz);
  return place(new THREE.Mesh(g, m), p);
}
export function rod(a: [number, number, number], b: [number, number, number], r: number, m: THREE.Material): THREE.Mesh {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.copy(va.clone().add(vb).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  mesh.castShadow = true;
  return mesh;
}

export function group(p: Place = {}, ...kids: THREE.Object3D[]): THREE.Group {
  const g = place(new THREE.Group(), p); for (const k of kids) g.add(k); return g;
}
// Call fn for both lateral sides (s = +1 / -1) — most military hardware is symmetric about Z.
export function sides(fn: (s: 1 | -1) => void) { fn(1); fn(-1); }

// Small decal plane facing +normal: numbers, chevrons, faction emblems (canvas textures).
export function decal(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number, p: Place = {}): THREE.Mesh {
  const cv = document.createElement("canvas"); cv.width = 128; cv.height = Math.round(128 * (h / w));
  const ctx = cv.getContext("2d")!; draw(ctx, cv.width, cv.height);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  const m = new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  const mesh = place(new THREE.Mesh(new THREE.PlaneGeometry(w, h), m), p);
  mesh.castShadow = false;
  return mesh;
}
export const hexStr = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
