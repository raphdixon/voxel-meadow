// GeminIsland — Endless Sunlit Voxel World Engine.
// Features:
//  - Multi-biome voxel turf ground shader (clover meadow, sandy shore, misty moss, volcanic basalt w/ glowing magma cracks, snow frost, stone plaza, autumn grove, desert mesa) — 0 extra draw calls, 0 Z-fighting
//  - 6 distinct path styles (asphalt road, winding dirt trail, cobblestone lane, timber boardwalk, volcanic ember trail, stepping flagstones)
//  - Dynamic multi-scale 3D plot stake & construction scaffolding (tiny 1.4m up to colossal 22m+ volcano plots)
//  - Physical 3D GeminIsland Contributor Signboard + optional live API micro-badges
//  - Camera-tracking texel-snapped 4096^2 PCF golden-hour shadows + GTAO + UnrealBloom + ACESFilmic + SMAA

import * as THREE from "../vendor/three-bundle.js";
import {
  EffectComposer,
  GTAOPass,
  OutputPass,
  RenderPass,
  SMAAPass,
  UnrealBloomPass,
} from "../vendor/three-bundle.js";
import { VillagerAgent, buildWorldPropMesh } from "./villagers.js";
import {
  Vox,
  buildCreationGroup,
  buildVoxelMesh,
  getCreationFootprintRadius,
  getWorldVoxelSize,
} from "./vox.js";

const CITY_SIGN_POS = [3.8, -10.8];
const CITY_SIGN_YAW = 0.62;
const MAX_SHADER_ZONES = 28;

const BIOME_IDS = {
  meadow_clover: 1,
  sandy_shore: 2,
  misty_moss: 3,
  volcanic_basalt: 4,
  snow_frost: 5,
  stone_plaza: 6,
  autumn_grove: 7,
  desert_mesa: 8,
};

function distToSeg2D(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const len2 = vx * vx + vz * vz;
  if (len2 < 0.001) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2));
  return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
}

export function estimatePreviewPlotRadius(promptText = "") {
  const s = String(promptText || "").trim();
  if (!s) return 3.3;
  if (
    /\b(volcano|stratovolcano|caldera|mountain|mt\.|everest|fuji|matterhorn|glacier|canyon|mesa|castle|citadel|fortress|palace|cathedral|stadium|arena|colosseum|amphitheater|amphitheatre|pyramid|ziggurat|launch\s*pad|spaceport|world\s*tree|yggdrasil|colossus|kaiju|godzilla|giant\s+waterfall|niagara|skyscraper|megastructure)\b/i.test(
      s,
    )
  ) {
    return 9.8;
  }
  if (
    /\b(waterfall|cascade|cliff|clocktower|tower|windmill|lighthouse|datacentre|datacenter|factory|station|barn|bridge|temple|pagoda|museum|library|hotel|ship|galleon|roller\s*coaster)\b/i.test(
      s,
    )
  ) {
    return 5.4;
  }
  if (
    /\b(tiny|miniature|micro|mailbox|letterbox|postbox|hydrant|mushroom|toadstool|flower\s*pot|bonsai|campfire|bonfire|lantern|birdhouse|gnome|acorn|pebble|teacup|hedgehog|hamster|kitten|bunny|frog)\b/i.test(
      s,
    ) &&
    !/\b(giant|huge|massive|colossal|large|house|castle|tower)\b/i.test(s)
  ) {
    return 1.45;
  }
  if (
    /\b(small|little|cart|bike|bicycle|scooter|skateboard|dog|puppy|cat|fox|duck|swan|boat|canoe|statue|fountain|bench|shrine|kiosk|stall|well)\b/i.test(
      s,
    )
  ) {
    return 2.25;
  }
  return 3.3;
}

function makeMeadowSkyTexture() {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, "#9ccaf0");
  grad.addColorStop(0.54, "#c9e4f6");
  grad.addColorStop(0.86, "#dfeed8");
  grad.addColorStop(1.0, "#cbe4be");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function createContributorSignboard(maxAniso = 4) {
  const group = new THREE.Group();
  const s = 0.21;
  const v = new Vox(905);

  v.box(-14, 0, -4, 14, 1, 4, "concrete2");
  v.box(-13, 1, -3, 13, 2, 3, "limestone");
  for (const [cx, cz] of [[-13, -3], [12, -3], [-13, 2], [12, 2]]) {
    v.put(cx, 2, cz, "brass");
  }

  v.box(-12, 2, -1, -10, 20, 1, "woodDark");
  v.box(10, 2, -1, 12, 20, 1, "woodDark");
  v.box(-12, 20, -1, -10, 21, 1, "brass");
  v.box(10, 20, -1, 12, 21, 1, "brass");

  v.box(-10, 5, -1, 10, 18, 1, "oak");
  v.box(-11, 4, -1, 11, 5, 1, "woodDark");
  v.box(-11, 18, -1, 11, 19, 1, "woodDark");

  v.box(-14, 19, -3, 14, 20, 3, "terracotta");
  v.box(-13, 20, -2, 13, 21, 2, "brickDark");
  v.box(-1, 21, -1, 1, 23, 1, "iron");
  v.box(-1, 22, 1, 1, 24, 3, "warmGlow", 1.45);

  v.sphere(-14, 1.5, 2, 1.8, 1.2, 1.6, "leaf");
  v.sphere(14, 1.5, 2, 1.8, 1.2, 1.6, "leafLight");
  v.clear(-18, -3, -8, 18, 0, 8);
  v.put(-14, 2, 2, "#f6d55c");
  v.put(14, 2, 2, "#ec8db0");

  group.add(buildVoxelMesh(v, { scale: s }));

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 280;
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, maxAniso);

  const plaqueGeo = new THREE.PlaneGeometry(4.15, 2.52);
  const plaqueMat = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.56,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const frontPlaque = new THREE.Mesh(plaqueGeo, plaqueMat);
  frontPlaque.position.set(0, 11.5 * s, 1.08 * s);
  group.add(frontPlaque);

  const backPlaque = new THREE.Mesh(plaqueGeo, plaqueMat);
  backPlaque.position.set(0, 11.5 * s, -1.08 * s);
  backPlaque.rotation.y = Math.PI;
  group.add(backPlaque);

  let renderedCount = -1;
  function updateCount(count) {
    const n = Math.max(0, Number(count) || 0);
    if (n === renderedCount) return;
    renderedCount = n;

    ctx.clearRect(0, 0, 512, 280);

    roundRectPath(ctx, 4, 4, 504, 272, 22);
    ctx.fillStyle = "#5c3b20";
    ctx.fill();

    roundRectPath(ctx, 18, 18, 476, 244, 14);
    ctx.fillStyle = "#fcf7ea";
    ctx.fill();

    roundRectPath(ctx, 28, 28, 456, 224, 10);
    ctx.strokeStyle = "#d3a14a";
    ctx.lineWidth = 3.5;
    ctx.stroke();

    ctx.fillStyle = "#c9953c";
    for (const [rx, ry] of [[42, 42], [470, 42], [42, 238], [470, 238]]) {
      ctx.beginPath();
      ctx.arc(rx, ry, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#6b4f35";
    ctx.font = "800 30px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GEMINISLAND", 256, 66);

    ctx.fillStyle = "#18211b";
    ctx.font = "800 104px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
    ctx.fillText(String(n), 256, 148);

    ctx.fillStyle = "#267043";
    ctx.font = "800 32px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
    ctx.fillText(n === 1 ? "CONTRIBUTOR" : "CONTRIBUTORS", 256, 220);

    tex.needsUpdate = true;
  }

  updateCount(0);
  group.position.set(CITY_SIGN_POS[0], 0, CITY_SIGN_POS[1]);
  group.position.y = 0;
  group.rotation.y = CITY_SIGN_YAW;

  return { group, updateCount };
}

function buildPlotMarkerGroup() {
  const group = new THREE.Group();

  // Unit-radius ring (0.90..1.04) scaled dynamically by plot radius (1.45m tiny -> 9.8m colossal!)
  const ringGeo = new THREE.RingGeometry(0.9, 1.04, 64);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = 0.122;
  group.add(ring);

  // 4 independent corner stakes repositioned dynamically to match plot footprint
  const singleStakeVox = new Vox(931);
  singleStakeVox.box(-1, 0, -1, 1, 5, 1, "woodDark");
  singleStakeVox.box(-1, 5, -1, 1, 6, 1, "gold", 0.45);
  const stakeProto = buildVoxelMesh(singleStakeVox, { scale: 0.24 });
  const stakeCorners = [];
  for (let i = 0; i < 4; i++) {
    const st = stakeProto.clone();
    group.add(st);
    stakeCorners.push(st);
  }

  // Construction scaffolding sub-group (scales with plot radius while queued/sculpting)
  const scaffoldGroup = new THREE.Group();
  const scafVox = new Vox(947);
  for (const [sx, sz] of [[-9, -9], [8, -9], [-9, 8], [8, 8]]) {
    scafVox.box(sx, 0, sz, sx + 2, 16, sz + 2, "wood");
  }
  scafVox.box(-9, 8, -9, 10, 9, -8, "hazard");
  scafVox.box(-9, 8, 9, 10, 9, 10, "hazard");
  scafVox.box(-9, 8, -9, -8, 9, 10, "hazard");
  scafVox.box(9, 8, -9, 10, 9, 10, "hazard");
  scafVox.box(-9, 15, -9, 10, 16, -8, "woodLight");
  scafVox.box(-9, 15, 9, 10, 16, 10, "woodLight");
  const scafFrame = buildVoxelMesh(scafVox, { scale: 0.22 });
  scaffoldGroup.add(scafFrame);

  const floatingCubes = [];
  const cubeCols = ["busYellow", "teal", "terracotta"];
  for (let i = 0; i < 3; i++) {
    const cv = new Vox(960 + i);
    cv.box(-2, -2, -2, 2, 2, 2, cubeCols[i], 0.35);
    const cm = buildVoxelMesh(cv, { scale: 0.2 });
    scaffoldGroup.add(cm);
    floatingCubes.push(cm);
  }
  scaffoldGroup.visible = false;
  group.add(scaffoldGroup);
  group.visible = false;

  let baseRadius = 3.3;
  function setPlotRadius(r) {
    baseRadius = Math.max(1.3, Math.min(12.5, Number(r) || 3.3));
    const corner = baseRadius * 0.7;
    const signs = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    for (let i = 0; i < 4; i++) {
      stakeCorners[i].position.set(signs[i][0] * corner, 0, signs[i][1] * corner);
      const stakeScale = Math.max(0.82, Math.min(1.55, 0.78 + baseRadius * 0.08));
      stakeCorners[i].scale.setScalar(stakeScale);
    }
    const scafScaleXZ = Math.max(0.55, Math.min(2.85, baseRadius / 2.75));
    const scafScaleY = Math.max(0.68, Math.min(2.1, 0.7 + baseRadius * 0.14));
    scafFrame.scale.set(scafScaleXZ, scafScaleY, scafScaleXZ);
  }
  setPlotRadius(3.3);

  return {
    group,
    ring,
    ringMat,
    scaffoldGroup,
    floatingCubes,
    setPlotRadius,
    getPlotRadius: () => baseRadius,
  };
}

