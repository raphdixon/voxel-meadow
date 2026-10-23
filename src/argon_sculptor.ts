import type { VoxelBlueprint } from "./types";
import { normalizeAndGroundBlueprint } from "./voxel_dsl";

export interface SculptRequest {
  prompt?: string;
  imageBase64?: string;
  imageMimeType?: string;
}

export type SculptResult =
  | { ok: true; blueprint: VoxelBlueprint; extractedSubject: string; modelUsed: string }
  | { ok: false; unsafe?: boolean; error: string };

const BLOCKED_PATTERNS = [
  /\b(nazi|swastika|hitler|kkk|child\s*porn|csam|rape|suicide\s*bomb|beheading)\b/i,
];

export function quickSafetyPrecheck(text: string): string | null {
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(text)) {
      return "Let's keep our shared meadow welcoming and family-friendly — please try creating something else.";
    }
  }
  return null;
}

export function extractJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const text = String(raw ?? "").trim();
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object");
  }
  const slice = stripped.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    const repaired = slice.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(repaired) as Record<string, unknown>;
  }
}

export async function callGeminiArgon(opts: {
  apiKey: string;
  primaryModel?: string;
  fallbackModel?: string;
  systemPrompt: string;
  userText: string;
  imageBase64?: string;
  imageMimeType?: string;
  temperature?: number;
  thinkingBudget?: number;
  maxOutputTokens?: number;
}): Promise<{ json: Record<string, unknown>; modelUsed: string }> {
  const models = [
    opts.primaryModel || "gemini-4-argon",
    "gemini-4-argon-eap",
    opts.fallbackModel || "gemini-3.8-flash",
  ];

  const userParts: Record<string, unknown>[] = [];
  if (opts.imageBase64 && opts.imageMimeType) {
    userParts.push({
      inlineData: {
        mimeType: opts.imageMimeType,
        data: opts.imageBase64,
      },
    });
  }
  userParts.push({ text: opts.userText });

  let lastErr: Error | null = null;
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": opts.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: opts.systemPrompt }] },
            contents: [{ role: "user", parts: userParts }],
            generationConfig: {
              temperature: opts.temperature ?? 0.45,
              maxOutputTokens: opts.maxOutputTokens ?? 16384,
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: opts.thinkingBudget ?? 2048 },
            },
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        lastErr = new Error(`${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
        continue;
      }

      const data = (await res.json()) as {
        candidates?: {
          content?: { parts?: { text?: string; thought?: boolean }[] };
        }[];
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const nonThought = parts
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text!)
        .join("");
      const rawText = nonThought.trim() || parts.map((p) => p.text ?? "").join("");
      const json = extractJsonObject(rawText);
      return { json, modelUsed: model };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr ?? new Error("All Argon/Gemini models failed");
}

const SCULPTOR_SYSTEM_PROMPT = `You are Master Voxel Sculptor Argon, creating breathtaking, tactile, high-definition 3D MagicaVoxel miniatures for a sunlit, family-friendly shared grass meadow world.

1. SAFETY GATE FIRST:
   - Inspect both any uploaded image and any text description.
   - Reject anything NSFW/sexual/nude, hate symbols/slurs/extremism, graphic gore/weapons/murder, self-harm, or private personal data/doxxing.
   - Playful everyday things, vehicles, animals, whimsical creatures, cozy buildings, trees, food carts, instruments, robots, spacecraft, boats, furniture, and landmarks are ALL welcome!
   - If unsafe, return ONLY: {"safe": false, "safeReason": "Polite 1-sentence reason."}

2. SUBJECT EXTRACTION (WHEN AN IMAGE IS PROVIDED):
   - Extract the single main hero object, vehicle, creature, character, or building from the photo (ignore messy backgrounds, hands holding objects, tables, or room clutter unless asked).
   - Sample 8 to 14 exact, harmonious custom hex colors into \`palette\` matching the real subject's main body, shaded underside, highlights, trim, glass, and warm lights.

3. STRICT 3D COORDINATE & ORIENTATION LAWS (CRITICAL):
   - Micro-voxel grid bounds: X in [-18..18], Y in [0..40], Z in [-18..18].
   - Y IS UP! Ground contact is Y = 0 (wheels, paws, boots, or plinth touch Y = 0).
   - +Z IS FORWARD / FRONT!
     * Vehicles: Front bumper, windshield & headlights face +Z; rear bumper & red taillights face -Z; left/right sides are -X/+X.
     * Creatures/Characters: Face, eyes, snout/beak face +Z; tail/back face -Z; legs step along Z.
     * Buildings/Stalls: Front door, steps, awning & counter face +Z!
   - HALF-OPEN SPANS: \`box\`, \`roundedBox\`, \`hollowBox\`, \`pillars\`, \`clear\` fill integer cells \`[x0..x1), [y0..y1), [z0..z1)\` so ALWAYS ensure \`x1 > x0\`, \`y1 > y0\`, \`z1 > z0\`. A 1-voxel pane at z=7 uses \`z0: 7, z1: 8\`.
   - USE \`"mirrorX": true\` FOR SYMMETRY! Placing a headlight, eye, ear, side window, mirror, wing, or wheel on +X (e.g. \`x0: 4, x1: 6, "mirrorX": true\`) automatically mirrors it cleanly onto -X (\`[-6..-4)\`)!

4. HIGH-DEFINITION MICRO-VOXEL CRAFT (26 TO 46 OPS, ULTRA-DETAILED):
   - NEVER output a boxy low-detail block! Build layered silhouettes, trims, recesses, curves, and micro-details:
     * Vehicles (e.g. school bus, tram, car, food truck): Use \`roundedBox\` for curved roofs/hoods, \`clear\` for wheel wells & recessed windows, \`box\` with \`glass\` for windshields & side window bays separated by mullions, rub-rails/bumpers in chrome/rubber, side mirrors, roof hatches/lights, warm glowing headlights (\`emit: 1.3\`) at +Z, red taillights (\`emit: 1.1\`) at -Z, AND put front & rear axles in \`parts\` with \`"kind": "wheel"\`!
     * Creatures/Animals: Use \`sphere\` / \`roundedBox\` for organic torso, chest, head, snout, cheeks, ears (\`mirrorX: true\`), pixel eyes/nose via \`voxels\` or \`box\`, collar/saddle/markings, 2 or 4 articulated legs in \`parts\` with \`"kind": "swingX"\` (give left legs \`phase: 0\` and right legs \`phase: 3.14\`!), and a wagging tail (\`"kind": "swingY"\`) or flapping wings (\`"kind": "swingZ"\`)!
     * Buildings/Shops/Monuments: Grounded \`plinth\` + \`stairs\` at +Z, multi-volume \`hollowBox\` / \`cylinder\` tower, \`roofGable\` / \`dome\` / \`cone\` with overhang eaves, \`arch\` doorway, window frames + flowerboxes, awnings, chimneys, signage, glowing interior windows (\`emit: 0.95\`), and 1-2 animated \`parts\` (\`spinY\`, \`spinZ\` windmill sails, \`bob\` smoke/lantern, \`swingZ\` sign/bell)!

5. PIVOT-LOCAL ANIMATED \`parts\` (CRITICAL):
   - Every item in \`parts\` has \`"pivot": [px, py, pz]\` in model coordinates, and ALL \`ops\` inside \`part.ops\` MUST BE AUTHORED AROUND LOCAL \`[0, 0, 0]\`!
   - Example wheel axle at \`pivot: [0, 3, 8]\`:
     \`{"name":"front-wheels","kind":"wheel","speed":1.0,"pivot":[0,3,8],"ops":[{"op":"cylinder","axis":"x","x0":5,"x1":7,"cy":0,"cz":0,"radius":3.0,"color":"rubber","mirrorX":true},{"op":"cylinder","axis":"x","x0":6,"x1":8,"cy":0,"cz":0,"radius":1.5,"color":"chrome","mirrorX":true}]}\`
     Notice \`cy: 0, cz: 0\` is local to \`pivot: [0, 3, 8]\`, so the bottom of the radius-3 tire touches \`3 - 3 = 0\` (ground Y=0) and spins around its exact center!
   - Example leg at \`pivot: [2.5, 5, 3]\` (\`"kind": "swingX", "amp": 0.45, "phase": 0\`): build leg downward from hip \`y0: -5, y1: 0\` so it swings from the hip joint and touches Y=0!

6. SUPPORTED \`ops\` UNION (ONLY USE THESE EXACT OP NAMES):
   - \`{"op":"box","x0":-5,"y0":2,"z0":-9,"x1":5,"y1":10,"z1":9,"color":"body","emit":0,"mirrorX":false}\`
   - \`{"op":"roundedBox","x0":-6,"y0":3,"z0":-11,"x1":6,"y1":13,"z1":11,"radius":2.0,"color":"body","emit":0}\`
   - \`{"op":"clear","x0":-5,"y0":7,"z0":-8,"x1":5,"y1":11,"z1":7}\`
   - \`{"op":"hollowBox","x0":-7,"y0":2,"z0":-6,"x1":7,"y1":14,"z1":6,"wall":1,"color":"cream","trim":"woodDark"}\`
   - \`{"op":"pillars","x0":-7,"y0":2,"z0":-6,"x1":7,"y1":14,"z1":6,"color":"woodDark"}\`
   - \`{"op":"plinth","sizeX":18,"heightY":2,"sizeZ":18,"base":"concrete2","top":"limestone","corner":"brass"}\`
   - \`{"op":"cylinder","axis":"y","cx":0,"y0":2,"y1":16,"cz":0,"radius":3.5,"color":"brick","mirrorX":false}\`
   - \`{"op":"cylinder","axis":"x","x0":5,"x1":7,"cy":0,"cz":0,"radius":3.0,"color":"rubber","mirrorX":true}\`
   - \`{"op":"cylinder","axis":"z","cx":0,"cy":8,"z0":-8,"z1":8,"radius":4.0,"color":"body"}\`
   - \`{"op":"ring","axis":"x","x0":5,"x1":7,"cy":0,"cz":0,"outerR":3.0,"innerR":1.5,"color":"rubber","mirrorX":true}\`
   - \`{"op":"ring","axis":"y","cx":0,"y0":10,"y1":11,"cz":0,"outerR":4.5,"innerR":3.2,"color":"brass"}\`
   - \`{"op":"ring","axis":"z","cx":0,"cy":10,"z0":5,"z1":6,"outerR":3.5,"innerR":2.2,"color":"gold"}\`
   - \`{"op":"cone","cx":0,"y0":14,"y1":22,"cz":0,"rBottom":4.5,"rTop":0.6,"color":"roof"}\`
   - \`{"op":"sphere","cx":0,"cy":6,"cz":0,"rx":4.0,"ry":3.5,"rz":5.5,"color":"fur","mirrorX":false}\`
   - \`{"op":"dome","cx":0,"yBase":14,"cz":0,"radius":4.5,"color":"copper"}\`
   - \`{"op":"roofGable","x0":-8,"yBase":14,"z0":-7,"x1":8,"z1":7,"rise":5,"axis":"x","color":"terracotta","trim":"cream"}\`
   - \`{"op":"roofPyramid","x0":-7,"yBase":14,"z0":-7,"x1":7,"z1":7,"color":"slate","trim":"gold"}\`
   - \`{"op":"stairs","x0":-2,"y0":0,"z0":8,"steps":2,"width":4,"dir":"+z","color":"marble"}\`
   - \`{"op":"arch","cx":0,"y0":2,"cz":6,"halfSpan":2,"height":6,"depth":1,"axis":"z","color":"brickDark"}\`
   - \`{"op":"line","x0":0,"y0":12,"z0":0,"x1":0,"y1":18,"z1":0,"radius":0.6,"color":"brass","mirrorX":false}\`
   - \`{"op":"voxels","list":[[2,7,9,"black"],[2,8,9,"white"]],"mirrorX":true}\`

7. OUTPUT STRICT JSON ONLY:
{
  "safe": true,
  "extractedSubject": "concise phrase of what was extracted/sculpted",
  "name": "Charming 2-4 Word Title",
  "description": "Warm 1-sentence visual description",
  "category": "vehicle" | "creature" | "building" | "prop" | "aircraft" | "watercraft",
  "scaleClass": "small" | "medium" | "large",
  "palette": { "body": "#...", "bodyShade": "#...", "trim": "#...", "accent": "#...", "glass": "#...", "glow": "#..." },
  "ops": [ ... 32 to 65 detailed VoxelOp objects ... ],
  "parts": [
    {
      "name": "part-name",
      "kind": "wheel" | "spinY" | "spinZ" | "spinX" | "bob" | "swingX" | "swingY" | "swingZ",
      "speed": 1.2,
      "amp": 0.4,
      "phase": 0,
      "pivot": [0, 3, 8],
      "ops": [ ... local VoxelOp objects centered around [0,0,0] ... ]
    }
  ]
}`;

export async function sculptWithArgon(
  req: SculptRequest,
  apiKey: string,
  primaryModel?: string,
  fallbackModel?: string,
): Promise<SculptResult> {
  const promptText = (req.prompt ?? "").trim().slice(0, 600);
  const hasImage = Boolean(req.imageBase64 && req.imageMimeType);

  if (!promptText && !hasImage) {
    return { ok: false, error: "Describe something or drop an image to sculpt." };
  }

  if (promptText) {
    const blocked = quickSafetyPrecheck(promptText);
    if (blocked) return { ok: false, unsafe: true, error: blocked };
  }

  const userDirective = hasImage
    ? promptText
      ? `Extract the subject from this image guided by the user's note ("${promptText}") and sculpt an ultra-detailed 3D micro-voxel version with rich parts and colors.`
      : `Carefully inspect this uploaded image, isolate the main foreground object/creature/vehicle/building, and sculpt an ultra-detailed, faithful 3D micro-voxel miniature of it with animated parts.`
    : `Sculpt an ultra-detailed, iconic 3D micro-voxel miniature of: "${promptText}". Include rich surface greebles, harmonious custom palette, emissive details, and lifelike animated parts.`;

  const first = await callGeminiArgon({
    apiKey,
    primaryModel,
    fallbackModel,
    systemPrompt: SCULPTOR_SYSTEM_PROMPT,
    userText: userDirective,
    imageBase64: req.imageBase64,
    imageMimeType: req.imageMimeType,
    temperature: 0.45,
    thinkingBudget: 768,
    maxOutputTokens: 10240,
  });

  if (first.json.safe === false) {
    const reason =
      typeof first.json.safeReason === "string" && first.json.safeReason.trim()
        ? first.json.safeReason.trim()
        : "That creation doesn't fit our family-friendly shared meadow — please try something else.";
    return { ok: false, unsafe: true, error: reason };
  }

  let bp = normalizeAndGroundBlueprint(first.json, promptText || "Meadow Creation");

  // If round 1 was unexpectedly sparse (< 160 voxels), run one targeted Argon enrichment pass
  if (bp.stats.voxels < 160) {
    const second = await callGeminiArgon({
      apiKey,
      primaryModel,
      fallbackModel,
      systemPrompt: SCULPTOR_SYSTEM_PROMPT,
      userText: `${userDirective}\n\nIMPORTANT REFINEMENT: Your previous draft only produced ${bp.stats.voxels} voxels, which is too tiny/sparse. Expand the body volume using roundedBox/sphere/hollowBox/cylinder across [-12..12] so it has 600 to 3000 crisp micro-voxels and at least 1 animated part in \`parts\`. Previous JSON:\n${JSON.stringify(first.json)}`,
      imageBase64: req.imageBase64,
      imageMimeType: req.imageMimeType,
      temperature: 0.4,
      thinkingBudget: 2048,
      maxOutputTokens: 16384,
    });
    if (second.json.safe === false) {
      return { ok: false, unsafe: true, error: "Please try creating something family-friendly." };
    }
    const enriched = normalizeAndGroundBlueprint(second.json, bp.name);
    if (enriched.stats.voxels > bp.stats.voxels) {
      bp = enriched;
    }
  }

  if (bp.stats.voxels < 25) {
    return { ok: false, error: "Argon couldn't form a clear 3D sculpture from that — try adding a few descriptive words." };
  }

  const extractedSubject =
    typeof first.json.extractedSubject === "string" && first.json.extractedSubject.trim()
      ? first.json.extractedSubject.trim().slice(0, 100)
      : bp.name;

  return {
    ok: true,
    blueprint: bp,
    extractedSubject,
    modelUsed: first.modelUsed,
  };
}
