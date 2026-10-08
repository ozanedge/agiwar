// type → model builder. Anthropic types wear the desert palette, OpenAI (nod_*) the urban grey one.
// Each family module exports its own map so families can be authored independently.
import type { Model } from "./render";
import { ARMOR } from "./models/armor";
import { INFANTRY } from "./models/infantry";
import { VEHICLES } from "./models/vehicles";
import { AIR } from "./models/air";
import { DEFENSE } from "./models/defense";
import { EXOTIC } from "./models/exotic";

export const REGISTRY: Record<string, () => Model> = { ...ARMOR, ...VEHICLES, ...INFANTRY, ...AIR, ...DEFENSE, ...EXOTIC };
