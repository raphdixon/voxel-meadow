// Endless Sunlit Voxel Turf World Engine.
// Features:
//  - Crisp voxel-tiled sunlit meadow ground shader with beveled grass blocks, subtle park-lawn weave & cumulus sun dapple
//  - Physical 3D City Contributor Signboard in the central village green (live contributor count)
//  - Simple in-world live API micro-badges (weather, surf, wind, time, moon, ISS)
//  - Interactive 3D voxel plot stake marker + live voxel construction scaffolding while building
//  - Camera-tracking texel-snapped 4096^2 PCF golden-hour shadows (zero pan shimmer!)
//  - GTAO real-time contact occlusion + subtle UnrealBloom + ACESFilmic + SMAA
//  - Smooth CatmullRom vehicle routes + polite non-overlapping voxel villagers

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
import { Vox, buildCreationGroup, buildVoxelMesh } from "./vox.js";

const CITY_SIGN_POS = [3.8, -10.8];
const CITY_SIGN_YAW = 0.62;

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

  // Stepped limestone & stone-shade base plinth + brass corner studs
  v.box(-14, 0, -4, 14, 1, 4, "concrete2");
  v.box(-13, 1, -3, 13, 2, 3, "limestone");
  for (const [cx, cz] of [[-13, -3], [12, -3], [-13, 2], [12, 2]]) {
    v.put(cx, 2, cz, "brass");
  }

  // Twin dark-oak timber posts
  v.box(-12, 2, -1, -10, 20, 1, "woodDark");
  v.box(10, 2, -1, 12, 20, 1, "woodDark");
  v.box(-12, 20, -1, -10, 21, 1, "brass");
  v.box(10, 20, -1, 12, 21, 1, "brass");

  // Solid oak signboard frame & backing
  v.box(-10, 5, -1, 10, 18, 1, "oak");
  v.box(-11, 4, -1, 11, 5, 1, "woodDark");
  v.box(-11, 18, -1, 11, 19, 1, "woodDark");

  // Pitched terracotta shingle eave canopy + warm glowing crown lantern
  v.box(-14, 19, -3, 14, 20, 3, "terracotta");
  v.box(-13, 20, -2, 13, 21, 2, "brickDark");
  v.box(-1, 21, -1, 1, 23, 1, "iron");
  v.box(-1, 22, 1, 1, 24, 3, "warmGlow", 1.45);

  // Cozy flower cushions tucked beside stone base
  v.sphere(-14, 1.5, 2, 1.8, 1.2, 1.6, "leaf");
  v.sphere(14, 1.5, 2, 1.8, 1.2, 1.6, "leafLight");
  v.clear(-18, -3, -8, 18, 0, 8);
  v.put(-14, 2, 2, "#f6d55c");
  v.put(14, 2, 2, "#ec8db0");

  group.add(buildVoxelMesh(v, { scale: s }));

  // Crisp high-DPI CanvasTexture plaque on front & back faces
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

    // Timber outer border
    roundRectPath(ctx, 4, 4, 504, 272, 22);
    ctx.fillStyle = "#5c3b20";
    ctx.fill();

    // Warm cream enamel sign face
    roundRectPath(ctx, 18, 18, 476, 244, 14);
    ctx.fillStyle = "#fcf7ea";
    ctx.fill();

    // Subtle brass pin-stripe + 4 corner rivets
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

    // Header
    ctx.fillStyle = "#6b4f35";
    ctx.font = "800 28px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("VOXEL MEADOW", 256, 66);

    // Big contributor count numeral
    ctx.fillStyle = "#18211b";
    ctx.font = "800 104px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
    ctx.fillText(String(n), 256, 148);

    // Concise bottom line
    ctx.fillStyle = "#267043";
    ctx.font = "800 32px -apple-system, BlinkMacSystemFont, 'Inter', sans-serif";
    ctx.fillText(n === 1 ? "CONTRIBUTOR" : "CONTRIBUTORS", 256, 220);

    tex.needsUpdate = true;
  }

  updateCount(0);
  group.position.set(CITY_SIGN_POS[0], 0, CITY_SIGN_POS[1]);
  group.rotation.y = CITY_SIGN_YAW;

  return { group, updateCount };
}

