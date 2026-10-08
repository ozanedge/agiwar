// Exotic unit models — mechs, walkers, robot dogs, crawler bots, UGVs. See baker/README.md.
// Legged units are posed with a small 2-bone IK: each frame places the feet on a gait cycle and
// solves knees, rebuilding the (cheap) leg meshes. Frame 0 = idle stance, 1..4 = stride (meta.walk).
import * as THREE from "three";
import { box, cyl, sphere, torus, loft, group, sides, mat, materials, PALETTES, type Mats, type Palette, type V2 } from "../kit";
import type { Model } from "../render";
import { limb } from "./infantry";

type V3 = [number, number, number];
const v = (a: V3) => new THREE.Vector3(...a);

// Armored beam (box) spanning two points; local width axis stays lateral for limbs in the XY plane.
function beam(a: V3, b: V3, w: number, d: number, m: THREE.Material, r = 0.3): THREE.Mesh {
  const va = v(a), vb = v(b), len = Math.max(0.05, va.distanceTo(vb));
  const mesh = box(w, len, d, m, {}, r);
  mesh.position.copy(va.clone().add(vb).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  return mesh;
}
// 2-bone IK: knee position for hip→foot with segment lengths a, b, bending toward `hint`.
function knee(H: V3, F: V3, a: number, b: number, hint: V3): V3 {
  const h = v(H), f = v(F), d = Math.min(a + b - 0.01, Math.max(0.01, h.distanceTo(f)));
  const dir = f.clone().sub(h).normalize();
  const x = (a * a - b * b + d * d) / (2 * d), y = Math.sqrt(Math.max(0, a * a - x * x));
  const hv = v(hint); const perp = hv.sub(dir.clone().multiplyScalar(hv.dot(dir))).normalize();
  const k = h.add(dir.multiplyScalar(x)).add(perp.multiplyScalar(y));
  return [k.x, k.y, k.z];
}
// gait: foot offset (forward, lift) for frame k and leg phase offset (radians)
function gait(k: number, off: number, stride: number, lift: number): [number, number] {
  if (k === 0) return [0, 0];
  const ph = ((k - 1) / 4) * Math.PI * 2 + off;
  return [stride * Math.cos(ph), Math.max(0, -Math.sin(ph)) * lift];
}

interface LegSpec { hip: V3; foot: V3; a: number; b: number; hint: V3; off: number; draw: (g: THREE.Group, H: V3, K: V3, F: V3) => void }
function legged(body: THREE.Group, legs: LegSpec[], stride: number, lift: number, bob: number): Pick<Model, "frames" | "animate"> {
  const lg = legs.map(() => group());
  const root = body.parent as THREE.Group;
  for (const g of lg) root.add(g);
  const baseY = body.position.y;
  const animate = (k: number) => {
    body.position.y = baseY + (k === 0 ? 0 : (k % 2 ? -bob : bob * 0.4));
    legs.forEach((L, i) => {
      const g = lg[i]; for (const c of [...g.children]) { g.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
      const [fx, fy] = gait(k, L.off, stride, lift);
      const H: V3 = [L.hip[0], L.hip[1] + body.position.y - baseY, L.hip[2]];
      const F: V3 = [L.foot[0] + fx, L.foot[1] + fy, L.foot[2]];
      L.draw(g, H, knee(H, F, L.a, L.b, L.hint), F);
    });
  };
  animate(0);
  return { frames: 5, animate };
}

const kit = (p: Palette) => ({ M: materials(p), P: p, oai: p.name === "openai" });
type K = ReturnType<typeof kit>;
const glow = (c: number, i: number) => mat({ color: 0x0a1820, emissive: c, emissiveI: i });

// ---------- bipedal mechs ----------
function mechLeg(K: K, w: number, footL: number) {
  const { M } = K;
  return (g: THREE.Group, H: V3, Kn: V3, F: V3) => {
    g.add(beam(H, Kn, w, w * 0.95, M.camo, 0.35));                       // thigh armor
    g.add(beam(Kn, [F[0] - 0.3, F[1] + 0.9, F[2]], w * 0.85, w * 0.9, M.camo, 0.35)); // shin
    g.add(limb(H, Kn, w * 0.28, M.dark)); g.add(limb(Kn, [F[0], F[1] + 1, F[2]], w * 0.24, M.metal)); // hydraulics
    g.add(box(w * 1.0, w * 0.75, w * 1.05, M.dark, { x: Kn[0] + 0.3, y: Kn[1], z: Kn[2] }, 0.3)); // knee actuator
    g.add(box(w * 0.7, w * 0.7, w * 1.0, M.camoHi, { x: Kn[0] + w * 0.55, y: Kn[1] + 0.2, z: Kn[2] }, 0.25)); // knee plate
    g.add(box(footL, 0.9, w * 1.25, M.dark, { x: F[0] + footL * 0.15, y: F[1] + 0.45, z: F[2] }, 0.3)); // foot
    g.add(box(footL * 0.4, 0.6, w * 1.3, M.camo, { x: F[0] + footL * 0.5, y: F[1] + 0.4, z: F[2] }, 0.2)); // toe cap
  };
}
function autocannon(K: K, p: V3, len: number): THREE.Group {
  const { M } = K, g = group({ x: p[0], y: p[1], z: p[2] });
  g.add(box(3.4, 2.2, 2.2, M.camoHi, { x: -0.4 }, 0.35));
  sides((s) => { g.add(cyl(0.3, len, M.metal, { x: 1.2 + len / 2, z: s * 0.5 }, "x", 10)); g.add(cyl(0.42, 0.9, M.dark, { x: 1.2 + len, z: s * 0.5 }, "x", 10)); });
  g.add(box(1.2, 1.0, 1.6, M.dark, { x: 1.5 }, 0.2));
  g.add(box(1.6, 1.2, 0.9, M.olive, { x: -1.0, y: -0.2, z: 1.5 }, 0.2)); // ammo feed
  return g;
}
function warmech(): Model {
  const K = kit(PALETTES.anthropic), { M } = K, root = group();
  const body = group({ y: 9.2 }); root.add(body);
  body.add(box(3.6, 2.0, 5.0, M.dark, { y: 0.4 }, 0.4)); // pelvis
  const B: V2[] = [[2.6, 2.4], [1.6, 3.2], [-2.0, 3.2], [-2.8, 2.2], [-2.8, -2.2], [-2.0, -3.2], [1.6, -3.2], [2.6, -2.4]];
  const T: V2[] = [[3.3, 3.2], [2.0, 4.4], [-2.3, 4.4], [-3.0, 3.0], [-3.0, -3.0], [-2.3, -4.4], [2.0, -4.4], [3.3, -3.2]];
  body.add(loft(B, 1.2, T, 6.4, M.camoHi));
  body.add(box(2.6, 1.7, 3.0, M.camoHi, { x: 1.4, y: 7.2 }, 0.4)); // cockpit head
  body.add(box(0.2, 0.55, 2.4, M.glass, { x: 2.72, y: 7.4 }, 0.05));
  body.add(box(0.15, 0.25, 0.5, M.lens, { x: 2.8, y: 6.8, z: 1.0 }, 0.04));
  body.add(box(2.4, 3.2, 5.6, M.dark, { x: -3.6, y: 4.0 }, 0.4)); // power pack
  for (let i = 0; i < 4; i++) body.add(box(0.25, 2.2, 4.6, M.metal, { x: -4.85, y: 4.0, z: -1.8 + i * 1.2, rx: 0 }, 0.05));
  sides((s) => {
    body.add(autocannon(K, [0.4, 6.6, s * 5.3], 6.2)); // shoulder autocannons
    body.add(box(0.8, 0.3, 2.3, M.marking, { x: -1.5, y: 7.85, z: s * 5.3 }, 0.05)); // pod stripe (faction)
    // arms: pauldron, upper arm, forearm w/ armored fist
    body.add(box(3.0, 2.0, 1.6, M.camoHi, { x: 0, y: 4.9, z: s * 4.5 }, 0.35));
    body.add(beam([0, 4.4, s * 4.7], [0.6, 1.0, s * 5.0], 1.4, 1.4, M.camo));
    body.add(beam([0.6, 1.0, s * 5.0], [3.2, 0.2, s * 4.8], 1.6, 1.7, M.camo));
    body.add(box(1.6, 1.5, 1.6, M.dark, { x: 3.9, y: 0.1, z: s * 4.8 }, 0.35));
  });
  body.add(cyl(0.06, 3.5, M.dark, { x: -3.6, y: 7.3, z: -2.0 }, "y", 6)); // antenna
  const meta = { muzzle: [8.1, 15.8, 5.3] as V3, walk: [1, 4] as [number, number] };
  const draw = mechLeg(K, 1.9, 3.6);
  return { root, meta, ...legged(body, [
    { hip: [0, 9.4, 2.4], foot: [0.2, 0, 2.7], a: 5.0, b: 5.0, hint: [1, 0, 0], off: 0, draw },
    { hip: [0, 9.4, -2.4], foot: [0.2, 0, -2.7], a: 5.0, b: 5.0, hint: [1, 0, 0], off: Math.PI, draw },
  ], 1.6, 1.2, 0.25) };
}
function titan(): Model {
  const K = kit(PALETTES.anthropic), { M } = K, root = group();
  const body = group({ y: 7.6 }); root.add(body);
  body.add(box(4.4, 2.2, 6.6, M.dark, { y: 0.4 }, 0.4));
  const B: V2[] = [[2.6, 3.4], [1.4, 4.6], [-2.6, 4.6], [-3.4, 3.2], [-3.4, -3.2], [-2.6, -4.6], [1.4, -4.6], [2.6, -3.4]];
  const T: V2[] = [[3.2, 4.2], [1.8, 5.6], [-2.8, 5.6], [-3.6, 3.9], [-3.6, -3.9], [-2.8, -5.6], [1.8, -5.6], [3.2, -4.2]];
  body.add(loft(B, 1.2, T, 7.6, M.camoHi));
  body.add(box(2.4, 1.5, 3.2, M.camoHi, { x: 1.6, y: 8.3 }, 0.4)); body.add(box(0.2, 0.45, 2.6, M.glass, { x: 2.82, y: 8.45 }, 0.05));
  // top turret (light twin MG)
  body.add(cyl(1.2, 0.7, M.dark, { x: -0.6, y: 8.0 }, "y", 16));
  body.add(box(2.0, 1.0, 1.6, M.camoHi, { x: -0.3, y: 8.8 }, 0.25));
  sides((s) => body.add(cyl(0.18, 3.6, M.metal, { x: 2.4, y: 8.8, z: s * 0.4 }, "x", 8)));
  // repair-drone pods on the back shoulders
  const green = glow(0x46ff8a, 1.6);
  sides((s) => {
    body.add(cyl(1.3, 3.2, M.dark, { x: -3.0, y: 7.6, z: s * 3.6 }, "y", 16));
    body.add(torus(1.32, 0.12, green, { x: -3.0, y: 8.3, z: s * 3.6, rx: Math.PI / 2 }));
    const dr = group({ x: -3.0, y: 9.5, z: s * 3.6 }); body.add(dr); // docked drone
    dr.add(box(1.2, 0.4, 1.2, M.camoHi, {}, 0.15));
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) dr.add(cyl(0.45, 0.06, M.dark, { x: a * 0.85, y: 0.15, z: b * 0.85 }, "y", 12));
  });
  // shield-wall: two huge frontal plates on hydraulic arms, angled out
  sides((s) => {
    const sh = group({ x: 5.4, y: 4.2, z: s * 2.9, ry: s * -0.22 }); body.add(sh);
    sh.add(box(1.0, 11.0, 5.6, M.camoHi, {}, 0.3));
    sh.add(box(0.5, 10.0, 4.6, M.camo, { x: 0.55 }, 0.2));
    for (let i = -1; i <= 1; i++) sh.add(box(0.35, 0.5, 4.8, M.dark, { x: 0.9, y: i * 3.2 }, 0.1)); // ribs
    sh.add(box(0.12, 1.0, 4.7, M.marking, { x: 0.86, y: 4.3 }, 0.03)); // faction band
    sh.add(box(0.2, 0.5, 0.9, M.glass, { x: 0.86, y: 2.2, z: -s * 1.4 }, 0.05)); // vision block
    body.add(beam([0.4, 5.3, s * 5.2], [4.6, 4.6, s * 3.6], 1.6, 1.6, M.camo));
    body.add(box(3.0, 2.2, 1.8, M.camoHi, { x: 0, y: 5.9, z: s * 5.6 }, 0.35));
  });
  const meta = { muzzle: [4.2, 16.4, 0] as V3, walk: [1, 4] as [number, number] };
  const draw = mechLeg(K, 2.4, 4.0);
  return { root, meta, ...legged(body, [
    { hip: [-0.4, 7.8, 3.1], foot: [-0.2, 0, 3.5], a: 4.2, b: 4.2, hint: [1, 0, 0], off: 0, draw },
    { hip: [-0.4, 7.8, -3.1], foot: [-0.2, 0, -3.5], a: 4.2, b: 4.2, hint: [1, 0, 0], off: Math.PI, draw },
  ], 1.2, 0.9, 0.2) };
}
function nodWarmech(): Model { // powered exoskeleton commando
  const K = kit(PALETTES.openai), { M } = K, root = group();
  const body = group({ y: 7.2 }); root.add(body);
  body.add(box(2.4, 1.6, 3.4, M.dark, { y: 0.3 }, 0.4));
  body.add(box(2.8, 4.4, 4.2, M.camoHi, { y: 3.4 }, 0.7));                         // torso armor
  body.add(box(1.2, 2.6, 3.0, M.camo, { x: 1.6, y: 3.6 }, 0.4));                   // chest plate
  body.add(box(2.2, 3.4, 3.6, M.dark, { x: -2.2, y: 3.6 }, 0.45));                 // power pack
  sides((s) => body.add(cyl(0.45, 2.2, M.metal, { x: -3.2, y: 4.2, z: s * 1.1 }, "y", 12)));
  body.add(box(0.15, 1.6, 0.4, M.marking, { x: -3.32, y: 4.0 }, 0.03));
  const hd = group({ x: 0.3, y: 6.4 }); body.add(hd);                                  // helmet
  hd.add(box(2.0, 1.8, 1.8, M.camoHi, {}, 0.7));
  hd.add(box(0.3, 0.45, 1.5, glow(0x8fe6ff, 1.2), { x: 1.0, y: 0.15 }, 0.1));    // visor
  hd.add(box(0.8, 0.5, 0.4, M.dark, { x: -0.3, y: 0.9, z: 0.6 }, 0.1));
  sides((s) => body.add(box(2.4, 1.6, 1.6, M.camoHi, { x: 0, y: 5.4, z: s * 2.6 }, 0.45))); // pauldrons
  // right arm cannon
  body.add(beam([0, 5.0, 2.7], [0.6, 2.8, 2.9], 1.3, 1.3, M.camo));
  body.add(cyl(0.95, 4.4, M.dark, { x: 2.6, y: 2.8, z: 2.9 }, "x", 16));
  body.add(cyl(0.55, 2.2, M.metal, { x: 5.6, y: 2.8, z: 2.9 }, "x", 12));
  body.add(cyl(0.7, 0.5, M.dark, { x: 6.8, y: 2.8, z: 2.9 }, "x", 12));
  body.add(box(1.6, 1.0, 0.5, M.marking, { x: 2.4, y: 3.6, z: 2.9 }, 0.05));
  // left arm
  body.add(beam([0, 5.0, -2.7], [0.5, 2.6, -2.9], 1.2, 1.2, M.camo));
  body.add(beam([0.5, 2.6, -2.9], [2.3, 2.0, -2.5], 1.1, 1.1, M.camo));
  body.add(sphere(0.7, M.dark, { x: 2.7, y: 1.9, z: -2.4 }, 10));
  const draw = (g: THREE.Group, H: V3, Kn: V3, F: V3) => {
    g.add(beam(H, Kn, 1.35, 1.35, M.camo)); g.add(beam(Kn, [F[0], F[1] + 0.7, F[2]], 1.15, 1.2, M.camo));
    g.add(box(1.2, 1.0, 1.4, M.dark, { x: Kn[0] + 0.3, y: Kn[1], z: Kn[2] }, 0.3));
    g.add(box(2.4, 0.75, 1.3, M.dark, { x: F[0] + 0.35, y: F[1] + 0.38, z: F[2] }, 0.25));
  };
  const meta = { muzzle: [7.1, 10.0, 2.9] as V3, walk: [1, 4] as [number, number] };
  return { root, meta, ...legged(body, [
    { hip: [0, 7.3, 1.2], foot: [0.1, 0, 1.4], a: 3.8, b: 3.7, hint: [1, 0, 0], off: 0, draw },
    { hip: [0, 7.3, -1.2], foot: [0.1, 0, -1.4], a: 3.8, b: 3.7, hint: [1, 0, 0], off: Math.PI, draw },
  ], 1.5, 1.0, 0.2) };
}
function nodTitan(): Model { // reverse-joint walker with twin cannons
  const K = kit(PALETTES.openai), { M } = K, root = group();
  const body = group({ y: 11.0 }); root.add(body);
  const B: V2[] = [[4.6, 1.4], [2.4, 3.0], [-3.6, 3.0], [-4.6, 1.8], [-4.6, -1.8], [-3.6, -3.0], [2.4, -3.0], [4.6, -1.4]];
  const T: V2[] = [[3.6, 1.0], [1.8, 2.4], [-3.0, 2.4], [-4.0, 1.4], [-4.0, -1.4], [-3.0, -2.4], [1.8, -2.4], [3.6, -1.0]];
  body.add(loft(B, 0, T, 3.4, M.camoHi));
  body.add(loft(B.map(([x, z]) => [x * 0.85, z * 0.85] as V2), -1.6, B, 0, M.camo));
  body.add(box(1.4, 1.2, 2.0, M.dark, { x: 4.6, y: 1.0 }, 0.3));                     // sensor head
  body.add(box(0.15, 0.45, 1.4, glow(0xff4a3a, 1.4), { x: 5.33, y: 1.15 }, 0.04));
  body.add(box(2.6, 0.12, 1.8, M.marking, { x: -1.2, y: 3.45 }, 0.03));
  sides((s) => {
    const c = group({ x: 1.4, y: -0.6, z: s * 3.4 }); body.add(c);                  // twin cannons
    c.add(box(3.6, 1.6, 1.4, M.dark, {}, 0.3));
    c.add(cyl(0.42, 6.0, M.metal, { x: 4.6 }, "x", 12)); c.add(cyl(0.6, 1.0, M.dark, { x: 7.6 }, "x", 12));
    body.add(box(1.4, 1.8, 1.4, M.camo, { x: -1.5, y: 1.6, z: s * 3.0 }, 0.3));   // hip housing
  });
  body.add(box(2.2, 1.6, 3.6, M.dark, { x: -4.4, y: 1.4 }, 0.4));
  const draw = (g: THREE.Group, H: V3, Kn: V3, F: V3) => {
    const A: V3 = [F[0] - 1.6, F[1] + 2.8, F[2]];                                     // raised heel (digitigrade)
    const Kd = knee(H, A, 5.0, 4.6, [1, 0, 0]);
    g.add(beam(H, Kd, 1.5, 1.3, M.camo)); g.add(beam(Kd, A, 1.1, 1.0, M.camo));
    g.add(limb(Kd, A, 0.3, M.metal));
    g.add(box(1.2, 1.2, 1.4, M.dark, { x: Kd[0], y: Kd[1], z: Kd[2] }, 0.3));
    g.add(beam(A, [F[0], F[1] + 0.4, F[2]], 0.8, 0.9, M.dark));
    sides((s) => g.add(box(2.0, 0.5, 0.5, M.dark, { x: F[0] + 0.7, y: F[1] + 0.25, z: F[2] + s * 0.55, ry: s * -0.4 }, 0.15))); // splayed toes
  };
  const meta = { muzzle: [9.4, 10.4, 3.4] as V3, walk: [1, 4] as [number, number] };
  return { root, meta, ...legged(body, [
    { hip: [-1.5, 11.6, 3.0], foot: [-0.6, 0, 3.0], a: 5, b: 4.6, hint: [1, 0, 0], off: 0, draw },
    { hip: [-1.5, 11.6, -3.0], foot: [-0.6, 0, -3.0], a: 5, b: 4.6, hint: [1, 0, 0], off: Math.PI, draw },
  ], 1.8, 1.2, 0.3) };
}

// ---------- quad walkers ----------
// Cylinder joint whose axis is `n` (the leg-plane normal).
function joint(at: V3, n: THREE.Vector3, r: number, len: number, m: THREE.Material): THREE.Mesh {
  const c = cyl(r, len, m, {}, "y", 16);
  c.position.set(...at); c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n.clone().normalize());
  return c;
}
// beam extended past both joints so segments always overlap (no gaps from any heading)
function strut(a: V3, b: V3, w: number, d: number, m: THREE.Material, ext: number): THREE.Mesh {
  const va = v(a), vb = v(b), dir = vb.clone().sub(va).normalize();
  const A = va.clone().sub(dir.clone().multiplyScalar(ext)), B = vb.clone().add(dir.multiplyScalar(ext));
  return beam([A.x, A.y, A.z], [B.x, B.y, B.z], w, d, m, Math.min(0.35, w * 0.25));
}
function quadLegDraw(M: Mats, w: number) {
  return (g: THREE.Group, H: V3, Kn: V3, F: V3) => {
    const n = v(Kn).sub(v(H)).cross(v(F).sub(v(Kn))); if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    const ax = Math.abs(n.z) > Math.abs(n.x) ? n : n; // leg-plane normal
    g.add(box(w * 1.9, w * 1.7, w * 1.9, M.camoHi, { x: H[0], y: H[1], z: H[2] }, 0.35)); // hip actuator housing
    g.add(joint(H, ax, w * 0.75, w * 2.3, M.dark));
    g.add(strut(H, Kn, w * 1.15, w * 1.05, M.camo, w * 0.4));                          // thigh
    g.add(joint(Kn, ax, w * 0.8, w * 1.7, M.metal));                                      // knee
    g.add(strut(Kn, F, w * 0.8, w * 0.8, M.camo, w * 0.35));                            // shin
    const tm = v(H).lerp(v(Kn), 0.55), sm = v(Kn).lerp(v(F), 0.5);
    g.add(limb([tm.x, tm.y - w * 0.4, tm.z], [sm.x, sm.y, sm.z], w * 0.2, M.steel));    // hydraulic piston
    g.add(cyl(w * 0.42, w * 0.9, M.dark, { x: sm.x, y: sm.y, z: sm.z }, "y", 10));
    g.add(cyl(w * 0.85, 0.6, M.dark, { x: F[0], y: 0.3, z: F[2] }, "y", 14));           // foot pad
    g.add(cyl(w * 0.5, 0.7, M.metal, { x: F[0], y: 0.9, z: F[2] }, "y", 10));
  };
}
function quadLegs(M: Mats, body: THREE.Group, hx: number, hy: number, hz: number, fz: number, a: number, b: number, w: number, stride: number) {
  const draw = quadLegDraw(M, w), L: LegSpec[] = [];
  for (const sx of [1, -1]) for (const sz of [1, -1])
    L.push({ hip: [sx * hx, hy, sz * hz], foot: [sx * hx * 1.25, 0, sz * fz], a, b, hint: [sx * 0.25, 1.8, sz * 0.4], off: sx * sz > 0 ? 0 : Math.PI, draw });
  return legged(body, L, stride, 1.4, 0.2);
}
function railwalker(): Model {
  const K = kit(PALETTES.anthropic), { M } = K, root = group();
  const body = group({ y: 7.0 }); root.add(body);
  const B: V2[] = [[5, 2.6], [3.6, 3.4], [-4.4, 3.4], [-5.2, 2.4], [-5.2, -2.4], [-4.4, -3.4], [3.6, -3.4], [5, -2.6]];
  body.add(loft(B, -1.0, B.map(([x, z]) => [x * 0.9, z * 0.88] as V2), 2.0, M.camoHi));
  body.add(box(8.0, 1.8, 5.4, M.dark, { y: -1.6 }, 0.4));
  const coil = glow(0x6fc8ff, 0.9);
  // railgun: breech + twin rails with coil rings + capacitor banks
  body.add(box(4.0, 2.2, 3.2, M.dark, { x: -3.0, y: 3.2 }, 0.35));
  sides((s) => {
    body.add(box(24, 0.7, 0.55, M.metal, { x: 9.0, y: 3.3, z: s * 0.75 }, 0.15));
    body.add(box(5.0, 1.6, 1.3, M.camo, { x: -1.0, y: 2.6, z: s * 2.4 }, 0.3)); // capacitors
    body.add(box(4.4, 0.2, 1.1, M.marking, { x: -1.0, y: 3.45, z: s * 2.4 }, 0.03));
  });
  for (let i = 0; i < 7; i++) body.add(torus(1.05, 0.22, i % 2 ? M.dark : coil, { x: 0.8 + i * 3.0, y: 3.3, ry: Math.PI / 2 }));
  body.add(box(1.4, 1.6, 2.2, M.dark, { x: 21.3, y: 3.3 }, 0.25)); // muzzle block
  body.add(box(1.6, 1.0, 1.4, M.dark, { x: 4.6, y: 0.4 }, 0.3)); body.add(box(0.12, 0.4, 0.9, M.lens, { x: 5.42, y: 0.45 }, 0.03));
  const meta = { muzzle: [22.2, 10.3, 0] as V3, walk: [1, 4] as [number, number] };
  return { root, meta, ...quadLegs(M, body, 3.6, 7.0, 3.3, 5.8, 4.4, 7.2, 1.35, 1.4) };
}
function nodRailwalker(): Model {
  const K = kit(PALETTES.openai), { M } = K, root = group();
  const body = group({ y: 7.4 }); root.add(body);
  const B: V2[] = [[4.4, 0], [2.6, 3.2], [-3.6, 3.2], [-4.6, 0], [-3.6, -3.2], [2.6, -3.2]];
  body.add(loft(B, -1.2, B.map(([x, z]) => [x * 0.85, z * 0.85] as V2), 1.8, M.camoHi));
  body.add(box(6.0, 1.8, 4.6, M.dark, { y: -1.6 }, 0.4));
  const red = glow(0xff3b2e, 1.8);
  // obelisk emitter: tapered angular spire with glowing slits and a crystal tip
  const Sb: V2[] = [[1.8, 0], [0, 1.8], [-1.8, 0], [0, -1.8]], St: V2[] = [[0.5, 0], [0, 0.5], [-0.5, 0], [0, -0.5]];
  body.add(loft(Sb, 1.8, St, 13.0, M.camoHi));
  body.add(loft(Sb.map(([x, z]) => [x * 1.25, z * 1.25] as V2), 1.6, Sb.map(([x, z]) => [x * 1.05, z * 1.05] as V2), 3.6, M.dark));
  body.add(box(0.12, 8.0, 0.35, red, { x: 1.05, y: 7.6, rz: 0.12 }, 0.03));
  body.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.75), red)).position.set(0, 13.6, 0);
  body.add(box(0.1, 1.2, 0.8, M.marking, { x: 1.35, y: 3.0 }, 0.03));
  body.add(box(1.4, 1.0, 1.6, M.dark, { x: 4.2, y: 0.2 }, 0.3)); body.add(box(0.12, 0.35, 1.0, red, { x: 4.92, y: 0.25 }, 0.03));
  const meta = { muzzle: [0, 21.0, 0] as V3, walk: [1, 4] as [number, number] };
  return { root, meta, ...quadLegs(M, body, 3.0, 7.2, 3.0, 5.6, 4.4, 7.4, 1.2, 1.3) };
}

