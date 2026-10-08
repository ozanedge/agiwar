// Armored vehicles: tracked chassis + main battle tanks, heavy tanks, self-propelled artillery.
import * as THREE from "three";
import { box, cyl, sphere, torus, prism, loft as kitLoft, slab, group, sides, rod, decal, hexStr, type Mats, type Palette, type V2 } from "../kit";

export const loft = kitLoft; // (kit.loft normalizes winding itself)

// Stadium-shaped track belt (side view), hollow so the road wheels show through, with
// cleat ribs on the outer face. Returns a group centered on z.
export function trackBelt(M: Mats, len: number, r: number, width: number, z: number, frontLift = 0.8): THREE.Group {
  const g = group({ z });
  const x0 = -len / 2 + r, x1 = len / 2 - r;
  const outer = new THREE.Shape();
  outer.moveTo(x0, 0);
  outer.lineTo(x1, 0);
  outer.absarc(x1, r + frontLift * 0.5, r + frontLift * 0.5, -Math.PI / 2, Math.PI / 2, false);
  outer.lineTo(x0, 2 * r + 0.4);
  outer.absarc(x0, r, r, Math.PI / 2, (3 * Math.PI) / 2, false);
  const t = 0.55;
  const hole = new THREE.Path();
  hole.moveTo(x0, t);
  hole.absarc(x0, r, r - t, -Math.PI / 2, -(3 * Math.PI) / 2, true);
  hole.lineTo(x1, 2 * r + frontLift - t);
  hole.absarc(x1, r + frontLift * 0.5, r + frontLift * 0.5 - t, Math.PI / 2, -Math.PI / 2, true);
  hole.lineTo(x0, t);
  outer.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(outer, { depth: width, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 1, curveSegments: 10 });
  geo.translate(0, 0, -width / 2);
  const belt = new THREE.Mesh(geo, M.track); belt.castShadow = belt.receiveShadow = true; g.add(belt);
  // cleats along the ground run + top run (read as a segmented track at sprite scale)
  for (let x = x0; x <= x1; x += 0.95) {
    g.add(box(0.42, 0.22, width + 0.1, M.metal, { x, y: -0.02 }, 0.05));
    g.add(box(0.42, 0.22, width + 0.1, M.metal, { x, y: 2 * r + 0.42 + (frontLift * (x - x0)) / (x1 - x0) * 0.6 }, 0.05));
  }
  return g;
}

