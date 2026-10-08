// Weapon & explosion FX: a pooled sprite particle system with procedurally generated textures.
// Everything lives in world (iso screen) px; particles carry a height `z` above the ground that is
// subtracted from y when drawn, so sparks arc up and fall back, smoke rises, scorch stays flat.
//   ground — scorch marks + dust rings (under units)
//   smoke  — smoke, dust, dirt (normal blend, above units)
//   glow   — fire, flashes, tracers, sparks, beams (ADDITIVE — reads as emitted light)
import { Container, Graphics, Sprite, Texture } from "pixi.js";

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255, br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
// color ramp: [t, color, t, color, ...]
function ramp(r: number[], t: number): number {
  if (t <= r[0]) return r[1];
  for (let i = 2; i < r.length; i += 2) if (t <= r[i]) return lerpColor(r[i - 1], r[i + 1], (t - r[i - 2]) / (r[i] - r[i - 2]));
  return r[r.length - 1];
}
export const RAMP = {
  fire: [0, 0xfff2c0, 0.1, 0xffc260, 0.3, 0xf07a22, 0.55, 0xa8401a, 0.8, 0x4a3328, 1, 0x3a3430],
  hot: [0, 0xffffff, 0.2, 0xfff0a0, 0.6, 0xffa030, 1, 0xc0400f],
  smoke: [0, 0x8a8076, 0.35, 0x625b54, 1, 0x4a4641],
  whiteSmoke: [0, 0xd8d6d0, 1, 0x9c9a95],
  dust: [0, 0xa8946e, 1, 0x7a6c54],
  plasma: [0, 0xffffff, 0.2, 0xbfe8ff, 0.6, 0x4fa8ff, 1, 0x1a3a90],
  red: [0, 0xffffff, 0.2, 0xffc0b0, 0.6, 0xff4a2a, 1, 0x801008],
  purple: [0, 0xffffff, 0.2, 0xe6c8ff, 0.6, 0xa860ff, 1, 0x3a1070],
};

