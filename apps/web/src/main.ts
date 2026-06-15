// agiwar web client: renders the server-authoritative snapshot and sends sparse commands.
import { Application, Container, Graphics } from "pixi.js";
import type { Camp, DoctrineId, FieldGeneral, ServerMsg, StateMsg, UnitState } from "../../../shared/types.js";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? "ws://localhost:8787";
const DOCTRINE_COLOR: Record<DoctrineId, number> = { aggressive: 0xff6b6b, recon: 0x5aa9ff, defensive: 0x5ad17a };
const DOCTRINE_CLASS: Record<DoctrineId, string> = { aggressive: "agg", recon: "rec", defensive: "def" };

const stage = document.getElementById("stage")!;
const noticeEl = document.getElementById("notice")!;
const readoutEl = document.getElementById("readout")!;
const campsEl = document.getElementById("camps")!;

let latestState: StateMsg | null = null;
let latestCamps: Camp[] = [];
let hovered: UnitState | null = null;
let cell = 16;

const app = new Application();
await app.init({ background: 0x0b0f14, resizeTo: stage, antialias: true });
stage.appendChild(app.canvas);
const world = new Container();
app.stage.addChild(world);

// ---- networking ----
let ws: WebSocket;
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (ev) => {
    const msg: ServerMsg = JSON.parse(ev.data);
    if (msg.type === "state") { latestState = msg; render(msg); }
    else if (msg.type === "camps") { latestCamps = msg.camps; syncCamps(msg.camps); syncFieldGeneral(msg.fieldGeneral); }
    else if (msg.type === "notice") { showNotice(msg.text, msg.level); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
function sendCmd(cmd: unknown) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd)); }
connect();

let noticeTimer: number | undefined;
function showNotice(text: string, level: string) {
  noticeEl.textContent = text;
  noticeEl.style.borderColor = level === "error" ? "#7a2c2c" : "#243140";
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (noticeEl.textContent = ""), 4000);
}

// ---- rendering ----
function render(s: StateMsg) {
  cell = Math.floor(Math.min(app.screen.width / s.gridW, app.screen.height / s.gridH));
  world.removeChildren();

  const grid = new Graphics();
  grid.rect(0, 0, s.gridW * cell, s.gridH * cell).fill(0x0e141b).stroke({ color: 0x16202b, width: 1 });
  world.addChild(grid);

  for (const b of s.bases) {
    const g = new Graphics();
    const col = b.owner === 0 ? 0x9fd2ff : 0xffae8f;
    g.rect(b.x * cell - cell, b.y * cell - cell, cell * 2.4, cell * 2.4).fill({ color: col, alpha: 0.18 }).stroke({ color: col, width: 2 });
    const hpw = (b.hp / b.maxHp) * cell * 2.4;
    g.rect(b.x * cell - cell, b.y * cell - cell - 6, hpw, 3).fill(col);
    world.addChild(g);
  }

  for (const u of s.units) {
    const overridden = u.overrideUntil > s.tick;
    const g = new Graphics();
    const cx = u.x * cell + cell / 2, cy = u.y * cell + cell / 2;
    const color = DOCTRINE_COLOR[u.camp];
    const dim = u.owner === 1 ? 0.45 : 1; // enemy units dimmed
    // native-doctrine badge shape: ▲ aggressive · ◆ recon · ⬟ defensive
    if (u.camp === "aggressive") g.poly([cx, cy - 5, cx + 5, cy + 4, cx - 5, cy + 4]);
    else if (u.camp === "recon") g.poly([cx, cy - 5, cx + 5, cy, cx, cy + 5, cx - 5, cy]);
    else g.rect(cx - 4.5, cy - 4.5, 9, 9);
    g.fill({ color, alpha: dim });
    if (u.hp < u.maxHp) g.rect(cx - 5, cy - 8, (u.hp / u.maxHp) * 10, 1.5).fill(0xcdd6e0);
    if (overridden) g.circle(cx, cy, 8).stroke({ color: 0xffd76b, width: 1, alpha: 0.5 + 0.5 * Math.sin(s.tick / 2) });
    g.eventMode = "static";
    g.cursor = "pointer";
    g.on("pointerover", () => { hovered = u; updateReadout(); });
    g.on("pointerout", () => { if (hovered?.id === u.id) { hovered = null; updateReadout(); } });
    world.addChild(g);
  }
  if (hovered) hovered = s.units.find((u) => u.id === hovered!.id) ?? null;
  updateReadout();
}

