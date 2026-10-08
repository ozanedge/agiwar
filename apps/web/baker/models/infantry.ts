// Infantry unit models — see baker/README.md for the style guide.
// A rigged soldier (hips → legs with knees; upper body leaning into a combat posture) carrying a
// faction-specific kit and weapon. 5 frames: 0 = idle stance, 1..4 = stride cycle (meta.walk).
import * as THREE from "three";
import { box, cyl, sphere, group, sides, mat, materials, PALETTES, type Mats, type Palette } from "../kit";
import type { Model } from "../render";

type V3 = [number, number, number];

// Capsule limb between two points (joints overlap naturally through the caps).
export function limb(a: V3, b: V3, r: number, m: THREE.Material): THREE.Mesh {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = Math.max(0.01, va.distanceTo(vb));
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), m);
  mesh.position.copy(va.clone().add(vb).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

interface Kit {
  M: Mats; P: Palette;
  uniform: THREE.Material; gear: THREE.Material; gun: THREE.Material; boots: THREE.Material; gloves: THREE.Material; mark: THREE.Material;
  oai: boolean;
}
function kitFor(p: Palette): Kit {
  const M = materials(p), oai = p.name === "openai";
  return {
    M, P: p, oai,
    uniform: oai ? M.camo : mat({ camo: { ...p, name: "anthropic-uniform", camo: [0xcdb991, 0xbba57d, 0xa48f68, 0xdac8a2] }, rough: 0.85, metal: 0.02, dust: 0x8a7a5c, aoH: 3 }),
    gear: mat({ color: oai ? 0x1d2023 : 0x4a3720, rough: 0.85, metal: 0.05, dust: p.dust, aoH: 2 }),
    gun: mat({ color: 0x17191b, rough: 0.38, metal: 0.65, aoH: 1 }),
    boots: mat({ color: oai ? 0x17181a : 0x2e261c, rough: 0.9, metal: 0, dust: p.dust, aoH: 2 }),
    gloves: mat({ color: oai ? 0x1a1c1e : 0x2c261e, rough: 0.85, metal: 0, aoH: 1 }),
    mark: M.marking,
  };
}

// Leg: hip pivot → thigh → knee pivot → shin → boot. set(thigh, knee) swings it (radians; + = forward).
interface Leg { g: THREE.Group; knee: THREE.Group; set: (thigh: number, bend: number) => void }
function leg(K: Kit, z: number, hipY: number, tl: number, sl: number, r: number): Leg {
  const g = group({ y: hipY, z });
  g.add(limb([0, 0, 0], [0, -tl, 0], r, K.uniform));
  const knee = group({ y: -tl }); g.add(knee);
  knee.add(sphere(r * 1.05, K.gear, { x: 0.12 }, 10)); // knee pad
  knee.add(limb([0, 0, 0], [0, -sl, 0], r * 0.85, K.uniform));
  knee.add(box(r * 2.9, 0.6, r * 1.9, K.boots, { x: r * 0.5, y: -sl - 0.25 }, 0.18)); // boot
  return { g, knee, set: (t, b) => { g.rotation.z = t; knee.rotation.z = -b; } };
}

export interface Weapon { g: THREE.Group; rHand: V3; lHand: V3; muzzle: V3 }
type Head = "helmet" | "fast" | "gasmask";
type Back = "pack" | "tanks" | "ruck";

// The soldier. Coordinates of the upper body are relative to the hip (y = HIP) so the whole torso can
// lean and bob; arms are solved to the weapon's grip points.
function soldier(K: Kit, weapon: (K: Kit) => Weapon, head: Head, back: Back, lean = -0.12): Model {
  const HIP = 5.5, root = group();
  const legs = [leg(K, 0.72, HIP, 2.85, 2.15, 0.5), leg(K, -0.72, HIP, 2.85, 2.15, 0.5)];
  for (const l of legs) root.add(l.g);
  const up = group({ y: HIP, rz: lean }); root.add(up);
  const { M } = K;
  // pelvis + belt w/ pouches
  up.add(box(1.9, 1.3, 2.4, K.uniform, { y: 0.35 }, 0.45));
  up.add(box(2.05, 0.45, 2.55, K.gear, { y: 0.85 }, 0.15));
  sides((s) => up.add(box(0.7, 0.7, 0.5, K.gear, { x: 0.25, y: 0.75, z: s * 1.25 }, 0.12)));
  // torso + plate carrier
  up.add(box(1.8, 3.1, 2.6, K.uniform, { y: 2.45 }, 0.65));
  up.add(box(2.25, 2.5, 2.75, K.gear, { y: 2.55 }, 0.35));
  for (let i = -1; i <= 1; i++) up.add(box(0.55, 0.85, 0.82, K.gear, { x: 1.35, y: 2.05, z: i * 0.92 }, 0.14)); // mag pouches
  up.add(box(0.4, 0.55, 0.9, K.gear, { x: 1.3, y: 3.15, z: -0.6 }, 0.1)); // radio/admin pouch
  // back: assault pack / ruck / fuel tanks
  if (back === "pack") up.add(box(1.3, 2.3, 2.2, K.gear, { x: -1.6, y: 2.5 }, 0.45));
  if (back === "ruck") { up.add(box(1.6, 3.0, 2.5, K.gear, { x: -1.75, y: 2.6 }, 0.55)); up.add(box(0.8, 0.8, 2.6, K.M.olive, { x: -1.9, y: 4.3, rx: Math.PI / 2 }, 0.38)); }
  if (back === "tanks") {
    sides((s) => { up.add(cyl(0.72, 3.4, M.steel, { x: -1.75, y: 2.6, z: s * 0.8 }, "y", 14)); up.add(sphere(0.72, M.steel, { x: -1.75, y: 4.3, z: s * 0.8 }, 12)); up.add(sphere(0.72, M.steel, { x: -1.75, y: 0.9, z: s * 0.8 }, 12)); });
    up.add(cyl(0.35, 0.9, M.metal, { x: -1.75, y: 4.7 }, "z", 10)); // manifold
    up.add(box(0.5, 0.35, 0.6, K.mark, { x: -1.2, y: 3.2, z: 1.5 }, 0.05)); // white band (OpenAI)
  }
  // shoulders + neck
  const SH = 3.75;
  sides((s) => up.add(sphere(0.66, K.uniform, { y: SH, z: s * 1.4 }, 12)));
  up.add(cyl(0.45, 0.8, M.skin, { y: 4.3 }, "y", 10));
  // head
  const hd = group({ x: 0.15, y: 5.15, rz: -lean * 0.6 }); up.add(hd);
  hd.add(sphere(0.85, M.skin, {}, 16));
  if (head !== "gasmask") { hd.add(box(0.55, 0.85, 0.95, M.skin, { x: 0.55, y: -0.2 }, 0.25)); hd.add(box(0.12, 0.2, 0.75, M.glass, { x: 0.84, y: 0.05 }, 0.04)); } // face + eyepro
  if (head === "gasmask") {
    hd.add(sphere(0.98, K.gear, { x: -0.05, y: 0.05 }, 16)); // hood
    hd.add(box(0.9, 1.1, 1.3, M.rubber, { x: 0.6, y: -0.1 }, 0.4)); // mask
    sides((s) => hd.add(cyl(0.26, 0.12, M.glass, { x: 0.98, y: 0.18, z: s * 0.36 }, "x", 12))); // eyepieces
    hd.add(cyl(0.38, 0.55, M.dark, { x: 1.1, y: -0.45, z: 0.15, rz: -0.4 }, "x", 12)); // filter canister
    hd.add(box(0.25, 0.4, 0.6, K.mark, { x: -0.6, y: 0.5 }, 0.05));
  } else {
    // ballistic helmet (shell + rim), headset cups, NVG shroud, rear battery pack
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.08, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), K.oai ? K.gear : K.uniform);
    shell.position.set(-0.05, 0.12, 0); shell.castShadow = true; hd.add(shell);
    if (head === "fast") sides((s) => hd.add(box(1.4, 0.25, 0.12, M.metal, { x: -0.05, y: 0.05, z: s * 1.08 }, 0.04))); // ARC rails
    sides((s) => hd.add(cyl(0.42, 0.35, M.dark, { x: 0.0, y: -0.15, z: s * 0.98 }, "z", 12)));
    hd.add(box(0.45, 0.4, 0.6, M.dark, { x: 1.05, y: 0.55 }, 0.1)); // NVG mount/shroud
    hd.add(box(0.5, 0.45, 0.55, K.gear, { x: -1.15, y: 0.45 }, 0.12)); // counterweight
    hd.add(box(0.2, 0.25, 0.32, K.mark, { x: -0.3, y: 1.25 }, 0.05)); // IR/ID patch on top
  }
  // weapon + arms
  const w = weapon(K); up.add(w.g);
  const arm = (sh: V3, hand: V3, s: 1 | -1) => {
    const mid: V3 = [(sh[0] + hand[0]) / 2 - 0.55, (sh[1] + hand[1]) / 2 - 0.75, (sh[2] + hand[2]) / 2 + s * 0.7];
    up.add(limb(sh, mid, 0.42, K.uniform));
    up.add(limb(mid, hand, 0.37, K.uniform));
    up.add(sphere(0.42, K.gloves, { x: hand[0], y: hand[1], z: hand[2] }, 10));
  };
  arm([0.05, SH - 0.1, 1.4], w.rHand, 1);
  arm([0.05, SH - 0.1, -1.4], w.lHand, -1);
  // shoulder ID patch (left)
  up.add(box(0.5, 0.45, 0.12, K.mark, { y: SH - 0.55, z: -1.8 }, 0.03));

  // pose: frame 0 idle, 1..4 stride
  const animate = (k: number) => {
    const P: [number, number, number, number, number][] = [
      // thighL, kneeL, thighR, kneeR, bob
      [0.06, 0.12, -0.06, 0.12, 0],
      [0.5, 0.15, -0.38, 0.35, -0.12],
      [0.05, 0.65, 0.05, 0.12, 0.12],
      [-0.38, 0.35, 0.5, 0.15, -0.12],
      [0.05, 0.12, 0.05, 0.65, 0.12],
    ];
    const [tl, kl, tr, kr, bob] = P[k];
    legs[0].set(tl, kl); legs[1].set(tr, kr);
    up.position.y = HIP + bob; for (const l of legs) l.g.position.y = HIP + bob;
    up.rotation.z = lean + (k ? -0.06 : 0);
  };
  animate(0);
  // muzzle in model space (hip-relative weapon point rotated by the lean)
  const c = Math.cos(lean), s = Math.sin(lean), [mx, my, mz] = w.muzzle;
  const muzzle: V3 = [+(mx * c - my * s).toFixed(2), +(HIP + mx * s + my * c).toFixed(2), mz];
  return { root, frames: 5, animate, meta: { walk: [1, 4], muzzle } };
}

