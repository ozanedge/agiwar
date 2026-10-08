// Aircraft unit models — fighters, bombers, attack helicopters, drones, hover platforms.
// See baker/README.md for the style guide. All flyers: origin at the airframe center (the client lifts
// them and draws the separately baked ground shadow). Airframes are shifted up so their underside sits
// above y≈1.5: the kit's height-AO/dust is keyed on model-space y, which suits ground vehicles but would
// grime an airframe centered on y=0.
import * as THREE from "three";
import { box, cyl, sphere, torus, prism, loft, slab, lathe, rod, group, sides, mat, materials, PALETTES, type Palette, type V2 } from "../kit";
import type { Model, ModelMeta } from "../render";

// ---------- aircraft paint ----------
const AIR_A: Palette = { ...PALETTES.anthropic, name: "air-anthropic", camo: [0x8e897e, 0x837e74, 0x7a756c, 0x969186], digital: false, camoScale: 44 };
const AIR_O: Palette = { ...PALETTES.openai, name: "air-openai", camo: [0x575d63, 0x51575d, 0x4b5157, 0x5c6268], digital: true, camoScale: 30 };

function airMats(p: Palette) {
  const lo = 0.5; // AO height — everything sits above it, so no ground grime on airframes
  return {
    skin: mat({ camo: p, rough: 0.55, metal: 0.25, dust: p.camo[2], aoH: lo }),
    skin2: mat({ color: p.camo[2], rough: 0.6, metal: 0.25, dust: p.camo[2], aoH: lo }), // darker panels / radome
    dark: mat({ color: 0x2c2f33, rough: 0.55, metal: 0.5, aoH: lo }),
    black: mat({ color: 0x141619, rough: 0.7, metal: 0.3, aoH: lo }),
    metal: mat({ color: 0x5c6268, rough: 0.35, metal: 0.85, aoH: lo }),
    burnt: mat({ color: 0x3d3a37, rough: 0.4, metal: 0.9, aoH: lo }), // nozzle titanium
    glass: mat({ color: 0x1a2a33, rough: 0.06, metal: 0.5, env: 1.6, aoH: lo }),
    gold: mat({ color: 0x5a4a26, rough: 0.08, metal: 0.8, env: 1.4, aoH: lo }), // gold-tinted stealth canopy
    lens: mat({ color: 0x0a0f14, rough: 0.05, metal: 0.2, emissive: 0x3fb8ff, emissiveI: 0.5, env: 1.2, aoH: lo }),
    marking: mat({ color: p.marking, rough: 0.55, metal: 0.05, aoH: lo }),
    white: mat({ color: 0xd9dcdf, rough: 0.5, metal: 0.1, aoH: lo }),
    olive: mat({ color: 0x4e5238, rough: 0.8, metal: 0.0, aoH: lo }),
    red: mat({ color: 0x300000, emissive: 0xff2a1a, emissiveI: 2.2, aoH: lo }),
    green: mat({ color: 0x002a10, emissive: 0x3aff7a, emissiveI: 2.2, aoH: lo }),
    energy: mat({ color: 0x0a2030, emissive: 0x66d8ff, emissiveI: 2.4, aoH: lo }),
    prop: new THREE.MeshStandardMaterial({ color: 0x6a7076, transparent: true, opacity: 0.13, roughness: 0.8, depthWrite: false }),
    blade: mat({ color: 0x3a3f44, rough: 0.6, metal: 0.3, aoH: lo }),
  };
}
type AM = ReturnType<typeof airMats>;
const cache = new Map<string, AM>();
const AMA = () => { if (!cache.has("a")) cache.set("a", airMats(AIR_A)); return cache.get("a")!; };
const AIR_A2: Palette = { ...AIR_A, name: "air-anthropic-dark", camo: [0x4b4e4d, 0x464948, 0x414443, 0x515453] };
const AMA2 = () => { if (!cache.has("a2")) cache.set("a2", airMats(AIR_A2)); return cache.get("a2")!; };
const AMO = () => { if (!cache.has("o")) cache.set("o", airMats(AIR_O)); return cache.get("o")!; };

// ---------- helpers ----------
const mirrorZ = (pts: V2[]): V2[] => pts.map(([x, z]) => [x, -z] as V2);
// both wing halves from the right-hand (z>0) outline
function wings(g: THREE.Group, outline: V2[], th: number, m: THREE.Material, y: number, dihedral = 0) {
  sides((s) => g.add(slab(s > 0 ? outline : mirrorZ(outline), th, m, { y, rx: -s * dihedral }, Math.min(0.2, th / 3))));
}
// vertical / canted fin from a side profile (x forward, y up), thickness th, rooted at (x0, y0, z)
function fin(prof: V2[], th: number, m: THREE.Material, p: { y: number; z: number; cant?: number }, tip?: THREE.Material): THREE.Group {
  const g = group({ y: p.y, z: p.z, rx: p.cant ?? 0 });
  g.add(prism(prof, th, m, {}, 0.1));
  if (tip) { // painted tip: the top-most segment of the profile
    const top = prof.reduce((a, b) => (b[1] > a[1] ? b : a));
    g.add(box(2.2, 0.6, th + 0.06, tip, { x: top[0] - 0.8, y: top[1] - 0.35 }, 0.05));
  }
  return g;
}
function nozzle(g: THREE.Group, m: AM, x: number, y: number, z: number, r: number, len = 2.6) {
  g.add(cyl(r * 0.92, len, m.burnt, { x: x - len / 2, y, z }, "x", 18, r));
  g.add(torus(r * 0.86, 0.14, m.metal, { x: x - len, y, z, ry: Math.PI / 2 }));
  g.add(cyl(r * 0.7, 0.2, m.black, { x: x - len + 0.05, y, z }, "x", 16));
}
function missile(len: number, r: number, body: THREE.Material, fins: THREE.Material, p: { x: number; y: number; z: number }, tip?: THREE.Material): THREE.Group {
  const g = group(p);
  g.add(lathe([[len / 2, 0], [len / 2 - r * 2.5, r], [-len / 2, r], [-len / 2 - 0.01, 0]], body, {}, 10));
  if (tip) g.add(lathe([[len / 2 + 0.01, 0], [len / 2 - r * 1.6, r * 0.95], [len / 2 - r * 1.7, 0]], tip, {}, 10));
  for (const a of [0, Math.PI / 2]) g.add(box(r * 3, 0.06, r * 4.4, fins, { x: -len / 2 + r * 1.6, rx: a + Math.PI / 4 }, 0.02));
  return g;
}
function canopy(g: THREE.Group, m: THREE.Material, frame: THREE.Material, x0: number, x1: number, r: number, y: number, sz = 0.8) {
  const L = x0 - x1;
  g.add(lathe([[x0, 0], [x0 - L * 0.15, r * 0.7], [x0 - L * 0.45, r], [x1 + L * 0.15, r * 0.85], [x1, 0]], m, { y }, 18, 0.9, sz));
  g.add(box(0.25, r * 0.9, r * 2 * sz + 0.1, frame, { x: x1 + L * 0.45, y: y + r * 0.45 }, 0.05)); // canopy bow frame
}
// place an airframe so its underside sits at y≥1.5, return the lift applied
function finish(root: THREE.Group, meta: ModelMeta, minY = 1.5): Model {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root);
  const dy = minY - b.min.y;
  root.position.y += dy;
  const up = (v?: [number, number, number] | [number, number, number, number]) => { if (v) v[1] += dy; };
  up(meta.muzzle); up(meta.wingtip); up(meta.rotor);
  return { root: group({}, root), flyer: true, meta };
}

