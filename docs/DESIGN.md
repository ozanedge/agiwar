# agiwar — design decisions (locked)

## Control hierarchy (4 generals)

| Role | Count | Cadence | Output | LLM |
|---|---|---|---|---|
| Camp generals | 3 | On edit, **3-min cooldown** | Compiled `BehaviorSpec` → native doctrine for all troops in that camp | Rare (compile-on-edit) |
| Field general | 1 | Every **15 s** | Time-boxed override orders | Steady, low (~4 calls/min) |
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

## Cost

- Camp compiles throttled by the 3-min cooldown (worst case ~1/min across 3 camps).
- Field general: predictable ~4 LLM calls/min/player.
- Model: Sonnet 4.6 on Bedrock (matches the skynetops runner). Camp compile can drop to Haiku 4.5 later.

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