// ---------- weapons (hip-relative, held at the ready; forward +X) ----------
const WZ = 0.8; // weapon carried on the right side
function lmg(K: Kit): Weapon {
  const M = { ...K.M, dark: K.gun }, g = group({ x: 0.45, y: 2.75, z: WZ, rz: -0.05 });
  g.add(box(1.5, 0.6, 0.36, M.dark, { x: -1.0, y: -0.05, rz: 0.1 }, 0.12)); // stock
  g.add(box(2.1, 0.78, 0.48, M.dark, { x: 0.65 }, 0.12));                    // receiver
  g.add(box(1.3, 0.2, 0.5, M.metal, { x: 0.75, y: 0.45 }, 0.05));           // feed cover
  g.add(box(0.8, 0.45, 0.32, M.dark, { x: 0.8, y: 0.75 }, 0.08)); g.add(box(0.06, 0.28, 0.24, M.lens, { x: 1.22, y: 0.75 }, 0.02)); // optic
  g.add(box(1.0, 1.0, 0.7, K.gear, { x: 0.65, y: -0.85, z: 0.12 }, 0.25));    // 200-rd soft pouch
  g.add(box(0.32, 0.75, 0.3, M.dark, { x: 0.05, y: -0.6, rz: 0.25 }, 0.08)); // pistol grip
  g.add(box(1.5, 0.55, 0.5, M.dark, { x: 2.35 }, 0.12));                      // handguard
  g.add(cyl(0.15, 2.4, M.metal, { x: 4.2 }, "x", 10));                        // barrel
  g.add(cyl(0.2, 0.45, M.dark, { x: 5.55 }, "x", 10));                        // flash hider
  sides((s) => g.add(cyl(0.06, 1.6, M.metal, { x: 3.6, y: -0.35, z: s * 0.12 }, "x", 6))); // folded bipod
  return { g, rHand: [0.5, 2.15, WZ], lHand: [2.75, 2.45, WZ - 0.05], muzzle: [6.25, 2.5, WZ] };
}
function javelin(K: Kit): Weapon {
  const M = { ...K.M, dark: K.gun }, g = group({ x: 0.3, y: 4.25, z: 1.3, rz: -0.06 });
  g.add(cyl(0.68, 9.2, K.oai ? K.M.dark : K.M.olive, { x: 0.3 }, "x", 18));          // launch tube
  g.add(cyl(0.78, 0.9, M.dark, { x: 4.55 }, "x", 18)); g.add(cyl(0.78, 0.7, M.dark, { x: -4.0 }, "x", 18)); // end caps
  g.add(cyl(0.5, 0.1, M.rubber, { x: 5.02 }, "x", 14));
  g.add(box(1.6, 1.25, 1.3, M.dark, { x: 1.1, y: -0.2, z: -1.15 }, 0.22));       // CLU
  g.add(box(0.1, 0.55, 0.7, M.lens, { x: 1.93, y: -0.1, z: -1.15 }, 0.03));
  g.add(box(0.5, 0.6, 0.5, M.dark, { x: 0.3, y: -0.4, z: -1.6 }, 0.1));           // eyepiece
  sides((s) => g.add(box(0.25, 0.9, 0.2, M.dark, { x: 1.1 + s * 0.5, y: -0.9, z: -1.15 }, 0.06))); // grips
  return { g, rHand: [1.35, 3.25, 0.55], lHand: [2.35, 3.45, -0.15], muzzle: [5.4, 4.3, 1.3] };
}
function flamer(K: Kit): Weapon {
  const M = { ...K.M, dark: K.gun }, g = group({ x: 0.5, y: 2.5, z: WZ, rz: -0.08 });
  g.add(box(1.4, 0.6, 0.42, M.dark, { x: 0.2 }, 0.12));                       // body/valves
  g.add(cyl(0.22, 3.0, M.steel, { x: 2.3 }, "x", 12));                         // wand
  g.add(cyl(0.34, 0.6, M.dark, { x: 3.95 }, "x", 12));                         // nozzle shroud
  g.add(sphere(0.14, M.burner, { x: 4.3, y: -0.28 }, 8));                      // pilot light
  g.add(box(0.3, 0.7, 0.3, M.dark, { x: 0.15, y: -0.55, rz: 0.2 }, 0.08));
  g.add(box(0.3, 0.6, 0.3, M.dark, { x: 1.55, y: -0.45 }, 0.08));
  // hose back to the tanks
  const hose = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-0.5, -0.2, 0), new THREE.Vector3(-1.6, -0.9, 0.4), new THREE.Vector3(-2.6, 0.2, -0.2)]), 12, 0.13, 6), M.rubber);
  hose.castShadow = true; g.add(hose);
  return { g, rHand: [0.55, 1.9, WZ], lHand: [2.1, 2.3, WZ - 0.05], muzzle: [4.9, 2.1, WZ] };
}
function nlaw(K: Kit): Weapon {
  const M = { ...K.M, dark: K.gun }, g = group({ x: 0.2, y: 4.2, z: 1.3, rz: -0.05 });
  g.add(cyl(0.6, 6.6, M.dark, { x: 0.4 }, "x", 16));                            // tube
  g.add(cyl(0.82, 1.5, K.oai ? K.gear : M.plain, { x: 3.2 }, "x", 16));           // front shock absorber
  g.add(cyl(0.78, 1.1, K.oai ? K.gear : M.plain, { x: -2.6 }, "x", 16));          // rear
  g.add(box(1.0, 0.55, 0.6, M.dark, { x: 0.9, y: 0.75 }, 0.1)); g.add(box(0.08, 0.32, 0.4, M.lens, { x: 1.42, y: 0.78 }, 0.02)); // sight
  g.add(box(0.3, 0.9, 0.3, M.dark, { x: 0.4, y: -0.75 }, 0.08)); g.add(box(0.3, 0.8, 0.3, M.dark, { x: 1.7, y: -0.7 }, 0.08));
  g.add(box(0.7, 0.2, 1.2, K.mark, { x: 3.2, y: 0.82 }, 0.03)); // white band
  return { g, rHand: [0.75, 3.45, 1.1], lHand: [2.0, 3.5, 0.6], muzzle: [4.1, 4.2, 1.3] };
}

const A = () => kitFor(PALETTES.anthropic), O = () => kitFor(PALETTES.openai);
export const INFANTRY: Record<string, () => Model> = {
  gunner: () => soldier(A(), lmg, "helmet", "pack"),
  rocket: () => soldier(A(), javelin, "helmet", "ruck", -0.08),
  nod_flamer: () => soldier(O(), flamer, "gasmask", "tanks"),
  nod_rocket: () => soldier(O(), nlaw, "fast", "pack", -0.08),
};