function buildPlotMarkerGroup() {
  const group = new THREE.Group();

  // Crisp glowing ground plot ring
  const ringGeo = new THREE.RingGeometry(2.35, 2.78, 48);
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

  // 4 chunky voxel corner stakes (oak + brass cap)
  const stakeVox = new Vox(931);
  for (const [sx, sz] of [[-8, -8], [7, -8], [-8, 7], [7, 7]]) {
    stakeVox.box(sx, 0, sz, sx + 2, 5, sz + 2, "woodDark");
    stakeVox.box(sx, 5, sz, sx + 2, 6, sz + 2, "gold", 0.45);
  }
  const stakesMesh = buildVoxelMesh(stakeVox, { scale: 0.22 });
  group.add(stakesMesh);

  // Construction scaffolding sub-group (shown while Argon builds in the background)
  const scaffoldGroup = new THREE.Group();
  const scafVox = new Vox(947);
  for (const [sx, sz] of [[-9, -9], [8, -9], [-9, 8], [8, 8]]) {
    scafVox.box(sx, 0, sz, sx + 2, 16, sz + 2, "wood");
  }
  // Crossbars
  scafVox.box(-9, 8, -9, 10, 9, -8, "hazard");
  scafVox.box(-9, 8, 9, 10, 9, 10, "hazard");
  scafVox.box(-9, 8, -9, -8, 9, 10, "hazard");
  scafVox.box(9, 8, -9, 10, 9, 10, "hazard");
  scafVox.box(-9, 15, -9, 10, 16, -8, "woodLight");
  scafVox.box(-9, 15, 9, 10, 16, 10, "woodLight");
  scaffoldGroup.add(buildVoxelMesh(scafVox, { scale: 0.22 }));

  // Animated floating voxel blocks inside the worksite
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

  return { group, ring, ringMat, scaffoldGroup, floatingCubes };
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

        float tilePx = max(fwidth(tileCoord.x), fwidth(tileCoord.y));
        float tileDetail = 1.0 - smoothstep(0.06, 0.20, tilePx);

        vec3 turfDeep = srgb2lin(103.0, 174.0, 74.0);
        vec3 turfBase = srgb2lin(116.0, 187.0, 84.0);
        vec3 turfMid  = srgb2lin(128.0, 198.0, 94.0);
        vec3 turfSun  = srgb2lin(142.0, 209.0, 105.0);

        float meadowZone = mNoise(wp * 0.028);
        float subZone = mNoise(wp * 0.085 + vec2(19.4, -11.2));
        float cellH = mHash(cell);
        vec2 terraceBlock = floor(cell * 0.25);
        float lawnCheck = mod(terraceBlock.x + terraceBlock.y, 2.0);

        vec3 grassCol = mix(turfDeep, turfBase, smoothstep(0.20, 0.68, meadowZone));
        grassCol = mix(grassCol, turfMid, smoothstep(0.42, 0.85, subZone) * 0.72);
        grassCol = mix(grassCol, turfSun, smoothstep(0.68, 0.96, meadowZone * 0.6 + subZone * 0.4) * 0.45);

        float blockTone = (floor(cellH * 4.0) / 3.0 - 0.5) * 0.075 + (lawnCheck - 0.5) * 0.028;
        grassCol *= 1.0 + blockTone * tileDetail;

        vec2 edgeDist = min(cellUv, 1.0 - cellUv);
        float minEdge = min(edgeDist.x, edgeDist.y);
        float seamW = max(0.042, tilePx * 1.35);
        float seam = smoothstep(0.0, seamW, minEdge);
        grassCol *= mix(1.0 - 0.08 * tileDetail, 1.0, seam);

        float topLip = (1.0 - smoothstep(0.0, 0.14, cellUv.y)) * seam;
        grassCol += grassCol * topLip * 0.045 * tileDetail;

        vec2 cloudUv = wp * 0.011 + vec2(uTime * 0.008, uTime * 0.0045);
        float cloud = mNoise(cloudUv) * 0.65 + mNoise(cloudUv * 2.0 + 3.7) * 0.35;
        grassCol *= mix(0.92, 1.05, smoothstep(0.32, 0.70, cloud));

        float distFocus = length(wp - uFocusXZ);
        vec3 horizonMist = srgb2lin(154.0, 206.0, 134.0);
        grassCol = mix(grassCol, horizonMist, smoothstep(185.0, 480.0, distFocus) * 0.58);

        diffuseColor.rgb = grassCol;`,
      );
  };
  mat.customProgramCacheKey = () => "endless-meadow-voxel-turf-v2";
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
    roughness: 0.86,
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
  const opsSig = (bp.ops || []).length;
  const partsSig = (bp.parts || [])
    .map((p) => `${p.name}:${(p.pivot || []).join(",")}:${(p.ops || []).length}`)
    .join("|");
  return `${opsSig}#${partsSig}`;
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

    this.x = creation.x;
    this.y = 0.004;
    this.z = creation.z;
    this.yaw = creation.yaw || 0;
    this.wheelAngle = 0;
    this.moveFactor = 0;
    this.spawnScale = creation.isSeed ? 1.0 : 0.05;

    // Height estimate for optional live-feed badge
    const worldUnit = creation.scaleClass === "large" ? 0.34 : creation.scaleClass === "medium" ? 0.24 : 0.18;
    this.topY = Math.max(2.2, (creation.blueprint?.stats?.maxY || 14) * worldUnit);
    this.feedReading = null;
    this.feedBadgeText = "";
    this.feedCanvas = null;
    this.feedTex = null;
    this.feedMesh = null;

    // Transit / Vehicle curve state
    this.routeCurve = null;
    this.routeLength = 1;
    this.routeDist = (index * 13.7) % 40;
    this.stopArcPositions = [];
    this.dwellingStop = null;
    this.dwellTimer = 0;
    this.lastStoppedId = null;
    this.doorX = this.x;
    this.doorZ = this.z;

    // Wander state
    this.wanderIdx = 0;
    this.wanderPause = (index * 1.3) % 2.5;
    this.hopPhase = 0;

    // Orbit / Float phase
    this.orbitAngle = (index * 1.9) % (Math.PI * 2);

    this.rebuildBehavior(creation);
    this.group.position.set(this.x, 0, this.z);
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
    this.data = creation;
    const nextSig = computeBlueprintSignature(creation.blueprint);
    if (creationsGroup && nextSig && nextSig !== this.blueprintSig) {
      // Live hot-swap when the orchestrator auto-repairs a creation's blueprint!
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
      const worldUnit = creation.scaleClass === "large" ? 0.34 : creation.scaleClass === "medium" ? 0.24 : 0.18;
      this.topY = Math.max(2.2, (creation.blueprint?.stats?.maxY || 14) * worldUnit);
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
      const targets =
        b.targets && b.targets.length
          ? b.targets
          : [
              [b.homeX + 5, b.homeZ + 3],
              [b.homeX - 4, b.homeZ + 4],
              [b.homeX + 1, b.homeZ - 5],
            ];
      if (this.wanderPause > 0) {
        this.wanderPause -= dt;
        this.y = 0;
        this.moveFactor = 0;
      } else {
        const tgt = targets[this.wanderIdx % targets.length];
        const dx = tgt[0] - this.x;
        const dz = tgt[1] - this.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.45) {
          this.wanderIdx = (this.wanderIdx + 1) % targets.length;
          this.wanderPause = 1.6 + (this.wanderIdx % 2) * 0.9;
          this.y = 0;
        } else {
          const stepLen = Math.min(dist, (b.speed || 2.5) * dt);
          this.x += (dx / dist) * stepLen;
          this.z += (dz / dist) * stepLen;
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
          this.wheelAngle += stepLen / 0.45;
          this.moveFactor = 1.0;

          const desiredYaw = Math.atan2(dx, dz);
          let dyaw = desiredYaw - this.yaw;
          while (dyaw > Math.PI) dyaw -= Math.PI * 2;
          while (dyaw < -Math.PI) dyaw += Math.PI * 2;
          this.yaw += dyaw * Math.min(1, dt * 7.5);

          if (b.style === "hop") {
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
      this.orbitAngle += ((b.speed || 4.8) / Math.max(8, b.radius || 16)) * dt;
      const r = b.radius || 16;
      const nx = b.centerX + Math.cos(this.orbitAngle) * r;
      const nz = b.centerZ + Math.sin(this.orbitAngle) * r;
      const dx = nx - this.x;
      const dz = nz - this.z;
      this.x = nx;
      this.z = nz;
      this.y = (b.altitude || 12.5) + Math.sin(t * 1.7) * 0.55;
      if (Math.hypot(dx, dz) > 0.001) {
        this.yaw = Math.atan2(dx, dz);
      }
      rollZ = -0.22;
      this.moveFactor = 1.0;
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

export function createMeadowWorldEngine(canvas, callbacks = {}) {
  const scene = new THREE.Scene();
  scene.background = makeMeadowSkyTexture();

  const w0 = Math.max(320, window.innerWidth);
  const h0 = Math.max(240, window.innerHeight);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
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
    520,
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
  const SHADOW_HALF = 68;
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
  sun.shadow.camera.far = 320;
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

  // Endless Voxel Turf Ground Plane
  const grassUniforms = {
    uTime: { value: 0 },
    uFocusXZ: { value: new THREE.Vector2(0, 0) },
  };
  const groundGeo = new THREE.PlaneGeometry(3600, 3600, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMesh = new THREE.Mesh(groundGeo, buildEndlessGrassMaterial(grassUniforms));
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  // Physical 3D City Contributor Signboard on the central village green
  const citySignboard = createContributorSignboard(maxAniso);
  scene.add(citySignboard.group);

  // Scattered scenic perimeter Meadow Groves
  const perimeterTreesGroup = new THREE.Group();
  scene.add(perimeterTreesGroup);
  const treeProtos = [buildMeadowTreeMesh(0), buildMeadowTreeMesh(1), buildMeadowTreeMesh(2)];
  const bushProtos = [buildMeadowBushMesh(0), buildMeadowBushMesh(1), buildMeadowBushMesh(2)];
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

    if (i % 2 === 0) {
      const bush = bushProtos[i % 3].clone();
      const bAng = ang + 0.05;
      bush.position.set(tx + Math.cos(bAng * 7) * 2.4, 0, tz + Math.sin(bAng * 5) * 2.4);
      bush.rotation.y = (i * 2.3) % (Math.PI * 2);
      perimeterTreesGroup.add(bush);
    }
  }

  const flagstoneProtos = [0, 1, 2].map((variant) => {
    const fv = new Vox(410 + variant * 17);
    const cMain = variant === 0 ? "limestone" : variant === 1 ? "path" : "cream";
    const cEdge = variant === 1 ? "path2" : "concrete";
    fv.box(-2, 0, -2, 2, 1, 2, cMain);
    fv.put(-2, 0, -2, cEdge);
    fv.put(1, 0, 1, cEdge);
    return buildVoxelMesh(fv, { scale: 0.24, castShadow: false, depthLayer: 1 });
  });

  const pathsGroup = new THREE.Group();
  const propsGroup = new THREE.Group();
  const creationsGroup = new THREE.Group();
  const villagersGroup = new THREE.Group();
  scene.add(pathsGroup, propsGroup, creationsGroup, villagersGroup);

  // Highlight Halo for "My Creation" or Selected Creation
  const haloGeo = new THREE.RingGeometry(2.7, 3.15, 48);
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

  // 3D Plot Marker + Live Construction Worksite
  const plotMarker = buildPlotMarkerGroup();
  scene.add(plotMarker.group);

  let spotState = { mode: "hidden", x: 16, z: 10 };
  let liveFeedsById = {};

  const creationEntities = new Map();
  const villagerAgents = new Map();
  let currentWorld = null;
  let highlightedId = null;

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

  function isClientSpotClear(x, z) {
    if (Math.abs(x) > 130 || Math.abs(z) > 130) return false;
    if (Math.hypot(x - CITY_SIGN_POS[0], z - CITY_SIGN_POS[1]) < 5.0) return false;
    if (!currentWorld) return true;
    for (const c of currentWorld.creations || []) {
      const sep = c.category === "building" ? 9.5 : 6.2;
      if (Math.hypot(x - c.x, z - c.z) < sep) return false;
    }
    for (const pr of currentWorld.props || []) {
      if (pr.kind === "pond" && Math.hypot(x - pr.x, z - pr.z) < (pr.radius || 6.5) + 3.8) {
        return false;
      }
    }
    for (const p of currentWorld.paths || []) {
      if (p.kind !== "road" || !p.points) continue;
      for (let i = 0; i < p.points.length; i++) {
        const a = p.points[i];
        const b = p.points[(i + 1) % p.points.length];
        if (!p.closed && i === p.points.length - 1) break;
        if (distToSeg2D(x, z, a[0], a[1], b[0], b[1]) < 5.2) return false;
      }
    }
    return true;
  }

  function snapToClearMeadowSpot(rawX, rawZ) {
    const cx = Math.max(-128, Math.min(128, rawX));
    const cz = Math.max(-128, Math.min(128, rawZ));
    if (isClientSpotClear(cx, cz)) {
      return [Number(cx.toFixed(1)), Number(cz.toFixed(1))];
    }
    for (let r = 2.5; r <= 38; r += 2.2) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const tx = cx + Math.cos(ang) * r;
        const tz = cz + Math.sin(ang) * r;
        if (isClientSpotClear(tx, tz)) {
          return [Number(tx.toFixed(1)), Number(tz.toFixed(1))];
        }
      }
    }
    return [Number(cx.toFixed(1)), Number(cz.toFixed(1))];
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
        name: "Meadow Town Sign",
        description: `${n} ${n === 1 ? "person has" : "people have"} contributed (${total} creations in the world)`,
        behavior: {
          statusLine: `${n} ${n === 1 ? "person has" : "people have"} contributed to Voxel Meadow`,
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
    let bestD = 4.6;
    for (const ent of creationEntities.values()) {
      const d = Math.hypot(ent.x - g[0], ent.z - g[1]);
      if (d < bestD) {
        bestD = d;
        best = ent;
      }
    }
    return best;
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

      if (p.kind === "road") {
        const samples = Math.min(200, Math.max(36, Math.round(len * 1.4)));
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
      } else {
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

    if (world.myCreationId && !highlightedId) {
      highlightedId = world.myCreationId;
    }
  }

  function setSpotPickerState(next) {
    const mode = next?.mode || "hidden";
    let nx = typeof next?.x === "number" ? next.x : spotState.x;
    let nz = typeof next?.z === "number" ? next.z : spotState.z;
    if (mode === "picking" && typeof next?.x !== "number") {
      const def = snapToClearMeadowSpot(cam.goalTx + 14, cam.goalTz + 8);
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
    const next = Math.min(3.4, Math.max(0.42, cam.goalZoom * factor));
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
        const snapped = snapToClearMeadowSpot(g[0], g[1]);
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
            const [sx, sz] = snapToClearMeadowSpot(g[0], g[1]);
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
        focusOn(picked.x, picked.z, 1.55);
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
    focusOn(ent.x, ent.z, 1.65);
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

    // Step all creations & collect active transit vehicles + stationary obstacles for villager avoidance
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
          r: ent.data.scaleClass === "large" ? 5.2 : 3.8,
        });
      }
    }

    // Step all villagers with full personal-space & building avoidance
    const allVillagers = Array.from(villagerAgents.values());
    for (const ag of allVillagers) {
      ag.step(dt, t, activeVehicles, ponds, allVillagers, obstacles);
    }

    if (highlightedId && creationEntities.has(highlightedId)) {
      const myEnt = creationEntities.get(highlightedId);
      selectionHalo.visible = true;
      selectionHalo.position.set(myEnt.x, 0.122, myEnt.z);
      selectionHalo.scale.setScalar(1 + Math.sin(t * 2.5) * 0.05);
    } else {
      selectionHalo.visible = false;
    }

    // Animate 3D plot ring + live construction scaffolding
    if (plotMarker.group.visible) {
      plotMarker.ring.scale.setScalar(1 + Math.sin(t * 3.2) * 0.045);
      if (plotMarker.scaffoldGroup.visible) {
        plotMarker.floatingCubes.forEach((cube, idx) => {
          const ang = t * 2.2 + (idx * Math.PI * 2) / 3;
          cube.position.set(
            Math.cos(ang) * 0.95,
            1.15 + Math.sin(t * 3.8 + idx * 1.4) * 0.38,
            Math.sin(ang) * 0.95,
          );
          cube.rotation.y = t * 1.8 + idx;
          cube.rotation.x = Math.sin(t * 2.1 + idx) * 0.35;
        });
      }
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);

  return {
    applyWorldSnapshot,
    applyLiveFeeds,
    setSpotPickerState,
    focusCreationById,
    focusOn,
    getCameraTarget: () => ({ x: cam.tx, z: cam.tz, zoom: cam.zoom }),
    isPointerActive: () => Boolean(pointerGesture),
    getCreationEntity: (id) => creationEntities.get(id) || null,
  };
}