function updateReadout() {
  if (!hovered || !latestState) { readoutEl.textContent = "hover a unit to inspect its doctrine"; return; }
  const u = hovered;
  const overridden = u.overrideUntil > latestState.tick;
  const secs = overridden ? Math.ceil((u.overrideUntil - latestState.tick) / 10) : 0;
  const cls = DOCTRINE_CLASS[u.camp];
  readoutEl.innerHTML =
    `unit #${u.id} · ${u.owner === 0 ? "yours" : "enemy"} · hp ${u.hp}/${u.maxHp}<br>` +
    `<b>Native:</b> <span class="${cls}">${u.camp}</span><br>` +
    `<b>Current:</b> ${overridden ? `<span style="color:#ffd76b">OVERRIDE — ${u.overrideLabel} (${secs}s, then reverts)</span>` : `<span class="${cls}">${u.camp} (native)</span>`}`;
}

// ---- camp doctrine editors ----
let built = false;
function syncCamps(camps: Camp[]) {
  if (!built) { buildCamps(camps); built = true; }
  for (const c of camps) {
    const cool = document.getElementById(`cool-${c.id}`)!;
    const now = Date.now();
    const remain = Math.max(0, Math.ceil((c.cooldownUntil - now) / 1000));
    const btn = document.getElementById(`btn-${c.id}`) as HTMLButtonElement;
    btn.disabled = c.compiling || remain > 0;
    cool.textContent = c.compiling ? "compiling doctrine…" : remain > 0 ? `cooldown: ${remain}s` : "";
    const spec = document.getElementById(`spec-${c.id}`)!;
    spec.textContent =
      `aggression ${c.spec.aggression.toFixed(2)} · engage ${c.spec.engageRange} · ` +
      `retreat<${(c.spec.retreatHealthPct * 100) | 0}% · explore ${c.spec.explorationBias.toFixed(2)} · ` +
      `leash ${c.spec.defendRadius ?? "none"}`;
  }
}
function buildCamps(camps: Camp[]) {
  campsEl.innerHTML = "";
  for (const c of camps) {
    const div = document.createElement("div");
    div.className = "camp";
    div.innerHTML =
      `<h3 class="${DOCTRINE_CLASS[c.id]}">${c.label}</h3>` +
      `<textarea id="ta-${c.id}">${c.prompt}</textarea>` +
      `<div class="row"><button id="btn-${c.id}">Retrain doctrine</button>` +
      `<button id="spawn-${c.id}">+ train unit</button><span class="cool" id="cool-${c.id}"></span></div>` +
      `<div class="spec" id="spec-${c.id}"></div>`;
    campsEl.appendChild(div);
    (document.getElementById(`btn-${c.id}`) as HTMLButtonElement).onclick = () =>
      sendCmd({ type: "editPrompt", camp: c.id, prompt: (document.getElementById(`ta-${c.id}`) as HTMLTextAreaElement).value });
    (document.getElementById(`spawn-${c.id}`) as HTMLButtonElement).onclick = () => sendCmd({ type: "spawn", camp: c.id });
  }
}
setInterval(() => { if (latestCamps.length) syncCamps(latestCamps); }, 250); // live cooldown countdown

// ---- field general doctrine editor ----
let fgBuilt = false;
function syncFieldGeneral(fg: FieldGeneral) {
  document.getElementById("fg-label")!.textContent = fg.label;
  const ta = document.getElementById("fg-prompt") as HTMLTextAreaElement;
  if (!fgBuilt) { ta.value = fg.prompt; fgBuilt = true; } // set once; don't clobber active typing
}
(document.getElementById("fg-rebrief") as HTMLButtonElement).onclick = () =>
  sendCmd({ type: "editFieldGeneral", prompt: (document.getElementById("fg-prompt") as HTMLTextAreaElement).value });

// ---- field general manual override buttons ----
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-order]")) {
  btn.onclick = () => {
    const kind = btn.dataset.order as "push" | "defend";
    sendCmd({ type: "fieldOrder", order: { kind, target: "all", durationTicks: 100, label: kind === "push" ? "Push enemy base" : "Defend base" } });
  };
}
