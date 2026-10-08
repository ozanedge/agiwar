# Unit sprite baker

Units are **pre-rendered 3D sprites**, the classic-RTS way. Each unit type is a procedural three.js
model (`models/*.ts`) rendered from the game's exact isometric camera (true 2:1 dimetric, 30° elevation)
at 32 headings, supersampled, with a baked key-light shadow and a dark silhouette outline, then trimmed
and packed into WebP atlas pages + a JSON frame index in `public/units/`. The client (`src/main.ts`,
"BAKED UNIT SPRITES") loads a type's sheet lazily the first time it appears and falls back to the legacy
vector art until then.

```bash
npm run dev                                        # vite (serves /baker/)
node scripts/bake-units.mjs tank,humvee            # bake some types (or `all`) → public/units/
open http://localhost:5173/baker/?units=tank       # preview without writing files
```

## Conventions
- **Space**: art px (1 unit = 1 screen px at zoom 1). Forward **+X**, up **+Y**, lateral **Z**. Origin = ground
  contact point under the unit's center (flyers: the airframe's center — the client lifts it and draws the
  baked ground shadow).
- **Scale** (≈ 4.3 art px per metre for vehicles, deliberately exaggerated for small things):
  MBT hull 34×17, APC ~30×12, light vehicles ~22×10, infantry ~12 tall, jets 45–60 long, helicopters ~40.
- **Palettes**: `PALETTES.anthropic` (desert tan, orange markings), `PALETTES.openai` (urban grey digital,
  white markings). `materials(p)` gives the shared set: `camo`/`camoHi` (camo + grime + height AO),
  `dark`, `metal`, `steel`, `rubber`, `track`, `glass`, `lens`, `marking`, `olive`, `skin`, emissive lights.
- **Primitives** (`kit.ts`): `box` (beveled), `cyl`, `sphere`, `torus`, `prism` (side profile extruded),
  `slab` (top outline extruded up), `loft` (tapered armor solid), `lathe` (fuselages/missiles along X),
  `rod`, `group`, `sides(s => …)` for symmetric parts.
- **Meta** (`Model.meta`): `muzzle`, `rotor` (helicopters: the client spins the blades — don't model them
  spinning), `wingtip` (contrails), `walk` (infantry: frame 0 idle, then the cycle).
- **Look**: serious modern military. Real-world silhouettes, mostly single-color paint with tonal camo and
  grime, dark gunmetal weapons, rubber, glass. Faction color only as markings (recognition panels, stripes).
  No neon, no cartoon proportions, no text decals (illegible at sprite scale).