export interface ChassisOpts {
  len: number; width: number; trackW: number; wheelR: number; wheels: number; hullTop: number;
  glacis?: number; skirtERA?: boolean; camo: THREE.Material;
}
// Tracked hull: two track runs with road wheels + sprockets, armored side skirts, sloped glacis,
// engine deck with grilles, fenders, lights, tow hooks. Origin = ground center.
export function trackedChassis(M: Mats, o: ChassisOpts): THREE.Group {
  const g = group();
  const L = o.len, hw = o.width / 2, tz = hw - o.trackW / 2;
  const r = o.wheelR;
  sides((s) => {
    g.add(trackBelt(M, L - 1, r + 0.15, o.trackW, s * tz));
    // road wheels, drive sprocket (rear), idler (front), return rollers
    for (let i = 0; i < o.wheels; i++) {
      const x = -L / 2 + 2.6 + (i * (L - 5.6)) / (o.wheels - 1);
      g.add(cyl(r, o.trackW * 0.78, M.dark, { x, y: r + 0.1, z: s * tz }, "z", 16));
      g.add(cyl(r * 0.45, o.trackW * 0.82, M.metal, { x, y: r + 0.1, z: s * tz }, "z", 10));
    }
    g.add(cyl(r * 0.95, o.trackW * 0.8, M.metal, { x: -L / 2 + 1.2, y: r + 0.3, z: s * tz }, "z", 12));
    g.add(cyl(r * 0.85, o.trackW * 0.8, M.dark, { x: L / 2 - 1.3, y: r + 0.9, z: s * tz }, "z", 12));
    // armored side skirts in segmented panels (covering the upper run), slightly flared
    const skTop = o.hullTop - 0.6, skBot = r * 1.15;
    const nPanels = 6, pl = (L - 2.4) / nPanels;
    for (let i = 0; i < nPanels; i++) {
      const x = -L / 2 + 1.6 + pl * (i + 0.5);
      const front = i === nPanels - 1;
      g.add(box(pl - 0.18, skTop - skBot, 0.55, o.camo, { x, y: (skTop + skBot) / 2, z: s * (hw + 0.1), rx: s * 0.06 }, 0.12));
      if (o.skirtERA) { // reactive armor tiles bolted on the skirts
        for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++)
          g.add(box(pl / 2 - 0.35, (skTop - skBot) / 2 - 0.3, 0.55, o.camo, { x: x - pl / 4 + (j * pl) / 2, y: skBot + 0.35 + ((k + 0.5) * (skTop - skBot)) / 2 - 0.1, z: s * (hw + 0.55), rx: s * 0.06 }, 0.1));
      }
      if (front) g.add(box(1.6, skTop - skBot - 0.6, 0.5, o.camo, { x: L / 2 - 0.4, y: (skTop + skBot) / 2 + 0.4, z: s * (hw + 0.1), ry: s * -0.5 }, 0.1));
    }
    // fenders (front + rear) over the tracks
    g.add(box(2.2, 0.25, o.trackW + 0.4, o.camo, { x: L / 2 + 0.2, y: o.hullTop - 0.9, z: s * tz, rz: -0.25 }, 0.08));
    g.add(box(1.4, 0.25, o.trackW + 0.4, o.camo, { x: -L / 2 + 0.3, y: o.hullTop - 0.6, z: s * tz }, 0.08));
    // headlight clusters + guards
    g.add(box(0.7, 0.6, 0.9, M.dark, { x: L / 2 + 0.6, y: o.hullTop - 0.3, z: s * (hw - 1.6) }, 0.1));
    g.add(box(0.15, 0.35, 0.5, M.whiteLight, { x: L / 2 + 0.98, y: o.hullTop - 0.25, z: s * (hw - 1.6) }, 0.02));
    // tow hooks
    g.add(box(0.6, 0.5, 0.4, M.metal, { x: L / 2 + 0.6, y: 2.0, z: s * (hw - 3.0) }, 0.1));
    g.add(box(0.6, 0.5, 0.4, M.metal, { x: -L / 2 - 0.4, y: 2.2, z: s * (hw - 3.0) }, 0.1));
  });
  // upper hull: side profile with lower front plate, sloped glacis, flat deck, raked rear
  const gl = o.glacis ?? 5.5, top = o.hullTop;
  const prof: V2[] = [[-L / 2, 1.9], [L / 2 - 1.2, 1.9], [L / 2 + 0.7, top - 1.9], [L / 2 + 0.7 - gl * 0.25, top - 1.5], [L / 2 + 0.6 - gl, top], [-L / 2 + 0.6, top], [-L / 2, top - 0.9]];
  g.add(prism(prof, 2 * (hw - o.trackW) + 0.6, o.camo, {}, 0.25));
  // sponsons over the tracks (hull extends over them under the skirts)
  g.add(box(L - 1.2, 0.7, o.width - 0.2, o.camo, { x: -0.3, y: top - 0.35 }, 0.2));
  // engine deck: two grille banks + exhaust louver on the rear plate
  sides((s) => {
    g.add(box(5.2, 0.25, 3.8, M.dark, { x: -L / 2 + 4.2, y: top + 0.1, z: s * 2.6 }, 0.08));
    for (let k = 0; k < 6; k++) g.add(box(0.28, 0.18, 3.6, M.metal, { x: -L / 2 + 2.0 + k * 0.85, y: top + 0.24, z: s * 2.6 }, 0.04));
  });
  g.add(box(0.4, 1.4, 6.5, M.dark, { x: -L / 2 - 0.05, y: top - 1.1 }, 0.08));
  // driver's hatch + periscopes on the glacis/deck front
  g.add(cyl(1.0, 0.35, o.camo, { x: L / 2 - gl - 0.7, y: top + 0.15 }, "y", 16));
  for (let k = -1; k <= 1; k++) g.add(box(0.35, 0.35, 0.55, M.glass, { x: L / 2 - gl + 0.3, y: top + 0.18, z: k * 0.65 }, 0.06));
  return g;
}

