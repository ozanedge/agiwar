// DEV FX lab: /fxlab.html?fx=explosion — loops one effect (or a gallery) over terrain-colored ground for tuning.
import { Application, Container, Graphics } from "pixi.js";
import { Fx, RAMP } from "./fx";

const app = new Application();
await app.init({ background: 0x163a2a, resizeTo: window, antialias: true, resolution: 1 });
document.getElementById("c")!.appendChild(app.canvas);
const world = new Container(); app.stage.addChild(world);
const bg = new Graphics(); // faint iso grid + sand patch so additive light reads like it will in-game
for (let i = -40; i < 40; i++) { bg.moveTo(i * 40, -800).lineTo(i * 40 + 1600, 800).stroke({ color: 0x0f2a1e, width: 1, alpha: 0.5 }); bg.moveTo(i * 40, 800).lineTo(i * 40 + 1600, -800).stroke({ color: 0x0f2a1e, width: 1, alpha: 0.5 }); }
bg.ellipse(500, 300, 180, 90).fill({ color: 0x5b5638, alpha: 0.6 });
world.addChild(bg);
const fx = new Fx(); world.addChild(fx.ground, fx.smoke, fx.fire, fx.glow);
const qs = new URLSearchParams(location.search);
const zoom = +(qs.get("zoom") ?? 2.5); world.scale.set(zoom);
const W = () => app.screen.width / zoom, H = () => app.screen.height / zoom;
const which = qs.get("fx") ?? "gallery";
const period = +(qs.get("period") ?? 1600);
(window as any).fxlab = { fx, ready: true };

function fire(kind: string, x: number, y: number) {
  switch (kind) {
    case "explosion": fx.explosion(x, y, 1); break;
    case "big": fx.explosion(x, y, 2.2, { smoke: 1.4, sparks: 1.4 }); break;
    case "air": fx.explosion(x, y, 1.3, { air: true, z: 20 }); break;
    case "muzzle": fx.muzzle(x, y, 0.3, 1.6, { smoke: true, blast: true }); break;
    case "laser": fx.beam("laser", x - 60, y - 10, x + 40, y + 12, 0xff5a3a, 1.4, 280); break;
    case "tesla": fx.beam("tesla", x - 60, y - 10, x + 40, y + 12, 0x8fd8ff, 1.3, 200); break;
    case "rail": fx.beam("rail", x - 60, y - 10, x + 40, y + 12, 0xbfe0ff, 2, 320); fx.explosion(x + 40, y + 12, 1, { ramp: RAMP.plasma }); break;
    case "sparks": fx.hitSparks(x, y, 1.2, true); break;
    case "dirt": fx.hitSparks(x, y, 1.2, false); break;
    case "burn": fx.burn(x, y, 1.2, period * 0.9); break;
    case "purple": fx.explosion(x, y, 1.8, { ramp: RAMP.purple }); break;
  }
}
const GALLERY = ["explosion", "big", "air", "muzzle", "laser", "tesla", "rail", "sparks", "dirt", "burn", "purple"];
let last = -1e9;
app.ticker.add(() => {
  const now = performance.now();
  fx.update(app.ticker.deltaMS, now);
  if (now - last > period) {
    last = now;
    if (which === "gallery") GALLERY.forEach((k, i) => fire(k, 70 + (i % 4) * (W() - 120) / 3, 70 + Math.floor(i / 4) * (H() - 110) / 2));
    else fire(which, W() / 2, H() / 2);
  }
});