// ================= FIXED-WING =================

// F-35A-like stealth multirole: wide blended fuselage, trapezoid wing, canted twin tails, single engine.
function f35(m: AM): Model {
  const g = group();
  g.add(lathe([[24, 0], [21.5, 0.9], [18, 1.8], [13, 2.6], [7, 3.3], [0, 3.6], [-10, 3.6], [-17, 3.1], [-21.5, 2.4], [-23, 2.1]], m.skin, {}, 22, 0.62, 1.3));
  g.add(slab([[20, 0.4], [10, 3.4], [4, 4.6], [-4, 4.8], [-4, -4.8], [4, -4.6], [10, -3.4], [20, -0.4]], 0.7, m.skin, { y: -0.2 })); // chined forebody
  wings(g, [[5, 3.2], [-7.5, 16], [-10.8, 16], [-13.5, 3.2]], 0.55, m.skin, 0.1);
  wings(g, [[-15, 2.6], [-20, 9.4], [-22.6, 9.4], [-23, 2.4]], 0.4, m.skin, 0.0);
  sides((s) => g.add(fin([[0, 0], [-3.6, 6.4], [-6.0, 6.4], [-7.2, 0]], 0.35, m.skin, { y: 1.6, z: s * 3.0, cant: -s * 0.45 }, m.marking).translateX(-14)));
  sides((s) => g.add(box(5.5, 1.6, 0.9, m.skin2, { x: 7.6, y: 0.5, z: s * 3.9, ry: s * 0.12 }, 0.35))); // DSI intake fairings
  sides((s) => g.add(box(0.9, 1.1, 1.0, m.black, { x: 10.3, y: 0.5, z: s * 3.9 }, 0.2)));
  canopy(g, m.gold, m.dark, 17.8, 9.5, 1.35, 1.55);
  nozzle(g, m, -22.8, 0.2, 0, 1.75, 3.2);
  g.add(box(4, 0.08, 1.2, m.skin2, { x: -2, y: 2.3 }, 0.03)); // spine panel
  sides((s) => g.add(box(1.4, 0.1, 0.5, m.marking, { x: -9.6, y: 0.4, z: s * 15.6 }, 0.03))); // wingtip flash
  return finish(g, { wingtip: [-9.2, 0.2, 16], muzzle: [19, 0.6, 2.2] });
}

// F-22-like air-dominance fighter: diamond wing, big canted tails, caret intakes, 2D nozzles.
function f22(m: AM): Model {
  const g = group();
  g.add(lathe([[30, 0], [27, 1.0], [22, 2.1], [15, 2.9], [7, 3.5], [-5, 3.7], [-16, 3.7], [-24, 3.2], [-27.5, 3.0]], m.skin, {}, 24, 0.58, 1.42));
  // chined forebody blending into the wide fuselage
  g.add(slab([[28, 0.3], [19, 2.8], [11, 4.9], [3, 6.6], [-16, 6.6], [-16, -6.6], [3, -6.6], [11, -4.9], [19, -2.8], [28, -0.3]], 0.8, m.skin, { y: -0.35 }, 0.25));
  // broad clipped-diamond wing (forward-swept trailing edge) + stabilators
  wings(g, [[8, 5.0], [-12, 21.5], [-14.8, 21.5], [-17.5, 5.0]], 0.6, m.skin, 0.0);
  wings(g, [[-18, 4.0], [-25, 13.2], [-28.8, 12.6], [-29.8, 3.6]], 0.42, m.skin, -0.08);
  // big, strongly canted twin tails
  sides((s) => g.add(fin([[0, 0], [-5.2, 9.2], [-9.0, 9.2], [-10.4, 0]], 0.42, m.skin, { y: 1.6, z: s * 5.0, cant: -s * 0.5 }, m.marking).translateX(-15)));
  // caret intakes: raked trapezoid trunks with dark slanted mouths
  sides((s) => {
    const zi = 5.0, zo = 7.2;
    g.add(loft([[13, zi], [13, zo], [1, zo], [1, zi]].map(([x, z]) => [x, s * z] as V2), -1.1, [[14.4, zi], [13.2, zo - 0.4], [1, zo - 0.6], [1, zi]].map(([x, z]) => [x, s * z] as V2), 1.5, m.skin));
    g.add(box(0.5, 2.3, 2.0, m.black, { x: 13.7, y: 0.2, z: s * 6.0, ry: s * 0.55, rz: 0.25 }, 0.08));
  });
  canopy(g, m.gold, m.dark, 23.5, 13, 1.6, 1.55, 0.85);
  // wide 2D thrust-vectoring nozzles
  sides((s) => {
    g.add(box(4.0, 1.3, 3.4, m.burnt, { x: -29.2, y: 0.1, z: s * 2.4 }, 0.15));
    g.add(box(0.25, 0.85, 2.9, m.black, { x: -31.2, y: 0.1, z: s * 2.4 }, 0.05));
    g.add(box(4.2, 0.2, 3.5, m.dark, { x: -29.3, y: 0.85, z: s * 2.4 }, 0.06));
  });
  g.add(box(6, 0.08, 1.6, m.skin2, { x: -4, y: 2.2 }, 0.03)); // spine panel
  sides((s) => g.add(box(1.8, 0.1, 0.6, m.marking, { x: -13.6, y: 0.35, z: s * 21.0 }, 0.03)));
  return finish(g, { wingtip: [-13.4, 0.3, 21.5], muzzle: [18, 1.0, 5.2] });
}