// ---------- procedural textures ----------
function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, w = size, h = size): Texture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d")!, size);
  return Texture.from(c);
}
function noise2(seed: number) { // tiny value noise for puffy blobs
  const r = (i: number, j: number) => { const s = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453; return s - Math.floor(s); };
  return (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const a = r(i, j), b = r(i + 1, j), c = r(i, j + 1), d = r(i + 1, j + 1);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
}
function blobTex(seed: number, size: number, hard: number, cells = 4, contrast = 55): Texture {
  return canvasTex(size, (ctx, s) => {
    const img = ctx.createImageData(s, s), n = noise2(seed);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = (x + 0.5) / s * 2 - 1, dy = (y + 0.5) / s * 2 - 1, r = Math.hypot(dx, dy);
      const f = n(x / s * cells, y / s * cells) * 0.6 + n(x / s * cells * 2.3, y / s * cells * 2.3) * 0.3 + n(x / s * cells * 5, y / s * cells * 5) * 0.1;
      const edge = 1 - r + (f - 0.5) * 0.9;              // noisy, billowy edge
      const a = Math.max(0, Math.min(1, edge * hard)) * Math.max(0, 1 - r * r);
      const lum = Math.min(255, 255 - contrast + contrast * f * 1.2 + (1 - r) * 30); // inner shading so a puff reads as volume
      const o = (y * s + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = lum; img.data[o + 3] = a * 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}
let TEX: ReturnType<typeof buildTextures> | null = null;
function buildTextures() {
  const radial = (stops: [number, string][]) => canvasTex(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (const [o, c] of stops) g.addColorStop(o, c);
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  });
  return {
    glow: radial([[0, "rgba(255,255,255,1)"], [0.2, "rgba(255,255,255,0.7)"], [0.5, "rgba(255,255,255,0.18)"], [1, "rgba(255,255,255,0)"]]),
    dot: radial([[0, "rgba(255,255,255,1)"], [0.35, "rgba(255,255,255,0.9)"], [0.6, "rgba(255,255,255,0.25)"], [1, "rgba(255,255,255,0)"]]),
    // horizontal capsule streak — tracers and sparks (stretched along velocity)
    streak: canvasTex(64, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 64, 0);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.55, "rgba(255,255,255,0.55)"); g.addColorStop(0.9, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(32, 8, 32, 5, 0, 0, TAU); ctx.fill();
      const g2 = ctx.createLinearGradient(0, 0, 64, 0); g2.addColorStop(0.3, "rgba(255,255,255,0)"); g2.addColorStop(0.92, "rgba(255,255,255,1)"); g2.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g2; ctx.fillRect(0, 7, 64, 2);
    }, 64, 16),
    ring: canvasTex(128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s / 2);
      g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.7, "rgba(255,255,255,0.15)"); g.addColorStop(0.88, "rgba(255,255,255,0.9)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    }),
    // 4-point star flare (muzzle / impact flash)
    flare: canvasTex(64, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.25, "rgba(255,255,255,0.35)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      ctx.globalCompositeOperation = "lighter";
      for (const [w, h] of [[s / 2, 1.6], [1.6, s / 2]]) {
        const lg = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); lg.addColorStop(0, "rgba(255,255,255,0.95)"); lg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = lg; ctx.beginPath(); ctx.ellipse(s / 2, s / 2, w, h, 0, 0, TAU); ctx.fill();
      }
    }),
    // muzzle cone flash pointing +x, origin at the left-middle
    muzzle: canvasTex(64, (ctx) => {
      ctx.globalCompositeOperation = "lighter";
      const petal = (len: number, wid: number, a: number) => {
        const g = ctx.createLinearGradient(0, 0, len, 0); g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 16); ctx.quadraticCurveTo(len * 0.35, 16 - wid, len, 16); ctx.quadraticCurveTo(len * 0.35, 16 + wid, 0, 16); ctx.fill();
      };
      petal(64, 9, 1); petal(40, 14, 0.7);
      ctx.save(); ctx.translate(0, 16); for (const r of [-0.8, 0.8]) { ctx.save(); ctx.rotate(r); ctx.translate(0, -16); petal(26, 4, 0.8); ctx.restore(); } ctx.restore();
      const g = ctx.createRadialGradient(4, 16, 0, 4, 16, 14); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, 20, 32);
    }, 64, 32),
    scorch: canvasTex(64, (ctx, s) => {
      const img = ctx.createImageData(s, s), n = noise2(91);
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const dx = (x + 0.5) / s * 2 - 1, dy = (y + 0.5) / s * 2 - 1, r = Math.hypot(dx, dy);
        const f = n(x / 9, y / 9) * 0.7 + n(x / 3, y / 3) * 0.3;
        const a = Math.max(0, Math.min(1, (1 - r) * 1.6 + (f - 0.5) * 1.2)) * (0.55 + 0.45 * f);
        const o = (y * s + x) * 4; img.data[o] = 22; img.data[o + 1] = 18; img.data[o + 2] = 14; img.data[o + 3] = a * 235;
      }
      ctx.putImageData(img, 0, 0);
    }),
    smoke: [blobTex(3, 64, 1.6), blobTex(17, 64, 1.6, 3), blobTex(29, 64, 1.4, 5), blobTex(41, 64, 1.8, 4)],
    fire: [blobTex(7, 64, 2.0, 3, 130), blobTex(13, 64, 1.9, 4, 130), blobTex(23, 64, 2.2, 5, 130)],
  };
}

// ---------- particles ----------
type Layer = "glow" | "smoke" | "ground" | "fire";
interface Part {
  s: Sprite; layer: Layer; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  grav: number; drag: number; age: number; life: number; s0: number; s1: number; a0: number; a1: number; fadeIn: number;
  rot: number; vr: number; ramp: number[] | null; tint: number; stretch: number; squash: number; base: number; follow?: boolean; bounce?: boolean;
}
export interface PartOpts {
  tex: Texture; layer?: Layer; x: number; y: number; z?: number; vx?: number; vy?: number; vz?: number; grav?: number; drag?: number;
  life: number; s0: number; s1?: number; a0?: number; a1?: number; fadeIn?: number; rot?: number; vr?: number; ramp?: number[]; tint?: number;
  stretch?: number; squash?: number; bounce?: boolean;
}
interface Beam { kind: "laser" | "rail" | "tesla"; x1: number; y1: number; x2: number; y2: number; t0: number; life: number; color: number; width: number; seed: number; lastSpark: number }
interface Emitter { x: number; y: number; t0: number; life: number; size: number; next: number; kind: "burn" | "smolder" }

