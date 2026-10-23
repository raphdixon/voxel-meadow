// Endless Sunlit Grass Voxel World Engine + Pure-White (#FFFFFF) Modal Turntable Preview.
// Features:
//  - Custom sunlit meadow grass shader with drifting cumulus cloud dapple & seamless pastel horizon
//  - Wind-rippling 3D voxel grass tufts, wildflowers & perimeter meadow trees
//  - Camera-tracking texel-snapped 4096^2 PCF golden-hour shadows (zero pan shimmer!)
//  - GTAO real-time contact occlusion + subtle UnrealBloom + ACESFilmic + SMAA
//  - Smooth CatmullRom vehicle routes with bus-stop deceleration, dwell & physical wheel roll
//  - Articulated voxel villagers boarding & alighting buses at different stops

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
import { Vox, buildCreationGroup, buildVoxelMesh, hashCoords } from "./vox.js";

function makeMeadowSkyTexture() {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, "#a8d2f0");
  grad.addColorStop(0.52, "#cfe8f7");
  grad.addColorStop(0.84, "#e6f4e4");
  grad.addColorStop(1.0, "#dceecc");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildEndlessGrassMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: "#7ec858",
    roughness: 0.92,
    metalness: 0.0,
    dithering: true,
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

        float mHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
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
        // Rolling meadow color patches (sunlit golden-lime clover -> rich spring emerald)
        float n1 = mNoise(wp * 0.045);
        float n2 = mNoise(wp * 0.14 + vec2(17.3, -9.1));
        float micro = mNoise(floor(wp * 2.0) * 0.73);
        float pxScale = max(fwidth(wp.x), fwidth(wp.y));
        float grainFade = 1.0 - smoothstep(0.18, 0.75, pxScale);

        vec3 lushDeep = vec3(0.32, 0.62, 0.23);
        vec3 springMid = vec3(0.45, 0.74, 0.29);
        vec3 sunClover = vec3(0.61, 0.84, 0.36);

        vec3 grassCol = mix(lushDeep, springMid, smoothstep(0.22, 0.72, n1));
        grassCol = mix(grassCol, sunClover, smoothstep(0.48, 0.88, n2) * 0.68);
        grassCol *= 1.0 + (micro - 0.5) * 0.07 * grainFade;

        // Soft drifting summer cloud shadows sweeping gently across the endless canvas
        vec2 cloudUv = wp * 0.016 + vec2(uTime * 0.011, uTime * 0.006);
        float cloud = mNoise(cloudUv) * 0.65 + mNoise(cloudUv * 2.1 + 4.2) * 0.35;
        float cloudShadow = mix(0.86, 1.04, smoothstep(0.34, 0.68, cloud));
        grassCol *= cloudShadow;

        // Subtle horizon mist blend far from camera focus so the grass canvas feels truly boundless
        float distFocus = length(wp - uFocusXZ);
        vec3 horizonMist = vec3(0.76, 0.89, 0.73);
        grassCol = mix(grassCol, horizonMist, smoothstep(165.0, 460.0, distFocus) * 0.62);

        diffuseColor.rgb = grassCol;`,
      );
  };
  mat.customProgramCacheKey = () => "endless-meadow-grass-v1";
  return mat;
}

function buildRibbonMesh(curve, sampleCount, halfWidth, yOffset, colorHex, receiveShadow = true) {
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
    polygonOffsetFactor: -1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

function buildMeadowTreeMesh(variant = 0) {
  const v = new Vox(700 + variant * 19);
  // Trunk + roots
  v.box(-1, 0, -1, 2, 1, 2, "woodDark");
  v.box(0, 0, 0, 1, 8, 1, variant % 3 === 1 ? "cream" : "woodDark");
  if (variant % 3 === 0) {
    // Lush Oak
    v.sphere(0.5, 11, 0.5, 4.8, 4.2, 4.8, "leaf");
    v.sphere(2.2, 10, 1.5, 3.0, 2.8, 3.0, "leafLight");
    v.sphere(-1.8, 9.5, -1.2, 3.2, 2.6, 3.2, "leafDark");
  } else if (variant % 3 === 1) {
    // Spring Blossom Birch
    v.sphere(0.5, 11.5, 0.5, 4.2, 4.6, 4.2, "#f29cb8");
    v.sphere(1.8, 10.2, 1.4, 2.8, 2.6, 2.8, "#fbd0df");
  } else {
    // Cypress / Meadow Pine
    v.cone(0.5, 5, 14, 0.5, 4.2, 0.9, "leafDark");
    v.cone(0.5, 9, 17, 0.5, 3.1, 0.6, "leaf");
  }
  return buildVoxelMesh(v, { scale: 0.28 });
}

class CreationSimEntity {
  constructor(creation, index = 0) {
    this.id = creation.id;
    this.data = creation;
    this.group = buildCreationGroup(creation.blueprint, {
      seed: 17 + index * 13,
      useWorldScale: true,
    });

    this.x = creation.x;
    this.y = 0;
    this.z = creation.z;
    this.yaw = creation.yaw || 0;
    this.wheelAngle = 0;
    this.moveFactor = 0;
    this.spawnScale = creation.isSeed ? 1.0 : 0.05;

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

  rebuildBehavior(creation) {
    this.data = creation;
    const b = creation.behavior;
    if (b?.type === "vehicle_route" && Array.isArray(b.waypoints) && b.waypoints.length >= 3) {
      const vecs = b.waypoints.map(([wx, wz]) => new THREE.Vector3(wx, 0, wz));
      this.routeCurve = new THREE.CatmullRomCurve3(vecs, true, "centripetal", 0.5);
      this.routeLength = Math.max(8, this.routeCurve.getLength());
      this.routeDist = this.routeDist % this.routeLength;

      // Map each stop to its closest arc-length position along the closed curve
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

  step(dt, t, allEntities = [], ponds = []) {
    // Springy arrival pop when freshly placed!
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
        // Smooth deceleration as we approach the next stop
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

        // Polite vehicle-to-vehicle spacing & intersection yielding
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
        // Exact wheel angular roll from linear ground distance!
        this.wheelAngle += stepDist / 0.62;
        this.moveFactor = speedScale;
      }

      const u = ((this.routeDist % this.routeLength) + this.routeLength) % this.routeLength / this.routeLength;
      const pos = this.routeCurve.getPointAt(u);
      const tan = this.routeCurve.getTangentAt(u);
      this.x = pos.x;
      this.z = pos.z;
      this.y = 0.07; // Sit cleanly on raised asphalt surface
      this.yaw = Math.atan2(tan.x, tan.z);

      // Starboard curb-side door world coordinates for boarding villagers
      const rightX = -Math.cos(this.yaw);
      const rightZ = Math.sin(this.yaw);
      this.doorX = this.x + rightX * 1.9 + Math.sin(this.yaw) * 0.9;
      this.doorZ = this.z + rightZ * 1.9 + Math.cos(this.yaw) * 0.9;

      // Subtle engine purr when stopped or driving
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
            this.y = 4 * 0.58 * u * (1 - u); // C1 parabolic hop arc
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
      rollZ = Math.sin(t * 2.1) * 0.05;
      pitchX = Math.cos(t * 1.8) * 0.035;
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
      rollZ = -0.22; // Graceful inward bank turn
      this.moveFactor = 1.0;
    } else {
      // Stationary landmark / cottage / monument
      this.y = 0;
      if (typeof b?.facingYaw === "number") {
        this.yaw = b.facingYaw;
      }
      this.moveFactor = 1.0;
    }

    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(pitchX, this.yaw, rollZ);
    const popEase = this.spawnScale < 1 ? 1 - (1 - this.spawnScale) ** 3 : 1;
    this.group.scale.setScalar(popEase);

    this.group.userData.animate?.(t, {
      wheelAngle: this.wheelAngle,
      moveFactor: this.moveFactor,
    });
  }

  dispose() {
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
    1,
    900,
  );

  // Studio Post-Processing (GTAO contact shadows + gentle warm bloom + SMAA)
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

  // Endless Meadow Ground Plane
  const grassUniforms = {
    uTime: { value: 0 },
    uFocusXZ: { value: new THREE.Vector2(0, 0) },
  };
  const groundGeo = new THREE.PlaneGeometry(3600, 3600, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMesh = new THREE.Mesh(groundGeo, buildEndlessGrassMaterial(grassUniforms));
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  // Wind-rippling Instanced 3D Voxel Grass Tufts & Wildflowers around camera view
  const tuftGeo = new THREE.BoxGeometry(0.11, 0.42, 0.11);
  tuftGeo.translate(0, 0.21, 0);
  const tuftMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.0 });
  tuftMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = grassUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 instW = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float breeze = sin(instW.x * 0.18 + uTime * 2.2 + instW.z * 0.13) * 0.16;
        transformed.x += breeze * clamp(position.y * 2.2, 0.0, 1.0);`,
      );
  };
  const TUFT_COUNT = isSoftwareGpu ? 350 : 1100;
  const tuftInst = new THREE.InstancedMesh(tuftGeo, tuftMat, TUFT_COUNT);
  tuftInst.receiveShadow = true;
  scene.add(tuftInst);

  // Scattered scenic perimeter Meadow Trees so scrolling far out discovers cozy groves
  const perimeterTreesGroup = new THREE.Group();
  scene.add(perimeterTreesGroup);
  const treeProtos = [buildMeadowTreeMesh(0), buildMeadowTreeMesh(1), buildMeadowTreeMesh(2)];
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
  }

  // Floating Golden Sunlight Pollen Motes
  const pollenCount = isSoftwareGpu ? 40 : 110;
  const pollenGeo = new THREE.BufferGeometry();
  const pollenPos = new Float32Array(pollenCount * 3);
  for (let i = 0; i < pollenCount; i++) {
    pollenPos[i * 3] = ((i * 73) % 100) - 50;
    pollenPos[i * 3 + 1] = 1.2 + ((i * 29) % 14);
    pollenPos[i * 3 + 2] = ((i * 97) % 100) - 50;
  }
  pollenGeo.setAttribute("position", new THREE.BufferAttribute(pollenPos, 3));
  const pollenPoints = new THREE.Points(
    pollenGeo,
    new THREE.PointsMaterial({
      color: 0xfff0b8,
      size: 2.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  scene.add(pollenPoints);

  // Dynamic World Scene Groups
  const pathsGroup = new THREE.Group();
  const propsGroup = new THREE.Group();
  const creationsGroup = new THREE.Group();
  const villagersGroup = new THREE.Group();
  scene.add(pathsGroup, propsGroup, creationsGroup, villagersGroup);

  // Highlight Halo for "My Creation" or Hovered Creation + Placement Ghost
  const haloGeo = new THREE.RingGeometry(2.7, 3.15, 48);
  haloGeo.rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xfff7c2,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });
  const selectionHalo = new THREE.Mesh(haloGeo, haloMat);
  selectionHalo.position.y = 0.11;
  selectionHalo.visible = false;
  scene.add(selectionHalo);

  let placementGhost = null;
  let placementRing = null;
  let placementBlueprint = null;
  let placementPos = [16, 10];
  let placementYaw = 0;

  // Entity Maps
  const creationEntities = new Map();
  const villagerAgents = new Map();
  let currentWorld = null;
  let highlightedId = null;

  // Camera State (Isometric Diorama Angle with 360 Orbit, Smooth Scroll Pan & Cursor Zoom)
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

  function pickCreationAt(clientX, clientY) {
    const g = screenToGround(clientX, clientY);
    if (!g) return null;
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

  // Repopulate grass tufts cleanly around the current camera focus, avoiding roads & ponds
  let lastGrassCenter = [9999, 9999];
  const dummyObj = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  const grassSwatches = ["#74be50", "#85cf5d", "#66b045", "#94d968", "#f7dc6f", "#f59bb8", "#fcfaf2"];

  function refreshGrassTufts(cx, cz) {
    lastGrassCenter = [cx, cz];
    const span = 56;
    let idx = 0;
    const step = 3.2;
    const baseGX = Math.floor((cx - span) / step);
    const baseGZ = Math.floor((cz - span) / step);
    const countSide = Math.ceil((span * 2) / step);

    for (let ix = 0; ix < countSide && idx < TUFT_COUNT; ix++) {
      for (let iz = 0; iz < countSide && idx < TUFT_COUNT; iz++) {
        const gx = baseGX + ix;
        const gz = baseGZ + iz;
        const h1 = hashCoords(gx, 0, gz, 31);
        if (h1 < 0.28) continue;
        const wx = (gx + (hashCoords(gx, 1, gz, 37) - 0.5) * 0.85) * step;
        const wz = (gz + (hashCoords(gx, 2, gz, 41) - 0.5) * 0.85) * step;

        // Keep tufts off ponds & building centers
        let blocked = false;
        if (currentWorld) {
          for (const pr of currentWorld.props) {
            if (pr.kind === "pond" && Math.hypot(wx - pr.x, wz - pr.z) < (pr.radius || 6.4) + 1.1) {
              blocked = true;
              break;
            }
          }
          if (!blocked) {
            for (const c of currentWorld.creations) {
              if (c.category === "building" && Math.hypot(wx - c.x, wz - c.z) < 4.5) {
                blocked = true;
                break;
              }
            }
          }
        }
        if (blocked) continue;

        const isBlossom = h1 > 0.91;
        dummyObj.position.set(wx, 0, wz);
        dummyObj.rotation.set(0, h1 * Math.PI * 2, 0);
        dummyObj.scale.set(
          isBlossom ? 1.35 : 0.9 + (h1 % 0.4),
          isBlossom ? 0.85 : 0.7 + (h1 % 0.85),
          isBlossom ? 1.35 : 0.9 + (h1 % 0.4),
        );
        dummyObj.updateMatrix();
        tuftInst.setMatrixAt(idx, dummyObj.matrix);

        const swatch = isBlossom
          ? grassSwatches[4 + (Math.abs(gx + gz) % 3)]
          : grassSwatches[Math.abs(gx * 3 + gz) % 4];
        tmpColor.set(swatch);
        tuftInst.setColorAt(idx, tmpColor);
        idx++;
      }
    }

    // Hide unused instances cleanly below ground
    dummyObj.scale.set(0.0001, 0.0001, 0.0001);
    dummyObj.position.set(0, -10, 0);
    dummyObj.updateMatrix();
    while (idx < TUFT_COUNT) {
      tuftInst.setMatrixAt(idx, dummyObj.matrix);
      idx++;
    }
    tuftInst.instanceMatrix.needsUpdate = true;
    if (tuftInst.instanceColor) tuftInst.instanceColor.needsUpdate = true;
  }

  function rebuildPathsAndProps(world) {
    while (pathsGroup.children.length) {
      const ch = pathsGroup.children.pop();
      ch.traverse((o) => {
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
        pathsGroup.add(buildRibbonMesh(curve, samples, 2.48, 0.03, "#d5cdc0"));
        pathsGroup.add(buildRibbonMesh(curve, samples, 2.08, 0.06, "#505560"));

        // Cream dashed road centerline
        const dashCount = Math.floor(len / 3.4);
        const dashGeo = new THREE.BoxGeometry(0.18, 0.02, 1.25);
        const dashMat = new THREE.MeshBasicMaterial({ color: "#f5ebd4" });
        for (let i = 0; i < dashCount; i++) {
          const u = (i + 0.5) / dashCount;
          const pt = curve.getPointAt(u);
          const tan = curve.getTangentAt(u);
          const dash = new THREE.Mesh(dashGeo, dashMat);
          dash.position.set(pt.x, 0.075, pt.z);
          dash.rotation.y = Math.atan2(tan.x, tan.z);
          pathsGroup.add(dash);
        }
      } else {
        // Warm limestone stepping stones along footpath
        const stoneCount = Math.max(3, Math.floor(len / 1.45));
        const stoneGeo = new THREE.CylinderGeometry(0.55, 0.62, 0.09, 8);
        const stoneMat = new THREE.MeshStandardMaterial({ color: "#e8dec6", roughness: 0.88 });
        for (let i = 0; i <= stoneCount; i++) {
          const u = i / stoneCount;
          const pt = curve.getPointAt(u);
          const stone = new THREE.Mesh(stoneGeo, stoneMat);
          stone.position.set(pt.x, 0.04, pt.z);
          stone.rotation.y = i * 0.9;
          stone.scale.set(1 + (i % 2) * 0.15, 1, 0.88 + ((i + 1) % 2) * 0.15);
          stone.receiveShadow = true;
          pathsGroup.add(stone);
        }
      }
    }

    for (const pr of world.props || []) {
      propsGroup.add(buildWorldPropMesh(pr));
    }
  }

  function applyWorldSnapshot(world) {
    currentWorld = world;
    rebuildPathsAndProps(world);

    const seenIds = new Set();
    world.creations.forEach((c, idx) => {
      seenIds.add(c.id);
      const existing = creationEntities.get(c.id);
      if (existing) {
        existing.rebuildBehavior(c);
      } else {
        const ent = new CreationSimEntity(c, idx);
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

    if (world.myCreationId) {
      highlightedId = world.myCreationId;
    }
    refreshGrassTufts(cam.tx, cam.tz);
  }

  // Camera Navigation Gestures (Trackpad 2-finger scroll pan, Pinch/Cmd+Wheel zoom, Drag pan, Right/Alt-drag orbit)
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
      if (placementBlueprint && e.shiftKey) {
        placementYaw += Math.sign(e.deltaY) * 0.25;
        return;
      }
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
    if (placementBlueprint) {
      const g = screenToGround(e.clientX, e.clientY);
      if (g) {
        placementPos = [g[0], g[1]];
      }
    }

    if (!pointerGesture) {
      const hovered = pickCreationAt(e.clientX, e.clientY);
      callbacks.onHoverCreation?.(hovered ? hovered.data : null, e.clientX, e.clientY);
      canvas.style.cursor = placementBlueprint ? "crosshair" : hovered ? "pointer" : "grab";
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
    canvas.style.cursor = placementBlueprint ? "crosshair" : "grab";

    if (wasClick) {
      if (placementBlueprint) {
        const g = screenToGround(e.clientX, e.clientY);
        if (g) {
          callbacks.onConfirmGroundSpot?.(g[0], g[1], placementYaw);
        }
        return;
      }
      const picked = pickCreationAt(e.clientX, e.clientY);
      if (picked) {
        highlightedId = picked.id;
        focusOn(picked.x, picked.z, 1.55);
        callbacks.onSelectCreation?.(picked.data);
      }
    }
  };
  canvas.addEventListener("pointerup", endGesture);
  canvas.addEventListener("pointercancel", endGesture);

  window.addEventListener("keydown", (e) => {
    if (e.target?.matches?.("input, textarea") || document.querySelector("dialog[open]")) return;
    const step = 7 / Math.max(0.5, cam.zoom);
    if (e.key === "ArrowLeft" || e.key === "a") cam.goalTx -= step;
    else if (e.key === "ArrowRight" || e.key === "d") cam.goalTx += step;
    else if (e.key === "ArrowUp" || e.key === "w") cam.goalTz -= step;
    else if (e.key === "ArrowDown" || e.key === "s") cam.goalTz += step;
    else if (e.key === "r" && placementBlueprint) placementYaw += Math.PI / 4;
    clampTarget();
  });

  function setPlacementBlueprint(blueprint) {
    if (placementGhost) {
      scene.remove(placementGhost);
      placementGhost.userData.dispose?.();
      placementGhost = null;
    }
    if (placementRing) {
      scene.remove(placementRing);
      placementRing.geometry.dispose();
      placementRing.material.dispose();
      placementRing = null;
    }
    placementBlueprint = blueprint;
    if (!blueprint) {
      canvas.style.cursor = "grab";
      return;
    }
    placementYaw = 0;
    placementPos = [cam.goalTx + 6, cam.goalTz + 6];
    placementGhost = buildCreationGroup(blueprint, { ghost: true, useWorldScale: true });
    scene.add(placementGhost);

    const rGeo = new THREE.RingGeometry(2.5, 3.0, 48);
    rGeo.rotateX(-Math.PI / 2);
    const rMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    placementRing = new THREE.Mesh(rGeo, rMat);
    placementRing.position.y = 0.1;
    scene.add(placementRing);
    canvas.style.cursor = "crosshair";
  }

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

  // Update sun shadow camera snapped to world shadow texels to eliminate shimmer when scrolling!
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

  // Main 60fps Animation Loop
  let lastNow = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000));
    lastNow = now;
    const t = now * 0.001;

    grassUniforms.uTime.value = t;

    // Smoothly damp camera pan/zoom/orbit
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

    if (Math.hypot(cam.tx - lastGrassCenter[0], cam.tz - lastGrassCenter[1]) > 7.5) {
      refreshGrassTufts(cam.tx, cam.tz);
    }

    // Drift sunlight pollen gently around camera target
    const pArr = pollenGeo.attributes.position.array;
    for (let i = 0; i < pollenCount; i++) {
      const idx = i * 3;
      pArr[idx + 1] = 1.2 + ((t * 0.35 + i * 1.7) % 12);
      const relX = ((((i * 73) % 90) - 45 + Math.sin(t * 0.5 + i) * 3) % 90);
      const relZ = ((((i * 97) % 90) - 45 + Math.cos(t * 0.4 + i) * 3) % 90);
      pArr[idx] = cam.tx + relX;
      pArr[idx + 2] = cam.tz + relZ;
    }
    pollenGeo.attributes.position.needsUpdate = true;

    // Step all creations & collect active transit vehicles for villager boarding
    const allEnts = Array.from(creationEntities.values());
    const ponds = (currentWorld?.props || []).filter((p) => p.kind === "pond");
    const activeVehicles = [];
    for (const ent of allEnts) {
      ent.step(dt, t, allEnts, ponds);
      if (ent.data.behavior?.type === "vehicle_route") {
        activeVehicles.push(ent);
      }
    }

    // Step all villagers
    for (const ag of villagerAgents.values()) {
      ag.step(dt, t, activeVehicles, ponds);
    }

    // Update subtle halo under visitor's own creation
    if (highlightedId && creationEntities.has(highlightedId)) {
      const myEnt = creationEntities.get(highlightedId);
      selectionHalo.visible = true;
      selectionHalo.position.set(myEnt.x, 0.1, myEnt.z);
      selectionHalo.scale.setScalar(1 + Math.sin(t * 2.5) * 0.05);
    } else {
      selectionHalo.visible = false;
    }

    // Update ghost preview during interactive spot picking
    if (placementGhost && placementRing) {
      placementGhost.position.set(placementPos[0], 0.15 + Math.sin(t * 3.2) * 0.12, placementPos[1]);
      placementGhost.rotation.y = placementYaw;
      placementGhost.userData.animate?.(t);
      placementRing.position.set(placementPos[0], 0.1, placementPos[1]);
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);

  return {
    applyWorldSnapshot,
    setPlacementBlueprint,
    focusCreationById,
    focusOn,
    getCreationEntity: (id) => creationEntities.get(id) || null,
  };
}

/**
 * Pure White (#FFFFFF) Studio 3D Turntable Renderer inside the Creation Modal.
 */
export function createWhitePreviewStage(canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#ffffff");

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const camera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.5, 120);

  const keyLight = new THREE.DirectionalLight(0xfff8eb, 2.15);
  keyLight.position.set(16, 26, 20);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -10;
  keyLight.shadow.camera.right = 10;
  keyLight.shadow.camera.top = 10;
  keyLight.shadow.camera.bottom = -10;
  keyLight.shadow.bias = -0.0005;
  scene.add(keyLight);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xeaeef5, 1.35));

  // Shadow-only floor so background remains pure #FFFFFF while grounded shadow anchors the sculpture!
  const floorGeo = new THREE.PlaneGeometry(40, 40);
  floorGeo.rotateX(-Math.PI / 2);
  const floorMat = new THREE.ShadowMaterial({ opacity: 0.13 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.receiveShadow = true;
  scene.add(floor);

  const turntable = new THREE.Group();
  scene.add(turntable);

  let modelGroup = null;
  let active = false;
  let userYaw = 0.55;
  let dragging = false;
  let lastX = 0;
  let frustumHalf = 5.2;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    userYaw += (e.clientX - lastX) * 0.012;
    lastX = e.clientX;
  });
  canvas.addEventListener("pointerup", () => {
    dragging = false;
  });

  function syncSize() {
    const w = Math.max(220, canvas.clientWidth || 380);
    const h = Math.max(180, canvas.clientHeight || 250);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.left = -frustumHalf * aspect;
    camera.right = frustumHalf * aspect;
    camera.top = frustumHalf;
    camera.bottom = -frustumHalf;
    camera.updateProjectionMatrix();
  }

  function showBlueprint(blueprint) {
    if (modelGroup) {
      turntable.remove(modelGroup);
      modelGroup.userData.dispose?.();
      modelGroup = null;
    }
    if (!blueprint) {
      active = false;
      return;
    }
    modelGroup = buildCreationGroup(blueprint, { seed: 29, useWorldScale: false });
    turntable.add(modelGroup);

    const box = new THREE.Box3().setFromObject(modelGroup);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    modelGroup.position.x = -center.x;
    modelGroup.position.z = -center.z;

    const maxDim = Math.max(size.x, size.y, size.z, 2.5);
    frustumHalf = maxDim * 0.68;
    camera.position.set(18, 14, 18);
    camera.lookAt(0, size.y * 0.44, 0);
    syncSize();
    active = true;
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (!active || !modelGroup) return;
    const t = now * 0.001;
    if (!dragging) {
      userYaw += 0.0065;
    }
    turntable.rotation.y = userYaw;
    modelGroup.userData.animate?.(t, { wheelAngle: t * 2.6, moveFactor: 1.0 });
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
  window.addEventListener("resize", () => {
    if (active) syncSize();
  });

  return { showBlueprint, syncSize };
}
