# agiwar

A low-APM, browser-based real-time strategy game. You don't micro units — you **author
the AI generals that train them**. Each general's natural-language doctrine is *compiled*
(by an LLM) into a behavior spec that autonomous units execute in real time.

Lives at **skynetops.ai/agiwar**. Separate repo + infrastructure from the flight-tracking
demo, same AWS account (`<AWS_ACCOUNT_ID>`, us-west-2) and GitHub org (`ozan-skynetops`).

## Concept

- **3 camp generals** (Aggressive / Recon / Defensive). Editing a general's prompt recompiles
  the doctrine for *all troops in that camp*. Retraining has a **3-minute cooldown**.
- **1 field general**, every ~15s, can issue a **time-boxed override** (e.g. "push the enemy
  base", "recall to defend"). Units obey for the duration, then **revert to their native
  training** — native doctrine is a unit's permanent identity; overrides are visibly transient.
- The LLM is only a **policy compiler** (style → clamped JSON spec). It never runs in the
  per-tick hot loop, so the sim stays cheap, deterministic, and cheat-resistant.

## Architecture

```
skynetops.ai/agiwar  ──(Vercel rewrite)──►  apps/web  (Pixi client)
                                                │ wss://
rt.agiwar.skynetops.ai  ──(LB)──►  server  (Node, stateful, fixed-tick sim)  ──►  Bedrock (Sonnet 4.6)
```

- `shared/` — protocol + `BehaviorSpec` + clamp/validate + doctrine presets + stub compiler
- `server/` — server-authoritative fixed-tick sim, utility/rule tactical layer, WS, cooldown
- `apps/web/` — Pixi renderer, native-doctrine badges, doctrine editors, field-order buttons
- `infra/` — Terraform for a **brand-new EKS cluster in its own VPC** (max isolation)
- `deploy/` — Dockerfile + k8s manifests for the realtime server

## Run locally

```bash
npm install
# terminal 1 — game server (uses AWS profile 'skynetops' for Bedrock; falls back to a
# deterministic keyword compiler if AWS is unreachable, so it always runs)
AWS_PROFILE=skynetops npm run dev:server
# terminal 2 — web client
npm run dev:web   # http://localhost:5173
```

Open the client, edit a general's doctrine, click **Retrain**, and watch that camp's units
change behavior. Two different prompts → two visibly different armies. That's the hook.

## Status

Built + verified:
- Deterministic fixed-tick sim; all **4 generals per player** are prompt-editable (3 camps →
  compiled doctrine on a 3-min cooldown; 1 field general → live, **event-gated** overrides).
- **Two-player matchmaking**: two humans pair into a PvP room; a solo player falls back to a bot.
- **Fog of war**: you only see enemy units/base within vision of your own units — so recon pays off.
- Sonnet 4.6 camp compiler + Haiku 4.5 field general (real Bedrock), with an offline stub fallback.
- Native-doctrine badges + time-boxed override/revert; low-egress split protocol; win condition.

Next: replays (cheap given the deterministic command stream), ranked/lobbies, richer unit types,
the utility-AI behavior layer (vs. today's fixed-parameter spec). Deploy seams (EKS/Vercel) are
authored but not provisioned.