const FEED_DOT_COLORS = {
  weather: "#f5b82e",
  surf: "#3ca7de",
  wind: "#4eb86e",
  time: "#d99b38",
  moon: "#9370cf",
  iss: "#3ec9bd",
};

function drawFeedBadgeCanvas(canvas, reading) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  roundRectPath(ctx, 6, 6, w - 12, h - 12, 54);
  ctx.fillStyle = "rgba(22, 28, 24, 0.88)";
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
  ctx.stroke();

  const dotCol = FEED_DOT_COLORS[reading.kind] || "#3fb963";
  ctx.fillStyle = dotCol;
  ctx.beginPath();
  ctx.arc(46, h / 2, 12, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "700 40px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(String(reading.badge || "").slice(0, 20), 74, h / 2 + 2);
}

function buildEndlessGrassMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: 0.88,
    metalness: 0.0,
    dithering: true,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uFocusXZ = uniforms.uFocusXZ;
    shader.uniforms.uZones = uniforms.uZones;
    shader.uniforms.uZoneCount = uniforms.uZoneCount;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldPos;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime;
        uniform vec2 uFocusXZ;
        uniform vec4 uZones[${MAX_SHADER_ZONES}];
        uniform int uZoneCount;
        varying vec3 vWorldPos;

        vec3 srgb2lin(float r, float g, float b) {
          return pow(vec3(r, g, b) / 255.0, vec3(2.2));
        }
        float mHash(vec2 p) {
          vec2 q = fract(p * vec2(123.34, 456.21));
          q += dot(q, q + 45.32);
          return fract(q.x * q.y);
        }
        float mNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mHash(i + vec2(0.0, 0.0)), mHash(i + vec2(1.0, 0.0)), u.x),
            mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec2 wp = vWorldPos.xz;
        const float TILE = 0.85;
        vec2 tileCoord = wp / TILE;
        vec2 cell = floor(tileCoord);
        vec2 cellUv = fract(tileCoord);
        vec2 cellCenter = (cell + 0.5) * TILE;

        float tilePx = max(fwidth(tileCoord.x), fwidth(tileCoord.y));
        float tileDetail = 1.0 - smoothstep(0.06, 0.20, tilePx);

        vec3 turfDeep = srgb2lin(103.0, 174.0, 74.0);
        vec3 turfBase = srgb2lin(116.0, 187.0, 84.0);
        vec3 turfMid  = srgb2lin(128.0, 198.0, 94.0);
        vec3 turfSun  = srgb2lin(142.0, 209.0, 105.0);

        float meadowZone = mNoise(wp * 0.028);
        float subZone = mNoise(wp * 0.085 + vec2(19.4, -11.2));
        float cellH = mHash(cell);
        float cellH2 = mHash(cell + vec2(37.2, -91.7));
        vec2 terraceBlock = floor(cell * 0.25);
        float lawnCheck = mod(terraceBlock.x + terraceBlock.y, 2.0);

        vec3 grassCol = mix(turfDeep, turfBase, smoothstep(0.20, 0.68, meadowZone));
        grassCol = mix(grassCol, turfMid, smoothstep(0.42, 0.85, subZone) * 0.72);
        grassCol = mix(grassCol, turfSun, smoothstep(0.68, 0.96, meadowZone * 0.6 + subZone * 0.4) * 0.45);

        // Organic voxel-stepped ground biome zones (stepped per voxel cell so borders look crisp & blocky!)
        float borderWarp = (mNoise(cellCenter * 0.15) - 0.5) * 4.2 + (mNoise(cellCenter * 0.37 + 11.3) - 0.5) * 1.8;
        float volcanicGlowMask = 0.0;

        for (int i = 0; i < ${MAX_SHADER_ZONES}; i++) {
          if (i >= uZoneCount) break;
          vec4 zn = uZones[i];
          float d = length(cellCenter - zn.xy) + borderWarp;
          float w = 1.0 - smoothstep(zn.z * 0.62, zn.z * 1.06, d);
          if (w > 0.01) {
            int bId = int(zn.w + 0.5);
            vec3 bCol = grassCol;
            if (bId == 1) {
              // 1: meadow_clover — lush emerald clover + wildflower pixels
              bCol = mix(srgb2lin(86.0, 168.0, 68.0), srgb2lin(118.0, 196.0, 82.0), subZone);
              if (cellH2 > 0.91) {
                bCol = cellH > 0.5 ? srgb2lin(249.0, 214.0, 92.0) : srgb2lin(242.0, 148.0, 184.0);
              }
            } else if (bId == 2) {
              // 2: sandy_shore — sunlit coastal golden sand & shell flecks
              bCol = mix(srgb2lin(224.0, 194.0, 134.0), srgb2lin(242.0, 221.0, 168.0), subZone);
              if (cellH2 > 0.93) bCol = srgb2lin(250.0, 243.0, 224.0);
            } else if (bId == 3) {
              // 3: misty_moss — deep damp forest moss, fern turf & river stones
              bCol = mix(srgb2lin(68.0, 126.0, 69.0), srgb2lin(92.0, 152.0, 82.0), subZone);
              if (cellH2 > 0.86) bCol = srgb2lin(116.0, 125.0, 122.0);
            } else if (bId == 4) {
              // 4: volcanic_basalt — scorched obsidian rock, ash & glowing magma fissures
              bCol = mix(srgb2lin(42.0, 44.0, 52.0), srgb2lin(66.0, 64.0, 72.0), subZone);
              float crackField = abs(mNoise(cellCenter * 0.28 + vec2(4.2, -8.1)) - 0.5);
              if (crackField < 0.055 && d < zn.z * 0.85) {
                float pulse = 0.72 + 0.28 * sin(uTime * 2.6 + cellH * 6.28);
                bCol = mix(srgb2lin(235.0, 78.0, 28.0), srgb2lin(255.0, 174.0, 48.0), pulse);
                volcanicGlowMask = max(volcanicGlowMask, w * pulse);
              }
            } else if (bId == 5) {
              // 5: snow_frost — crisp alpine snow & pale glacier blue
              bCol = mix(srgb2lin(222.0, 236.0, 248.0), srgb2lin(247.0, 251.0, 255.0), subZone);
            } else if (bId == 6) {
              // 6: stone_plaza — warm sandstone & limestone courtyard pavers
              float checker = mod(cell.x + cell.y, 2.0);
              bCol = mix(srgb2lin(202.0, 190.0, 168.0), srgb2lin(224.0, 214.0, 194.0), checker * 0.65 + subZone * 0.35);
            } else if (bId == 7) {
              // 7: autumn_grove — golden-amber & russet fallen leaf carpet
              bCol = mix(srgb2lin(182.0, 124.0, 56.0), srgb2lin(218.0, 158.0, 68.0), subZone);
              if (cellH2 > 0.82) bCol = srgb2lin(174.0, 78.0, 52.0);
              else if (cellH2 < 0.22) bCol = srgb2lin(116.0, 162.0, 72.0);
            } else if (bId == 8) {
              // 8: desert_mesa — red-ochre canyon earth & terracotta sand
              bCol = mix(srgb2lin(198.0, 114.0, 68.0), srgb2lin(224.0, 152.0, 96.0), subZone);
            }
            grassCol = mix(grassCol, bCol, w);
          }
        }

        float blockTone = (floor(cellH * 4.0) / 3.0 - 0.5) * 0.075 + (lawnCheck - 0.5) * 0.028;
        grassCol *= 1.0 + blockTone * tileDetail;

        vec2 edgeDist = min(cellUv, 1.0 - cellUv);
        float minEdge = min(edgeDist.x, edgeDist.y);
        float seamW = max(0.042, tilePx * 1.35);
        float seam = smoothstep(0.0, seamW, minEdge);
        grassCol *= mix(1.0 - 0.085 * tileDetail, 1.0, seam);

        float topLip = (1.0 - smoothstep(0.0, 0.14, cellUv.y)) * seam;
        grassCol += grassCol * topLip * 0.045 * tileDetail;

        vec2 cloudUv = wp * 0.011 + vec2(uTime * 0.008, uTime * 0.0045);
        float cloud = mNoise(cloudUv) * 0.65 + mNoise(cloudUv * 2.0 + 3.7) * 0.35;
        grassCol *= mix(0.92, 1.05, smoothstep(0.32, 0.70, cloud));

        float distFocus = length(wp - uFocusXZ);
        vec3 horizonMist = srgb2lin(154.0, 206.0, 134.0);
        grassCol = mix(grassCol, horizonMist, smoothstep(185.0, 480.0, distFocus) * 0.58);

        diffuseColor.rgb = grassCol;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        if (volcanicGlowMask > 0.01) {
          totalEmissiveRadiance += srgb2lin(255.0, 102.0, 28.0) * (volcanicGlowMask * 0.85);
        }`,
      );
  };
  mat.customProgramCacheKey = () => "geminisland-voxel-biomes-v3";
  return mat;
}

function buildRibbonMesh(
  curve,
  sampleCount,
  halfWidth,
  yOffset,
  colorHex,
  receiveShadow = true,
  polyOffset = -1,
) {
  const pts = curve.getSpacedPoints(sampleCount);
  const isClosed = Boolean(curve.closed);
  const ringCount = isClosed ? pts.length - 1 : pts.length;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < pts.length; i++) {
    const p = isClosed && i === pts.length - 1 ? pts[0] : pts[i];
    const prev = isClosed
      ? pts[(i - 1 + ringCount) % ringCount]
      : pts[Math.max(0, i - 1)];
    const next = isClosed
      ? pts[(i + 1) % ringCount]
      : pts[Math.min(pts.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const rx = -tz * halfWidth;
    const rz = tx * halfWidth;

    positions.push(p.x - rx, yOffset, p.z - rz);
    positions.push(p.x + rx, yOffset, p.z + rz);
    normals.push(0, 1, 0, 0, 1, 0);
    const v = i / Math.max(1, pts.length - 1);
    uvs.push(0, v, 1, v);

    if (i < pts.length - 1) {
      const base = i * 2;
      indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
    }
  }

  for (const side of [-1, 1]) {
    const sideBase = positions.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = isClosed && i === pts.length - 1 ? pts[0] : pts[i];
      const prev = isClosed
        ? pts[(i - 1 + ringCount) % ringCount]
        : pts[Math.max(0, i - 1)];
      const next = isClosed
        ? pts[(i + 1) % ringCount]
        : pts[Math.min(pts.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const nx = -tz * side;
      const nz = tx * side;
      const ex = p.x + nx * halfWidth;
      const ez = p.z + nz * halfWidth;

      positions.push(ex, yOffset, ez);
      positions.push(ex, 0, ez);
      normals.push(nx, 0.25, nz, nx, 0.25, nz);
      const v = i / Math.max(1, pts.length - 1);
      uvs.push(v, 1, v, 0);

      if (i < pts.length - 1) {
        const b = sideBase + i * 2;
        if (side === 1) {
          indices.push(b, b + 1, b + 3, b, b + 3, b + 2);
        } else {
          indices.push(b, b + 3, b + 1, b, b + 2, b + 3);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.88,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: polyOffset,
    polygonOffsetUnits: polyOffset * 1.5,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

function buildMeadowTreeMesh(variant = 0) {
  const v = new Vox(700 + variant * 19);
  v.box(-1, 0, -1, 2, 1, 2, "woodDark");
  v.box(0, 0, 0, 1, 8, 1, variant % 3 === 1 ? "cream" : "woodDark");
  if (variant % 3 === 0) {
    v.sphere(0.5, 11, 0.5, 4.8, 4.2, 4.8, "leaf");
    v.sphere(2.2, 10, 1.5, 3.0, 2.8, 3.0, "leafLight");
    v.sphere(-1.8, 9.5, -1.2, 3.2, 2.6, 3.2, "leafDark");
  } else if (variant % 3 === 1) {
    v.sphere(0.5, 11.5, 0.5, 4.2, 4.6, 4.2, "#f29cb8");
    v.sphere(1.8, 10.2, 1.4, 2.8, 2.6, 2.8, "#fbd0df");
  } else {
    v.cone(0.5, 5, 14, 0.5, 4.2, 0.9, "leafDark");
    v.cone(0.5, 9, 17, 0.5, 3.1, 0.6, "leaf");
  }
  return buildVoxelMesh(v, { scale: 0.28 });
}

function buildMeadowBushMesh(variant = 0) {
  const v = new Vox(820 + variant * 23);
  v.sphere(0, 1.6, 0, 3.2, 2.1, 2.9, variant % 2 === 0 ? "leaf" : "leafDark");
  v.sphere(2.2, 1.3, 1.2, 2.3, 1.7, 2.1, "leafLight");
  v.clear(-6, -4, -6, 6, 0, 6);
  const flowerCol = variant % 3 === 0 ? "#f6d55c" : variant % 3 === 1 ? "#ec8db0" : "#faf3e3";
  v.put(-1, 3, 1, flowerCol);
  v.put(2, 2, 2, flowerCol);
  v.put(0, 3, -1, flowerCol);
  return buildVoxelMesh(v, { scale: 0.24 });
}

function computeBlueprintSignature(bp) {
  if (!bp) return "";
  const opsSig = (bp.ops || []).map((o) => o.op).join(",");
  const partsSig = (bp.parts || [])
    .map((p) => `${p.name}:${p.kind}:${p.phase || 0}:${(p.pivot || []).join(",")}:${(p.ops || []).length}`)
    .join("|");
  return `${bp.category || ""}:${bp.scaleClass || ""}:${bp.stats?.voxels || 0}:${opsSig}#${partsSig}`;
}