// F-15E-like strike fighter: rectangular intakes, clipped delta-ish wing, twin vertical tails,
// conformal fuel tanks, two-seat canopy, and a long-range standoff missile on the centerline.
function f15e(m: AM): Model {
  const g = group();
  g.add(lathe([[28, 0], [25, 0.8], [21, 1.6], [16, 2.0], [10, 2.3], [4, 2.6], [-14, 2.6], [-24, 2.4]], m.skin, { y: 0.5 }, 22, 0.85, 1.0));
  sides((s) => {
    g.add(box(10, 2.6, 2.6, m.skin, { x: 4, y: 0.2, z: s * 3.3 }, 0.4));                       // intake trunks
    g.add(box(0.5, 2.2, 2.2, m.black, { x: 9.0, y: 0.2, z: s * 3.4, rz: 0.2 }, 0.1));
    g.add(box(18, 2.3, 2.6, m.skin, { x: -10, y: 0.0, z: s * 3.2 }, 0.8));                   // engine nacelles
    g.add(lathe([[4, 0], [2, 1.1], [-12, 1.1], [-13, 0.6]], m.skin2, { x: -2, y: 1.5, z: s * 4.6 }, 14)); // conformal tanks
    nozzle(g, m, -19, 0.0, s * 2.3, 1.25, 2.4);
  });
  wings(g, [[1.5, 4.5], [-9.5, 19.5], [-13.5, 19.5], [-14.5, 4.5]], 0.6, m.skin, 0.4);
  wings(g, [[-15.5, 3.5], [-19.5, 10.5], [-22.5, 10.5], [-22, 3.5]], 0.4, m.skin, 0.0);
  sides((s) => g.add(fin([[0, 0], [-3.5, 8.0], [-6.2, 8.0], [-7.6, 0]], 0.38, m.skin, { y: 1.7, z: s * 3.6 }, m.marking).translateX(-13.5)));
  canopy(g, m.glass, m.dark, 21.5, 9.5, 1.6, 2.2, 0.8);
  // standoff cruise missile under the centerline + pylon
  g.add(box(6, 0.8, 0.6, m.dark, { x: -2, y: -1.8 }, 0.1));
  g.add(missile(20, 0.95, m.white, m.dark, { x: -2, y: -2.8, z: 0 }, m.dark));
  sides((s) => { // long-range missiles on the wing pylons (the "sniper" load) + wingtip AAM rails
    g.add(box(4, 0.7, 0.4, m.dark, { x: -6, y: -0.2, z: s * 9.5 }, 0.08));
    g.add(missile(13, 0.7, m.white, m.dark, { x: -5, y: -1.2, z: s * 9.5 }, m.dark));
    g.add(missile(7, 0.42, m.white, m.dark, { x: -9, y: -0.3, z: s * 14.5 }, m.dark));
  });
  sides((s) => g.add(box(1.4, 0.1, 0.5, m.marking, { x: -11.4, y: 0.75, z: s * 19.1 }, 0.03)));
  return finish(g, { wingtip: [-11.5, 0.6, 19.5], muzzle: [8, -2.8, 0] });
}

// Eurofighter-like canard delta with a full air-to-air load.
function typhoon(m: AM): Model {
  const g = group();
  g.add(lathe([[25, 0], [22, 0.9], [17, 1.8], [10, 2.5], [2, 2.9], [-12, 3.0], [-21, 2.7], [-23, 2.5]], m.skin, {}, 22, 0.75, 1.05));
  g.add(box(9, 2.0, 5.0, m.skin, { x: 4, y: -1.5 }, 0.6)); // chin intake box
  g.add(box(0.4, 1.4, 4.0, m.black, { x: 8.6, y: -1.6 }, 0.1));
  wings(g, [[3, 2.6], [-14.5, 16], [-16.5, 15.6], [-17, 2.6]], 0.55, m.skin, 0.0);
  sides((s) => g.add(slab(s > 0 ? [[15, 2.0], [11.8, 6.6], [10.6, 6.6], [10.6, 2.0]] : mirrorZ([[15, 2.0], [11.8, 6.6], [10.6, 6.6], [10.6, 2.0]]), 0.3, m.skin, { y: 0.9 }))); // canards
  g.add(fin([[0, 0], [-5, 8.4], [-7.6, 8.4], [-9.0, 0]], 0.42, m.skin, { y: 1.8, z: 0 }, m.marking).translateX(-12.5));
  canopy(g, m.glass, m.dark, 19.5, 11, 1.5, 1.7);
  sides((s) => {
    nozzle(g, m, -22.5, -0.2, s * 1.3, 1.25, 2.6);
    g.add(missile(8, 0.42, m.white, m.dark, { x: -12.5, y: 0.2, z: s * 16.4 }, m.dark)); // wingtip pods/AAMs
    g.add(missile(8.5, 0.44, m.white, m.dark, { x: -6, y: -0.8, z: s * 9 }, m.dark));
    g.add(missile(8.5, 0.44, m.white, m.dark, { x: -8, y: -0.8, z: s * 12.5 }, m.dark));
    g.add(missile(9, 0.5, m.white, m.dark, { x: -2, y: -2.4, z: s * 2.0 }, m.dark));     // semi-recessed BVR
  });
  return finish(g, { wingtip: [-14.5, 0.2, 16.4], muzzle: [11, 0.4, 2.6] });
}

