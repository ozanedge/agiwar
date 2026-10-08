// Static defenses: guard tower, base cannon, CIWS. Buildings rotate whole with heading in-game, so
// every footprint is round.
import * as THREE from "three";
import { box, cyl, sphere, torus, group, sides, rod, mat, type Mats, type V2 } from "../kit";
import type { Model } from "../render";
import { loft, kA, kO } from "./armor";

const concrete = () => mat({ color: 0x847e70, rough: 0.92, metal: 0.0, dust: 0x5a5244, aoH: 5 });
const navyGrey = () => mat({ color: 0x7d858c, rough: 0.55, metal: 0.25, dust: 0x4a4e52, aoH: 4 });

function sandbagRing(M: Mats, r: number, y: number, n: number): THREE.Group {
  const g = group();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.add(box(2.0, 0.9, 1.1, M.olive, { x: Math.cos(a) * r, y: y + 0.45, z: Math.sin(a) * r, ry: -a + Math.PI / 2 }, 0.4));
    if (i % 2 === 0) g.add(box(2.0, 0.9, 1.1, M.olive, { x: Math.cos(a + Math.PI / n) * r, y: y + 1.3, z: Math.sin(a + Math.PI / n) * r, ry: -a - Math.PI / n + Math.PI / 2 }, 0.4));
  }
  return g;
}

// ---- Anthropic Guard Tower: fortified concrete tower + remote twin-autocannon turret ----
function guardTower(M: Mats): THREE.Group {
  const root = group();
  const C = concrete();
  root.add(cyl(10.5, 1.2, C, { y: 0.6 }, "y", 32, 10.0));       // footing
  root.add(sandbagRing(M, 10.2, 1.2, 22));
  root.add(cyl(7.0, 8.0, C, { y: 5.2 }, "y", 28, 7.6));         // tower (slight batter)
  for (let i = 0; i < 8; i++) { // firing slits
    const a = (i / 8) * Math.PI * 2 + 0.2;
    root.add(box(0.7, 0.9, 2.4, M.rubber, { x: Math.cos(a) * 7.0, y: 6.8, z: Math.sin(a) * 7.0, ry: -a }, 0.05));
    root.add(box(0.6, 0.25, 2.8, C, { x: Math.cos(a) * 7.25, y: 7.4, z: Math.sin(a) * 7.25, ry: -a }, 0.05)); // slit visor
  }
  for (const y of [3.2, 5.4]) root.add(torus(7.3 - (y - 1.2) * 0.07, 0.12, M.dark, { y, rx: Math.PI / 2 })); // formwork seams
  root.add(cyl(7.6, 1.0, C, { y: 9.6 }, "y", 28));               // parapet cap
  root.add(torus(7.2, 0.25, M.dark, { y: 10.1, rx: Math.PI / 2 }));
  root.add(box(0.4, 7.5, 1.4, M.metal, { x: -7.2, y: 5.0, z: 1.5, ry: 0.2 }, 0.05)); // ladder
  for (let k = 0; k < 8; k++) root.add(box(0.3, 0.15, 1.4, M.metal, { x: -7.45, y: 1.8 + k * 0.95, z: 1.5, ry: 0.2 }, 0.03));
  // remote turret
  const tur = group({ y: 10.1, sx: 1.35, sy: 1.35, sz: 1.35 }); root.add(tur);
  tur.add(cyl(3.6, 0.8, M.dark, { y: 0.4 }, "y", 20));
  const head: V2[] = [[4.2, 2.2], [1.5, 3.4], [-3.8, 3.4], [-4.6, 2.2], [-4.6, -2.2], [-3.8, -3.4], [1.5, -3.4], [4.2, -2.2]];
  tur.add(loft(head, 0.8, head.map(([x, z]) => [x * 0.85, z * 0.82] as V2), 3.6, M.camoHi));
  sides((s) => {
    tur.add(cyl(0.38, 9.0, M.metal, { x: 8.0, y: 2.1, z: s * 1.25 }, "x", 12));
    tur.add(cyl(0.55, 2.4, M.dark, { x: 4.6, y: 2.1, z: s * 1.25 }, "x", 12));
    tur.add(box(1.0, 0.7, 0.7, M.dark, { x: 12.6, y: 2.1, z: s * 1.25 }, 0.1)); // muzzle brake
  });
  tur.add(box(1.6, 1.3, 1.4, M.dark, { x: 0.5, y: 4.2, z: 0 }, 0.15)); // sensor head
  tur.add(box(0.1, 0.7, 1.0, M.lens, { x: 1.32, y: 4.25 }, 0.02));
  tur.add(box(2.0, 0.06, 1.6, M.marking, { x: -2.6, y: 3.62 }, 0.02));
  tur.add(rod([-3.5, 3.6, 1.6], [-3.8, 8.0, 1.8], 0.06, M.dark));
  return root;
}