class CreationSimEntity {
  constructor(creation, index = 0) {
    this.id = creation.id;
    this.index = index;
    this.data = creation;
    this.blueprintSig = computeBlueprintSignature(creation.blueprint);
    this.group = buildCreationGroup(creation.blueprint, {
      seed: 17 + index * 13,
      useWorldScale: true,
    });
    this.group.rotation.order = "YXZ";

    this.x = creation.x;
    this.y = 0.004;
    this.z = creation.z;
    this.yaw = creation.yaw || 0;
    this.wheelAngle = 0;
    this.moveFactor = 0;
    this.spawnScale = creation.isSeed ? 1.0 : 0.05;

    const worldUnit = getWorldVoxelSize(creation.scaleClass);
    this.footprintRadius = getCreationFootprintRadius(
      creation.scaleClass,
      creation.blueprint?.stats?.footprintX ?? 14,
      creation.blueprint?.stats?.footprintZ ?? 14,
    );
    this.topY = Math.max(1.8, (creation.blueprint?.stats?.maxY || 14) * worldUnit);
    this.feedReading = null;
    this.feedBadgeText = "";
    this.feedCanvas = null;
    this.feedTex = null;
    this.feedMesh = null;

    this.routeCurve = null;
    this.routeLength = 1;
    this.routeDist = (index * 13.7) % 40;
    this.stopArcPositions = [];
    this.dwellingStop = null;
    this.dwellTimer = 0;
    this.lastStoppedId = null;
    this.doorX = this.x;
    this.doorZ = this.z;

    this.flightCurve = null;
    this.flightLength = 1;
    this.flightDist = (index * 19.3) % 60;
    this.bankRoll = 0;

    this.wanderIdx = 0;
    this.wanderPause = (index * 1.3) % 2.5;
    this.hopPhase = 0;

    this.orbitAngle = (index * 1.9) % (Math.PI * 2);

    this.rebuildBehavior(creation);
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.y = this.yaw;
    this.group.scale.setScalar(this.spawnScale);
  }

