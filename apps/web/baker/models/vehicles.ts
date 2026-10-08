// Wheeled vehicles: 8x8 APC, light strike vehicle, recon bike, truck-mounted laser.
import * as THREE from "three";
import { box, cyl, sphere, torus, prism, group, sides, rod, PALETTES, type Mats, type V2 } from "../kit";
import type { Model } from "../render";
import { loft, rws, smokeLaunchers, kA, kO } from "./armor";

// Off-road tire with tread blocks, rim and hub. Axis along Z, centered at (x, r, z).
export function wheel(M: Mats, r: number, w: number, p: { x: number; z: number; y?: number }, knobby = true): THREE.Group {
  const g = group({ x: p.x, y: p.y ?? r, z: p.z });
  g.add(cyl(r * 0.94, w, M.rubber, {}, "z", 22));
  if (knobby) for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    g.add(box(r * 0.28, r * 0.16, w * 0.9, M.rubber, { x: Math.cos(a) * r * 0.92, y: Math.sin(a) * r * 0.92, rz: a }, 0.04));
  }
  sides((s) => {
    g.add(cyl(r * 0.52, 0.12, M.dark, { z: s * (w / 2 + 0.02) }, "z", 16));
    g.add(cyl(r * 0.22, 0.25, M.metal, { z: s * (w / 2 + 0.08) }, "z", 10));
  });
  return g;
}
function crewHead(M: Mats, p: { x: number; y: number; z: number }, s = 1): THREE.Group {
  const g = group({ ...p, sx: s, sy: s, sz: s });
  g.add(box(1.2, 1.4, 1.5, M.olive, { y: -0.6 }, 0.4));                    // torso / plate carrier
  g.add(sphere(0.62, M.skin, { x: 0.1, y: 0.45 }, 12));                     // head
  g.add(sphere(0.72, M.plain, { y: 0.62, sy: 0.75 }, 14));                  // helmet
  g.add(box(0.35, 0.3, 0.7, M.dark, { x: 0.55, y: 0.85 }, 0.08));           // NVG mount
  return g;
}

