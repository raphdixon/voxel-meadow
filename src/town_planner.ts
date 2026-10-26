import type {
  CreationCategory,
  ScaleClass,
  WorldCreation,
  WorldPath,
  WorldProp,
  WorldStateSnapshot,
} from "./types";
import { distPointToPolyline2D, sampleCatmullRom2D } from "./voxel_audit";
import { detectBlueprintFrontAngle, getCreationFootprintRadius } from "./voxel_dsl";

export type TownPlanningRole =
  | "mobile"
  | "natural_scenic"
  | "remote_industrial"
  | "downtown_civic"
  | "neighborhood_cottage";

const NATURAL_SCENIC_RE =
  /\b(waterfall|cascade|cataract|cliff|gorge|canyon|volcano|stratovolcano|caldera|mountain|peak|glacier|island|atoll|coast|coastline|vista|beach|shore|cove|reef|lagoon|oasis|forest|woods|grove|world\s*tree|cave|cavern|geyser|hot\s*spring|hammock|lounger)\b/i;

const REMOTE_INDUSTRIAL_RE =
  /\b(quarry|mine|mining|coal\s*pit|ore\s*pit|excavat|launchpad|launch\s*pad|spaceport|rocket\s*pad|oil\s*rig|refinery|smelter|power\s*plant|reactor|wind\s*farm|solar\s*farm)\b/i;

const GEOLOGICAL_EXCAVATION_RE =
  /\b(quarry|mine|mining|pit|crater|excavat|oil\s*rig)\b/i;

const DOWNTOWN_CIVIC_RE =
  /\b(tower|skyscraper|high-?rise|office|datacentre|datacenter|server|cloud|parliament|capitol|city\s*hall|courthouse|firehouse|fire\s*station|police|hospital|station|clocktower|museum|library|archive|wikipedia|university|arena|stadium|amphitheater|amphitheatre|colosseum|cathedral|palace|pavilion|retail|mall|store|bank|hotel|ihop|ziggurat|diner|cinema|theater|theatre)\b/i;

/**
 * Classifies any creation into an intelligent SimCity town-planning role so the orchestrator
 * knows whether it belongs on an orthogonal downtown block, a neighborhood cottage lane,
 * a distant industrial highway, or a natural perimeter vista.
 */
export function classifyTownPlanningRole(
  text: string,
  category: CreationCategory,
  scaleClass: ScaleClass,
): TownPlanningRole {
  if (
    category === "vehicle" ||
    category === "aircraft" ||
    category === "watercraft" ||
    category === "creature"
  ) {
    return "mobile";
  }
  if (NATURAL_SCENIC_RE.test(text)) {
    return "natural_scenic";
  }
  if (REMOTE_INDUSTRIAL_RE.test(text)) {
    return "remote_industrial";
  }
  if (DOWNTOWN_CIVIC_RE.test(text) || scaleClass === "colossal") {
    return "downtown_civic";
  }
  return "neighborhood_cottage";
}

/**
 * Determines whether a stationary creation should rotate to face its fronting street.
 * Architectural buildings, shops, cottages, courts, and towers face the street;
 * quarries, mines, waterfalls, cliffs, volcanoes, islands, and beach hammocks do NOT.
 */
export function shouldCreationFaceRoad(creation: WorldCreation): boolean {
  if (creation.isSeed || creation.isCompanion) return false;
  if (creation.behavior && creation.behavior.type !== "landmark") return false;
  if (
    creation.category === "vehicle" ||
    creation.category === "aircraft" ||
    creation.category === "watercraft" ||
    creation.category === "creature"
  ) {
    return false;
  }
  const text = `${creation.name} ${creation.creatorPrompt ?? ""} ${creation.description ?? ""}`;
  if (NATURAL_SCENIC_RE.test(text)) return false;
  if (GEOLOGICAL_EXCAVATION_RE.test(text)) return false;
  return true;
}