  setLiveFeedReading(reading, maxAniso = 4) {
    this.feedReading = reading || null;
    if (!reading || !reading.badge) {
      if (this.feedMesh) this.feedMesh.visible = false;
      return;
    }
    if (!this.feedMesh) {
      this.feedCanvas = document.createElement("canvas");
      this.feedCanvas.width = 512;
      this.feedCanvas.height = 116;
      this.feedTex = new THREE.CanvasTexture(this.feedCanvas);
      this.feedTex.colorSpace = THREE.SRGBColorSpace;
      this.feedTex.anisotropy = Math.min(8, maxAniso);
      const geo = new THREE.PlaneGeometry(4.2, 0.95);
      const mat = new THREE.MeshBasicMaterial({
        map: this.feedTex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.feedMesh = new THREE.Mesh(geo, mat);
      this.feedMesh.position.set(0, this.topY + 1.15, 0);
      this.group.add(this.feedMesh);
    }
    this.feedMesh.visible = true;
    const key = `${reading.kind}:${reading.badge}`;
    if (key !== this.feedBadgeText) {
      this.feedBadgeText = key;
      drawFeedBadgeCanvas(this.feedCanvas, reading);
      this.feedTex.needsUpdate = true;
    }
  }

  rebuildBehavior(creation, creationsGroup = null) {
    const wasStationary = this.data?.behavior?.type === "landmark";
    this.data = creation;
    this.footprintRadius = getCreationFootprintRadius(
      creation.scaleClass,
      creation.blueprint?.stats?.footprintX ?? 14,
      creation.blueprint?.stats?.footprintZ ?? 14,
    );
    if (wasStationary && creation.behavior?.type === "landmark") {
      this.x = creation.x;
      this.z = creation.z;
    }
    const nextSig = computeBlueprintSignature(creation.blueprint);
    if (creationsGroup && nextSig && nextSig !== this.blueprintSig) {
      this.blueprintSig = nextSig;
      if (this.feedMesh) {
        this.group.remove(this.feedMesh);
      }
      creationsGroup.remove(this.group);
      this.group.userData.dispose?.();
      this.group = buildCreationGroup(creation.blueprint, {
        seed: 17 + this.index * 13,
        useWorldScale: true,
      });
      this.group.rotation.order = "YXZ";
      const worldUnit = getWorldVoxelSize(creation.scaleClass);
      this.topY = Math.max(1.8, (creation.blueprint?.stats?.maxY || 14) * worldUnit);
      if (this.feedMesh) {
        this.feedMesh.position.set(0, this.topY + 1.15, 0);
        this.group.add(this.feedMesh);
      }
      this.group.position.set(this.x, this.y, this.z);
      this.group.rotation.y = this.yaw;
      creationsGroup.add(this.group);
    }
    const b = creation.behavior;
    if (b?.type === "vehicle_route" && Array.isArray(b.waypoints) && b.waypoints.length >= 3) {
      const vecs = b.waypoints.map(([wx, wz]) => new THREE.Vector3(wx, 0, wz));
      this.routeCurve = new THREE.CatmullRomCurve3(vecs, true, "centripetal", 0.5);
      this.routeLength = Math.max(8, this.routeCurve.getLength());
      this.routeDist = this.routeDist % this.routeLength;

      const samples = 160;
      this.stopArcPositions = (b.stops || []).map((stop) => {
        let bestU = 0;
        let bestD = Infinity;
        for (let i = 0; i < samples; i++) {
          const u = i / samples;
          const pt = this.routeCurve.getPointAt(u);
          const d = Math.hypot(pt.x - stop.x, pt.z - stop.z);
          if (d < bestD) {
            bestD = d;
            bestU = u;
          }
        }
        return { stop, distOnCurve: bestU * this.routeLength };
      });
    } else {
      this.routeCurve = null;
      this.dwellingStop = null;
    }

    if (b?.type === "fly_circle" && Array.isArray(b.waypoints) && b.waypoints.length >= 3) {
      const defaultAlt = b.altitude || 14.0;
      const vecs = b.waypoints.map((wp) =>
        wp.length >= 3
          ? new THREE.Vector3(wp[0], wp[1], wp[2])
          : new THREE.Vector3(wp[0], defaultAlt, wp[1]),
      );
      this.flightCurve = new THREE.CatmullRomCurve3(vecs, true, "centripetal", 0.5);
      this.flightLength = Math.max(12, this.flightCurve.getLength());
      this.flightDist = this.flightDist % this.flightLength;
    } else {
      this.flightCurve = null;
    }
  }

  step(dt, t, allEntities = [], ponds = [], camAz = 0.62) {
    if (this.spawnScale < 1.0) {
      this.spawnScale = Math.min(1.0, this.spawnScale + dt * 3.2);
    }

    const b = this.data.behavior;
    this.moveFactor = 0;
    let pitchX = 0;
    let rollZ = 0;

    if (b?.type === "vehicle_route" && this.routeCurve) {
      if (this.dwellingStop) {
        this.dwellTimer -= dt;
        this.moveFactor = 0;
        if (this.dwellTimer <= 0) {
          this.lastStoppedId = this.dwellingStop.id;
          this.dwellingStop = null;
        }
      } else {
        let speedScale = 1.0;
        for (const sp of this.stopArcPositions) {
          let ahead = sp.distOnCurve - this.routeDist;
          if (ahead < -this.routeLength * 0.5) ahead += this.routeLength;
          if (ahead > this.routeLength * 0.5) ahead -= this.routeLength;

          if (Math.abs(ahead) > 4.2 && this.lastStoppedId === sp.stop.id) {
            this.lastStoppedId = null;
          }
          if (sp.stop.id !== this.lastStoppedId && ahead >= -0.4 && ahead < 6.0) {
            speedScale = Math.max(0.22, ahead / 6.0);
            if (ahead <= 0.45) {
              this.routeDist = sp.distOnCurve;
              this.dwellingStop = sp.stop;
              this.dwellTimer = sp.stop.dwellSec || 4.0;
              speedScale = 0;
              break;
            }
          }
        }

        if (speedScale > 0) {
          const fwdX = Math.sin(this.yaw);
          const fwdZ = Math.cos(this.yaw);
          for (const other of allEntities) {
            if (other === this || other.data.behavior?.type !== "vehicle_route") continue;
            const dx = other.x - this.x;
            const dz = other.z - this.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 8.2 && dist > 0.01) {
              const dot = (dx * fwdX + dz * fwdZ) / dist;
              if (dot > 0.35 || (dot > -0.15 && this.id > other.id)) {
                speedScale = Math.min(speedScale, Math.max(0, (dist - 5.4) / 2.8));
              }
            }
          }
        }

        const stepDist = (b.speed || 6.0) * speedScale * dt;
        this.routeDist = (this.routeDist + stepDist) % this.routeLength;
        this.wheelAngle += stepDist / 0.62;
        this.moveFactor = speedScale;
      }

      const u = (((this.routeDist % this.routeLength) + this.routeLength) % this.routeLength) / this.routeLength;
      const pos = this.routeCurve.getPointAt(u);
      const tan = this.routeCurve.getTangentAt(u);
      this.x = pos.x;
      this.z = pos.z;
      this.y = 0.092;
      this.yaw = Math.atan2(tan.x, tan.z);

      const rightX = -Math.cos(this.yaw);
      const rightZ = Math.sin(this.yaw);
      this.doorX = this.x + rightX * 1.9 + Math.sin(this.yaw) * 0.9;
      this.doorZ = this.z + rightZ * 1.9 + Math.cos(this.yaw) * 0.9;

      pitchX = this.dwellingStop ? 0 : Math.sin(t * 14) * 0.008 * this.moveFactor;
    } else if (b?.type === "wander") {
      const isGlide = b.style === "glide";
      const glideBaseY = b.hoverHeight || 1.9;
      const targets =
        b.targets && b.targets.length
          ? b.targets
          : [
              [b.homeX + 12, b.homeZ + 8],
              [b.homeX - 11, b.homeZ + 9],
              [b.homeX + 4, b.homeZ - 14],
            ];
      if (this.wanderPause > 0) {
        this.wanderPause -= dt;
        this.y = isGlide ? glideBaseY + Math.sin(t * 2.2 + this.index) * 0.22 : 0;
        this.moveFactor = isGlide ? 0.5 : 0;
      } else {
        const tgt = targets[this.wanderIdx % targets.length];
        const dx = tgt[0] - this.x;
        const dz = tgt[1] - this.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.55) {
          this.wanderIdx = (this.wanderIdx + 1) % targets.length;
          this.wanderPause = isGlide ? 0.6 : 1.5 + (this.wanderIdx % 2) * 0.8;
          this.y = isGlide ? glideBaseY + Math.sin(t * 2.2 + this.index) * 0.22 : 0;
        } else {
          const stepLen = Math.min(dist, (b.speed || 2.8) * dt);
          this.x += (dx / dist) * stepLen;
          this.z += (dz / dist) * stepLen;

          if (!isGlide) {
            for (const pond of ponds) {
              const pr = (pond.radius || 6.4) + 0.9;
              const pdx = this.x - pond.x;
              const pdz = this.z - pond.z;
              const pd = Math.hypot(pdx, pdz);
              if (pd < pr && pd > 0.01) {
                this.x = pond.x + (pdx / pd) * pr;
                this.z = pond.z + (pdz / pd) * pr;
              }
            }
          }
          for (const other of allEntities) {
            if (other === this) continue;
            if (other.data.category !== "building" && other.data.behavior?.type !== "landmark") continue;
            const br = (other.footprintRadius || 4.0) + 1.1;
            const bdx = this.x - other.x;
            const bdz = this.z - other.z;
            const bd = Math.hypot(bdx, bdz);
            if (bd < br && bd > 0.01) {
              this.x = other.x + (bdx / bd) * br;
              this.z = other.z + (bdz / bd) * br;
            }
          }

          this.wheelAngle += stepLen / 0.45;
          this.moveFactor = 1.0;

          const desiredYaw = Math.atan2(dx, dz);
          let dyaw = desiredYaw - this.yaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          this.yaw += dyaw * Math.min(1, dt * 7.5);

          if (isGlide) {
            this.y = glideBaseY + Math.sin(t * 2.5 + this.index) * 0.26;
            pitchX = 0.06;
            rollZ = Math.max(-0.22, Math.min(0.22, -dyaw * 0.35));
          } else if (b.style === "hop") {
            this.hopPhase = (this.hopPhase + dt * 3.4) % 1;
            const u = this.hopPhase;
            this.y = 4 * 0.58 * u * (1 - u);
            pitchX = (0.5 - u) * 0.22;
          } else if (b.style === "trot") {
            this.y = Math.abs(Math.sin(t * 9.0)) * 0.12;
            rollZ = Math.sin(t * 9.0) * 0.04;
          } else {
            this.y = Math.abs(Math.sin(t * 6.5)) * 0.06;
          }
        }
      }
    } else if (b?.type === "water_float") {
      this.orbitAngle += ((b.speed || 1.4) / Math.max(2.2, b.radius || 4.0)) * dt;
      const r = b.radius || 4.0;
      const nx = b.pondX + Math.cos(this.orbitAngle) * r;
      const nz = b.pondZ + Math.sin(this.orbitAngle) * r * 0.82;
      const dx = nx - this.x;
      const dz = nz - this.z;
      this.x = nx;
      this.z = nz;
      this.y = 0.14 + Math.sin(t * 2.4 + this.orbitAngle) * 0.045;
      if (Math.hypot(dx, dz) > 0.0005) {
        this.yaw = Math.atan2(dx, dz);
      }
      const surfBoost =
        this.feedReading?.kind === "surf" && typeof this.feedReading.value === "number"
          ? Math.max(0.7, Math.min(2.2, this.feedReading.value))
          : 1.0;
      rollZ = Math.sin(t * 2.1) * 0.05 * surfBoost;
      pitchX = Math.cos(t * 1.8) * 0.035 * surfBoost;
      this.moveFactor = 0.7;
    } else if (b?.type === "fly_circle") {
      if (this.flightCurve) {
        this.flightDist = (this.flightDist + (b.speed || 6.4) * dt) % this.flightLength;
        const u = (((this.flightDist % this.flightLength) + this.flightLength) % this.flightLength) / this.flightLength;
        const pos = this.flightCurve.getPointAt(u);
        const tan = this.flightCurve.getTangentAt(u);
        const tanAhead = this.flightCurve.getTangentAt((u + 0.022) % 1);

        this.x = pos.x;
        this.z = pos.z;
        this.y = pos.y + Math.sin(t * 2.6 + this.index) * 0.36;
        this.yaw = Math.atan2(tan.x, tan.z);

        const yawAhead = Math.atan2(tanAhead.x, tanAhead.z);
        let dTurn = yawAhead - this.yaw;
        while (dTurn > Math.PI) dTurn -= Math.PI * 2;
        while (dTurn < -Math.PI) dTurn += Math.PI * 2;

        const targetBank = Math.max(-0.46, Math.min(0.46, -dTurn * 1.55));
        this.bankRoll += (targetBank - this.bankRoll) * Math.min(1, dt * 5.2);
        rollZ = this.bankRoll;
        pitchX = Math.max(-0.36, Math.min(0.36, -tan.y * 0.78));
        this.moveFactor = 1.0;
      } else {
        this.orbitAngle += ((b.speed || 5.6) / Math.max(10, b.radius || 24)) * dt;
        const r = b.radius || 24;
        const nx = b.centerX + Math.cos(this.orbitAngle) * r;
        const nz = b.centerZ + Math.sin(this.orbitAngle) * r * 0.86;
        const ny = (b.altitude || 14.0) + Math.sin(this.orbitAngle * 2.0 + t * 0.6) * 2.1;
        const dx = nx - this.x;
        const dy = ny - this.y;
        const dz = nz - this.z;
        const hDist = Math.hypot(dx, dz);
        this.x = nx;
        this.z = nz;
        this.y = ny;
        if (hDist > 0.001) {
          this.yaw = Math.atan2(dx, dz);
          pitchX = Math.max(-0.32, Math.min(0.32, -Math.atan2(dy, hDist) * 0.75));
        }
        rollZ = -0.24;
        this.moveFactor = 1.0;
      }
    } else {
      this.y = 0.004;
      if (typeof b?.facingYaw === "number") {
        this.yaw = b.facingYaw;
      }
      if (this.feedReading?.kind === "wind" && typeof this.feedReading.value === "number") {
        this.moveFactor = Math.max(0.45, Math.min(2.1, this.feedReading.value / 15));
      } else {
        this.moveFactor = 1.0;
      }
    }

    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(pitchX, this.yaw, rollZ);
    const popEase = this.spawnScale < 1 ? 1 - (1 - this.spawnScale) ** 3 : 1;
    this.group.scale.setScalar(popEase);

    if (this.feedMesh && this.feedMesh.visible) {
      this.feedMesh.position.y = this.topY + 1.15 + Math.sin(t * 2.1) * 0.05;
      this.feedMesh.rotation.y = camAz - this.yaw;
    }

    this.group.userData.animate?.(t, {
      wheelAngle: this.wheelAngle,
      moveFactor: this.moveFactor,
    });
  }