// ---------- robot dogs ----------
function robotDog(p: Palette, oai: boolean): Model {
  const K = kit(p), { M } = K, root = group();
  const body = group({ y: 4.6 }); root.add(body);
  body.add(box(6.0, 1.9, 2.6, M.camoHi, {}, 0.6));
  body.add(box(5.0, 0.4, 2.0, M.dark, { y: 1.0 }, 0.15));                            // payload rail
  body.add(box(1.4, 1.4, 2.0, M.dark, { x: 3.4, y: 0.1 }, 0.4));                      // sensor head
  body.add(box(0.12, 0.45, 1.3, M.lens, { x: 4.12, y: 0.15 }, 0.04));
  sides((s) => body.add(box(0.12, 0.35, 0.35, M.glass, { x: 3.0, y: 0.1, z: s * 1.32 }, 0.03)));
  body.add(box(0.8, 0.12, 0.8, M.marking, { x: -2.0, y: 1.25 }, 0.03));
  // weapon module
  const wm = group({ x: 0.2, y: 1.5 }); body.add(wm);
  wm.add(cyl(0.7, 0.5, M.dark, { y: 0.1 }, "y", 14));
  if (!oai) {
    wm.add(box(2.4, 1.0, 1.2, M.camoHi, { x: 0.3, y: 0.8 }, 0.25));
    wm.add(cyl(0.16, 3.4, M.metal, { x: 3.1, y: 0.85 }, "x", 8)); wm.add(cyl(0.22, 0.5, M.dark, { x: 4.9, y: 0.85 }, "x", 8));
    wm.add(box(0.8, 0.6, 0.5, M.dark, { x: 0.6, y: 1.5 }, 0.1)); wm.add(box(0.08, 0.3, 0.3, M.lens, { x: 1.02, y: 1.5 }, 0.02));
  } else {
    wm.add(box(2.0, 0.9, 1.6, M.camoHi, { x: 0.2, y: 0.75 }, 0.25));
    sides((s) => wm.add(cyl(0.32, 2.8, M.dark, { x: 1.0, y: 0.9, z: s * 0.55 }, "x", 12)));         // twin launch tubes
    sides((s) => wm.add(cyl(0.22, 0.06, M.rubber, { x: 2.42, y: 0.9, z: s * 0.55 }, "x", 10)));
    wm.add(cyl(0.08, 2.2, M.dark, { x: -0.8, y: 2.0 }, "y", 6)); wm.add(sphere(0.3, M.dark, { x: -0.8, y: 3.1 }, 8)); // sensor mast
  }
  const draw = (g: THREE.Group, H: V3, Kn: V3, F: V3) => {
    g.add(beam(H, Kn, 0.75, 0.6, M.camo, 0.25)); g.add(beam(Kn, F, 0.45, 0.45, M.dark, 0.15));
    g.add(sphere(0.42, M.dark, { x: Kn[0], y: Kn[1], z: Kn[2] }, 10));
    g.add(sphere(0.38, M.rubber, { x: F[0], y: 0.32, z: F[2] }, 10));
  };
  const L: LegSpec[] = [];
  for (const sx of [1, -1]) for (const sz of [1, -1])
    L.push({ hip: [sx * 2.3, 4.3, sz * 1.25], foot: [sx * 2.4, 0, sz * 1.45], a: 2.6, b: 2.7, hint: [-1, 0, 0], off: sx * sz > 0 ? 0 : Math.PI, draw });
  const meta = { muzzle: (oai ? [3.1, 7.0, 0.55] : [5.3, 6.95, 0]) as V3, walk: [1, 4] as [number, number] };
  return { root, meta, ...legged(body, L, 0.9, 0.8, 0.12) };
}