// JAS-39 Gripen-like light canard delta (OpenAI "Venom Wing").
function gripen(m: AM): Model {
  const g = group();
  g.add(lathe([[22, 0], [19.5, 0.8], [15, 1.6], [8, 2.2], [0, 2.4], [-12, 2.3], [-19, 2.0], [-20, 1.8]], m.skin, {}, 20, 0.8, 1.0));
  sides((s) => { g.add(box(7, 2.0, 1.8, m.skin, { x: 3, y: 0.0, z: s * 2.4 }, 0.5)); g.add(box(0.4, 1.6, 1.4, m.black, { x: 6.4, y: 0.0, z: s * 2.5 }, 0.08)); });
  wings(g, [[1, 2.4], [-11, 13.6], [-13.4, 13.2], [-13.8, 2.4]], 0.5, m.skin, -0.2);
  sides((s) => g.add(slab(s > 0 ? [[6.8, 2.6], [3.4, 7.2], [2.2, 7.2], [2.0, 2.6]] : mirrorZ([[6.8, 2.6], [3.4, 7.2], [2.2, 7.2], [2.0, 2.6]]), 0.3, m.skin, { y: 0.9 })));
  g.add(fin([[0, 0], [-4.6, 7.0], [-6.8, 7.0], [-8.0, 0]], 0.4, m.skin, { y: 1.4, z: 0 }, m.marking).translateX(-11));
  canopy(g, m.glass, m.dark, 16.5, 9, 1.35, 1.45);
  nozzle(g, m, -19.5, 0.0, 0, 1.45, 2.6);
  sides((s) => { g.add(missile(7, 0.4, m.white, m.dark, { x: -10.5, y: -0.1, z: s * 13.8 }, m.dark)); g.add(missile(7.5, 0.42, m.white, m.dark, { x: -6, y: -0.9, z: s * 8.5 }, m.dark)); });
  return finish(g, { wingtip: [-11.5, 0.1, 13.8], muzzle: [10, 0.3, 2.4] });
}

// YF-23-like dark interceptor (OpenAI "Banshee"): long nose, diamond wing, ruddervator V-tails, nozzle troughs.
function yf23(m: AM): Model {
  const g = group();
  g.add(lathe([[29, 0], [25, 0.9], [20, 1.7], [13, 2.4], [5, 2.8], [-6, 2.8], [-18, 2.3], [-24, 1.8]], m.skin, {}, 22, 0.7, 1.1));
  sides((s) => g.add(lathe([[8, 0], [5, 1.6], [-14, 2.0], [-24, 1.7], [-25, 1.2]], m.skin, { x: -2, y: 0.4, z: s * 4.8 }, 16, 0.85, 1.15))); // engine nacelles
  wings(g, [[4, 4.0], [-12.5, 17.2], [-15.5, 17.2], [-21.5, 4.0]], 0.55, m.skin, 0.0);
  sides((s) => g.add(fin([[0, 0], [-5.8, 7.2], [-9.0, 7.2], [-9.8, 0]], 0.4, m.skin, { y: 1.6, z: s * 5.2, cant: -s * 0.82 }, m.marking).translateX(-15)));
  sides((s) => { g.add(box(7, 0.25, 2.2, m.burnt, { x: -23, y: 1.5, z: s * 4.8 }, 0.08)); g.add(box(1, 1.4, 1.8, m.black, { x: 4.6, y: -0.6, z: s * 5.0 }, 0.1)); });
  canopy(g, m.gold, m.dark, 22, 13, 1.3, 1.65);
  sides((s) => g.add(box(1.6, 0.1, 0.5, m.marking, { x: -14, y: 0.35, z: s * 16.8 }, 0.03)));
  return finish(g, { wingtip: [-14, 0.2, 17.2], muzzle: [17, 0.6, 2.4] });
}

// B-2-like flying wing (OpenAI "Stealth Bomber"): sawtooth trailing edge, blended center body, dorsal intakes.
function b2(m: AM): Model {
  const g = group();
  const half: V2[] = [[24, 0.01], [-8.5, 37.5], [-11.5, 37.5], [-3.5, 25.5], [-11, 14.5], [-6.5, 8], [-13, 0.01]];
  const out: V2[] = [...half, ...mirrorZ(half).reverse().slice(1, -1)];
  g.add(slab(out, 0.9, m.skin, { y: 0 }, 0.3));
  // blended center body: tapered loft rising out of the wing
  g.add(loft([[22, 0], [8, 9.5], [-6, 9], [-11, 0], [-6, -9], [8, -9.5]], 0.6, [[16, 0], [6, 4.6], [-4, 4.4], [-8, 0], [-4, -4.4], [6, -4.6]], 2.6, m.skin));
  g.add(box(3.2, 0.4, 3.0, m.glass, { x: 14.2, y: 2.25, ry: 0 }, 0.15)); // cockpit windows
  sides((s) => {
    g.add(loft([[6, 6], [6, 9], [-2, 9.5], [-2, 5.5]].map(([x, z]) => [x, s * z] as V2), 0.6, [[4, 6.4], [4, 8.6], [-2, 9.0], [-2, 6.0]].map(([x, z]) => [x, s * z] as V2), 1.9, m.skin)); // intake humps
    g.add(box(0.5, 0.6, 3.0, m.black, { x: 5.2, y: 1.45, z: s * 7.5 }, 0.08));
    g.add(box(5, 0.15, 3.4, m.burnt, { x: -7.5, y: 0.95, z: s * 7.2, ry: s * -0.15 }, 0.05)); // exhaust troughs
    g.add(box(1.6, 0.12, 0.6, m.marking, { x: -8.8, y: 0.95, z: s * 36.6, ry: s * 0.5 }, 0.03));
  });
  return finish(g, { wingtip: [-10, 0.5, 37.5], muzzle: [6, -0.4, 0] });
}