// Turret smoke grenade dischargers: a cluster of short tubes angled up/forward.
export function smokeLaunchers(M: Mats, x: number, y: number, z: number, s: 1 | -1, n = 4): THREE.Group {
  const g = group({ x, y, z, ry: s * -0.35 });
  g.add(box(1.0, 0.6, 2.4, M.dark, { y: -0.2 }, 0.1));
  for (let i = 0; i < n; i++) g.add(cyl(0.26, 1.0, M.dark, { x: 0.35, y: 0.25, z: -0.9 + (i * 1.8) / (n - 1), rz: -0.7 }, "y", 10));
  return g;
}
// Remote weapon station: armored mount + MG + sensor box (commander's CROWS).
export function rws(M: Mats, camo: THREE.Material, p: { x: number; y: number; z: number }, scale = 1): THREE.Group {
  const g = group({ ...p, sx: scale, sy: scale, sz: scale });
  g.add(cyl(1.05, 0.5, camo, { y: 0.25 }, "y", 16));
  g.add(box(1.8, 1.0, 1.4, camo, { x: 0.1, y: 0.95 }, 0.18));
  g.add(box(0.9, 0.8, 0.7, M.dark, { x: 0.3, y: 1.0, z: 0.95 }, 0.1)); // sensor head
  g.add(box(0.08, 0.5, 0.45, M.lens, { x: 0.76, y: 1.0, z: 0.95 }, 0.02));
  g.add(cyl(0.16, 3.2, M.metal, { x: 2.3, y: 1.0, z: -0.25 }, "x", 8)); // MG barrel
  g.add(box(1.0, 0.55, 0.5, M.metal, { x: 0.8, y: 1.0, z: -0.25 }, 0.08));   // receiver
  g.add(box(0.7, 0.6, 0.5, M.olive, { x: 0.0, y: 0.95, z: -0.9 }, 0.1));     // ammo can
  return g;
}
// Smoothbore main gun with thermal sleeve segments, fume extractor, muzzle reference sensor.
export function mainGun(M: Mats, len: number, r: number, p: { x: number; y: number }, brake = false): THREE.Group {
  const g = group({ x: p.x, y: p.y });
  const seg = 3, sl = (len * 0.82) / seg;
  for (let i = 0; i < seg; i++) {
    g.add(cyl(r * 1.12, sl - 0.12, M.camo, { x: sl * (i + 0.5) }, "x", 18)); // sleeve section
    g.add(cyl(r * 1.24, 0.22, M.dark, { x: sl * (i + 1) - 0.05 }, "x", 18)); // clamp ring
  }
  g.add(cyl(r * 1.6, len * 0.16, M.camo, { x: len * 0.42 }, "x", 18, r * 1.6)); // fume extractor bulge
  g.add(cyl(r * 0.95, len * 0.2, M.metal, { x: len * 0.9 }, "x", 16)); // bare muzzle end
  if (brake) { g.add(box(1.4, r * 2.4, r * 3.2, M.dark, { x: len + 0.4 }, 0.15)); g.add(cyl(r * 0.7, 0.4, M.rubber, { x: len + 1.15 }, "x", 12)); }
  else g.add(box(0.5, 0.45, 0.45, M.dark, { x: len * 0.97, y: r * 1.1 }, 0.06)); // MRS
  return g;
}

