#!/usr/bin/env node
// Bakes unit sprite sheets into public/units/ by driving /baker/ in headless Chrome.
// Usage (with `npm run dev` running): node scripts/bake-units.mjs [tank,humvee|all] [--url http://localhost:5173]
// Writes <type>-<page>.webp, <type>-shadow-<page>.webp (flyers) and <type>.json, then a manifest.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../public/units");
const args = process.argv.slice(2);
const units = args.find((a) => !a.startsWith("--")) ?? "all";
const base = (args.find((a) => a.startsWith("--url="))?.slice(6)) ?? "http://localhost:5173";
const shot = args.find((a) => a.startsWith("--shot="))?.slice(7);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1400 } });
page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.exposeFunction("saveFile", (name, dataUrl) => {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, "base64"));
});
await page.goto(`${base}/baker/?units=${units}`);
const t0 = Date.now();
let last = "";
while (!(await page.evaluate(() => window.bakeDone))) {
  const msg = await page.$eval("#log", (e) => e.textContent);
  if (msg !== last) { process.stdout.write(`\r${msg}`.padEnd(60)); last = msg; }
  await new Promise((r) => setTimeout(r, 500));
}
const err = await page.evaluate(() => window.bakeError);
if (err) { console.error("\n" + err); process.exit(1); }
if (shot) await page.screenshot({ path: shot, fullPage: true });
// manifest of every baked type present on disk
const types = fs.readdirSync(outDir).filter((f) => f.endsWith(".json") && f !== "manifest.json").map((f) => f.slice(0, -5)).sort();
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ types }));
console.log(`\nbaked ${units} in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outDir}`);
await browser.close();