// Su-35 Flanker-like heavy air-superiority fighter (OpenAI "Tesla Jet").
function flanker(m: AM): Model {
  const g = group();
  g.add(lathe([[30, 0], [27, 0.9], [22, 1.7], [16, 2.2], [9, 2.4], [2, 2.2]], m.skin, { y: 1.0 }, 20, 0.95, 1.0)); // forward fuselage
  g.add(slab([[18, 0.8], [8, 4.4], [-4, 7.0], [-24, 6.6], [-26, 0], [-24, -6.6], [-4, -7.0], [8, -4.4], [18, -0.8]], 1.6, m.skin, { y: -0.2 }, 0.5)); // lifting body
  sides((s) => {
    g.add(box(9, 2.4, 3.0, m.skin, { x: 0, y: -1.6, z: s * 3.4 }, 0.4));        // under-wing intakes
    g.add(box(0.5, 2.0, 2.6, m.black, { x: 4.6, y: -1.6, z: s * 3.4 }, 0.1));
    g.add(lathe([[0, 2.0], [-18, 1.9], [-20, 1.5]], m.skin2, { x: -4, y: 0.0, z: s * 3.4 }, 16)); // engine nacelles
    nozzle(g, m, -24, 0.0, s * 3.4, 1.45, 2.6);
    g.add(fin([[0, 0], [-4.4, 8.6], [-7.0, 8.6], [-8.2, 0]], 0.42, m.skin, { y: 1.3, z: s * 4.6, cant: -s * 0.12 }, m.marking).translateX(-12));
    g.add(missile(8.5, 0.46, m.white, m.dark, { x: -8, y: -0.6, z: s * 11 }, m.dark));
    g.add(missile(8.5, 0.46, m.white, m.dark, { x: -10, y: -0.6, z: s * 14.5 }, m.dark));
    g.add(missile(6.5, 0.38, m.white, m.dark, { x: -12.5, y: 0.0, z: s * 19.2 }, m.dark));
  });
  wings(g, [[2, 6.2], [-10, 19.4], [-13.4, 19.4], [-15, 6.2]], 0.5, m.skin, 0.0);
  wings(g, [[-17, 6], [-22, 13], [-25, 13], [-26, 5.6]], 0.4, m.skin, 0.0);
  g.add(lathe([[0, 0.8], [-6, 0.7], [-7, 0.2]], m.skin2, { x: -24, y: 0.4 }, 12)); // tail stinger
  canopy(g, m.glass, m.dark, 24.5, 15, 1.5, 2.9);
  return finish(g, { wingtip: [-12.5, 0.2, 19.4], muzzle: [16, 1.4, 2.4] });
}

// ================= ROTORCRAFT =================

function skidGear(g: THREE.Group, m: AM, x0: number, x1: number, y: number, z: number) {
  sides((s) => {
    g.add(rod([x0, y, s * z], [x1, y, s * z], 0.22, m.dark));
    g.add(rod([x0, y, s * z], [x0 + 0.6, y + 0.6, s * z], 0.22, m.dark));
    for (const x of [x0 - 1.5, x1 + 2]) g.add(rod([x, y, s * z], [x, y + 2.4, s * (z - 1.0)], 0.2, m.dark));
  });
}
function rocketPod(m: AM, p: { x: number; y: number; z: number }): THREE.Group {
  const g = group(p);
  g.add(cyl(0.95, 4.2, m.skin2, {}, "x", 14));
  g.add(cyl(0.75, 0.15, m.black, { x: 2.1 }, "x", 12));
  g.add(cyl(0.98, 0.25, m.dark, { x: 1.6 }, "x", 14));
  return g;
}
function hellfires(m: AM, p: { x: number; y: number; z: number }): THREE.Group {
  const g = group(p);
  g.add(box(3.2, 0.4, 1.8, m.dark, { y: 0.55 }, 0.08));
  for (const a of [-0.45, 0.45]) for (const b of [0, -0.85]) g.add(missile(3.4, 0.32, m.olive, m.dark, { x: 0, y: b, z: a }, m.dark));
  return g;
}

// AH-1Z Viper / Tiger-like tandem attack helicopter (Anthropic "Gunship").
function viper(m: AM): Model {
  const g = group();
  g.add(lathe([[14, 0], [12.5, 1.4], [9, 2.4], [3, 2.8], [-3, 2.7], [-6, 1.8]], m.skin, { y: 0.0 }, 20, 1.15, 0.72)); // narrow tandem fuselage
  g.add(lathe([[-5, 1.3], [-15, 0.95], [-23, 0.65], [-24, 0.4]], m.skin, { y: 0.9 }, 14)); // tail boom
  canopy(g, m.glass, m.dark, 12.8, 8.2, 1.3, 2.3, 1.0);   // gunner (front)
  canopy(g, m.glass, m.dark, 7.8, 3.2, 1.4, 3.0, 1.0);    // pilot (stepped up)
  sides((s) => {
    g.add(box(6.5, 1.8, 1.6, m.skin, { x: -1.0, y: 2.6, z: s * 1.8 }, 0.6)); // engine nacelles
    g.add(cyl(0.7, 0.4, m.black, { x: -4.4, y: 2.8, z: s * 2.2 }, "x", 12));
    g.add(slab(s > 0 ? [[1.6, 1.4], [0.6, 7.6], [-1.4, 7.6], [-1.6, 1.4]] : mirrorZ([[1.6, 1.4], [0.6, 7.6], [-1.4, 7.6], [-1.6, 1.4]]), 0.4, m.skin, { y: 0.4 })); // stub wings
    g.add(rocketPod(m, { x: 0.2, y: -0.8, z: s * 4.6 }));
    g.add(hellfires(m, { x: 0.0, y: -0.8, z: s * 7.3 }));
    g.add(box(0.9, 0.12, 0.35, m.marking, { x: -0.6, y: 0.85, z: s * 7.2 }, 0.03));
  });
  g.add(cyl(0.6, 1.6, m.dark, { x: 0.8, y: 3.8 }, "y", 12)); // rotor mast
  g.add(cyl(1.1, 0.6, m.dark, { x: 0.8, y: 4.7 }, "y", 14)); // hub
  g.add(fin([[0, 0], [-1.6, 6.0], [-3.6, 6.0], [-3.2, 0]], 0.35, m.skin, { y: 1.2, z: 0 }, m.marking).translateX(-20.5));
  g.add(slab([[-19, 3.2], [-20.5, 3.2], [-20.5, -3.2], [-19, -3.2]], 0.3, m.skin, { y: 1.0 }));
  g.add(cyl(2.4, 0.1, m.prop, { x: -23, y: 5.4, z: 0.5 }, "z", 20)); // tail rotor disc
  g.add(sphere(1.0, m.dark, { x: 12.4, y: -1.6 }, 14)); // chin turret
  g.add(cyl(0.18, 3.6, m.metal, { x: 14.2, y: -1.7 }, "x", 8));
  g.add(sphere(0.75, m.lens, { x: 14.3, y: -0.5 }, 12)); // nose sensor
  skidGear(g, m, 7, -5, -3.4, 2.4);
  return finish(g, { rotor: [0.8, 5.0, 0, 18], muzzle: [16, -1.7, 0] });
}