function factionMarks(M: Mats, P: Palette, g: THREE.Group, at: { x: number; y: number; z: number }, num: string, s: 1 | -1) {
  // tactical number on the turret side (faces ±z)
  g.add(decal((ctx, w, h) => {
    ctx.fillStyle = hexStr(P.marking); ctx.font = `bold ${h * 0.8}px "Arial Narrow", Arial, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(num, w / 2, h * 0.55);
  }, 2.6, 1.1, { x: at.x, y: at.y, z: at.z, ry: s > 0 ? 0 : Math.PI }));
}

export interface MbtOpts { scale?: number; twin?: boolean; long?: boolean; num?: string }
// Modern main battle tank (Abrams/Leopard-class): wedge-armored turret, 120mm gun, CROWS, CITV, bustle rack.
export function mbt(M: Mats, P: Palette, o: MbtOpts = {}): THREE.Group {
  const root = group();
  const T = group(); root.add(T);
  const L = 34, W = 17, top = 5.3;
  T.add(trackedChassis(M, { len: L, width: W, trackW: 3.6, wheelR: 1.3, wheels: 7, hullTop: top, skirtERA: true, camo: M.camo }));
  // ---- turret ----
  const tur = group({ x: -1.2, y: top + 0.35 }); T.add(tur);
  const B: V2[] = [[11.0, 4.0], [6.5, 6.3], [-9.5, 6.3], [-13.0, 5.1], [-13.0, -5.1], [-9.5, -6.3], [6.5, -6.3], [11.0, -4.0], [8.6, -1.8], [8.6, 1.8]];
  const Tp: V2[] = [[9.8, 3.7], [6.0, 5.7], [-9.1, 5.7], [-12.5, 4.7], [-12.5, -4.7], [-9.1, -5.7], [6.0, -5.7], [9.8, -3.7], [7.9, -1.6], [7.9, 1.6]];
  tur.add(loft(B.map(([x, z]) => [x, -z] as V2), 0.1, Tp.map(([x, z]) => [x, -z] as V2), 3.4, M.camoHi));
  tur.add(cyl(5.6, 0.6, M.dark, { x: -0.5, y: -0.2 }, "y", 24)); // turret ring (dark gap under the turret)
  // mantlet + gun(s)
  tur.add(box(2.6, 2.3, 3.4, M.camoHi, { x: 8.6, y: 1.6 }, 0.25));
  const gunLen = o.long ? 26 : 21;
  if (o.twin) sides((s) => tur.add(mainGun(M, gunLen, 0.55, { x: 9.2, y: 1.7 }).translateZ(s * 1.1)));
  else tur.add(mainGun(M, gunLen, 0.62, { x: 9.2, y: 1.7 }));
  tur.add(box(0.8, 0.45, 0.45, M.dark, { x: 9.7, y: 1.5, z: 2.0 }, 0.06)); // coax port
  // gunner's primary sight (armored box with glass doors), CITV, hatches
  tur.add(box(2.4, 1.2, 1.9, M.camoHi, { x: 5.0, y: 3.85, z: 3.3 }, 0.18));
  tur.add(box(0.12, 0.7, 1.3, M.glass, { x: 6.22, y: 3.9, z: 3.3 }, 0.03));
  tur.add(cyl(0.65, 0.8, M.dark, { x: 3.4, y: 3.7, z: -3.6 }, "y", 14));
  tur.add(box(1.2, 0.9, 0.9, M.dark, { x: 3.5, y: 4.4, z: -3.6 }, 0.12));
  tur.add(box(0.1, 0.5, 0.6, M.lens, { x: 4.12, y: 4.45, z: -3.6 }, 0.02));
  tur.add(rws(M, M.camoHi, { x: -2.6, y: 3.3, z: 2.7 }));                 // commander CROWS
  tur.add(cyl(1.1, 0.35, M.camoHi, { x: -2.2, y: 3.45, z: -2.9 }, "y", 16)); // loader's hatch
  tur.add(box(0.9, 0.5, 0.3, M.camoHi, { x: -1.6, y: 3.9, z: -4.0 }, 0.08)); // hatch shield
  tur.add(cyl(0.13, 3.0, M.metal, { x: -0.3, y: 4.4, z: -3.3 }, "x", 8));  // loader's MG
  sides((s) => tur.add(smokeLaunchers(M, 6.4, 2.7, s * 5.6, s)));
  // bustle rack: tube frame with stowage bags + jerry cans
  const br = group({ x: -13.2, y: 1.6 }); tur.add(br);
  br.add(box(3.4, 0.15, 10.6, M.dark, { x: -1.6, y: -0.2 }, 0.05));
  sides((s) => { br.add(rod([0, 1.4, s * 5.3], [-3.3, 1.4, s * 5.3], 0.1, M.dark)); br.add(rod([-3.3, -0.2, s * 5.3], [-3.3, 1.4, s * 5.3], 0.1, M.dark)); });
  br.add(rod([-3.3, 1.4, -5.3], [-3.3, 1.4, 5.3], 0.1, M.dark));
  br.add(box(2.8, 1.3, 3.2, M.olive, { x: -1.6, y: 0.5, z: -3.2 }, 0.45));
  br.add(box(2.6, 1.1, 2.6, M.olive, { x: -1.7, y: 0.45, z: 0.0 }, 0.45));
  br.add(box(1.0, 1.4, 0.7, M.plain, { x: -2.4, y: 0.6, z: 3.0 }, 0.1));
  br.add(box(1.0, 1.4, 0.7, M.plain, { x: -1.0, y: 0.6, z: 3.0 }, 0.1));
  // antennas + wind sensor + IFF/air-recognition panel (faction color — the real-world VS-17 panel)
  sides((s) => tur.add(rod([-11.5, 3.3, s * 4.4], [-12.0, 7.6, s * 4.6], 0.05, M.dark)));
  tur.add(rod([-7, 3.3, 0], [-7, 5.4, 0], 0.08, M.dark)); tur.add(box(0.5, 0.25, 0.5, M.dark, { x: -7, y: 5.5 }, 0.05));
  tur.add(box(2.4, 0.06, 1.6, M.marking, { x: -6.4, y: 3.33, z: -1.4 }, 0.02));
  // faction stripe around the turret sides + tactical numbers
  sides((s) => {
    tur.add(box(1.0, 0.9, 0.06, M.marking, { x: -4.5, y: 1.8, z: s * 6.08, rx: s * 0.17 }, 0.01));
  });
  root.scale.setScalar(o.scale ?? 1);
  return root;
}

import { materials, PALETTES } from "../kit";
import type { Model } from "../render";

const A = PALETTES.anthropic, O = PALETTES.openai;
export const kA = () => ({ M: materials(A), P: A });
export const kO = () => ({ M: materials(O), P: O });

// Missile pod: armored box with a grid of tube mouths on its front face (+x).
function missilePod(M: Mats, camo: THREE.Material, w: number, h: number, d: number, nx: number, ny: number): THREE.Group {
  const g = group();
  g.add(box(w, h, d, camo, {}, 0.2));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const z = -d / 2 + (d * (i + 0.5)) / nx, y = -h / 2 + (h * (j + 0.5)) / ny;
    g.add(cyl(Math.min(d / nx, h / ny) * 0.32, 0.3, M.rubber, { x: w / 2 + 0.05, y, z }, "x", 10));
  }
  return g;
}

// ---- Anthropic Mammoth: super-heavy twin-gun tank, double track runs, missile pods ----
function mammoth(M: Mats): THREE.Group {
  const root = group();
  const L = 44, W = 23, top = 6.4;
  root.add(trackedChassis(M, { len: L, width: W, trackW: 4.4, wheelR: 1.6, wheels: 8, hullTop: top, skirtERA: true, glacis: 7, camo: M.camo }));
  // inner track runs (double-track look visible front/rear)
  sides((s) => root.add(trackBelt(M, L - 3, 1.75, 3.2, s * (W / 2 - 7.6))));
  const tur = group({ x: -2.5, y: top + 0.4 }); root.add(tur);
  const B: V2[] = [[13.5, 5.0], [8.0, 8.2], [-11.5, 8.2], [-15.5, 6.6], [-15.5, -6.6], [-11.5, -8.2], [8.0, -8.2], [13.5, -5.0], [11.0, -2.6], [11.0, 2.6]];
  const T: V2[] = B.map(([x, z]) => [x * 0.93 - 0.4, z * 0.9] as V2);
  tur.add(loft(B, 0.1, T, 4.2, M.camoHi));
  tur.add(cyl(7.2, 0.7, M.dark, { x: -1, y: -0.25 }, "y", 24));
  tur.add(box(3.0, 2.8, 6.6, M.camoHi, { x: 11.0, y: 2.0 }, 0.3)); // mantlet
  sides((s) => tur.add(mainGun(M, 24, 0.7, { x: 11.8, y: 2.1 }, true).translateZ(s * 1.8)));
  // missile pods on the turret flanks
  sides((s) => {
    const pod = missilePod(M, M.camoHi, 7, 2.6, 2.8, 2, 2); pod.position.set(-3.5, 3.0, s * 9.6); tur.add(pod);
    tur.add(box(3, 0.6, 1.6, M.dark, { x: -3.5, y: 1.5, z: s * 8.6 }, 0.1)); // pod mount arm
    tur.add(smokeLaunchers(M, 7.5, 3.3, s * 7.3, s));
  });
  tur.add(rws(M, M.camoHi, { x: -4.5, y: 4.2, z: 3.3 }, 1.15));
  tur.add(box(2.6, 1.3, 2.0, M.camoHi, { x: 6.0, y: 4.8, z: -4.0 }, 0.2)); // sight
  tur.add(box(0.12, 0.8, 1.4, M.glass, { x: 7.35, y: 4.85, z: -4.0 }, 0.03));
  tur.add(cyl(1.3, 0.4, M.camoHi, { x: -4.0, y: 4.35, z: -3.6 }, "y", 16));
  tur.add(box(3.0, 0.06, 2.0, M.marking, { x: -9.0, y: 4.23, z: 0 }, 0.02)); // recognition panel
  // rear stowage
  tur.add(box(3.0, 1.6, 12, M.olive, { x: -16.6, y: 1.6 }, 0.5));
  sides((s) => tur.add(rod([-14, 4.2, s * 5.5], [-14.4, 9.5, s * 5.8], 0.06, M.dark)));
  sides((s) => tur.add(box(1.2, 1.0, 0.06, M.marking, { x: -6, y: 2.0, z: s * 8.08, rx: s * 0.1 }, 0.01)));
  return root;
}

// ---- Anthropic Siege Crawler: PzH 2000-class SPH ----
function siege(M: Mats): THREE.Group {
  const root = group();
  const L = 36, W = 17, top = 5.2;
  root.add(trackedChassis(M, { len: L, width: W, trackW: 3.6, wheelR: 1.3, wheels: 7, hullTop: top, skirtERA: false, glacis: 6, camo: M.camo }));
  const tur = group({ x: -6.5, y: top + 0.3 }); root.add(tur);
  const B: V2[] = [[9.5, 6.4], [-10.5, 6.6], [-11.5, 5.6], [-11.5, -5.6], [-10.5, -6.6], [9.5, -6.4], [11.0, -3.6], [11.0, 3.6]];
  const T: V2[] = [[8.6, 5.9], [-10.0, 6.1], [-11.0, 5.2], [-11.0, -5.2], [-10.0, -6.1], [8.6, -5.9], [9.6, -3.4], [9.6, 3.4]];
  tur.add(loft(B, 0.1, T, 5.4, M.camoHi));
  tur.add(box(3.0, 3.0, 3.6, M.camoHi, { x: 10.6, y: 2.6 }, 0.3)); // cradle/mantlet
  const gun = group({ x: 11.5, y: 2.8, rz: 0.1 }); tur.add(gun);
  gun.add(cyl(0.95, 4, M.camoHi, { x: 2 }, "x", 18));
  gun.add(cyl(0.62, 26, M.camo, { x: 15 }, "x", 18));
  gun.add(cyl(0.95, 2.4, M.camo, { x: 12 }, "x", 18)); // fume extractor
  gun.add(box(2.0, 1.5, 2.2, M.dark, { x: 28.6 }, 0.2)); // muzzle brake
  gun.add(box(2.0, 0.4, 2.6, M.dark, { x: 28.6, y: 0.3 }, 0.1));
  // roof: hatches, MG, sensors, ammo hatch rear
  tur.add(cyl(1.0, 0.35, M.camoHi, { x: 1.0, y: 5.55, z: 3.2 }, "y", 14));
  tur.add(cyl(1.0, 0.35, M.camoHi, { x: 1.0, y: 5.55, z: -3.2 }, "y", 14));
  tur.add(box(1.6, 0.9, 1.0, M.dark, { x: 5.5, y: 5.8, z: 3.6 }, 0.12));
  tur.add(box(0.1, 0.5, 0.6, M.lens, { x: 6.32, y: 5.85, z: 3.6 }, 0.02));
  tur.add(cyl(0.12, 2.8, M.metal, { x: 2.5, y: 6.3, z: -3.2 }, "x", 8));
  tur.add(box(4.0, 0.06, 2.6, M.marking, { x: -5.5, y: 5.55 }, 0.02));
  sides((s) => {
    tur.add(smokeLaunchers(M, 8.0, 4.2, s * 6.1, s));
    tur.add(box(6, 2.2, 0.5, M.olive, { x: -4, y: 2.8, z: s * 6.6 }, 0.3)); // side stowage bins
    tur.add(rod([-9.5, 5.4, s * 5.0], [-10, 10, s * 5.2], 0.06, M.dark));
  });
  // travel lock on the hull front
  root.add(box(1.0, 2.0, 2.4, M.dark, { x: 14.5, y: top + 1.0 }, 0.15));
  return root;
}

// ---- Anthropic "Tesla Coil": tracked directed-energy vehicle (high-energy laser/arc turret) ----
function tesla(M: Mats): THREE.Group {
  const root = group();
  const L = 30, W = 16, top = 5.0;
  root.add(trackedChassis(M, { len: L, width: W, trackW: 3.4, wheelR: 1.2, wheels: 6, hullTop: top, skirtERA: false, glacis: 5, camo: M.camo }));
  // capacitor banks + radiators on the rear deck
  for (let i = 0; i < 4; i++) sides((s) => {
    root.add(cyl(0.9, 6.0, M.dark, { x: -8, y: top + 1.0 + 0, z: s * (1.2 + i * 1.7) }, "x", 14));
    root.add(torus(0.92, 0.12, M.metal, { x: -6, y: top + 1.0, z: s * (1.2 + i * 1.7), ry: Math.PI / 2 }));
  });
  sides((s) => root.add(box(7, 2.6, 0.4, M.dark, { x: -8, y: top + 1.4, z: s * 7.4, rx: s * 0.2 }, 0.08)));
  // armored turret base
  const tur = group({ x: 3.5, y: top + 0.3 }); root.add(tur);
  tur.add(loft([[5, 4.5], [-5, 4.8], [-6, 3.5], [-6, -3.5], [-5, -4.8], [5, -4.5], [6.2, -2.6], [6.2, 2.6]], 0, [[4.2, 3.9], [-4.6, 4.2], [-5.5, 3.0], [-5.5, -3.0], [-4.6, -4.2], [4.2, -3.9], [5.2, -2.2], [5.2, 2.2]], 2.8, M.camoHi));
  // yoke + beam director
  sides((s) => tur.add(box(2.6, 4.2, 0.9, M.camoHi, { x: 0.5, y: 4.6, z: s * 3.0 }, 0.2)));
  const bd = group({ x: 0.5, y: 5.2, rz: 0.08 }); tur.add(bd);
  bd.add(cyl(2.3, 5.6, M.camoHi, { x: 0.6 }, "x", 22));
  bd.add(cyl(2.45, 0.5, M.dark, { x: 3.4 }, "x", 22));
  bd.add(cyl(1.75, 0.3, M.glass, { x: 3.7 }, "x", 22));
  bd.add(cyl(1.0, 0.3, M.energy, { x: 3.8 }, "x", 18));
  bd.add(box(2.0, 1.0, 1.6, M.dark, { x: -1.0, y: 2.4 }, 0.15)); // tracker optic
  bd.add(box(0.1, 0.6, 0.8, M.lens, { x: 0.02, y: 2.4 }, 0.02));
  // conduits from capacitors to turret
  sides((s) => root.add(rod([-4.8, top + 1.4, s * 2.0], [0.5, top + 2.4, s * 2.6], 0.25, M.rubber)));
  root.add(box(3, 0.06, 2.0, M.marking, { x: -1.5, y: top + 0.08, z: 0 }, 0.02));
  return root;
}

// ---- OpenAI hover hull: angular stealth body on an air-cushion skirt with lift-fan grilles ----
function hoverHull(M: Mats, L: number, W: number, top: number): THREE.Group {
  const g = group();
  const hl = L / 2, hw = W / 2;
  // skirt (dark rubberized air cushion)
  const sk: V2[] = [[hl - 1.5, hw - 0.6], [hl + 0.2, hw - 3], [hl + 0.2, -(hw - 3)], [hl - 1.5, -(hw - 0.6)], [-hl + 1, -(hw - 0.4)], [-hl - 0.2, -(hw - 2)], [-hl - 0.2, hw - 2], [-hl + 1, hw - 0.4]];
  g.add(loft(sk.map(([x, z]) => [x * 0.96, z * 0.94] as V2), 0.3, sk, 1.7, M.rubber));
  // lower hull flares out, upper hull chamfers in (stealth facets)
  const mid: V2[] = [[hl + 1.2, hw - 3.5], [hl - 2, hw], [-hl + 1.5, hw], [-hl, hw - 1.5], [-hl, -(hw - 1.5)], [-hl + 1.5, -hw], [hl - 2, -hw], [hl + 1.2, -(hw - 3.5)]];
  const upr: V2[] = [[hl - 5, hw - 4.5], [hl - 7, hw - 1.6], [-hl + 3, hw - 1.6], [-hl + 1.4, hw - 3], [-hl + 1.4, -(hw - 3)], [-hl + 3, -(hw - 1.6)], [hl - 7, -(hw - 1.6)], [hl - 5, -(hw - 4.5)]];
  g.add(loft(sk.map(([x, z]) => [x * 0.98, z * 0.97] as V2), 1.6, mid, 2.6, M.camo));
  g.add(loft(mid, 2.6, upr, top, M.camo));
  // lift-fan grilles on the deck
  sides((s) => {
    for (const fx of [-hl + 5.5, hl - 9.5]) {
      g.add(cyl(2.0, 0.3, M.dark, { x: fx, y: top + 0.05, z: s * (hw - 4.6) }, "y", 20));
      for (let k = -2; k <= 2; k++) g.add(box(0.25, 0.2, 3.6, M.metal, { x: fx + k * 0.7, y: top + 0.22, z: s * (hw - 4.6) }, 0.04));
      g.add(torus(2.0, 0.18, M.metal, { x: fx, y: top + 0.2, z: s * (hw - 4.6), rx: Math.PI / 2 }));
    }
    // side thruster vents
    g.add(box(4, 0.8, 0.3, M.dark, { x: -hl + 4, y: 2.0, z: s * (hw + 0.05) }, 0.08));
    g.add(box(0.2, 0.3, 1.0, M.whiteLight, { x: hl + 0.9, y: 2.3, z: s * (hw - 4.2) }, 0.02));
  });
  g.add(box(0.4, 1.0, W - 6, M.dark, { x: -hl - 0.05, y: 2.8 }, 0.1)); // rear exhaust louver
  return g;
}

function hoverLightTank(M: Mats): THREE.Group {
  const root = group();
  const L = 30, W = 15, top = 4.4;
  root.add(hoverHull(M, L, W, top));
  const tur = group({ x: -1.5, y: top }); root.add(tur);
  const B: V2[] = [[8.5, 2.6], [5.0, 5.2], [-7.0, 5.2], [-9.0, 3.8], [-9.0, -3.8], [-7.0, -5.2], [5.0, -5.2], [8.5, -2.6]];
  tur.add(loft(B, 0, B.map(([x, z]) => [x * 0.88 - 0.4, z * 0.8] as V2), 2.8, M.camoHi));
  tur.add(box(2.2, 1.9, 2.6, M.camoHi, { x: 8.3, y: 1.4 }, 0.25));
  tur.add(mainGun(M, 17, 0.5, { x: 8.8, y: 1.45 }, true));
  tur.add(rws(M, M.camoHi, { x: -2.0, y: 2.8, z: 2.0 }, 0.85));
  tur.add(box(1.8, 1.0, 1.4, M.dark, { x: 3.5, y: 3.3, z: -2.4 }, 0.15));
  tur.add(box(0.1, 0.6, 0.9, M.lens, { x: 4.42, y: 3.3, z: -2.4 }, 0.02));
  sides((s) => {
    tur.add(smokeLaunchers(M, 5.0, 2.2, s * 4.6, s, 3));
    tur.add(box(3.6, 0.5, 0.06, M.marking, { x: -3.5, y: 1.4, z: s * 5.0, rx: s * 0.3 }, 0.01));
    tur.add(rod([-8, 2.8, s * 2.8], [-8.4, 7, s * 3.0], 0.05, M.dark));
  });
  return root;
}

function hoverMammoth(M: Mats): THREE.Group {
  const root = group();
  const L = 42, W = 21, top = 5.4;
  root.add(hoverHull(M, L, W, top));
  const tur = group({ x: -3, y: top }); root.add(tur);
  const B: V2[] = [[11.5, 3.5], [7.0, 7.4], [-10.0, 7.4], [-13.0, 5.4], [-13.0, -5.4], [-10.0, -7.4], [7.0, -7.4], [11.5, -3.5]];
  tur.add(loft(B, 0, B.map(([x, z]) => [x * 0.9 - 0.5, z * 0.82] as V2), 3.8, M.camoHi));
  // twin railguns: open dual rails with coil collars
  sides((s) => {
    const rg = group({ x: 10.5, y: 1.9, z: s * 2.6 }); tur.add(rg);
    rg.add(box(4, 2.2, 2.2, M.camoHi, { x: 0.5 }, 0.25));
    rg.add(box(22, 0.5, 1.6, M.metal, { x: 13, y: 0.55 }, 0.1));
    rg.add(box(22, 0.5, 1.6, M.metal, { x: 13, y: -0.55 }, 0.1));
    for (let k = 0; k < 4; k++) rg.add(box(0.8, 1.9, 1.9, M.dark, { x: 4.5 + k * 4.5 }, 0.12));
    rg.add(box(0.5, 0.4, 1.0, M.energy, { x: 23.8 }, 0.05));
    tur.add(missilePod(M, M.camoHi, 5, 2.0, 2.2, 2, 2).translateX(-3).translateY(3.0).translateZ(s * 8.3));
  });
  tur.add(rws(M, M.camoHi, { x: -4, y: 3.8, z: 0 }, 1.1));
  tur.add(box(3.6, 0.06, 2.4, M.marking, { x: -9, y: 3.83 }, 0.02));
  sides((s) => tur.add(rod([-11, 3.8, s * 4.0], [-11.5, 9, s * 4.2], 0.06, M.dark)));
  return root;
}

function hoverSiege(M: Mats): THREE.Group {
  const root = group();
  const L = 32, W = 15, top = 4.2;
  root.add(hoverHull(M, L, W, top));
  // armored cab (front)
  const cab = group({ x: 9.5, y: top }); root.add(cab);
  cab.add(loft([[3.5, 5.4], [-3.5, 5.6], [-3.5, -5.6], [3.5, -5.4]], 0, [[1.8, 5.0], [-3.2, 5.2], [-3.2, -5.2], [1.8, -5.0]], 3.0, M.camoHi));
  cab.add(box(0.15, 1.2, 8.0, M.glass, { x: 2.75, y: 1.9, rz: 0.55 }, 0.04));
  cab.add(box(1.4, 0.8, 1.0, M.dark, { x: -1.5, y: 3.4, z: 2.5 }, 0.1));
  // launcher: two 6-tube pods on a turntable, elevated
  const tt = group({ x: -5, y: top }); root.add(tt);
  tt.add(cyl(4.2, 0.8, M.dark, { y: 0.4 }, "y", 20));
  tt.add(box(4, 2.0, 6, M.camoHi, { x: 2, y: 1.6 }, 0.2));
  const lp = group({ x: -2.0, y: 3.4, rz: 0.32 }); tt.add(lp);
  sides((s) => {
    const pod = missilePod(M, M.camoHi, 13, 3.2, 4.2, 3, 2); pod.position.set(1.5, 1.8, s * 2.3); lp.add(pod);
    pod.add(box(13.2, 0.1, 0.5, M.marking, { y: 1.62, z: 0 }, 0.01));
  });
  return root;
}

export const ARMOR: Record<string, () => Model> = {
  tank: () => ({ root: mbt(kA().M, A), meta: { muzzle: [29.5, 7.4, 0] } }),
  mammoth: () => ({ root: mammoth(kA().M), meta: { muzzle: [35.5, 8.9, 1.8] } }),
  siege: () => ({ root: siege(kA().M), meta: { muzzle: [39.0, 11.0, 0] } }),
  tesla: () => ({ root: tesla(kA().M), meta: { muzzle: [8.4, 10.8, 0] } }),
  nod_lighttank: () => ({ root: hoverLightTank(kO().M), meta: { muzzle: [25.8, 5.9, 0] } }),
  nod_mammoth: () => ({ root: hoverMammoth(kO().M), meta: { muzzle: [32.0, 7.3, 2.6] } }),
  nod_siege: () => ({ root: hoverSiege(kO().M), meta: { muzzle: [-0.5, 12.0, 2.3] } }),
};