// ---- Anthropic "APC": Stryker/Boxer-class 8x8 with RWS + slat armor ----
function apc(M: Mats): THREE.Group {
  const root = group();
  const R = 1.95, TW = 1.6, WZ = 5.4;
  for (const x of [-10.2, -6.4, 5.6, 9.4]) sides((s) => root.add(wheel(M, R, TW, { x, z: s * WZ })));
  // lower hull flares over the wheels, upper hull tumblehomes in; V-nose glacis
  const low: V2[] = [[15.2, 2.2], [13.5, 4.4], [-14.6, 4.4], [-15, 3.6], [-15, -3.6], [-14.6, -4.4], [13.5, -4.4], [15.2, -2.2]];
  const mid: V2[] = [[15.6, 3.0], [13.8, 6.3], [-14.9, 6.3], [-15.2, 5.6], [-15.2, -5.6], [-14.9, -6.3], [13.8, -6.3], [15.6, -3.0]];
  const top: V2[] = [[10.6, 2.8], [9.6, 5.5], [-14.6, 5.5], [-14.9, 5.0], [-14.9, -5.0], [-14.6, -5.5], [9.6, -5.5], [10.6, -2.8]];
  root.add(loft(low, 1.5, mid, 3.9, M.camo));
  root.add(loft(mid, 3.9, top, 7.0, M.camo));
  // wheel-arch fenders
  sides((s) => { for (const x of [-8.3, 7.5]) root.add(box(9.4, 0.3, 1.4, M.camo, { x, y: 4.05, z: s * 6.2 }, 0.1)); });
  // slat armor cage on the rear flanks (dark bar grid stood off the hull)
  sides((s) => {
    const sl = group({ x: -5.5, y: 4.9, z: s * 6.75 }); root.add(sl);
    sl.add(box(15, 0.22, 0.22, M.dark, { y: 1.9 }, 0.05)); sl.add(box(15, 0.22, 0.22, M.dark, { y: -1.5 }, 0.05));
    for (let i = 0; i < 16; i++) sl.add(box(0.14, 3.4, 0.14, M.dark, { x: -7.2 + i * 0.96, y: 0.2 }, 0.03));
  });
  // roof: RWS, commander + driver hatches, periscopes, stowage, antennas, recognition panel
  root.add(rws(M, M.camoHi, { x: 1.5, y: 7.0, z: -1.4 }, 1.1));
  root.add(cyl(1.0, 0.35, M.camoHi, { x: -3.5, y: 7.15, z: 2.0 }, "y", 14));
  root.add(cyl(0.9, 0.35, M.camoHi, { x: 8.0, y: 7.1, z: 2.6 }, "y", 14));
  for (let k = 0; k < 3; k++) root.add(box(0.4, 0.35, 0.55, M.glass, { x: 9.7, y: 7.1, z: 1.8 + k * 0.65, rz: -0.3 }, 0.05));
  root.add(box(5.0, 1.1, 4.4, M.olive, { x: -11.0, y: 7.55, z: 0.5 }, 0.45));
  root.add(box(1.0, 1.3, 0.7, M.plain, { x: -13.3, y: 7.6, z: -3.6 }, 0.1));
  root.add(box(1.0, 1.3, 0.7, M.plain, { x: -12.0, y: 7.6, z: -3.6 }, 0.1));
  root.add(box(3.0, 0.06, 2.2, M.marking, { x: -5.0, y: 7.03, z: -2.2 }, 0.02));
  sides((s) => root.add(rod([-13.8, 7.0, s * 4.6], [-14.3, 12.5, s * 4.9], 0.05, M.dark)));
  sides((s) => root.add(smokeLaunchers(M, 9.0, 6.6, s * 4.9, s, 3)));
  // front: headlights, tow hooks, trim vane hint; rear: ramp outline + exhaust grille
  sides((s) => {
    root.add(box(0.7, 0.5, 0.9, M.dark, { x: 15.0, y: 4.9, z: s * 3.6 }, 0.1));
    root.add(box(0.12, 0.3, 0.55, M.whiteLight, { x: 15.38, y: 4.95, z: s * 3.6 }, 0.02));
    root.add(box(0.6, 0.5, 0.4, M.metal, { x: 15.5, y: 2.6, z: s * 2.2 }, 0.1));
    root.add(box(0.2, 0.4, 0.3, M.redLight, { x: -15.15, y: 5.8, z: s * 4.6 }, 0.02));
  });
  root.add(box(0.15, 4.6, 6.0, M.dark, { x: -15.1, y: 4.3 }, 0.05));
  root.add(box(3.5, 0.2, 2.6, M.dark, { x: 4.5, y: 7.05, z: 3.4 }, 0.06)); // engine grille
  sides((s) => root.add(box(1.4, 0.7, 0.06, M.marking, { x: -1, y: 5.6, z: s * 5.95, rx: s * -0.33 }, 0.01)));
  return root;
}