// ---------- tracked kamikaze crawler ----------
function crawler(p: Palette, oai: boolean): Model {
  const K = kit(p), { M } = K, root = group();
  sides((s) => {
    root.add(box(6.2, 1.5, 1.3, M.track, { y: 0.85, z: s * 1.75 }, 0.6));
    for (let x = -2.6; x <= 2.6; x += 0.65) root.add(box(0.28, 0.16, 1.4, M.metal, { x, y: 1.6, z: s * 1.75 }, 0.04));
    for (const x of [-2.2, 0, 2.2]) root.add(cyl(0.55, 1.36, M.dark, { x, y: 0.75, z: s * 1.75 }, "z", 12));
  });
  root.add(box(5.4, 1.2, 2.3, M.camo, { y: 1.5 }, 0.35));
  if (!oai) {
    root.add(box(3.0, 1.3, 2.0, M.olive, { x: -0.4, y: 2.6 }, 0.25));                // demolition charge
    root.add(box(3.05, 0.25, 2.05, M.marking, { x: -0.4, y: 2.9 }, 0.04));
    root.add(cyl(0.12, 1.0, M.dark, { x: 2.0, y: 2.6 }, "y", 6)); root.add(box(0.7, 0.5, 0.7, M.dark, { x: 2.0, y: 3.2 }, 0.15));
    root.add(box(0.06, 0.25, 0.4, M.lens, { x: 2.37, y: 3.2 }, 0.02));
    root.add(cyl(0.04, 3.0, M.dark, { x: -2.2, y: 3.4, z: 0.7 }, "y", 5));
  } else {
    root.add(cyl(1.0, 2.6, M.dark, { x: -0.6, y: 2.7 }, "x", 16));                   // shaped-charge canister
    root.add(cyl(1.0, 1.2, M.camoHi, { x: 1.3, y: 2.7 }, "x", 16, 0.35));
    root.add(cyl(1.03, 0.3, M.marking, { x: -0.6, y: 2.7 }, "x", 16));
    root.add(box(0.6, 0.6, 1.4, M.dark, { x: 2.4, y: 1.8 }, 0.15)); root.add(box(0.06, 0.3, 1.0, M.lens, { x: 2.72, y: 1.85 }, 0.02));
    root.add(cyl(0.04, 2.2, M.dark, { x: -2.4, y: 3.0, z: -0.8 }, "y", 5));
  }
  return { root, meta: { muzzle: [2.6, 2.4, 0] } };
}