// AH-64E Apache-like (OpenAI "Apache Gunship"): boxy sponsons, flat-plate canopy, mast radar, chain gun.
function apache(m: AM): Model {
  const g = group();
  g.add(loft([[14, 0.0], [11, 1.6], [3, 2.0], [-5, 1.6], [-7, 0], [-5, -1.6], [3, -2.0], [11, -1.6]], -1.6, [[12.5, 0], [10, 1.2], [3, 1.5], [-5, 1.3], [-6.5, 0], [-5, -1.3], [3, -1.5], [10, -1.2]], 2.0, m.skin));
  g.add(loft([[11.5, 0], [9.6, 1.25], [4, 1.35], [4, -1.35], [9.6, -1.25]], 1.95, [[10, 0], [9, 0.85], [6.0, 0.95], [6.0, -0.95], [9, -0.85]], 3.0, m.glass)); // front canopy
  g.add(loft([[6.5, 1.3], [1, 1.35], [1, -1.35], [6.5, -1.3]], 1.95, [[5.6, 0.95], [1.6, 1.0], [1.6, -1.0], [5.6, -0.95]], 3.8, m.glass)); // rear canopy
  g.add(lathe([[-5, 1.4], [-15, 1.0], [-23.5, 0.75], [-24.5, 0.4]], m.skin, { y: 0.6 }, 14));
  sides((s) => {
    g.add(box(9, 2.0, 1.8, m.skin, { x: 2.5, y: -0.4, z: s * 2.6 }, 0.5));   // avionics sponsons
    g.add(box(6, 2.0, 1.9, m.skin, { x: -1.5, y: 2.8, z: s * 2.4 }, 0.7));   // engine nacelles
    g.add(cyl(0.85, 0.3, m.black, { x: 1.6, y: 2.8, z: s * 2.4 }, "x", 12));
    g.add(box(1.8, 0.9, 0.6, m.burnt, { x: -4.6, y: 3.1, z: s * 2.9, ry: s * 0.5 }, 0.15)); // IR-suppressed exhaust
    g.add(slab(s > 0 ? [[1.4, 2.2], [0.8, 7.8], [-1.2, 7.8], [-1.6, 2.2]] : mirrorZ([[1.4, 2.2], [0.8, 7.8], [-1.2, 7.8], [-1.6, 2.2]]), 0.4, m.skin, { y: 0.6 }));
    g.add(hellfires(m, { x: 0.0, y: -0.6, z: s * 4.4 }));
    g.add(rocketPod(m, { x: 0.2, y: -0.6, z: s * 7.0 }));
    g.add(box(0.9, 0.12, 0.35, m.marking, { x: -0.6, y: 1.05, z: s * 7.4 }, 0.03));
    g.add(rod([5, -1.6, s * 2.6], [5, -3.6, s * 2.9], 0.25, m.dark));       // main gear
    g.add(cyl(0.9, 0.6, m.black, { x: 5, y: -3.6, z: s * 3.1 }, "z", 14));
  });
  g.add(cyl(0.6, 2.0, m.dark, { x: 0.6, y: 3.9 }, "y", 12));
  g.add(cyl(1.1, 0.6, m.dark, { x: 0.6, y: 4.9 }, "y", 14));
  const dome = sphere(1.6, m.skin2, { x: 0.6, y: 6.4 }, 18); dome.scale.set(1, 0.55, 1); g.add(dome); // Longbow radar
  g.add(fin([[0, 0], [-1.2, 5.6], [-3.4, 5.6], [-3.0, 0]], 0.35, m.skin, { y: 1.0, z: 0 }, m.marking).translateX(-21));
  g.add(slab([[-22.4, 3.0], [-24, 3.0], [-24, -3.0], [-22.4, -3.0]], 0.3, m.skin, { y: 6.4 })); // T-tail stabilator
  g.add(cyl(2.4, 0.1, m.prop, { x: -23.4, y: 4.2, z: -0.5 }, "z", 20));
  g.add(sphere(1.1, m.dark, { x: 12.6, y: -0.8 }, 14));   // TADS/PNVS nose turret
  g.add(sphere(0.6, m.lens, { x: 13.5, y: -0.6 }, 10));
  g.add(box(1.2, 0.8, 0.9, m.dark, { x: 7.5, y: -2.0 }, 0.15)); // M230 chain gun under the chin
  g.add(cyl(0.2, 4.2, m.metal, { x: 10.2, y: -2.1 }, "x", 8));
  return finish(g, { rotor: [0.6, 5.2, 0, 18.5], muzzle: [12.3, -2.1, 0] });
}