// ---- OpenAI Buggy: Flyer-72/DAGOR-class light strike vehicle ----
function buggy(M: Mats): THREE.Group {
  const root = group();
  const R = 2.25;
  for (const x of [-7.4, 7.0]) sides((s) => root.add(wheel(M, R, 1.5, { x, z: s * 4.6 })));
  // low tub chassis with light armor door plates
  root.add(loft([[10.5, 2.4], [9.0, 3.6], [-9.5, 3.6], [-10.5, 2.8], [-10.5, -2.8], [-9.5, -3.6], [9.0, -3.6], [10.5, -2.4]], 1.6,
    [[10.8, 2.6], [8.8, 3.8], [-9.6, 3.8], [-10.7, 3.0], [-10.7, -3.0], [-9.6, -3.8], [8.8, -3.8], [10.8, -2.6]], 3.6, M.camo));
  root.add(prism([[5.0, 3.6], [10.8, 3.6], [10.4, 4.4], [6.0, 4.9]], 7.2, M.camo, {}, 0.2)); // hood
  sides((s) => root.add(box(6.5, 1.6, 0.35, M.camo, { x: -1.0, y: 4.3, z: s * 3.75 }, 0.08))); // door armor
  sides((s) => root.add(box(2.6, 0.25, 2.4, M.dark, { x: 7.0, y: 4.8, z: s * 4.6 }, 0.06)));  // fenders
  sides((s) => root.add(box(2.6, 0.25, 2.4, M.dark, { x: -7.4, y: 4.8, z: s * 4.6 }, 0.06)));
  // windshield frame + roll cage
  root.add(box(0.2, 2.0, 6.6, M.dark, { x: 4.6, y: 5.8, rz: 0.35 }, 0.05));
  root.add(box(0.1, 1.6, 6.0, M.glass, { x: 4.72, y: 5.75, rz: 0.35 }, 0.03));
  sides((s) => {
    root.add(rod([4.2, 4.5, s * 3.3], [3.4, 8.0, s * 3.0], 0.18, M.dark));
    root.add(rod([3.4, 8.0, s * 3.0], [-4.0, 8.0, s * 3.0], 0.18, M.dark));
    root.add(rod([-4.0, 8.0, s * 3.0], [-8.5, 4.2, s * 3.4], 0.18, M.dark));
    root.add(rod([-4.0, 8.0, s * 3.0], [-4.4, 4.2, s * 3.5], 0.18, M.dark));
  });
  root.add(rod([3.4, 8.0, 3.0], [3.4, 8.0, -3.0], 0.18, M.dark));
  root.add(rod([-4.0, 8.0, 3.0], [-4.0, 8.0, -3.0], 0.18, M.dark));
  // crew: driver + passenger, and the gunner standing at the ring mount
  root.add(crewHead(M, { x: 1.6, y: 5.6, z: 1.7 }));
  root.add(crewHead(M, { x: 1.6, y: 5.6, z: -1.7 }));
  root.add(torus(1.5, 0.18, M.dark, { x: -2.0, y: 8.15, rx: Math.PI / 2 }));
  root.add(crewHead(M, { x: -2.6, y: 8.0, z: 0 }));
  const mg = group({ x: -1.0, y: 8.6 }); root.add(mg);
  mg.add(box(1.6, 0.7, 0.6, M.metal, {}, 0.1));
  mg.add(cyl(0.16, 3.6, M.metal, { x: 2.5 }, "x", 8));
  mg.add(box(0.8, 0.9, 1.4, M.dark, { x: 0.4, y: 0.2 }, 0.1)); // gun shield
  mg.add(box(0.6, 0.5, 0.5, M.olive, { x: -0.3, y: -0.2, z: -0.7 }, 0.08));
  // rear cargo: spare tire, jerry cans, gear
  root.add(cyl(1.7, 1.0, M.rubber, { x: -9.4, y: 5.2, rz: 0 }, "z", 18));
  root.add(cyl(0.7, 1.1, M.dark, { x: -9.4, y: 5.2 }, "z", 10));
  root.add(box(1.0, 1.2, 0.7, M.plain, { x: -7.6, y: 4.2, z: 2.4 }, 0.1));
  root.add(box(1.0, 1.2, 0.7, M.plain, { x: -7.6, y: 4.2, z: -2.4 }, 0.1));
  root.add(box(2.6, 1.0, 3.0, M.olive, { x: -7.3, y: 4.1 }, 0.4));
  // light bar + headlights + white marking stripe on the hood
  root.add(box(0.4, 0.35, 3.6, M.dark, { x: 3.6, y: 8.2 }, 0.06));
  sides((s) => root.add(box(0.12, 0.3, 0.6, M.whiteLight, { x: 10.85, y: 4.0, z: s * 2.2 }, 0.02)));
  root.add(box(4.5, 0.06, 1.0, M.marking, { x: 8.0, y: 4.75, rz: -0.12 }, 0.01));
  sides((s) => root.add(rod([-9.8, 4.6, s * 2.8], [-10.2, 10.5, s * 3.0], 0.05, M.dark)));
  return root;
}