const MAX_PARTS = 2600;
export class Fx {
  ground = new Container(); smoke = new Container(); fire = new Container(); glow = new Container(); beamG = new Graphics();
  private parts: Part[] = [];
  private pool: Record<Layer, Sprite[]> = { glow: [], smoke: [], ground: [], fire: [] };
  private beams: Beam[] = [];
  private emitters: Emitter[] = [];
  private scorches: { s: Sprite; t0: number; life: number }[] = [];
  readonly T: ReturnType<typeof buildTextures>;
  constructor() {
    TEX ??= buildTextures(); this.T = TEX;
    this.glow.blendMode = "add"; this.beamG.blendMode = "add";
    this.glow.addChild(this.beamG);
  }
  private layerOf(l: Layer): Container { return l === "glow" ? this.glow : l === "smoke" ? this.smoke : l === "fire" ? this.fire : this.ground; }
  get busy() { return this.parts.length > 0 || this.beams.length > 0 || this.emitters.length > 0; }
  /** A pooled sprite the caller positions itself each frame (projectile heads); hand it back with give(). */
  take(tex: Texture, tint = 0xffffff, layer: Layer = "glow"): Sprite {
    const s = this.pool[layer].pop() ?? new Sprite();
    s.texture = tex; s.anchor.set(0.5); s.visible = true; s.alpha = 1; s.rotation = 0; s.scale.set(1); s.tint = tint;
    s.blendMode = layer === "glow" ? "add" : "normal";
    this.layerOf(layer).addChild(s);
    return s;
  }
  give(s: Sprite, layer: Layer = "glow") { s.visible = false; s.parent?.removeChild(s); this.pool[layer].push(s); }

  part(o: PartOpts): Part | null {
    if (this.parts.length >= MAX_PARTS) return null;
    const layer = o.layer ?? "glow";
    const s = this.pool[layer].pop() ?? new Sprite();
    s.texture = o.tex; s.anchor.set(o.tex === this.T.muzzle ? 0 : 0.5, 0.5); s.visible = true;
    if (layer === "glow") s.blendMode = "add"; else s.blendMode = "normal";
    this.layerOf(layer).addChild(s);
    const p: Part = {
      s, layer, x: o.x, y: o.y, z: o.z ?? 0, vx: o.vx ?? 0, vy: o.vy ?? 0, vz: o.vz ?? 0, grav: o.grav ?? 0, drag: o.drag ?? 0,
      age: 0, life: o.life, s0: o.s0, s1: o.s1 ?? o.s0, a0: o.a0 ?? 1, a1: o.a1 ?? 0, fadeIn: o.fadeIn ?? 0, rot: o.rot ?? 0, vr: o.vr ?? 0,
      ramp: o.ramp ?? null, tint: o.tint ?? 0xffffff, stretch: o.stretch ?? 0, squash: o.squash ?? 1, base: (o.tex.width || 64), bounce: o.bounce,
    };
    this.parts.push(p); this.apply(p);
    return p;
  }
  private apply(p: Part) {
    const k = p.age / p.life, e = 1 - (1 - k) * (1 - k);
    const sc = lerp(p.s0, p.s1, e) / (p.base / 2); // s0/s1 are radii in px
    const s = p.s;
    s.position.set(p.x, p.y - p.z);
    if (p.stretch > 0) { // align to (screen) velocity and stretch with speed — sparks, tracers
      const vx = p.vx, vy = p.vy - p.vz, sp = Math.hypot(vx, vy);
      s.rotation = Math.atan2(vy, vx); s.scale.set(sc * (1 + sp * p.stretch), sc * 0.5);
    } else { s.rotation = p.rot; s.scale.set(sc, sc * p.squash); }
    let a = lerp(p.a0, p.a1, k); if (p.fadeIn > 0 && p.age < p.fadeIn) a *= p.age / p.fadeIn;
    s.alpha = Math.max(0, a);
    s.tint = p.ramp ? ramp(p.ramp, k) : p.tint;
  }

