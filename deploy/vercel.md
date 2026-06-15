# Surfacing the web client at skynetops.ai/agiwar

The agiwar web client deploys as its **own Vercel project** (in the skynetops Team), built with
`VITE_BASE=/agiwar/`. It's surfaced under the apex domain via **one rewrite** added to the
**existing** skynetops Vercel project — the only touch to existing infra.

## In the agiwar web project
- Root directory: `apps/web`
- Build command: `VITE_BASE=/agiwar/ npm run build` (output `dist`)
- Env: `VITE_WS_URL=wss://rt.agiwar.skynetops.ai`
- It gets its own deployment URL, e.g. `agiwar-web.vercel.app`.

## In the EXISTING skynetops project — add to its `vercel.json`
```json
{
  "rewrites": [
    { "source": "/agiwar", "destination": "https://agiwar-web.vercel.app/agiwar" },
    { "source": "/agiwar/:path*", "destination": "https://agiwar-web.vercel.app/agiwar/:path*" }
  ]
}
```

This proxies `skynetops.ai/agiwar/*` to the agiwar deployment while everything else on the apex
domain is untouched. (The realtime WebSocket does **not** go through this rewrite — the client
dials `wss://rt.agiwar.skynetops.ai` directly, since Vercel can't host the stateful socket server.)
