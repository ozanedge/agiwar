# agiwar — design decisions (locked)

## Control hierarchy (4 generals)

| Role | Count | Cadence | Output | LLM |
|---|---|---|---|---|
| Camp generals | 3 | On edit, **3-min cooldown** | Compiled `BehaviorSpec` → native doctrine for all troops in that camp | Rare (compile-on-edit) |
| Field general | 1 | **Event-gated, 30 s floor** | Time-boxed override orders | Haiku 4.5, only on material change |
| Tactical sim | — | Every tick (server) | Actual movement & targeting | None (deterministic) |

## Two-layer control

1. **Strategic (LLM, infrequent):** prompt → `BehaviorSpec` (the *policy compiler*). Never per-tick.
2. **Tactical (deterministic, every tick):** rule/utility layer consumes the spec. Server-authoritative,
   seeded — no `Math.random`/`Date.now` in the tick, so matches are reproducible/replayable.

## Override vs. native doctrine (decision: time-boxed overrides — option 1)

- A unit's **native doctrine** = the compiled spec of the camp that trained it. It is the unit's
  permanent identity, always shown (camp color + badge: ▲ aggressive · ◆ recon · ⬟ defensive).
- A field-general order is a **full override for N ticks** on the targeted units, shown with a
  pulsing ring + countdown. When it expires, the unit **reverts to native** (visible). MVP uses a
  hard revert with a fading indicator; a gradual blend-back is a later polish item.
- Rationale: keeps both layers meaningful, deterministic, and legible. Teaches the core loop —
  if you keep overriding a camp, your doctrine prompt is wrong; go fix the training.

## Safety boundary

The LLM can only emit fields in `BehaviorSpec`, and every field is **clamped server-side**
(`shared/spec.ts#clampSpec`). "Make my units invincible" is not expressible, so prompt injection
cannot break balance — it can only move legal dials.

## Cost engineering (the field general is the whole bill)

Infra is a flat ~$185/mo (the dedicated EKS cluster). The variable cost is dominated by the
field general — a per-player LLM loop. A naive "every 15s, Sonnet, 24/7" implementation is
~$8k/mo at 10 concurrent players. The same gameplay, built correctly, is a few hundred. So:

- **Event-gated, not a metronome** (`server/src/fieldgeneral.ts`). The field general only calls
  the LLM when the battlefield *materially changes* (coarse signature over unit count, enemy
  contacts, base hp, army hp). A stalemate or idle field costs **$0**. This is the biggest lever
  and also makes the general feel reactive rather than clock-driven.
- **30s minimum interval** floor between calls, even when things are changing.
- **Haiku 4.5** for the field general (~3× cheaper than Sonnet; doctrine-level orders don't need
  Sonnet). Camp compiles stay on **Sonnet 4.6** (rare, cooldown-throttled, quality matters there).
- **Bedrock prompt caching** on the static system prompt (future-proofing — only saves once the
  cached prefix exceeds Bedrock's minimum size, so today's savings come from gating + Haiku).
- Camp compiles throttled by the 3-min cooldown (worst case ~1/min across 3 camps).

Tunables (env): `FIELD_GENERAL=off`, `FG_MIN_INTERVAL_MS`, `FG_MODEL_ID`.

## Egress

The sim runs at `TICK_HZ` (10) but broadcasts at `NET_HZ` (5), and **camps are sent only on
change** (not their prompt strings every tick). Naive 10Hz full-snapshot broadcast was ~$100–150/mo
of AWS egress at 10 concurrent 24/7; this trims it to ~$20. Next step if needed: delta-encode unit
positions instead of full state.

## Infrastructure (decision: brand-new EKS cluster — max isolation)

- Brand-new EKS cluster in its **own VPC**, same AWS account (`<AWS_ACCOUNT_ID>`, us-west-2),
  provisioned by Terraform in this repo (independent state/lifecycle from `skynetops-ops`).
- Public realtime ingress via load balancer → `rt.agiwar.skynetops.ai` (WebSocket; not Vercel).
- Web client on a separate Vercel project, surfaced at `skynetops.ai/agiwar` via **one rewrite**
  in the existing skynetops Vercel project (the only touch to existing infra).
- Account SCP blocks public **Lambda Function URLs**; not used here (realtime is a container behind
  a load balancer). Confirm public LB ingress is permitted before `terraform apply`.
- Trade-off accepted: separate control plane (~$70+/mo) and no free Edge Delta telemetry (different
  cluster) — install the ED agent into this cluster separately if the observability story is wanted.