  update(dtMs: number, now: number) {
    const dt = Math.min(0.05, dtMs / 1000);
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dtMs;
      if (p.age >= p.life) { p.s.visible = false; p.s.parent?.removeChild(p.s); this.pool[p.layer].push(p.s); this.parts[i] = this.parts[this.parts.length - 1]; this.parts.pop(); continue; }
      p.vz -= p.grav * dt; p.z += p.vz * dt;
      if (p.z < 0 && p.grav > 0) { p.z = 0; if (p.bounce && p.vz < -30) { p.vz *= -0.35; p.vx *= 0.5; p.vy *= 0.5; } else { p.vz = 0; p.vx *= 0.8; p.vy *= 0.8; } }
      const d = 1 - Math.min(0.95, p.drag * dt); p.vx *= d; p.vy *= d; if (p.grav === 0) p.vz *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      this.apply(p);
    }
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i], el = now - e.t0;
      if (el >= e.life) { this.emitters.splice(i, 1); continue; }
      const k = el / e.life;
      while (e.next <= now) {
        const strength = e.kind === "burn" ? 1 - k * 0.7 : 0.4 * (1 - k);
        if (e.kind === "burn" && Math.random() < 1 - k * 0.6) this.flame(e.x + rand(-4, 4) * e.size, e.y + rand(-2, 2) * e.size, e.size * 1.3 * (0.5 + strength * 0.5));
        this.smokePuff(e.x + rand(-2, 2) * e.size, e.y, e.size * (0.8 + 0.6 * strength), { z: 4 * e.size, vz: rand(14, 26) * e.size, life: rand(2600, 4200), dark: true, a: 0.42 * (0.4 + strength) });
        e.next += e.kind === "burn" ? 45 / Math.max(0.6, e.size) : 160;
      }
    }
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      const sc = this.scorches[i], k = (now - sc.t0) / sc.life;
      if (k >= 1) { sc.s.destroy(); this.scorches.splice(i, 1); continue; }
      sc.s.alpha = 0.7 * Math.min(1, (1 - k) * 3);
    }
    this.drawBeams(now);
  }

  // ---------- building blocks ----------
  flash(x: number, y: number, r: number, color = 0xfff0c0, life = 110, z = 0) {
    this.part({ tex: this.T.glow, x, y, z, life, s0: r, s1: r * 1.3, a0: 1, a1: 0, tint: color });
    this.part({ tex: this.T.flare, x, y, z, life: life * 0.8, s0: r * 0.8, s1: r * 1.1, a0: 0.9, a1: 0, tint: 0xffffff, rot: Math.random() * TAU });
  }
  light(x: number, y: number, r: number, color = 0xff8a30, life = 260, a = 0.35) { // ground light pool cast by a blast
    this.part({ tex: this.T.glow, x, y, life, s0: r, s1: r * 1.2, a0: a, a1: 0, tint: color, squash: 0.5 });
  }
  flame(x: number, y: number, size: number, z = 0, vz?: number) {
    this.part({ tex: this.T.fire[(Math.random() * 3) | 0], layer: "fire", x, y, z: z + rand(0, 2) * size, vx: rand(-4, 4), vy: rand(-2, 2), vz: vz ?? rand(16, 30) * size, drag: 1.5,
      life: rand(420, 680), s0: 4.2 * size, s1: 1.8 * size, a0: 0.95, a1: 0, ramp: RAMP.fire, rot: Math.random() * TAU, vr: rand(-2, 2), fadeIn: 40 });
  }
  smokePuff(x: number, y: number, size: number, o: { z?: number; vx?: number; vy?: number; vz?: number; life?: number; dark?: boolean; a?: number; color?: number[] } = {}) {
    this.part({ tex: this.T.smoke[(Math.random() * 4) | 0], layer: "smoke", x, y, z: o.z ?? 0, vx: o.vx ?? rand(-5, 5), vy: o.vy ?? rand(-2, 2), vz: o.vz ?? rand(8, 16), drag: 0.9,
      life: o.life ?? rand(1600, 2600), s0: 3 * size, s1: 8 * size, a0: o.a ?? 0.6, a1: 0, fadeIn: 120, ramp: o.color ?? (o.dark === false ? RAMP.whiteSmoke : RAMP.smoke), rot: Math.random() * TAU, vr: rand(-0.4, 0.4) });
  }
  sparks(x: number, y: number, n: number, speed: number, o: { z?: number; color?: number[]; up?: number; size?: number; dir?: number; spread?: number; life?: number } = {}) {
    for (let i = 0; i < n; i++) {
      const a = o.dir != null ? o.dir + rand(-1, 1) * (o.spread ?? 0.8) : Math.random() * TAU, sp = speed * rand(0.4, 1.1);
      this.part({ tex: this.T.streak, x, y, z: o.z ?? 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.55, vz: rand(0.2, 1) * (o.up ?? speed * 0.6), grav: 260, drag: 1.2,
        life: (o.life ?? 420) * rand(0.6, 1.2), s0: (o.size ?? 1.4), s1: (o.size ?? 1.4) * 0.6, a0: 1, a1: 0, ramp: o.color ?? RAMP.hot, stretch: 0.012, bounce: true });
    }
  }
  ring(x: number, y: number, r: number, color = 0xffd8a0, life = 320, a = 0.7) {
    this.part({ tex: this.T.ring, x, y, life, s0: r * 0.2, s1: r, a0: a, a1: 0, tint: color, squash: 0.5 });
  }
  dirt(x: number, y: number, size: number, n = 6) { // kicked-up soil clods + dust
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = rand(20, 60) * size;
      this.part({ tex: this.T.dot, layer: "smoke", x, y, z: 1, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5, vz: rand(60, 140) * size, grav: 420, life: rand(600, 950), s0: rand(0.9, 1.6) * size, a0: 1, a1: 0.5, tint: 0x2e261c });
    }
    for (let i = 0; i < 3; i++) this.smokePuff(x + rand(-3, 3) * size, y + rand(-1, 1) * size, size * 0.8, { color: RAMP.dust, vz: rand(6, 14), life: rand(900, 1500), a: 0.45 });
  }
  scorch(x: number, y: number, r: number, life = 26000) {
    if (this.scorches.length > 140) { this.scorches[0].s.destroy(); this.scorches.shift(); }
    const s = new Sprite(this.T.scorch); s.anchor.set(0.5); s.position.set(x, y); s.rotation = 0;
    s.scale.set((r * 2) / 64, (r * 2) / 64 * 0.5); s.alpha = 0.7;
    this.ground.addChild(s); this.scorches.push({ s, t0: performance.now(), life });
  }
  burn(x: number, y: number, size: number, life: number) { // burning wreck: flames + a rising smoke column
    if (this.emitters.length > 40) this.emitters.shift();
    this.emitters.push({ x, y, t0: performance.now(), life, size, next: performance.now(), kind: "burn" });
  }

  // ---------- composites ----------
  /** Explosion. size ≈ 1 for a tank shell; 2–3 for vehicle deaths. */
  explosion(x: number, y: number, size: number, o: { air?: boolean; z?: number; ramp?: number[]; scorch?: boolean; smoke?: number; sparks?: number; dirt?: boolean } = {}) {
    const z = o.z ?? 0, R = o.ramp ?? RAMP.fire;
    this.flash(x, y, 15 * size, R === RAMP.fire ? 0xffe4a8 : ramp(R, 0.3), 110 + 30 * size, z + 3 * size);
    if (!o.air) this.light(x, y, 30 * size, ramp(R, 0.35), 340 + 80 * size, 0.32);
    // fireball: billowing fire puffs that cool through the ramp as they expand and rise
    this.part({ tex: this.T.glow, x, y, z: z + 4 * size, life: 420 + 120 * size, s0: 14 * size, s1: 10 * size, a0: 0.55, a1: 0, ramp: R }); // hot core
    const nf = Math.round(10 + size * 8);
    for (let i = 0; i < nf; i++) {
      const a = Math.random() * TAU, sp = rand(8, 30) * size;
      this.part({ tex: this.T.fire[(Math.random() * 3) | 0], layer: "fire", x: x + Math.cos(a) * rand(1, 6) * size, y: y + Math.sin(a) * rand(0.5, 3) * size, z: z + rand(1, 8) * size,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.55, vz: rand(16, 46) * size, drag: 2.4,
        life: rand(440, 760) * (0.85 + size * 0.15), s0: rand(3, 5.5) * size, s1: rand(8, 13) * size, a0: 1, a1: 0, ramp: R, rot: Math.random() * TAU, vr: rand(-1.5, 1.5), fadeIn: 30 });
    }
    // smoke: darker, longer, rising column that takes over from the fireball
    const ns = Math.round((o.smoke ?? 1) * (5 + size * 4));
    for (let i = 0; i < ns; i++) {
      const a = Math.random() * TAU, sp = rand(4, 18) * size;
      this.part({ tex: this.T.smoke[(Math.random() * 4) | 0], layer: "smoke", x: x + Math.cos(a) * 3 * size, y: y + Math.sin(a) * 1.5 * size, z: z + rand(3, 10) * size,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5, vz: rand(10, 26) * size, drag: 1.1, life: rand(2200, 3800) * (0.8 + size * 0.2),
        s0: rand(4, 6) * size, s1: rand(12, 18) * size, a0: 0.78, a1: 0, fadeIn: 220, ramp: RAMP.smoke, rot: Math.random() * TAU, vr: rand(-0.3, 0.3) });
    }
    this.sparks(x, y, Math.round((o.sparks ?? 1) * (10 + size * 10)), 95 * Math.sqrt(size), { z: z + 3, up: 150 * Math.sqrt(size), color: R === RAMP.fire ? RAMP.hot : R, life: 700, size: 1.3 });
    if (!o.air) {
      this.ring(x, y, 26 * size, 0xffe2b0, 300 + 60 * size, 0.38);
      if (o.dirt !== false) this.dirt(x, y, Math.min(2.2, size), Math.round(4 + size * 4));
      if (o.scorch !== false) this.scorch(x, y, 9 * size);
    }
  }
  /** Muzzle flash pointing along `dir` (screen radians). */
  muzzle(x: number, y: number, dir: number, size: number, o: { smoke?: boolean; color?: number; blast?: boolean } = {}) {
    const c = o.color ?? 0xffd890;
    const p = this.part({ tex: this.T.muzzle, x, y, life: 70 + 30 * size, s0: 9 * size, s1: 11 * size, a0: 1, a1: 0, tint: c, rot: dir, squash: 0.9 });
    if (p) p.s.anchor.set(0, 0.5);
    this.part({ tex: this.T.glow, x, y, life: 90, s0: 5 * size, s1: 7 * size, a0: 0.9, a1: 0, tint: c });
    if (o.smoke) for (let i = 0; i < (o.blast ? 6 : 2); i++) {
      const a = dir + rand(-0.6, 0.6) + (o.blast && i > 2 ? Math.PI * rand(0.4, 0.6) * (i % 2 ? 1 : -1) : 0), sp = rand(12, 36) * size;
      this.smokePuff(x, y, size * 0.7, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6, vz: rand(4, 10), life: rand(700, 1300), dark: false, a: 0.38 });
    }
    if (o.blast) this.ring(x, y + 2, 14 * size, 0xd8d0c0, 260, 0.35);
  }
  /** Bullet/frag hit: sparks off armor, or a dust kick on a miss. */
  hitSparks(x: number, y: number, size: number, armor: boolean) {
    if (armor) { this.part({ tex: this.T.flare, x, y, z: 2, life: 90, s0: 6 * size, s1: 7 * size, a0: 1, a1: 0, tint: 0xfff2c0, rot: Math.random() * TAU }); this.sparks(x, y, Math.round(4 + 4 * size), 80, { z: 3, up: 80, size: 1.3 * size, life: 380 }); }
    else { this.dirt(x, y, 0.7 * size, 4); }
  }

  // ---------- beams ----------
  beam(kind: Beam["kind"], x1: number, y1: number, x2: number, y2: number, color: number, width: number, life: number) {
    if (this.beams.length > 60) this.beams.shift();
    this.beams.push({ kind, x1, y1, x2, y2, t0: performance.now(), life, color, width, seed: Math.random() * 1000, lastSpark: 0 });
    if (kind === "rail") { // the slug's wake: a corkscrew of thin vapor puffs that lingers along the line
      const len = Math.hypot(x2 - x1, y2 - y1), n = Math.min(40, Math.floor(len / 6)), nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
      for (let i = 0; i < n; i++) {
        const t = i / n, w = Math.sin(t * len * 0.25) * 2;
        this.smokePuff(x1 + (x2 - x1) * t + nx * w, y1 + (y2 - y1) * t + ny * w, 0.45, { vx: rand(-2, 2), vy: rand(-2, 2), vz: rand(2, 6), life: rand(900, 1500), dark: false, a: 0.3, color: [0, 0xcfe4ff, 1, 0x8fa8c8] });
      }
    }
  }
  private drawBeams(now: number) {
    const g = this.beamG; g.clear();
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i], k = (now - b.t0) / b.life;
      if (k >= 1) { this.beams.splice(i, 1); continue; }
      const fade = b.kind === "laser" ? (k < 0.8 ? 1 : (1 - k) / 0.2) : 1 - k;
      const flick = b.kind === "laser" ? 0.75 + 0.25 * Math.sin(now / 18 + b.seed) : 1;
      const W = b.width * flick;
      let pts: number[];
      if (b.kind === "tesla") { // jagged branching lightning, re-rolled every ~45ms
        const seg = 9, bucket = Math.floor(now / 45) + b.seed, rr = noiseR(bucket);
        const dx = b.x2 - b.x1, dy = b.y2 - b.y1, len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
        pts = [b.x1, b.y1];
        for (let s = 1; s < seg; s++) { const t = s / seg, j = (rr() - 0.5) * Math.min(18, len * 0.22) * Math.sin(t * Math.PI); pts.push(b.x1 + dx * t + nx * j, b.y1 + dy * t + ny * j); }
        pts.push(b.x2, b.y2);
        for (let br = 0; br < 2; br++) { // forks
          const si = 2 + Math.floor(rr() * (seg - 4)), bx = pts[si * 2], by = pts[si * 2 + 1], ang = Math.atan2(dy, dx) + (rr() - 0.5) * 2.2, bl = rr() * 16 + 6;
          const ex = bx + Math.cos(ang) * bl, ey = by + Math.sin(ang) * bl * 0.6, mx = (bx + ex) / 2 + (rr() - 0.5) * 6, my = (by + ey) / 2 + (rr() - 0.5) * 6;
          g.moveTo(bx, by).lineTo(mx, my).lineTo(ex, ey).stroke({ color: b.color, width: W * 1.6, alpha: 0.35 * fade }).moveTo(bx, by).lineTo(mx, my).lineTo(ex, ey).stroke({ color: 0xffffff, width: W * 0.6, alpha: 0.8 * fade });
        }
      } else pts = [b.x1, b.y1, b.x2, b.y2];
      const line = (w: number, c: number, a: number) => { g.moveTo(pts[0], pts[1]); for (let j = 2; j < pts.length; j += 2) g.lineTo(pts[j], pts[j + 1]); g.stroke({ color: c, width: w, alpha: a, cap: "round", join: "round" }); };
      line(W * 6, b.color, 0.18 * fade); line(W * 2.8, b.color, 0.55 * fade); line(W * 1.15, 0xffffff, 1 * fade);
      // continuous impact sparks + glow at the far end while the beam is on
      if (now - b.lastSpark > 45 && k < 0.85) {
        b.lastSpark = now;
        this.part({ tex: this.T.glow, x: b.x2, y: b.y2, life: 90, s0: W * 4, s1: W * 5, a0: 0.8 * fade, a1: 0, tint: b.color });
        if (b.kind !== "rail") this.sparks(b.x2, b.y2, 2, 50, { z: 2, up: 50, size: 0.9, color: b.kind === "laser" ? RAMP.red : RAMP.plasma, life: 260 });
        this.part({ tex: this.T.glow, x: b.x1, y: b.y1, life: 80, s0: W * 3, s1: W * 3, a0: 0.7 * fade, a1: 0, tint: b.color });
      }
    }
  }
}
function noiseR(seed: number) { let s = Math.floor(seed * 9301 + 49297) % 233280; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