// ---- Base Cannon: Mk 45-class stealth gunhouse on an armored barbette (neutral naval grey) ----
function baseCannon(M: Mats): THREE.Group {
  const root = group();
  const C = concrete(), N = navyGrey();
  root.add(cyl(13, 1.4, C, { y: 0.7 }, "y", 36, 12.4));
  root.add(cyl(10.5, 3.6, N, { y: 3.2 }, "y", 32, 11));           // barbette
  root.add(torus(10.6, 0.35, M.dark, { y: 5.0, rx: Math.PI / 2 }));
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; root.add(box(0.5, 2.6, 0.9, M.dark, { x: Math.cos(a) * 10.8, y: 3.0, z: Math.sin(a) * 10.8, ry: -a }, 0.05)); }
  // stealth gunhouse: faceted wedge
  const tur = group({ y: 5.0 }); root.add(tur);
  const B: V2[] = [[9.5, 2.8], [4.0, 7.0], [-7.5, 7.0], [-9.0, 5.2], [-9.0, -5.2], [-7.5, -7.0], [4.0, -7.0], [9.5, -2.8]];
  const T: V2[] = [[6.5, 1.8], [2.5, 4.8], [-6.5, 4.8], [-7.5, 3.6], [-7.5, -3.6], [-6.5, -4.8], [2.5, -4.8], [6.5, -1.8]];
  tur.add(loft(B, 0, T, 6.0, N));
  tur.add(box(3.0, 3.2, 3.6, N, { x: 8.6, y: 2.4 }, 0.3));         // gun port shield
  const gun = group({ x: 9.6, y: 2.6, rz: 0.04 }); tur.add(gun);
  gun.add(cyl(1.15, 3.0, M.dark, { x: 1.2 }, "x", 20));
  gun.add(cyl(0.78, 22, N, { x: 12 }, "x", 20, 0.68));
  gun.add(cyl(0.95, 1.4, M.dark, { x: 22.4 }, "x", 18));
  // roof details: vents, sight dome, handrails, warning band
  tur.add(sphere(1.1, M.dark, { x: -2, y: 6.0, z: 2.4 }, 14));
  tur.add(box(3.0, 0.4, 2.2, M.dark, { x: -4.5, y: 6.1, z: -1.8 }, 0.08));
  for (let k = 0; k < 4; k++) tur.add(box(0.2, 0.2, 2.0, M.metal, { x: -5.6 + k * 0.7, y: 6.35, z: -1.8 }, 0.03));
  sides((s) => tur.add(rod([-6.5, 6.0, s * 4.4], [2.0, 6.0, s * 4.4], 0.08, M.metal)));
  root.add(torus(12.2, 0.3, mat({ color: 0xd8b13a, rough: 0.6 }), { y: 1.42, rx: Math.PI / 2 })); // yellow hazard ring
  return root;
}

// ---- OpenAI turret: Phalanx/Centurion-class CIWS on a round pad ----
function ciws(M: Mats): THREE.Group {
  const root = group();
  const C = concrete(), white = mat({ color: 0xe6e9ec, rough: 0.5, metal: 0.05, aoH: 3 });
  root.add(cyl(8.5, 1.2, C, { y: 0.6 }, "y", 30, 8.0));
  root.add(sandbagRing(M, 8.3, 1.2, 18));
  root.add(cyl(3.2, 3.0, M.camo, { y: 2.7 }, "y", 20, 3.8));   // pedestal
  const tur = group({ y: 4.2 }); root.add(tur);
  tur.add(cyl(2.8, 1.2, M.camo, { y: 0.6 }, "y", 20));
  sides((s) => tur.add(box(3.6, 3.2, 0.8, M.camo, { x: 0, y: 2.6, z: s * 2.4 }, 0.2))); // yoke arms
  tur.add(box(3.2, 2.4, 3.2, M.dark, { x: -1.0, y: 2.8 }, 0.3));                       // ammo drum housing
  // radome: cylinder + dome cap (the iconic "R2-D2" silhouette)
  tur.add(cyl(1.9, 3.4, white, { x: -0.2, y: 5.8 }, "y", 22));
  tur.add(sphere(1.9, white, { x: -0.2, y: 7.5, sy: 0.85 }, 22));
  tur.add(box(0.15, 1.2, 1.6, M.dark, { x: 1.72, y: 6.0 }, 0.04));
  // 6-barrel gatling with muzzle shroud
  const gun = group({ x: 1.0, y: 2.7 }); tur.add(gun);
  gun.add(cyl(0.95, 2.2, M.dark, { x: 1.0 }, "x", 16));
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; gun.add(cyl(0.16, 7.5, M.metal, { x: 5.6, y: Math.cos(a) * 0.48, z: Math.sin(a) * 0.48 }, "x", 6)); }
  gun.add(cyl(0.75, 0.9, M.dark, { x: 8.8 }, "x", 14));
  gun.add(cyl(0.75, 0.5, M.dark, { x: 5.0 }, "x", 14));
  sides((s) => tur.add(box(2.0, 0.06, 0.06, M.marking, { x: -0.2, y: 5.0, z: s * 1.93 }, 0.01)));
  tur.add(torus(1.92, 0.12, M.marking, { x: -0.2, y: 4.6, rx: Math.PI / 2 }));
  return root;
}

export const DEFENSE: Record<string, () => Model> = {
  turret: () => ({ root: guardTower(kA().M), meta: { muzzle: [17.7, 12.9, 1.69] } }),
  baseturret: () => ({ root: baseCannon(kA().M), meta: { muzzle: [32.6, 8.5, 0] } }),
  nod_turret: () => ({ root: ciws(kO().M), meta: { muzzle: [10.3, 6.9, 0] } }),
};