// ---------- 6×6 armed UGV ----------
function ugv(p: Palette, oai: boolean): Model {
  const K = kit(p), { M } = K, root = group();
  sides((s) => { for (const x of [-4.4, 0, 4.4]) {
    root.add(cyl(1.5, 1.3, M.rubber, { x, y: 1.5, z: s * 3.7 }, "z", 18));
    root.add(cyl(0.75, 1.36, M.dark, { x, y: 1.5, z: s * 3.7 }, "z", 10));
  } root.add(box(13.6, 0.35, 1.6, M.camo, { y: 3.2, z: s * 3.7 }, 0.1)); }); // fender line
  root.add(box(13.0, 2.2, 5.6, M.camo, { y: 2.6 }, 0.5));
  root.add(box(3.0, 1.0, 5.0, M.camo, { x: 5.6, y: 3.3, rz: 0.35 }, 0.3));         // sloped nose
  root.add(box(3.6, 0.8, 4.4, M.dark, { x: -4.0, y: 3.9 }, 0.2));                   // battery bay
  for (let i = 0; i < 4; i++) root.add(box(0.25, 0.2, 4.0, M.metal, { x: -5.4 + i * 0.9, y: 4.35 }, 0.04));
  sides((s) => { root.add(box(0.2, 0.4, 0.6, M.whiteLight, { x: 6.75, y: 3.2, z: s * 2.0 }, 0.03)); root.add(box(0.3, 0.4, 0.5, M.glass, { x: 6.5, y: 3.3, z: s * 2.0 }, 0.05)); });
  root.add(box(1.6, 0.1, 1.6, M.marking, { x: -1.0, y: 3.72, z: 1.6 }, 0.02));
  // remote weapon station
  const r = group({ x: 1.0, y: 3.7 }); root.add(r);
  r.add(cyl(1.4, 0.5, M.dark, { y: 0.25 }, "y", 16));
  r.add(box(2.6, 1.4, 2.0, M.camoHi, { x: 0.1, y: 1.2 }, 0.3));
  r.add(box(1.0, 0.9, 0.9, M.dark, { x: 0.4, y: 1.3, z: 1.4 }, 0.12)); r.add(box(0.08, 0.5, 0.6, M.lens, { x: 0.93, y: 1.3, z: 1.4 }, 0.02));
  let muzzle: V3;
  if (!oai) {
    r.add(cyl(0.2, 4.6, M.metal, { x: 3.4, y: 1.2, z: -0.3 }, "x", 10)); r.add(cyl(0.3, 0.7, M.dark, { x: 5.9, y: 1.2, z: -0.3 }, "x", 10));
    r.add(box(1.2, 0.9, 0.8, M.olive, { x: -0.4, y: 1.1, z: -1.4 }, 0.15));
    muzzle = [7.3, 4.9, -0.3];
  } else {
    sides((s) => { r.add(cyl(0.45, 4.0, M.dark, { x: 1.6, y: 2.4, z: s * 0.9 }, "x", 14)); r.add(cyl(0.32, 0.06, M.rubber, { x: 3.62, y: 2.4, z: s * 0.9 }, "x", 12)); });
    r.add(cyl(0.16, 3.0, M.metal, { x: 2.8, y: 1.0, z: -0.2 }, "x", 8));
    muzzle = [4.8, 6.1, 0.9];
  }
  return { root, meta: { muzzle } };
}

export const EXOTIC: Record<string, () => Model> = {
  warmech, titan,
  nod_warmech: nodWarmech, nod_titan: nodTitan,
  railwalker, nod_railwalker: nodRailwalker,
  spitter: () => robotDog(PALETTES.anthropic, false), nod_spitter: () => robotDog(PALETTES.openai, true),
  spore: () => crawler(PALETTES.anthropic, false), nod_spore: () => crawler(PALETTES.openai, true),
  devourer: () => ugv(PALETTES.anthropic, false), nod_devourer: () => ugv(PALETTES.openai, true),
};