function wrapAnglePi(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Snaps a world-space facing angle (where `0` = `+Z` South, `Math.PI/2` = `+X` East,
 * `Math.PI` = `-Z` North, `-Math.PI/2` = `-X` West) to crisp SimCity urban angles:
 * - Cardinal `90°` increments (`0`, `±π/2`, `π`) whenever within `24°` of a cardinal axis
 * - Clean `45°` diagonal (`±π/4`, `±3π/4`) when fronting a diagonal boulevard!
 */
export function snapAngleToSimCityGrid(rawWorldYaw: number): number {
  const wrapped = wrapAnglePi(rawWorldYaw);
  const nearestCardinal = Math.round(wrapped / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(wrapAnglePi(wrapped - nearestCardinal)) <= 0.42) {
    return Number(wrapAnglePi(nearestCardinal).toFixed(4));
  }
  const nearestOctant = Math.round(wrapped / (Math.PI / 4)) * (Math.PI / 4);
  return Number(wrapAnglePi(nearestOctant).toFixed(4));
}

/**
 * Computes a clean, uniform SimCity street-facing `yaw` for architectural buildings,
 * or returns `null` for quarries, waterfalls, cliffs, islands, and mobile creations.
 */
export function computeIntelligentBuildingYaw(
  creation: WorldCreation,
  paths: WorldPath[],
): number | null {
  if (!shouldCreationFaceRoad(creation)) return null;

  // Prefer primary streets (`road`, `cottage_road`, `cobblestone`) within 26m over tiny footpaths
  const streetKinds = new Set(["road", "cottage_road", "cobblestone"]);
  let bestStreetDist = Infinity;
  let bestStreetTarget: [number, number] | null = null;
  let bestAnyDist = Infinity;
  let bestAnyTarget: [number, number] | null = null;

  for (const p of paths) {
    if (!p.points || p.points.length < 2) continue;
    // Ignore creation's own tiny doorway spur if a real avenue/lane is nearby so buildings align to the street block, not a diagonal stub
    const isOwnSpur = p.id === `spur-${creation.id}` || p.id === `initpath-${creation.id}`;
    const curve = sampleCatmullRom2D(p.points, Boolean(p.closed), 1.0);
    const hit = distPointToPolyline2D(creation.x, creation.z, curve);

    if (!isOwnSpur && streetKinds.has(p.kind) && hit.dist < bestStreetDist) {
      bestStreetDist = hit.dist;
      bestStreetTarget = [hit.closestX, hit.closestZ];
    }
    if (!isOwnSpur && hit.dist < bestAnyDist) {
      bestAnyDist = hit.dist;
      bestAnyTarget = [hit.closestX, hit.closestZ];
    }
  }

  const chosenTarget =
    bestStreetTarget && bestStreetDist <= 28.0 ? bestStreetTarget : bestAnyTarget;
  if (!chosenTarget) return null;

  const dx = chosenTarget[0] - creation.x;
  const dz = chosenTarget[1] - creation.z;
  if (Math.hypot(dx, dz) < 0.4) return null;

  const worldDirToStreet = Math.atan2(dx, dz);
  const snappedStreetDir = snapAngleToSimCityGrid(worldDirToStreet);
  const localFront = detectBlueprintFrontAngle(creation.blueprint);
  return Number(wrapAnglePi(snappedStreetDir - localFront).toFixed(3));
}

/**
 * Chooses a SimCity-aligned plot for newly placed creations when no manual spot is forced
 * (or nudges cleanly around an occupied spot).
 */
export function chooseSimCityPlot(opts: {
  reqX: number | null | undefined;
  reqZ: number | null | undefined;
  category: CreationCategory;
  scaleClass: ScaleClass;
  newRadius: number;
  contextText: string;
  world: Omit<WorldStateSnapshot, "myCreationId">;
  isSpotClear: (x: number, z: number) => boolean;
}): [number, number] {
  const { reqX, reqZ, category, scaleClass, newRadius, contextText, world, isSpotClear } = opts;
  const snapGrid = (v: number) => Math.round(v / 2) * 2;

  if (
    typeof reqX === "number" &&
    Number.isFinite(reqX) &&
    typeof reqZ === "number" &&
    Number.isFinite(reqZ)
  ) {
    const cx = Math.max(-138, Math.min(138, reqX));
    const cz = Math.max(-138, Math.min(138, reqZ));
    if (isSpotClear(cx, cz)) {
      return [Number(cx.toFixed(1)), Number(cz.toFixed(1))];
    }
    for (let step = 4; step <= 88; step += 4) {
      const offsets: [number, number][] = [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
        [step, step],
        [-step, step],
        [step, -step],
        [-step, -step],
      ];
      for (const [ox, oz] of offsets) {
        const tx = snapGrid(cx + ox);
        const tz = snapGrid(cz + oz);
        if (isSpotClear(tx, tz)) {
          return [tx, tz];
        }
      }
    }
  }

  const role = classifyTownPlanningRole(contextText, category, scaleClass);

  // 1. Remote industrial (quarries, mines, launchpads) -> outer frontier zones (r = 96..134m)
  if (role === "remote_industrial") {
    const frontierCandidates: [number, number][] = [
      [126, -116],
      [-18, -126],
      [118, -82],
      [-96, -104],
      [112, 88],
      [-108, 86],
    ];
    for (const [fx, fz] of frontierCandidates) {
      if (isSpotClear(fx, fz)) return [fx, fz];
    }
  }

  // 2. Natural scenic (waterfalls, cliffs, volcanoes, islands, beaches) -> scenic perimeter rim
  if (role === "natural_scenic") {
    const scenicCandidates: [number, number][] = [
      [-16, 88],
      [82, 34],
      [58, 26],
      [-86, 68],
      [26, 92],
      [92, -38],
      [-92, -48],
    ];
    for (const [sx, sz] of scenicCandidates) {
      if (isSpotClear(sx, sz)) return [sx, sz];
    }
  }

  // 3. City & village buildings -> orthogonal street-block frontage along roads & cottage lanes
  if (role === "downtown_civic" || role === "neighborhood_cottage") {
    const preferredKind =
      role === "downtown_civic"
        ? new Set(["road", "cobblestone"])
        : new Set(["cottage_road", "cobblestone", "road"]);
    const streets = world.paths.filter(
      (p) => preferredKind.has(p.kind) && p.points && p.points.length >= 2,
    );
    for (const st of streets) {
      const curve = sampleCatmullRom2D(st.points, Boolean(st.closed), 6.0);
      const halfW = st.kind === "road" ? 3.2 : 2.0;
      const setback = Math.ceil((halfW + newRadius + 2.8) / 2) * 2;
      for (let i = 1; i < curve.length - 1; i++) {
        const pt = curve[i];
        const prev = curve[i - 1];
        const next = curve[i + 1];
        const dx = next[0] - prev[0];
        const dz = next[1] - prev[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.1) continue;
        // Snap perpendicular to exact SimCity grid normal
        const rawPerp = Math.atan2(-dz / len, dx / len);
        const gridNorm = snapAngleToSimCityGrid(rawPerp);
        const nx = Math.sin(gridNorm);
        const nz = Math.cos(gridNorm);
        for (const side of [1, -1]) {
          const tx = snapGrid(pt[0] + nx * setback * side);
          const tz = snapGrid(pt[1] + nz * setback * side);
          // Never place inside Central Park [-22..22, -18..18]
          if (Math.abs(tx) < 23 && Math.abs(tz) < 19) continue;
          const r = Math.hypot(tx, tz);
          if (r < 26 || r > 116) continue;
          if (isSpotClear(tx, tz)) {
            return [tx, tz];
          }
        }
      }
    }
  }

  // 4. Structured orthogonal ring fallback on 8m grid steps
  const minRing = newRadius >= 8.5 ? 48 : 32;
  for (let ring = minRing; ring <= 128; ring += 12) {
    for (let u = -ring; u <= ring; u += 8) {
      const candidates: [number, number][] = [
        [u, -ring],
        [u, ring],
        [-ring, u],
        [ring, u],
      ];
      for (const [tx, tz] of candidates) {
        if (isSpotClear(tx, tz)) return [tx, tz];
      }
    }
  }
  return [56, -48];
}

/**
 * Plain, factual, objective 1-sentence physical descriptions (zero narrative prose)
 * for all seed and established creations on GeminIsland.
 */
export const FACTUAL_CREATION_DESCRIPTIONS: Record<string, { description: string; statusLine: string }> = {
  "seed-school-bus": {
    description: "Yellow village school bus with black trim, stop sign arm, and twin headlights.",
    statusLine: "Downtown avenue bus loop",
  },
  "seed-windmill-bakery": {
    description: "Stone windmill bakery with four rotating timber sails, brick oven, and striped awning.",
    statusLine: "Windmill bakery on West Lane",
  },
  "seed-clocktower-station": {
    description: "Limestone and copper clocktower with illuminated dials and covered timber waiting porch.",
    statusLine: "North Avenue transit station",
  },
  "seed-matcha-bookshop": {
    description: "Two-storey sage-green timber bookshop with bay windows and rooftop planter boxes.",
    statusLine: "Corner bookshop on East Avenue",
  },
  "seed-meadow-pup": {
    description: "Golden retriever puppy with red collar and articulated legs.",
    statusLine: "Golden retriever puppy",
  },
  "seed-pond-duck": {
    description: "Mallard duck with green head feathers, brown wings, and orange bill.",
    statusLine: "Central Pond mallard",
  },
  "c-mvm7qli8-4h2k": {
    description: "Modular server building with cyan rack windows, rooftop chillers, and spinning HVAC fans.",
    statusLine: "Modular cloud datacentre",
  },
  "c-mvmvo1vh-47fbad": {
    description: "Winged green voxel dragon with articulated wings, horns, and segmented tail.",
    statusLine: "Flying green dragon",
  },
  "c-mvn0lbb4-74136e": {
    description: "Stepped granite cliff waterfall with alpine spruce trees, mossy ledges, and turquoise plunge pool.",
    statusLine: "Multi-tiered granite waterfall",
  },
  "c-mvn8g9cn-a857de": {
    description: "Two-storey leather-boot-shaped house with timber windows, front porch, and brick chimney.",
    statusLine: "Boot-shaped residential cottage",
  },
  "c-mvn9yxeh-1d5644": {
    description: "Contemporary stone-and-glass retail building with sunshade louvers and rooftop HVAC units.",
    statusLine: "Stone and glass retail building",
  },
  "c-mvnbcub6-d06441": {
    description: "Compact neon-trimmed cantina building with rooftop sombrero sign and counter window.",
    statusLine: "Roadside cantina building",
  },
  "c-mvnbmbqg-48aa8f": {
    description: "Outdoor hardcourt pickleball court with painted boundary lines, center net, and player bench.",
    statusLine: "Outdoor pickleball court",
  },
  "c-mvnc3mga-c6ea36": {
    description: "Two-storey brick country pub with wrap-around corrugated iron verandas and rooftop sign.",
    statusLine: "Two-storey brick pub",
  },
  "c-mvnc7tlr-6784e6": {
    description: "Terraced open-pit mineral quarry with dark rock walls, boom crane, and equipment shed.",
    statusLine: "Northeast open-pit mineral quarry",
  },
  "c-mvnd5i04-14bfd5": {
    description: "Enclosed turf padel court with glass back walls, mesh fencing, and corner floodlights.",
    statusLine: "Enclosed turf padel court",
  },
  "c-mvne3zub-216636": {
    description: "Wooden vert skateboard halfpipe with elevated side decks, steel coping rails, and floodlights.",
    statusLine: "Wooden skateboard halfpipe",
  },
  "c-mvne5cm4-375d1d": {
    description: "Classical two-storey stone mansion with fluted front columns and gilded rooftop domes.",
    statusLine: "Classical stone mansion",
  },
  "c-mvnengyt-a5d341": {
    description: "Yellow twin-engine jet airliner with swept wings, red cheek decals, and tail stabilizer.",
    statusLine: "Twin-engine jet airliner",
  },
  "c-mvnepky4-e46ba2": {
    description: "Large industrial datacentre hall with steel wall panels, cooling towers, and rooftop satellite dish.",
    statusLine: "Hyperscale datacentre facility",
  },
  "c-mvnf2juk-326f62": {
    description: "Single glass-and-steel high-rise office tower with recessed lobby colonnade and rooftop spire.",
    statusLine: "Glass and steel office tower",
  },
  "c-mvng01tx-c070df": {
    description: "Grey rhinoceros sitting inside a white porcelain clawfoot bathtub filled with foam.",
    statusLine: "Rhinoceros in clawfoot bathtub",
  },
  "c-mvnlor0y-0ebcf9": {
    description: "Twin-engine swept-wing fighter jet in grey livery with angled tailplane.",
    statusLine: "Swept-wing jet aircraft",
  },
  "c-mvnlu09c-0cd9f7": {
    description: "Timber-framed stucco cottage with pitched roof, window flower boxes, and stone chimney.",
    statusLine: "Timber-framed stucco cottage",
  },
  "c-mvnmyyq6-bc000b": {
    description: "Small coastal island with tiered broadcast pavilion, striped lighthouse, and radio mast.",
    statusLine: "Coastal lighthouse and broadcast island",
  },
  "c-mvns4thf-81f7de": {
    description: "Red-brick municipal fire station with arched apparatus bays and brass bell cupola.",
    statusLine: "Municipal brick fire station",
  },
  "c-mvo96y3f-96e304": {
    description: "Coastal rock outcrop with pine trees, sea stacks, and shallow turquoise tide pools.",
    statusLine: "Coastal rock outcrop and tide pools",
  },
  "c-mvoab00r-9b0864": {
    description: "Three-storey dark Victorian Gothic house with steep gabled roofs, iron cresting, and lit windows.",
    statusLine: "Victorian Gothic manor house",
  },
  "c-mvobfiiw-3fb48e": {
    description: "Pastel pink-and-cream ice cream van with rooftop soft-serve cone sign and serving window.",
    statusLine: "Ice cream van on town loop",
  },
  "c-mvocr3dc-a475ca": {
    description: "Large domed golden beehive structure with tiered comb rings and arched entrance.",
    statusLine: "Domed golden beehive apiary",
  },
  "c-mvocxa72-f718f5": {
    description: "Domed elliptical stadium wrapped in horizontal LED light bands.",
    statusLine: "Elliptical LED arena",
  },
  "c-mvod5t0a-226189": {
    description: "Burger-shaped roadside food stand with sesame-bun roof, counter window, and rooftop sign.",
    statusLine: "Burger-shaped food stand",
  },
  "c-mvodkwqc-c9e4a4": {
    description: "Modernist white stone assembly building with curved wings, forecourt, and central flag spire.",
    statusLine: "Modernist parliament building",
  },
  "c-mvodns66-ce9982": {
    description: "Open-air stepped stone amphitheatre with covered concert stage and overhead lighting rig.",
    statusLine: "Open-air stone amphitheatre",
  },
  "c-mvoehstp-db1cae": {
    description: "Tiered circular pancake-stack diner building topped with a blue A-frame roof.",
    statusLine: "Tiered pancake diner building",
  },
  "c-mvofq9cw-f479a6": {
    description: "Oversized voxel bare foot sculpture with five toes and striped ankle cuff.",
    statusLine: "Voxel foot sculpture",
  },
  "c-mvofu6xi-9656b7": {
    description: "Woven rope hammock slung between two palm trees on a sandy patch.",
    statusLine: "Beach palm hammock",
  },
  "c-mvogm9ja-6cd891": {
    description: "Tall bipedal armored mecha robot with chest core and shoulder radar array.",
    statusLine: "Bipedal armored mecha robot",
  },
  "c-mvoi4jxh-b16cfb": {
    description: "Heavy-lift three-core rocket standing beside a steel launch umbilical tower.",
    statusLine: "Three-core rocket launch complex",
  },
  "c-mvoivyhf-8fdd46": {
    description: "Open-sided timber pavilion with central bottle display, oak barrels, and string lights.",
    statusLine: "Open-sided timber tasting pavilion",
  },
  "c-mvoiz95f-8d5336": {
    description: "Neoclassical stone library building with columned portico and rooftop puzzle-globe sculpture.",
    statusLine: "Neoclassical library archive",
  },
  "c-mvojw3k4-4ee278": {
    description: "Two-storey brick corner pub with illuminated marquee sign, rope stanchions, and rooftop patio.",
    statusLine: "Two-storey brick corner pub",
  },
  "comp-quarry-dump-truck": {
    description: "Articulated yellow mining dump truck loaded with raw mineral ore.",
    statusLine: "Quarry-to-city ore haul truck",
  },
  "comp-firehouse-pumper": {
    description: "Red municipal fire engine with roof ladder, hose reel, and emergency light bar.",
    statusLine: "Municipal fire engine",
  },
};

/**
 * Strips flowery/whimsical adjectives from LLM-generated descriptions so any newly added
 * creation also reads as a clean, matter-of-fact description of the object.
 */
export function normalizeFactualDescription(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return s;
  s = s.replace(
    /^(a|an)\s+(whimsical|charming|delightful|mouth-watering|sun-drenched|sun-warmed|nostalgic|cheerful|contented|playful|cozy|adorable|striking|monumental|mythical|decrepit)\s+/i,
    (_, art: string) => `${art.toUpperCase()} `,
  );
  // Capitalize first letter cleanly
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Clean outer-meadow patrol anchors for Aegis Perimeter Titan (`c-mvogm9ja-6cd891`),
 * circling the town while staying well clear of Borealis Mineral Quarry (`[118, -114]`),
 * Interstellar Rocket Launchpad (`[0, -126]`), Emerald Cliff Waterfall (`[-14, 91]`),
 * and outer neighborhood landmarks.
 */
export const PERIMETER_TITAN_SEED_LOOP: [number, number][] = [
  [52, 118],
  [-58, 76],
  [-116, -8],
  [-56, -112],
  [44, -108],
  [98, -92],
  [116, -36],
  [122, 24],
];

interface WanderObstacleCircle {
  id: string;
  x: number;
  z: number;
  clearR: number;
}

function clampCoord(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function closestOnSegment2D(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): { dist: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-6 ? clampCoord(((cx - ax) * dx + (cz - az) * dz) / len2, 0, 1) : 0;
  const px = ax + dx * t;
  const pz = az + dz * t;
  return { dist: Math.hypot(cx - px, cz - pz), t };
}

function buildWanderObstacles(
  walker: Pick<WorldCreation, "id" | "scaleClass" | "blueprint">,
  style: string | undefined,
  creations: WorldCreation[],
  props: WorldProp[],
): WanderObstacleCircle[] {
  const selfR = getCreationFootprintRadius(
    walker.scaleClass,
    walker.blueprint?.stats?.footprintX ?? 14,
    walker.blueprint?.stats?.footprintZ ?? 14,
  );
  const selfPad = Math.min(3.8, Math.max(0.85, selfR * 0.48));
  const isGlide = style === "glide";
  const obs: WanderObstacleCircle[] = [];

  for (const c of creations) {
    if (c.id === walker.id) continue;
    if (c.category !== "building" && c.behavior?.type !== "landmark") continue;
    const r = getCreationFootprintRadius(
      c.scaleClass,
      c.blueprint?.stats?.footprintX ?? 14,
      c.blueprint?.stats?.footprintZ ?? 14,
    );
    obs.push({ id: c.id, x: c.x, z: c.z, clearR: r + selfPad + 2.2 });
  }
  if (!isGlide) {
    for (const p of props) {
      if (p.kind !== "pond") continue;
      const r = p.radius ?? 6.4;
      obs.push({ id: p.id, x: p.x, z: p.z, clearR: r + selfPad * 0.6 + 1.6 });
    }
  }
  obs.push({ id: "city-sign", x: 10.5, z: 4.5, clearR: 2.8 + selfPad * 0.4 });
  return obs;
}

export function nudgeWanderPointClearOfWorld(
  px: number,
  pz: number,
  walker: Pick<WorldCreation, "id" | "scaleClass" | "blueprint">,
  style: string | undefined,
  creations: WorldCreation[],
  props: WorldProp[],
  bound = 136,
): [number, number] {
  const obs = buildWanderObstacles(walker, style, creations, props);
  return nudgePointClearInternal(px, pz, obs, bound);
}

function nudgePointClearInternal(
  px: number,
  pz: number,
  obs: WanderObstacleCircle[],
  bound = 136,
): [number, number] {
  let x = clampCoord(px, -bound, bound);
  let z = clampCoord(pz, -bound, bound);
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const o of obs) {
      const dx = x - o.x;
      const dz = z - o.z;
      const d = Math.hypot(dx, dz);
      if (d < o.clearR - 0.05) {
        let ux = d > 0.05 ? dx / d : o.x > 0 ? -1 : 1;
        let uz = d > 0.05 ? dz / d : o.z > 0 ? -1 : 1;
        let nx = o.x + ux * (o.clearR + 0.45);
        let nz = o.z + uz * (o.clearR + 0.45);
        if (Math.abs(nx) > bound - 1 || Math.abs(nz) > bound - 1) {
          const toCenterLen = Math.hypot(-o.x, -o.z) || 1;
          ux = -o.x / toCenterLen;
          uz = -o.z / toCenterLen;
          nx = o.x + ux * (o.clearR + 0.8);
          nz = o.z + uz * (o.clearR + 0.8);
        }
        x = clampCoord(nx, -bound, bound);
        z = clampCoord(nz, -bound, bound);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return [Number(x.toFixed(1)), Number(z.toFixed(1))];
}

/**
 * Ensures every wander waypoint AND every straight-line walk segment between consecutive
 * waypoints clears stationary buildings, quarries, waterfalls, and ponds (taking the walker's
 * own scaleClass footprint into account), inserting clean detour waypoints around obstacles.
 */
export function sanitizeWanderTargetsForWorld(
  walker: Pick<WorldCreation, "id" | "scaleClass" | "blueprint" | "x" | "z">,
  style: string | undefined,
  rawTargets: [number, number][],
  creations: WorldCreation[],
  props: WorldProp[],
): [number, number][] {
  const obs = buildWanderObstacles(walker, style, creations, props);
  const seed =
    rawTargets.length >= 2
      ? rawTargets
      : ([
          [walker.x + 12, walker.z + 8],
          [walker.x - 11, walker.z + 9],
          [walker.x + 4, walker.z - 14],
        ] as [number, number][]);

  let pts = seed.map(([tx, tz]) => nudgePointClearInternal(tx, tz, obs));

  for (let pass = 0; pass < 4 && pts.length < 18; pass++) {
    const nextPts: [number, number][] = [];
    let inserted = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      nextPts.push(a);
      if (nextPts.length >= 18) continue;

      let worst: WanderObstacleCircle | null = null;
      let worstPen = 0;
      for (const o of obs) {
        const hit = closestOnSegment2D(a[0], a[1], b[0], b[1], o.x, o.z);
        const req = o.clearR - 0.7;
        if (hit.t > 0.03 && hit.t < 0.97 && hit.dist < req) {
          const pen = req - hit.dist;
          if (pen > worstPen) {
            worstPen = pen;
            worst = o;
          }
        }
      }

      if (worst) {
        const sdx = b[0] - a[0];
        const sdz = b[1] - a[1];
        const slen = Math.hypot(sdx, sdz) || 1;
        const px1 = -sdz / slen;
        const pz1 = sdx / slen;
        const cand1 = nudgePointClearInternal(
          worst.x + px1 * (worst.clearR + 1.9),
          worst.z + pz1 * (worst.clearR + 1.9),
          obs,
        );
        const cand2 = nudgePointClearInternal(
          worst.x - px1 * (worst.clearR + 1.9),
          worst.z - pz1 * (worst.clearR + 1.9),
          obs,
        );
        const score = (c: [number, number]): number => {
          const dPath = Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(b[0] - c[0], b[1] - c[1]);
          let penalty = 0;
          for (const other of obs) {
            const h1 = closestOnSegment2D(a[0], a[1], c[0], c[1], other.x, other.z);
            const h2 = closestOnSegment2D(c[0], c[1], b[0], b[1], other.x, other.z);
            if (h1.dist < other.clearR - 0.7) penalty += 500;
            if (h2.dist < other.clearR - 0.7) penalty += 500;
          }
          return dPath + penalty;
        };
        const chosen = score(cand1) <= score(cand2) ? cand1 : cand2;
        nextPts.push(chosen);
        inserted = true;
      }
    }
    pts = nextPts;
    if (!inserted) break;
  }

  return pts;
}