// MQ-8 Fire Scout-like unmanned recon helicopter (Anthropic "Orca Scout").
function fireScout(m: AM): Model {
  const g = group();
  const pale = mat({ color: 0xc4c5c1, rough: 0.5, metal: 0.2, aoH: 0.5 });
  const S = 1.4; // built at base size, scaled up so the recon unit reads clearly
  // MQ-8C (Bell 407 airframe): bulbous pale cabin, dark belly + nose, slim tail boom
  g.add(lathe([[7.6, 0], [6.8, 1.3], [4.6, 2.2], [1, 2.45], [-2, 2.3], [-4, 1.5]], pale, {}, 22, 1.05, 0.9));
  g.add(lathe([[7.5, 0], [6.6, 1.2], [4, 1.8], [-1, 1.9], [-3.4, 1.2]], m.skin2, { y: -0.95 }, 22, 0.6, 0.86)); // dark belly + chin
  g.add(box(4.2, 1.3, 2.6, m.dark, { x: -0.5, y: 2.6 }, 0.5));   // engine fairing
  g.add(box(0.6, 0.6, 1.2, m.black, { x: -2.8, y: 2.7 }, 0.15)); // exhaust
  g.add(lathe([[-3.5, 0.85], [-10.5, 0.48], [-11.5, 0.3]], pale, { y: 0.7 }, 14));
  g.add(fin([[0, 0], [-1.0, 3.4], [-2.4, 3.4], [-2.2, 0]], 0.28, pale, { y: 0.9, z: 0 }, m.marking).translateX(-9.2));
  g.add(slab([[-8.0, 2.2], [-9.2, 2.2], [-9.2, -2.2], [-8.0, -2.2]], 0.22, pale, { y: 0.7 }));
  sides((s) => g.add(box(0.5, 0.9, 0.12, m.marking, { x: -8.6, y: 1.2, z: s * 2.2 }, 0.03))); // stab end plates
  g.add(cyl(1.5, 0.08, m.prop, { x: -10.9, y: 2.2, z: 0.45 }, "z", 18));                 // tail rotor disc
  g.add(box(0.18, 3.0, 0.1, m.blade, { x: -10.9, y: 2.2, z: 0.5, rx: 0.5 }, 0.03));
  g.add(cyl(0.45, 1.3, m.dark, { x: 0, y: 3.6 }, "y", 10));      // mast
  g.add(cyl(0.8, 0.45, m.dark, { x: 0, y: 4.3 }, "y", 12));      // hub
  // prominent chin EO/IR sensor ball
  g.add(cyl(0.22, 0.8, m.dark, { x: 5.6, y: -1.9 }, "y", 8));
  g.add(sphere(1.25, m.dark, { x: 5.6, y: -2.9 }, 16));
  g.add(sphere(0.6, m.lens, { x: 6.55, y: -2.9 }, 12));
  // antennas
  g.add(rod([2.5, 2.3, 0], [2.0, 4.0, 0], 0.08, m.dark));
  sides((s) => g.add(rod([-5, 0.9, s * 0.7], [-6, 2.6, s * 1.0], 0.07, m.dark)));
  g.add(box(1.6, 0.12, 0.5, m.white, { x: 3.0, y: -2.3, z: 0 }, 0.03)); // belly datalink blade
  skidGear(g, m, 4.0, -2.6, -2.5, 1.8);
  const root = group({ sx: S, sy: S, sz: S }, g);
  return finish(root, { rotor: [0, 4.55 * S, 0, 9 * S], muzzle: [6.55 * S, -2.9 * S, 0] });
}

// ================= HEAVY GUNSHIP + DRONES =================

// Armored twin-boom heavy gunship (OpenAI "Heavy Gunship") with a big tail autocannon firing aft.
function heavyGunship(m: AM): Model {
  const g = group();
  g.add(lathe([[17, 0], [15, 1.8], [11, 3.2], [3, 3.8], [-6, 3.6], [-11, 2.6], [-13, 1.8]], m.skin, {}, 22, 0.95, 1.0));
  canopy(g, m.glass, m.dark, 15.6, 10.5, 1.8, 1.9, 1.1);
  wings(g, [[4, 3.2], [3, 18.5], [-2.5, 18.5], [-4, 3.2]], 0.8, m.skin, 2.2);
  sides((s) => {
    g.add(lathe([[10, 0], [8.5, 1.4], [5, 1.9], [-14, 1.5], [-19, 0.9]], m.skin, { y: 2.2, z: s * 7.5 }, 16)); // booms + nacelles
    g.add(cyl(0.6, 1.0, m.dark, { x: 10.2, y: 2.2, z: s * 7.5 }, "x", 10));
    g.add(cyl(4.6, 0.12, m.prop, { x: 10.8, y: 2.2, z: s * 7.5 }, "x", 24)); // prop disc
    for (let k = 0; k < 2; k++) g.add(box(0.14, 8.6, 0.45, m.blade, { x: 10.9, y: 2.2, z: s * 7.5, rx: (k * Math.PI) / 2 + s * 0.3 }, 0.06)); // blades (blurred)
    g.add(fin([[0, 0], [-1.4, 5.0], [-3.6, 5.0], [-4, 0]], 0.38, m.skin, { y: 3.0, z: s * 7.5 }, m.marking).translateX(-15));
    for (let k = 0; k < 4; k++) g.add(box(2.6, 0.3, 1.6, m.skin2, { x: 6 - k * 3, y: 3.5, z: s * 2.2 + s * 0.4, rx: s * 0.6 }, 0.1)); // armor plates
    g.add(box(1.6, 0.12, 0.5, m.marking, { x: -0.8, y: 3.4 + 0.75, z: s * 17.8 }, 0.03));
  });
  g.add(slab([[-16.5, 8.5], [-19, 8.5], [-19, -8.5], [-16.5, -8.5]], 0.45, m.skin, { y: 7.0 })); // tail plane joining the fins
  // big rear autocannon turret in the tail cone
  g.add(sphere(2.0, m.skin2, { x: -12, y: 0.6 }, 16));
  g.add(box(3, 1.4, 1.6, m.dark, { x: -14, y: 0.6 }, 0.2));
  g.add(cyl(0.55, 9, m.metal, { x: -19.5, y: 0.6 }, "x", 12));
  g.add(cyl(0.85, 1.6, m.dark, { x: -23.5, y: 0.6 }, "x", 12)); // muzzle brake
  sides((s) => g.add(cyl(0.3, 2.4, m.dark, { x: 6, y: -2.6, z: s * 1.4 }, "x", 8))); // side sponson guns
  return finish(g, { wingtip: [0, 3.0, 18.5], muzzle: [-24.5, 0.6, 0] });
}

// Military FPV / loitering quadcopter with a shaped-charge warhead (Anthropic "Drone Swarm").
function fpv(m: AM): Model {
  const g = group();
  for (const [x, z] of [[2.6, 2.6], [2.6, -2.6], [-2.6, 2.6], [-2.6, -2.6]]) {
    g.add(rod([0, 0.3, 0], [x, 0.3, z], 0.32, m.dark));
    g.add(cyl(0.55, 0.8, m.black, { x, y: 0.7, z }, "y", 10));
    g.add(cyl(1.9, 0.06, m.prop, { x, y: 1.15, z }, "y", 20));
  }
  g.add(box(3.4, 1.0, 1.8, m.skin, { y: 0.4 }, 0.3));
  g.add(lathe([[4.4, 0], [3.8, 0.55], [1.4, 0.65], [0.8, 0.4]], m.olive, { y: 0.1 }, 12)); // warhead
  g.add(box(0.6, 0.6, 0.6, m.dark, { x: 1.6, y: 1.1 }, 0.1));
  g.add(sphere(0.25, m.lens, { x: 1.95, y: 1.15 }, 8));
  g.add(box(0.8, 0.08, 0.3, m.marking, { x: -1, y: 0.92 }, 0.02));
  return finish(g, { muzzle: [4.4, 0.1, 0] });
}