// ---- OpenAI Recon Bike: military dirt bike with rider + side rocket pod (exaggerated ~14 long) ----
function bike(M: Mats): THREE.Group {
  const root = group();
  const R = 2.2;
  root.add(wheel(M, R, 0.9, { x: 4.6, z: 0 })); root.add(wheel(M, R, 0.9, { x: -4.6, z: 0 }));
  // forks, frame, swingarm, engine, tank, seat, fenders
  sides((s) => root.add(rod([4.6, R, s * 0.6], [2.8, 6.6, s * 0.55], 0.2, M.steel)));
  root.add(rod([2.8, 6.8, 0], [-1.5, 5.4, 0], 0.32, M.dark));
  sides((s) => root.add(rod([-4.6, R, s * 0.55], [-0.5, 3.4, s * 0.5], 0.2, M.dark)));
  root.add(box(3.0, 2.2, 1.4, M.metal, { x: 0.6, y: 3.6 }, 0.3));      // engine
  root.add(cyl(0.3, 4.0, M.steel, { x: -2.4, y: 3.4, z: 0.85, rz: 0.2 }, "x", 8)); // exhaust
  root.add(box(3.2, 1.6, 2.0, M.camo, { x: 1.0, y: 6.0 }, 0.6));       // tank
  root.add(box(4.0, 0.7, 1.4, M.rubber, { x: -2.2, y: 5.9 }, 0.3));    // seat
  root.add(box(3.0, 0.3, 1.2, M.camo, { x: 4.6, y: 4.7, rz: 0.15 }, 0.1));  // front fender
  root.add(box(3.4, 0.3, 1.3, M.camo, { x: -4.6, y: 5.4, rz: -0.2 }, 0.1)); // rear fender
  root.add(box(0.6, 1.4, 1.6, M.camo, { x: 3.5, y: 7.2, rz: -0.3 }, 0.15)); // number plate / headlight
  root.add(box(0.1, 0.5, 0.6, M.whiteLight, { x: 3.85, y: 7.2, rz: -0.3 }, 0.02));
  root.add(box(0.3, 0.3, 3.2, M.dark, { x: 2.6, y: 7.6 }, 0.05));       // handlebar
  // rider (helmet, goggles, plate carrier, arms to bars, legs on pegs)
  const rd = group({ x: -1.4, y: 6.4 }); root.add(rd);
  sides((s) => {
    rd.add(rod([0, 0.4, s * 0.8], [2.4, -1.0, s * 1.0], 0.42, M.olive));   // thigh
    rd.add(rod([2.4, -1.0, s * 1.0], [1.8, -3.0, s * 1.1], 0.38, M.olive)); // shin
    rd.add(box(1.0, 0.5, 0.6, M.rubber, { x: 2.1, y: -3.2, z: s * 1.1 }, 0.15));  // boot
    rd.add(rod([1.2, 3.0, s * 1.0], [3.9, 1.3, s * 1.5], 0.3, M.olive));   // arm
  });
  rd.add(box(2.0, 2.8, 2.2, M.olive, { x: 0.7, y: 1.8, rz: -0.35 }, 0.6)); // torso
  rd.add(box(1.2, 2.0, 1.8, M.dark, { x: -0.5, y: 2.0, rz: -0.35 }, 0.4)); // backpack radio
  rd.add(rod([-0.7, 3.0, -0.6], [-1.4, 7.0, -0.7], 0.05, M.dark));        // whip antenna
  rd.add(sphere(0.95, M.camo, { x: 1.7, y: 3.9, sy: 0.9 }, 14));           // helmet
  rd.add(box(0.4, 0.45, 1.2, M.glass, { x: 2.55, y: 3.75 }, 0.15));        // goggles
  // rocket pod on the right side rack (4 tubes, forward)
  const pod = group({ x: -3.5, y: 6.6, z: -1.7 }); root.add(pod);
  pod.add(box(3.6, 1.6, 1.6, M.camo, {}, 0.2));
  for (const [y, z] of [[0.4, 0.4], [0.4, -0.4], [-0.4, 0.4], [-0.4, -0.4]] as V2[]) pod.add(cyl(0.3, 0.3, M.rubber, { x: 1.82, y, z }, "x", 10));
  pod.add(box(3.7, 0.08, 0.5, M.marking, { y: 0.82 }, 0.01));
  root.add(box(3.0, 0.3, 1.0, M.dark, { x: -3.5, y: 5.75, z: -1.5 }, 0.05)); // rack
  return root;
}