  dispose() {
    if (this.feedMesh) {
      this.feedMesh.geometry.dispose();
      this.feedMesh.material.dispose();
      this.feedTex?.dispose();
    }
    this.group.userData.dispose?.();
  }
}

export function createMeadowWorldEngine(canvas, callbacks = {}, options = {}) {
  const ogMode = Boolean(options.ogMode);
  const scene = new THREE.Scene();
  scene.background = makeMeadowSkyTexture();

  const w0 = Math.max(320, window.innerWidth);
  const h0 = Math.max(240, window.innerHeight);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: ogMode,
  });
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") : "";
  const isSoftwareGpu = /swiftshader|llvmpipe|software|basic render/i.test(gpuName);
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 4;

  renderer.setPixelRatio(isSoftwareGpu ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w0, h0, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const BASE_FRUSTUM = 34;
  const aspect0 = w0 / h0;
  const camera = new THREE.OrthographicCamera(
    -BASE_FRUSTUM * aspect0,
    BASE_FRUSTUM * aspect0,
    BASE_FRUSTUM,
    -BASE_FRUSTUM,
    18,
    560,
  );

  const composer = isSoftwareGpu ? null : new EffectComposer(renderer);
  let gtaoPass = null;
  let smaaPass = null;
  if (composer) {
    composer.addPass(new RenderPass(scene, camera));
    gtaoPass = new GTAOPass(scene, camera, w0, h0);
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    gtaoPass.blendIntensity = 0.44;
    gtaoPass.updateGtaoMaterial({
      radius: 0.22,
      distanceExponent: 1.4,
      thickness: 0.65,
      scale: 1.0,
      samples: 14,
      distanceFallOff: 1.0,
      screenSpaceRadius: true,
    });
    composer.addPass(gtaoPass);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(w0, h0), 0.12, 0.25, 1.15);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
    smaaPass = new SMAAPass(w0, h0);
    composer.addPass(smaaPass);
  }

  // Sunlit Golden-Hour Directional Key Light with Camera-Tracking Texel-Snapped Shadows
  const SUN_OFFSET = new THREE.Vector3(64, 118, 76);
  const SHADOW_HALF = 86;
  const SHADOW_RES = isSoftwareGpu ? 1024 : 4096;
  const sun = new THREE.DirectionalLight(0xfff3db, 2.25);
  sun.position.copy(SUN_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_RES, SHADOW_RES);
  sun.shadow.camera.left = -SHADOW_HALF;
  sun.shadow.camera.right = SHADOW_HALF;
  sun.shadow.camera.top = SHADOW_HALF;
  sun.shadow.camera.bottom = -SHADOW_HALF;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 360;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.028;
  sun.shadow.radius = 2.0;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xeef7ff, 0x6ea44c, 1.12);
  scene.add(hemi);

  const rim = new THREE.DirectionalLight(0xffe7c2, 0.35);
  rim.position.set(-85, 70, -90);
  scene.add(rim);

  // Endless Voxel Turf + Multi-Biome Ground Plane
  const grassUniforms = {
    uTime: { value: 0 },
    uFocusXZ: { value: new THREE.Vector2(0, 0) },
    uZones: { value: Array.from({ length: MAX_SHADER_ZONES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uZoneCount: { value: 0 },
  };
  const groundGeo = new THREE.PlaneGeometry(3600, 3600, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMesh = new THREE.Mesh(groundGeo, buildEndlessGrassMaterial(grassUniforms));
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const citySignboard = createContributorSignboard(maxAniso);
  scene.add(citySignboard.group);

  // Scattered scenic perimeter Meadow Groves (auto-hidden when a new creation claims that clearing!)
  const perimeterTreesGroup = new THREE.Group();
  scene.add(perimeterTreesGroup);
  const treeProtos = [buildMeadowTreeMesh(0), buildMeadowTreeMesh(1), buildMeadowTreeMesh(2)];
  const bushProtos = [buildMeadowBushMesh(0), buildMeadowBushMesh(1), buildMeadowBushMesh(2)];
  const perimeterScenery = [];
  for (let i = 0; i < 46; i++) {
    const r = 44 + ((i * 19) % 92);
    const ang = i * 2.399963 + 0.4;
    const tx = Math.cos(ang) * r;
    const tz = Math.sin(ang) * r;
    const tree = treeProtos[i % 3].clone();
    tree.position.set(tx, 0, tz);
    tree.rotation.y = (i * 1.7) % (Math.PI * 2);
    const sc = 0.85 + (i % 4) * 0.14;
    tree.scale.setScalar(sc);
    perimeterTreesGroup.add(tree);
    perimeterScenery.push({ mesh: tree, x: tx, z: tz });

    if (i % 2 === 0) {
      const bush = bushProtos[i % 3].clone();
      const bAng = ang + 0.05;
      const bx = tx + Math.cos(bAng * 7) * 2.4;
      const bz = tz + Math.sin(bAng * 5) * 2.4;
      bush.position.set(bx, 0, bz);
      bush.rotation.y = (i * 2.3) % (Math.PI * 2);
      perimeterTreesGroup.add(bush);
      perimeterScenery.push({ mesh: bush, x: bx, z: bz });
    }
  }

  // Shared voxel prototypes for the 6 path styles
  const flagstoneProtos = [0, 1, 2].map((variant) => {
    const fv = new Vox(410 + variant * 17);
    const cMain = variant === 0 ? "limestone" : variant === 1 ? "path" : "cream";
    const cEdge = variant === 1 ? "path2" : "concrete";
    fv.box(-2, 0, -2, 2, 1, 2, cMain);
    fv.put(-2, 0, -2, cEdge);
    fv.put(1, 0, 1, cEdge);
    return buildVoxelMesh(fv, { scale: 0.24, castShadow: false, depthLayer: 1 });
  });

  const dirtPebbleProtos = [0, 1, 2].map((variant) => {
    const pv = new Vox(450 + variant * 13);
    pv.box(-1, 0, -1, 1, 1, 1, variant === 0 ? "stone" : variant === 1 ? "path2" : "moss");
    if (variant === 0) pv.put(1, 0, 0, "concrete2");
    return buildVoxelMesh(pv, { scale: 0.2, castShadow: false, depthLayer: 1 });
  });

  const cobbleProtos = [0, 1, 2].map((variant) => {
    const cv = new Vox(490 + variant * 19);
    const cA = variant === 0 ? "concrete" : variant === 1 ? "limestone" : "path";
    const cB = variant === 0 ? "concrete2" : variant === 1 ? "stone" : "path2";
    cv.box(-3, 0, -2, 0, 1, 1, cA);
    cv.box(1, 0, -2, 3, 1, 2, cB);
    cv.box(-2, 0, 1, 1, 1, 2, cB);
    return buildVoxelMesh(cv, { scale: 0.23, castShadow: false, depthLayer: 2 });
  });

  const boardwalkPlankProtos = [0, 1].map((variant) => {
    const bv = new Vox(530 + variant * 11);
    const plankCol = variant === 0 ? "oak" : "woodLight";
    bv.box(-5, 1, -1, 5, 2, 2, plankCol);
    bv.box(-5, 0, -1, -4, 1, 2, "woodDark");
    bv.box(4, 0, -1, 5, 1, 2, "woodDark");
    return buildVoxelMesh(bv, { scale: 0.22, castShadow: true, depthLayer: 2 });
  });

  const volcanicStepProtos = [0, 1].map((variant) => {
    const vv = new Vox(570 + variant * 17);
    vv.box(-2, 0, -2, 2, 1, 2, "basalt");
    vv.put(variant === 0 ? -2 : 1, 0, 0, "ash");
    vv.put(0, 0, variant === 0 ? 1 : -1, "lava", 1.15);
    return buildVoxelMesh(vv, { scale: 0.24, castShadow: false, depthLayer: 2 });
  });

  const pathsGroup = new THREE.Group();
  const propsGroup = new THREE.Group();
  const creationsGroup = new THREE.Group();
  const villagersGroup = new THREE.Group();
  scene.add(pathsGroup, propsGroup, creationsGroup, villagersGroup);

  // Unit-radius Highlight Halo (scaled dynamically to match tiny vs colossal creation footprints!)
  const haloGeo = new THREE.RingGeometry(0.92, 1.06, 64);
  haloGeo.rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xfff7c2,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const selectionHalo = new THREE.Mesh(haloGeo, haloMat);
  selectionHalo.position.y = 0.122;
  selectionHalo.visible = false;
  scene.add(selectionHalo);

  const plotMarker = buildPlotMarkerGroup();
  scene.add(plotMarker.group);

  let spotState = { mode: "hidden", x: 16, z: 10 };
  let previewPlotRadius = 3.3;
  let liveFeedsById = {};

  const creationEntities = new Map();
  const villagerAgents = new Map();
  let currentWorld = null;
  let highlightedId = null;
  let ogSettledFrames = 0;

  const cam = {
    tx: 0,
    tz: -2,
    goalTx: 0,
    goalTz: -2,
    zoom: 1.02,
    goalZoom: 1.02,
    az: 0.62,
    goalAz: 0.62,
    el: 0.66,
    goalEl: 0.66,
  };

  const CLAMP_BOUND = 175;
  function clampTarget() {
    cam.goalTx = Math.max(-CLAMP_BOUND, Math.min(CLAMP_BOUND, cam.goalTx));
    cam.goalTz = Math.max(-CLAMP_BOUND, Math.min(CLAMP_BOUND, cam.goalTz));
  }

  function isClientSpotClear(x, z, candidateRadius = previewPlotRadius) {
    const rNew = Math.max(1.3, Number(candidateRadius) || 3.3);
    const bound = Math.max(112, 138 - rNew);
    if (Math.abs(x) > bound || Math.abs(z) > bound) return false;
    if (Math.hypot(x - CITY_SIGN_POS[0], z - CITY_SIGN_POS[1]) < rNew + 2.8) return false;
    if (!currentWorld) return true;
    for (const c of currentWorld.creations || []) {
      if (c.category === "aircraft" || c.behavior?.type === "fly_circle") continue;
      if (c.category === "watercraft" || c.behavior?.type === "water_float") continue;
      const otherR = getCreationFootprintRadius(
        c.scaleClass,
        c.blueprint?.stats?.footprintX ?? 14,
        c.blueprint?.stats?.footprintZ ?? 14,
      );
      if (Math.hypot(x - c.x, z - c.z) < rNew + otherR + 1.8) return false;
    }
    for (const pr of currentWorld.props || []) {
      if (pr.kind === "pond" && Math.hypot(x - pr.x, z - pr.z) < (pr.radius || 6.5) + rNew + 1.4) {
        return false;
      }
    }
    for (const p of currentWorld.paths || []) {
      if (p.kind !== "road" || !p.points) continue;
      for (let i = 0; i < p.points.length; i++) {
        const a = p.points[i];
        const b = p.points[(i + 1) % p.points.length];
        if (!p.closed && i === p.points.length - 1) break;
        if (distToSeg2D(x, z, a[0], a[1], b[0], b[1]) < rNew + 2.5) return false;
      }
    }
    return true;
  }

  function snapToClearMeadowSpot(rawX, rawZ, candidateRadius = previewPlotRadius) {
    const cx = Math.max(-132, Math.min(132, rawX));
    const cz = Math.max(-132, Math.min(132, rawZ));
    if (isClientSpotClear(cx, cz, candidateRadius)) {
      return [Number(cx.toFixed(1)), Number(cz.toFixed(1))];
    }
    const baseAng = Math.atan2(cz, cx);
    for (let r = 2.5; r <= 78; r += 2.6) {
      for (let k = 0; k < 20; k++) {
        const ang = baseAng + (k / 20) * Math.PI * 2;
        const tx = cx + Math.cos(ang) * r;
        const tz = cz + Math.sin(ang) * r;
        if (isClientSpotClear(tx, tz, candidateRadius)) {
          return [Number(tx.toFixed(1)), Number(tz.toFixed(1))];
        }
      }
    }
    return [Number(cx.toFixed(1)), Number(cz.toFixed(1))];
  }

  function setPreviewPrompt(promptText) {
    const nextR = estimatePreviewPlotRadius(promptText);
    previewPlotRadius = nextR;
    plotMarker.setPlotRadius(nextR);
    if (spotState.mode === "staked" || spotState.mode === "picking") {
      if (!isClientSpotClear(spotState.x, spotState.z, nextR)) {
        const [sx, sz] = snapToClearMeadowSpot(spotState.x, spotState.z, nextR);
        spotState.x = sx;
        spotState.z = sz;
        plotMarker.group.position.set(sx, 0, sz);
        callbacks.onAutoNudgeSpot?.(sx, sz);
      }
    }
  }

  const raycaster = new THREE.Raycaster();
  const groundPlaneMath = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpHit = new THREE.Vector3();

  function screenToGround(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    if (raycaster.ray.intersectPlane(groundPlaneMath, tmpHit)) {
      return [tmpHit.x, tmpHit.z];
    }
    return null;
  }

  function getCitySignHoverItem() {
    const n = currentWorld?.contributorCount ?? 0;
    const total = currentWorld?.creations?.length ?? 0;
    return {
      id: "__city_sign__",
      x: CITY_SIGN_POS[0],
      z: CITY_SIGN_POS[1],
      data: {
        id: "__city_sign__",
        name: "GeminIsland Sign",
        description: `${n} ${n === 1 ? "person has" : "people have"} contributed (${total} creations on the island)`,
        behavior: {
          statusLine: `${n} ${n === 1 ? "person has" : "people have"} contributed to GeminIsland`,
        },
      },
    };
  }

  function pickCreationAt(clientX, clientY) {
    const g = screenToGround(clientX, clientY);
    if (!g) return null;

    if (Math.hypot(g[0] - CITY_SIGN_POS[0], g[1] - CITY_SIGN_POS[1]) < 3.4) {
      return getCitySignHoverItem();
    }

    let best = null;
    let bestScore = Infinity;
    for (const ent of creationEntities.values()) {
      const hitRadius = Math.max(4.4, (ent.footprintRadius || 3.5) + 1.2);
      const d = Math.hypot(ent.x - g[0], ent.z - g[1]);
      if (d < hitRadius && d < bestScore) {
        bestScore = d;
        best = ent;
      }
    }
    return best;
  }

  function updateBiomeShaderUniforms(zones) {
    const list = Array.isArray(zones) ? zones.slice(0, MAX_SHADER_ZONES) : [];
    let count = 0;
    for (let i = 0; i < MAX_SHADER_ZONES; i++) {
      const vec = grassUniforms.uZones.value[i];
      const zItem = list[i];
      if (zItem && BIOME_IDS[zItem.biome]) {
        vec.set(
          Number(zItem.x) || 0,
          Number(zItem.z) || 0,
          Math.max(4.0, Number(zItem.radius) || 9.0),
          BIOME_IDS[zItem.biome],
        );
        count++;
      } else {
        vec.set(0, 0, 0, 0);
      }
    }
    grassUniforms.uZoneCount.value = count;
  }

  function updatePerimeterTreeClearance(world) {
    const creations = world?.creations || [];
    for (const item of perimeterScenery) {
      let blocked = false;
      for (const c of creations) {
        if (c.category === "aircraft" || c.behavior?.type === "fly_circle") continue;
        const fr = getCreationFootprintRadius(
          c.scaleClass,
          c.blueprint?.stats?.footprintX ?? 14,
          c.blueprint?.stats?.footprintZ ?? 14,
        );
        if (Math.hypot(item.x - c.x, item.z - c.z) < fr + 3.0) {
          blocked = true;
          break;
        }
      }
      item.mesh.visible = !blocked;
    }
  }

  function rebuildPathsAndProps(world) {
    while (pathsGroup.children.length) {
      const ch = pathsGroup.children.pop();
      ch.traverse((o) => {
        if (o.userData?.sharedProto) return;
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    while (propsGroup.children.length) {
      const ch = propsGroup.children.pop();
      ch.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }

    for (const p of world.paths || []) {
      if (!p.points || p.points.length < 2) continue;
      const vecs = p.points.map(([x, z]) => new THREE.Vector3(x, 0, z));
      const curve = new THREE.CatmullRomCurve3(vecs, Boolean(p.closed), "centripetal", 0.5);
      const len = Math.max(4, curve.getLength());
      const samples = Math.min(200, Math.max(28, Math.round(len * 1.4)));

      if (p.kind === "road") {
        pathsGroup.add(buildRibbonMesh(curve, samples, 2.52, 0.052, "#dfd7c5", true, -1));
        pathsGroup.add(buildRibbonMesh(curve, samples, 2.1, 0.088, "#4b505c", true, -2));

        const dashCount = Math.floor(len / 3.4);
        const dashGeo = new THREE.BoxGeometry(0.2, 0.026, 1.3);
        const dashMat = new THREE.MeshBasicMaterial({
          color: "#f6eed8",
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -4,
        });
        for (let i = 0; i < dashCount; i++) {
          const u = (i + 0.5) / dashCount;
          const pt = curve.getPointAt(u);
          const tan = curve.getTangentAt(u);
          const dash = new THREE.Mesh(dashGeo, dashMat);
          dash.position.set(pt.x, 0.106, pt.z);
          dash.rotation.y = Math.atan2(tan.x, tan.z);
          pathsGroup.add(dash);
        }
      } else if (p.kind === "dirt_trail") {
        // Warm country dirt road / forest trail with soft sandy-loam edge & scattered border pebbles
        pathsGroup.add(buildRibbonMesh(curve, samples, 1.48, 0.042, "#b58b5e", true, -1));
        pathsGroup.add(buildRibbonMesh(curve, samples, 1.08, 0.068, "#8e6239", true, -2));

        const pebbleCount = Math.max(3, Math.floor(len / 2.2));
        for (let i = 0; i <= pebbleCount; i++) {
          const u = i / pebbleCount;
          const pt = curve.getPointAt(u);
          const tan = curve.getTangentAt(u);
          const side = i % 2 === 0 ? 1 : -1;
          const nx = -tan.z * side;
          const nz = tan.x * side;
          const pebble = dirtPebbleProtos[i % dirtPebbleProtos.length].clone();
          pebble.userData.sharedProto = true;
          pebble.position.set(pt.x + nx * 1.25, -0.14, pt.z + nz * 1.25);
          pebble.rotation.y = (i * 1.9) % (Math.PI * 2);
          pathsGroup.add(pebble);
        }
      } else if (p.kind === "cobblestone") {
        // Old-world stone cobble lane with warm mortar ribbon + irregular stone clusters
        pathsGroup.add(buildRibbonMesh(curve, samples, 1.32, 0.045, "#a39a8b", true, -1));
        const cobbleCount = Math.max(4, Math.floor(len / 1.15));
        for (let i = 0; i <= cobbleCount; i++) {
          const u = i / cobbleCount;
          const pt = curve.getPointAt(u);
          const tan = curve.getTangentAt(u);
          const cob = cobbleProtos[i % cobbleProtos.length].clone();
          cob.userData.sharedProto = true;
          cob.position.set(pt.x, -0.155, pt.z);
          cob.rotation.y = Math.atan2(tan.x, tan.z) + (i % 2 === 0 ? 0.05 : -0.05);
          pathsGroup.add(cob);
        }
      } else if (p.kind === "boardwalk") {
        // Raised timber plank boardwalk for beaches, ponds, lagoons & waterfalls
        const plankCount = Math.max(4, Math.floor(len / 0.92));
        for (let i = 0; i <= plankCount; i++) {
          const u = i / plankCount;
          const pt = curve.getPointAt(u);
          const tan = curve.getTangentAt(u);
          const plank = boardwalkPlankProtos[i % boardwalkPlankProtos.length].clone();
          plank.userData.sharedProto = true;
          plank.position.set(pt.x, -0.18, pt.z);
          plank.rotation.y = Math.atan2(tan.x, tan.z);
          pathsGroup.add(plank);
        }
      } else if (p.kind === "volcanic_trail") {
        // Charred obsidian basalt path with warm glowing ember stones
        pathsGroup.add(buildRibbonMesh(curve, samples, 1.38, 0.048, "#2b2d36", true, -1));
        const stepCount = Math.max(3, Math.floor(len / 1.45));
        for (let i = 0; i <= stepCount; i++) {
          const u = i / stepCount;
          const pt = curve.getPointAt(u);
          const tan = curve.getTangentAt(u);
          const st = volcanicStepProtos[i % volcanicStepProtos.length].clone();
          st.userData.sharedProto = true;
          st.position.set(pt.x, -0.16, pt.z);
          st.rotation.y = Math.atan2(tan.x, tan.z) + (((i % 3) - 1) * 0.12);
          pathsGroup.add(st);
        }
      } else {
        // Garden stepping flagstones
        const stoneCount = Math.max(3, Math.floor(len / 1.42));
        for (let i = 0; i <= stoneCount; i++) {
          const u = i / stoneCount;
          const pt = curve.getPointAt(u);
          const tan = curve.getTangentAt(u);
          const stone = flagstoneProtos[i % flagstoneProtos.length].clone();
          stone.userData.sharedProto = true;
          stone.position.set(pt.x, -0.185, pt.z);
          stone.rotation.y = Math.atan2(tan.x, tan.z) + (((i % 3) - 1) * 0.08);
          stone.scale.set(1.0 + (i % 2) * 0.12, 1, 0.92 + ((i + 1) % 2) * 0.12);
          pathsGroup.add(stone);
        }
      }
    }

    for (const pr of world.props || []) {
      propsGroup.add(buildWorldPropMesh(pr));
    }
  }

  function frameActiveWorldForOg() {
    if (!currentWorld) return;
    const creations = currentWorld.creations || [];
    const userLandmarks = creations.filter((c) => !c.isSeed && c.behavior?.type === "landmark");
    const aspect = Math.max(0.5, window.innerWidth / Math.max(1, window.innerHeight));
    const blend = aspect < 0.75 ? 0.16 : aspect < 1.15 ? 0.26 : 0.38;
    let cx = 0;
    let cz = -3;
    if (userLandmarks.length > 0) {
      const latest = userLandmarks[userLandmarks.length - 1];
      cx = Math.max(-18, Math.min(18, latest.x * blend));
      cz = Math.max(-18, Math.min(18, latest.z * blend - 2));
    }
    const zoom = aspect < 0.75 ? 0.64 : aspect < 1.15 ? 0.82 : 0.94;
    cam.tx = cam.goalTx = cx;
    cam.tz = cam.goalTz = cz;
    cam.zoom = cam.goalZoom = zoom;
    cam.az = cam.goalAz = 0.64;
    cam.el = cam.goalEl = 0.64;
    highlightedId = null;
    for (const ent of creationEntities.values()) {
      ent.spawnScale = 1.0;
    }
  }

  function applyLiveFeeds(feedsMap) {
    liveFeedsById = feedsMap || {};
    for (const [id, ent] of creationEntities.entries()) {
      ent.setLiveFeedReading(liveFeedsById[id] || null, maxAniso);
    }
  }

  function applyWorldSnapshot(world) {
    currentWorld = world;
    const contribCount =
      typeof world.contributorCount === "number"
        ? world.contributorCount
        : (world.creations || []).filter((c) => !c.isSeed).length;
    citySignboard.updateCount(contribCount);
    updateBiomeShaderUniforms(world.terrainZones || []);
    updatePerimeterTreeClearance(world);
    rebuildPathsAndProps(world);

    const seenIds = new Set();
    world.creations.forEach((c, idx) => {
      seenIds.add(c.id);
      const existing = creationEntities.get(c.id);
      if (existing) {
        existing.rebuildBehavior(c, creationsGroup);
        existing.setLiveFeedReading(liveFeedsById[c.id] || null, maxAniso);
      } else {
        const ent = new CreationSimEntity(c, idx);
        if (ogMode) ent.spawnScale = 1.0;
        ent.setLiveFeedReading(liveFeedsById[c.id] || null, maxAniso);
        creationEntities.set(c.id, ent);
        creationsGroup.add(ent.group);
      }
    });
    for (const [id, ent] of creationEntities.entries()) {
      if (!seenIds.has(id)) {
        creationsGroup.remove(ent.group);
        ent.dispose();
        creationEntities.delete(id);
      }
    }

    const seenVillagers = new Set();
    world.villagers.forEach((v, idx) => {
      seenVillagers.add(v.id);
      const existing = villagerAgents.get(v.id);
      if (existing) {
        existing.updateFromServer(v);
      } else {
        const agent = new VillagerAgent(v, idx);
        villagerAgents.set(v.id, agent);
        villagersGroup.add(agent.group);
      }
    });
    for (const [id, ag] of villagerAgents.entries()) {
      if (!seenVillagers.has(id)) {
        villagersGroup.remove(ag.group);
        ag.dispose();
        villagerAgents.delete(id);
      }
    }

    if (ogMode) {
      frameActiveWorldForOg();
      ogSettledFrames = 0;
    } else if (world.myCreationId && !highlightedId) {
      highlightedId = world.myCreationId;
    }
  }

  function setSpotPickerState(next) {
    const mode = next?.mode || "hidden";
    let nx = typeof next?.x === "number" ? next.x : spotState.x;
    let nz = typeof next?.z === "number" ? next.z : spotState.z;
    if (mode === "picking" && typeof next?.x !== "number") {
      const def = snapToClearMeadowSpot(cam.goalTx + 14, cam.goalTz + 8, previewPlotRadius);
      nx = def[0];
      nz = def[1];
    }
    spotState = { mode, x: nx, z: nz };

    if (mode === "hidden") {
      plotMarker.group.visible = false;
      plotMarker.scaffoldGroup.visible = false;
      canvas.style.cursor = "grab";
    } else if (mode === "picking") {
      plotMarker.group.visible = true;
      plotMarker.scaffoldGroup.visible = false;
      plotMarker.ringMat.color.setHex(0xffffff);
      plotMarker.group.position.set(nx, 0, nz);
      canvas.style.cursor = "crosshair";
    } else if (mode === "staked") {
      plotMarker.group.visible = true;
      plotMarker.scaffoldGroup.visible = false;
      plotMarker.ringMat.color.setHex(0xffe57f);
      plotMarker.group.position.set(nx, 0, nz);
      canvas.style.cursor = "grab";
    } else if (mode === "building") {
      plotMarker.group.visible = true;
      plotMarker.scaffoldGroup.visible = true;
      plotMarker.ringMat.color.setHex(0xffe57f);
      plotMarker.group.position.set(nx, 0, nz);
      canvas.style.cursor = "grab";
    }
  }

  function panByPixels(dxPx, dyPx) {
    const vh = canvas.clientHeight || window.innerHeight;
    const worldPerPx = (2 * BASE_FRUSTUM) / (cam.zoom * vh);
    const right = dxPx * worldPerPx;
    const fwd = (dyPx * worldPerPx) / Math.max(0.35, Math.sin(cam.el));
    const cosA = Math.cos(cam.az);
    const sinA = Math.sin(cam.az);
    cam.goalTx += right * cosA + fwd * sinA;
    cam.goalTz += -right * sinA + fwd * cosA;
    clampTarget();
  }

  function zoomAt(factor, clientX, clientY) {
    const next = Math.min(3.4, Math.max(0.38, cam.goalZoom * factor));
    const p = screenToGround(clientX, clientY);
    if (p) {
      const k = 1 - cam.goalZoom / next;
      cam.goalTx += (p[0] - cam.goalTx) * k;
      cam.goalTz += (p[1] - cam.goalTz) * k;
      clampTarget();
    }
    cam.goalZoom = next;
  }

  let lastTrackpadAt = 0;
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * 0.0085), e.clientX, e.clientY);
        return;
      }
      const now = performance.now();
      const notched =
        e.deltaMode !== 0 ||
        (e.deltaX === 0 && Math.abs(e.wheelDeltaY) >= 120 && e.wheelDeltaY % 120 === 0);
      if (notched && now - lastTrackpadAt > 400) {
        zoomAt(Math.exp(-Math.sign(e.deltaY) * 0.16), e.clientX, e.clientY);
        return;
      }
      lastTrackpadAt = now;
      panByPixels(e.deltaX, e.deltaY);
    },
    { passive: false },
  );

  let pointerGesture = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const isOrbit = e.button === 2 || e.button === 1 || e.altKey;
    pointerGesture = {
      id: e.pointerId,
      kind: isOrbit ? "orbit" : "pan",
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (spotState.mode === "picking" && !pointerGesture) {
      const g = screenToGround(e.clientX, e.clientY);
      if (g) {
        const snapped = snapToClearMeadowSpot(g[0], g[1], previewPlotRadius);
        spotState.x = snapped[0];
        spotState.z = snapped[1];
        plotMarker.group.position.set(snapped[0], 0, snapped[1]);
      }
    }

    if (!pointerGesture) {
      if (spotState.mode === "picking") {
        callbacks.onHoverCreation?.(null, e.clientX, e.clientY, null);
        canvas.style.cursor = "crosshair";
        return;
      }
      const hovered = pickCreationAt(e.clientX, e.clientY);
      const reading = hovered && hovered.id !== "__city_sign__" ? liveFeedsById[hovered.id] || null : null;
      callbacks.onHoverCreation?.(hovered ? hovered.data : null, e.clientX, e.clientY, reading);
      canvas.style.cursor = hovered ? "pointer" : spotState.mode === "staked" ? "crosshair" : "grab";
      return;
    }

    if (pointerGesture.id !== e.pointerId) return;
    const dx = e.clientX - pointerGesture.lastX;
    const dy = e.clientY - pointerGesture.lastY;
    pointerGesture.lastX = e.clientX;
    pointerGesture.lastY = e.clientY;

    if (Math.hypot(e.clientX - pointerGesture.startX, e.clientY - pointerGesture.startY) > 5) {
      pointerGesture.moved = true;
    }

    if (pointerGesture.kind === "orbit") {
      cam.goalAz -= dx * 0.0065;
      cam.goalEl = Math.max(0.34, Math.min(1.22, cam.goalEl + dy * 0.005));
      canvas.style.cursor = "grabbing";
    } else if (pointerGesture.moved) {
      panByPixels(-dx, -dy);
      canvas.style.cursor = "grabbing";
    }
  });

  const endGesture = (e) => {
    if (!pointerGesture || pointerGesture.id !== e.pointerId) return;
    const wasClick = !pointerGesture.moved && pointerGesture.kind === "pan";
    pointerGesture = null;
    canvas.style.cursor = spotState.mode === "picking" ? "crosshair" : "grab";

    if (wasClick) {
      if (spotState.mode === "picking" || spotState.mode === "staked") {
        const pickedExisting = spotState.mode === "staked" ? pickCreationAt(e.clientX, e.clientY) : null;
        if (!pickedExisting) {
          const g = screenToGround(e.clientX, e.clientY);
          if (g) {
            const [sx, sz] = snapToClearMeadowSpot(g[0], g[1], previewPlotRadius);
            spotState.x = sx;
            spotState.z = sz;
            plotMarker.group.position.set(sx, 0, sz);
            callbacks.onPickGroundSpot?.(sx, sz);
          }
          return;
        }
      }

      const picked = pickCreationAt(e.clientX, e.clientY);
      if (picked) {
        if (picked.id !== "__city_sign__") {
          highlightedId = picked.id;
        }
        const scaleCls = picked.data?.scaleClass;
        const targetZoom =
          scaleCls === "colossal" ? 0.86 : scaleCls === "large" ? 1.28 : scaleCls === "tiny" ? 2.0 : 1.55;
        focusOn(picked.x, picked.z, targetZoom);
        callbacks.onSelectCreation?.(picked.data, liveFeedsById[picked.id] || null);
      }
    }
  };
  canvas.addEventListener("pointerup", endGesture);
  canvas.addEventListener("pointercancel", endGesture);

  window.addEventListener("keydown", (e) => {
    if (e.target?.matches?.("input, textarea")) return;
    const step = 7 / Math.max(0.5, cam.zoom);
    if (e.key === "ArrowLeft" || e.key === "a") cam.goalTx -= step;
    else if (e.key === "ArrowRight" || e.key === "d") cam.goalTx += step;
    else if (e.key === "ArrowUp" || e.key === "w") cam.goalTz -= step;
    else if (e.key === "ArrowDown" || e.key === "s") cam.goalTz += step;
    clampTarget();
  });

  function focusOn(x, z, zoom = 1.45) {
    cam.goalTx = x;
    cam.goalTz = z;
    cam.goalZoom = zoom;
    clampTarget();
  }

  function focusCreationById(id) {
    const ent = creationEntities.get(id);
    if (!ent) return;
    highlightedId = id;
    const altOffset = ent.y > 1 ? ent.y / Math.max(0.35, Math.tan(cam.el)) : 0;
    const projX = ent.x - Math.sin(cam.az) * altOffset;
    const projZ = ent.z - Math.cos(cam.az) * altOffset;
    const scaleCls = ent.data?.scaleClass;
    const zoom =
      ent.y > 4
        ? 1.22
        : scaleCls === "colossal"
          ? 0.86
          : scaleCls === "large"
            ? 1.28
            : scaleCls === "tiny"
              ? 2.05
              : 1.62;
    focusOn(projX, projZ, zoom);
  }

  function handleResize() {
    const w = Math.max(320, window.innerWidth);
    const h = Math.max(240, window.innerHeight);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = -BASE_FRUSTUM * aspect;
    camera.right = BASE_FRUSTUM * aspect;
    camera.top = BASE_FRUSTUM;
    camera.bottom = -BASE_FRUSTUM;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setSize(w, h);
      gtaoPass?.setSize(w, h);
      smaaPass?.setSize(w, h);
    }
    if (ogMode && currentWorld) {
      frameActiveWorldForOg();
    }
  }
  window.addEventListener("resize", handleResize);

  const lightUp = new THREE.Vector3(0, 1, 0);
  const lightDir = SUN_OFFSET.clone().normalize();
  const lightRight = new THREE.Vector3().crossVectors(lightUp, lightDir).normalize();
  const lightOrthoUp = new THREE.Vector3().crossVectors(lightDir, lightRight).normalize();

  function updateTexelSnappedSun(tx, tz) {
    const texelSize = (SHADOW_HALF * 2) / SHADOW_RES;
    const focusVec = new THREE.Vector3(tx, 0, tz);
    const projR = Math.round(focusVec.dot(lightRight) / texelSize) * texelSize;
    const projU = Math.round(focusVec.dot(lightOrthoUp) / texelSize) * texelSize;
    const projD = focusVec.dot(lightDir);

    const snappedTarget = new THREE.Vector3()
      .addScaledVector(lightRight, projR)
      .addScaledVector(lightOrthoUp, projU)
      .addScaledVector(lightDir, projD);

    sun.target.position.copy(snappedTarget);
    sun.position.copy(snappedTarget).add(SUN_OFFSET);
    sun.target.updateMatrixWorld();
  }

  let lastNow = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
    lastNow = now;
    const t = now * 0.001;

    grassUniforms.uTime.value = t;

    const damp = 1 - Math.exp(-dt * 11);
    cam.tx += (cam.goalTx - cam.tx) * damp;
    cam.tz += (cam.goalTz - cam.tz) * damp;
    cam.zoom += (cam.goalZoom - cam.zoom) * damp;
    cam.az += (cam.goalAz - cam.az) * damp;
    cam.el += (cam.goalEl - cam.el) * damp;

    const camDist = 240;
    const horiz = Math.cos(cam.el) * camDist;
    camera.position.set(
      cam.tx + Math.sin(cam.az) * horiz,
      Math.sin(cam.el) * camDist,
      cam.tz + Math.cos(cam.az) * horiz,
    );
    camera.lookAt(cam.tx, 0, cam.tz);
    camera.zoom = cam.zoom;
    camera.updateProjectionMatrix();

    groundMesh.position.set(cam.tx, 0, cam.tz);
    grassUniforms.uFocusXZ.value.set(cam.tx, cam.tz);
    updateTexelSnappedSun(cam.tx, cam.tz);

    const allEnts = Array.from(creationEntities.values());
    const ponds = (currentWorld?.props || []).filter((p) => p.kind === "pond");
    const activeVehicles = [];
    const obstacles = [{ x: CITY_SIGN_POS[0], z: CITY_SIGN_POS[1], r: 2.9 }];

    for (const ent of allEnts) {
      ent.step(dt, t, allEnts, ponds, cam.az);
      if (ent.data.behavior?.type === "vehicle_route") {
        activeVehicles.push(ent);
      } else if (ent.data.category === "building" || ent.data.behavior?.type === "landmark") {
        obstacles.push({
          x: ent.x,
          z: ent.z,
          r: (ent.footprintRadius || 3.8) + 0.8,
        });
      }
    }

    const allVillagers = Array.from(villagerAgents.values());
    for (const ag of allVillagers) {
      ag.step(dt, t, activeVehicles, ponds, allVillagers, obstacles);
    }

    if (!ogMode && highlightedId && creationEntities.has(highlightedId)) {
      const myEnt = creationEntities.get(highlightedId);
      if (myEnt.y <= 2.5) {
        selectionHalo.visible = true;
        selectionHalo.position.set(myEnt.x, 0.122, myEnt.z);
        const haloBase = Math.max(1.8, (myEnt.footprintRadius || 2.8) + 0.6);
        selectionHalo.scale.setScalar(haloBase * (1 + Math.sin(t * 2.5) * 0.035));
      } else {
        selectionHalo.visible = false;
      }
    } else {
      selectionHalo.visible = false;
    }

    if (plotMarker.group.visible) {
      const baseR = plotMarker.getPlotRadius();
      plotMarker.ring.scale.setScalar(baseR * (1 + Math.sin(t * 3.2) * 0.035));
      if (plotMarker.scaffoldGroup.visible) {
        const orbitR = Math.max(0.75, Math.min(3.4, baseR * 0.36));
        const orbitY = Math.max(1.0, Math.min(3.6, 0.9 + baseR * 0.22));
        plotMarker.floatingCubes.forEach((cube, idx) => {
          const ang = t * 2.2 + (idx * Math.PI * 2) / 3;
          cube.position.set(
            Math.cos(ang) * orbitR,
            orbitY + Math.sin(t * 3.8 + idx * 1.4) * 0.38,
            Math.sin(ang) * orbitR,
          );
          cube.rotation.y = t * 1.8 + idx;
          cube.rotation.x = Math.sin(t * 2.1 + idx) * 0.35;
        });
      }
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);

    if (ogMode && currentWorld) {
      ogSettledFrames++;
      if (ogSettledFrames >= 6 && !window.__geminIslandOgReady) {
        window.__geminIslandOgReady = true;
      }
    }
  }
  requestAnimationFrame(animate);

  return {
    applyWorldSnapshot,
    applyLiveFeeds,
    setSpotPickerState,
    setPreviewPrompt,
    focusCreationById,
    focusOn,
    getCameraTarget: () => ({ x: cam.tx, z: cam.tz, zoom: cam.zoom }),
    getPlotRadius: () => plotMarker.getPlotRadius(),
    isPointerActive: () => Boolean(pointerGesture),
    getCreationEntity: (id) => creationEntities.get(id) || null,
  };
}