// open cylindrical fan duct (double-sided shell), y = bottom
function duct(r: number, h: number, mt: THREE.MeshStandardMaterial, p: { x: number; y: number; z: number }): THREE.Mesh {
  const m2 = mt.clone(); m2.side = THREE.DoubleSide; m2.onBeforeCompile = mt.onBeforeCompile; m2.customProgramCacheKey = mt.customProgramCacheKey;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.94, h, 28, 1, true), m2);
  mesh.position.set(p.x, p.y + h / 2, p.z); mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}
// Heavy armored ducted-fan hover weapons platform (orb family).
function hoverPlatform(m: AM, variant: "a" | "o"): Model {
  const g = group();
  const D = 9.5;
  for (const [x, z] of [[D, D], [D, -D], [-D, D], [-D, -D]]) {
    g.add(duct(4.2, 1.8, m.skin2, { x, y: 0.0, z }));
    g.add(torus(4.2, 0.28, m.skin, { x, y: 1.8, z, rx: Math.PI / 2 }));
    g.add(cyl(3.6, 0.15, m.prop, { x, y: 0.9, z }, "y", 24));
    g.add(cyl(0.8, 1.0, m.dark, { x, y: 0.9, z }, "y", 12));
    for (const a of [0, Math.PI / 2]) g.add(box(7.6, 0.2, 0.3, m.dark, { x, y: 0.9, z, ry: a }, 0.05));
    g.add(rod([x * 0.45, 1.4, z * 0.45], [x * 0.78, 1.0, z * 0.78], 0.55, m.skin2)); // pylon arm
  }
  if (variant === "a") {
    g.add(loft([[8, 0], [5, 6.2], [-6, 6.2], [-9, 0], [-6, -6.2], [5, -6.2]], -0.6, [[6.4, 0], [4, 4.8], [-5, 4.8], [-7.2, 0], [-5, -4.8], [4, -4.8]], 3.6, m.skin));
    g.add(box(8, 2.0, 5.4, m.skin, { x: -0.5, y: 4.6 }, 0.6));            // turret
    sides((s) => g.add(box(24, 0.7, 0.6, m.metal, { x: 14, y: 4.8, z: s * 0.85 }, 0.15))); // twin railgun rails
    for (let k = 0; k < 3; k++) g.add(box(1.2, 1.5, 2.4, m.dark, { x: 7 + k * 5.5, y: 4.8 }, 0.15)); // rail clamps
    for (let k = 0; k < 3; k++) g.add(box(0.3, 0.3, 1.0, m.energy, { x: 7.7 + k * 5.5, y: 5.6 }, 0.05)); // charge lights
    g.add(box(1.2, 1.4, 2.6, m.dark, { x: 26, y: 4.8 }, 0.2));
    g.add(rod([-4, 5.6, 2.2], [-4.5, 10, 2.4], 0.12, m.dark)); g.add(sphere(0.7, m.lens, { x: -4.5, y: 10.2, z: 2.4 }, 10));
    g.add(box(2.4, 0.08, 1.8, m.marking, { x: -3.5, y: 5.62, z: -1.2 }, 0.02));
    return finish(g, { muzzle: [27, 4.8, 0] });
  }
  g.add(loft([[7, 4], [4, 7], [-4, 7], [-7, 4], [-7, -4], [-4, -7], [4, -7], [7, -4]], -0.6, [[5.4, 3.2], [3.2, 5.4], [-3.2, 5.4], [-5.4, 3.2], [-5.4, -3.2], [-3.2, -5.4], [3.2, -5.4], [5.4, -3.2]], 3.4, m.skin));
  const dome = sphere(3.6, m.skin2, { x: -1, y: 3.4 }, 20); dome.scale.set(1, 0.6, 1); g.add(dome); // sensor dome
  for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) g.add(box(1.0, 0.25, 1.0, m.black, { x: -4.6 + j * 1.25, y: 3.5, z: (i ? 1 : -1) * 4.4 }, 0.05)); // VLS cells
  g.add(box(6, 1.8, 2.6, m.skin, { x: 4.5, y: 4.0 }, 0.4));
  g.add(cyl(0.65, 20, m.metal, { x: 17, y: 4.1 }, "x", 14));            // long cannon
  g.add(cyl(1.0, 2.0, m.dark, { x: 27.2, y: 4.1 }, "x", 14));
  g.add(cyl(1.15, 3, m.dark, { x: 9.5, y: 4.1 }, "x", 14));
  g.add(rod([-3, 5.2, -2.5], [-3.6, 10.6, -2.8], 0.12, m.dark)); g.add(box(1.6, 0.7, 0.4, m.dark, { x: -3.6, y: 10.8, z: -2.8 }, 0.1));
  g.add(box(2.0, 0.08, 1.6, m.marking, { x: 1.8, y: 4.92 }, 0.02));
  return finish(g, { muzzle: [28.2, 4.1, 0] });
}

export const AIR: Record<string, () => Model> = {
  jet: () => f35(AMA()),
  interceptor: () => f22(AMA2()),
  wraith: () => f15e(AMA()),
  firejet: () => typhoon(AMA()),
  nod_jet: () => gripen(AMO()),
  nod_interceptor: () => yf23(AMO()),
  nod_wraith: () => b2(AMO()),
  nod_firejet: () => flanker(AMO()),
  gunship: () => viper(AMA()),
  nod_gunship: () => apache(AMO()),
  nod_dronewing: () => heavyGunship(AMO()),
  drone: () => fireScout(AMA()),
  dronewing: () => fpv(AMA()),
  singularity: () => hoverPlatform(airMats(PALETTES.anthropic), "a"),
  nod_singularity: () => hoverPlatform(airMats(PALETTES.openai), "o"),
};
void materials;