// ---- OpenAI "Laser Coil": HEMTT 6x6 truck with a high-energy laser beam director ----
function laserTruck(M: Mats): THREE.Group {
  const root = group();
  const R = 2.0;
  for (const x of [10.0, -5.6, -10.0]) sides((s) => root.add(wheel(M, R, 1.6, { x, z: s * 4.9 })));
  root.add(box(28, 1.2, 8.2, M.dark, { x: -1, y: 2.9 }, 0.15)); // frame rails
  // armored cab
  root.add(loft([[15, 5.1], [8.5, 5.4], [8.5, -5.4], [15, -5.1]], 2.6, [[13.6, 4.7], [8.6, 5.0], [8.6, -5.0], [13.6, -4.7]], 9.2, M.camo));
  root.add(box(0.15, 2.4, 8.4, M.glass, { x: 14.3, y: 7.4, rz: 0.2 }, 0.04));
  sides((s) => root.add(box(3.0, 2.0, 0.12, M.glass, { x: 11.5, y: 7.6, z: s * 4.98 }, 0.03)));
  root.add(box(1.4, 1.2, 1.0, M.dark, { x: 10.0, y: 9.8, z: -2.5 }, 0.1)); // roof hatch MG/sensor
  sides((s) => { root.add(box(3.0, 0.3, 2.6, M.camo, { x: 10, y: 4.5, z: s * 4.9 }, 0.08)); root.add(box(0.12, 0.35, 0.7, M.whiteLight, { x: 15.05, y: 4.2, z: s * 3.6 }, 0.02)); });
  root.add(box(4.5, 0.3, 9.4, M.camo, { x: -7.8, y: 4.8 }, 0.1)); // rear fenders
  // power module (generator + battery) behind the cab, radiator grilles
  root.add(box(5.0, 4.4, 8.0, M.camo, { x: 4.8, y: 5.6 }, 0.3));
  sides((s) => { for (let k = 0; k < 5; k++) root.add(box(0.25, 3.0, 0.15, M.dark, { x: 3.0 + k * 0.9, y: 5.8, z: s * 4.05 }, 0.03)); });
  root.add(cyl(0.45, 2.2, M.metal, { x: 6.5, y: 8.9, z: 3.2 }, "y", 10)); // exhaust stack
  // flatbed + beam director turret
  root.add(box(13, 0.8, 8.4, M.camo, { x: -6.2, y: 3.9 }, 0.15));
  const tur = group({ x: -6.5, y: 4.3 }); root.add(tur);
  tur.add(cyl(3.6, 1.6, M.camoHi, { y: 0.8 }, "y", 22));
  sides((s) => tur.add(box(2.4, 3.8, 0.8, M.camoHi, { x: 0.3, y: 3.4, z: s * 2.8 }, 0.2)));
  const bd = group({ x: 0.3, y: 4.4, rz: 0.15 }); tur.add(bd);
  bd.add(cyl(2.1, 4.8, M.camoHi, { x: 0.4 }, "x", 22));
  bd.add(cyl(2.25, 0.5, M.dark, { x: 2.9 }, "x", 22));
  bd.add(cyl(1.6, 0.3, M.glass, { x: 3.2 }, "x", 22));
  bd.add(cyl(0.8, 0.3, M.energy, { x: 3.3 }, "x", 16));
  bd.add(box(1.6, 0.9, 1.4, M.dark, { x: -0.6, y: 2.2 }, 0.12));
  bd.add(box(0.1, 0.5, 0.7, M.lens, { x: 0.22, y: 2.2 }, 0.02));
  // stowage + markings
  root.add(box(3, 1.0, 2.6, M.olive, { x: -11.4, y: 4.8, z: 2.3 }, 0.35));
  root.add(box(4.0, 0.06, 1.0, M.marking, { x: 11.5, y: 9.23 }, 0.01));
  sides((s) => root.add(box(3.0, 0.4, 0.06, M.marking, { x: 4.8, y: 6.5, z: s * 4.04 }, 0.01)));
  sides((s) => root.add(rod([8.8, 9.2, s * 4.6], [8.4, 14, s * 4.8], 0.05, M.dark)));
  return root;
}

export const VEHICLES: Record<string, () => Model> = {
  humvee: () => ({ root: apc(kA().M), meta: { muzzle: [5.5, 8.15, -1.85] } }),
  nod_buggy: () => ({ root: buggy(kO().M), meta: { muzzle: [3.3, 8.6, 0] } }),
  nod_bike: () => ({ root: bike(kO().M), meta: { muzzle: [-1.6, 6.6, -1.7] } }),
  nod_tesla: () => ({ root: laserTruck(kO().M), meta: { muzzle: [-2.5, 9.5, 0] } }),
};
void PALETTES;
