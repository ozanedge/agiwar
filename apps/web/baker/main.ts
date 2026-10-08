// Unit sprite baker entry. Open /baker/?units=tank,humvee (or ?units=all) under `vite`; the
// scripts/bake-units.mjs Playwright runner exposes window.saveFile to write the outputs into
// public/units/. Without a runner it just previews.
import { bake, RES, type Model, type Sheet } from "./render";
import { REGISTRY } from "./registry";

const log = document.getElementById("log")!, out = document.getElementById("out")!;
const qs = new URLSearchParams(location.search);
const want = (qs.get("units") ?? "all").split(",");
const types = want[0] === "all" ? Object.keys(REGISTRY) : want.filter((t) => REGISTRY[t]);
declare global { interface Window { saveFile?: (name: string, data: string) => Promise<void>; bakeDone?: boolean; bakeError?: string } }

function previewRow(type: string, sheet: Sheet, frames: HTMLCanvasElement[]) {
  const h = document.createElement("h3"); h.textContent = `${type} — ${sheet.w}px frame, ${sheet.pages.length} page(s)`; out.appendChild(h);
  const row = document.createElement("div"); row.className = "row big"; out.appendChild(row);
  for (const f of frames.slice(0, 4)) { // native res (= how it looks at 4× zoom), cropped to content
    const c = document.createElement("canvas"); const m = Math.round(f.width * 0.22);
    c.width = f.width - 2 * m; c.height = f.height - 2 * m;
    c.getContext("2d")!.drawImage(f, -m, -m); row.appendChild(c);
  }
  const row2 = document.createElement("div"); row2.className = "row"; out.appendChild(row2);
  for (const zoom of [1, 2, 3]) for (const f of frames.slice(0, 4)) { // game scale at zoom 1 and 2 (on terrain green)
    const c = document.createElement("canvas"); const s = zoom / RES;
    c.width = Math.ceil(f.width * s); c.height = Math.ceil(f.height * s);
    const ctx = c.getContext("2d")!; ctx.imageSmoothingQuality = "high"; ctx.drawImage(f, 0, 0, c.width, c.height); row2.appendChild(c);
  }
}

(async () => {
  try {
    const index: Record<string, string> = {};
    for (const type of types) {
      const model: Model = REGISTRY[type]();
      const { sheet, pages, spages, preview } = await bake(type, model, (m) => (log.textContent = m));
      previewRow(type, sheet, preview);
      if (window.saveFile) {
        for (let i = 0; i < pages.length; i++) await window.saveFile(sheet.pages[i], pages[i].toDataURL("image/webp", 0.94));
        for (let i = 0; i < spages.length; i++) await window.saveFile(sheet.spages![i], spages[i].toDataURL("image/webp", 0.9));
        await window.saveFile(`${type}.json`, "data:application/json;base64," + btoa(JSON.stringify(sheet)));
      }
      index[type] = `${type}.json`;
    }
    log.textContent = `done: ${types.join(", ")}`;
  } catch (e) {
    window.bakeError = String((e as Error).stack ?? e); log.textContent = "ERROR " + window.bakeError; console.error(e);
  }
  window.bakeDone = true;
})();
