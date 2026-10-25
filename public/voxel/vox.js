// Micro-Voxel CSG Compiler, 4-Corner Baked AO Mesher, and 3D Chamfered Bevel Shader.
// Exact client-side counterpart to src/voxel_dsl.ts.

import * as THREE from "../vendor/three-bundle.js";

export const VOXEL_UNIT = 0.25;
export const SCALE_FACTORS = {
  tiny: 0.4,
  small: 0.56,
  medium: 0.92,
  large: 1.14,
  colossal: 1.72,
};

export function getWorldVoxelSize(scaleClass) {
  return VOXEL_UNIT * (SCALE_FACTORS[scaleClass] || SCALE_FACTORS.medium);
}

export function getCreationFootprintRadius(scaleClass, footprintX = 14, footprintZ = 14) {
  const voxSize = getWorldVoxelSize(scaleClass);
  const maxSpan = Math.max(4, footprintX || 14, footprintZ || 14);
  const minSpan = Math.max(4, Math.min(footprintX || 14, footprintZ || 14));
  const effectiveHalfSpan = (maxSpan * 0.72 + minSpan * 0.28) * 0.5 * voxSize;
  const minR =
    scaleClass === "colossal"
      ? 7.2
      : scaleClass === "large"
        ? 3.8
        : scaleClass === "medium"
          ? 2.6
          : scaleClass === "small"
            ? 1.7
            : 1.05;
  return Number(Math.max(minR, Math.min(14.5, effectiveHalfSpan + 0.35)).toFixed(2));
}

export const PALETTE = {
  grass: "#86c864",
  grass2: "#78ba57",
  grass3: "#97d675",
  soil: "#8b5e3c",
  soilDark: "#70492c",
  path: "#e6d6b5",
  path2: "#d8c6a1",
  concrete: "#dcd6cb",
  concrete2: "#cfcac0",
  concreteDark: "#b4afa5",
  asphalt: "#585b63",
  slate: "#434854",
  slateLight: "#656d7d",
  brick: "#cc7a57",
  brick2: "#b96947",
  brickDark: "#945036",
  mortar: "#e5cbb0",
  plaster: "#f2eadb",
  cream: "#faf3e3",
  limestone: "#e8dfc8",
  marble: "#f5f2ec",
  marbleShade: "#e1ddd4",
  granite: "#7a7e85",
  wood: "#c9935b",
  woodLight: "#deb07c",
  woodDark: "#8f5e36",
  oak: "#a87444",
  crate: "#d4a366",
  leather: "#6e4328",
  terracotta: "#c86d49",
  steel: "#8c99a6",
  steelLight: "#b4c0cc",
  steelDark: "#59636e",
  iron: "#3b4048",
  chrome: "#d8e2eb",
  brass: "#d9a74a",
  gold: "#f4c44e",
  goldDark: "#c79428",
  copper: "#c8754b",
  hazard: "#f2be38",
  red: "#df5246",
  redDark: "#a8342b",
  crimson: "#be3438",
  orange: "#ec8438",
  amber: "#ffb642",
  yellow: "#f6d55c",
  busYellow: "#f5b82e",
  lime: "#96d65f",
  leaf: "#58ad52",
  leafDark: "#3e853b",
  leafLight: "#78c86c",
  teal: "#47b0a3",
  tealDark: "#2d7d74",
  cyan: "#5ce6db",
  sky: "#6fb7f0",
  water: "#4fa8de",
  blue: "#4c82d4",
  blueDark: "#2f5696",
  indigo: "#5b63b8",
  purple: "#9370cf",
  purpleDark: "#65469c",
  pink: "#ec8db0",
  magenta: "#d95ca3",
  white: "#fcfaf5",
  silver: "#c5ccd4",
  charcoal: "#262930",
  rubber: "#23252b",
  black: "#181a20",
  glass: "#b8e4f2",
  warmGlow: "#ffe29a",
  screenCyan: "#64f5df",
  screenGreen: "#5ef28c",
  fire: "#ff7426",
  lava: "#ff5a1f",
  basalt: "#363840",
  ash: "#6c6e75",
  sand: "#ead39c",
  moss: "#4b9645",
  snow: "#f3f7fc",
};

const AO_LEVELS = [0.22, 0.48, 0.76, 1.0];

const FACES = [
  {
    n: [1, 0, 0],
    corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
    aoDirs: [
      [[1, -1, 0], [1, 0, 1], [1, -1, 1]],
      [[1, -1, 0], [1, 0, -1], [1, -1, -1]],
      [[1, 1, 0], [1, 0, -1], [1, 1, -1]],
      [[1, 1, 0], [1, 0, 1], [1, 1, 1]],
    ],
  },
  {
    n: [-1, 0, 0],
    corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    aoDirs: [
      [[-1, -1, 0], [-1, 0, -1], [-1, -1, -1]],
      [[-1, -1, 0], [-1, 0, 1], [-1, -1, 1]],
      [[-1, 1, 0], [-1, 0, 1], [-1, 1, 1]],
      [[-1, 1, 0], [-1, 0, -1], [-1, 1, -1]],
    ],
  },
  {
    n: [0, 1, 0],
    corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
    aoDirs: [
      [[-1, 1, 0], [0, 1, 1], [-1, 1, 1]],
      [[1, 1, 0], [0, 1, 1], [1, 1, 1]],
      [[1, 1, 0], [0, 1, -1], [1, 1, -1]],
      [[-1, 1, 0], [0, 1, -1], [-1, 1, -1]],
    ],
  },
  {
    n: [0, -1, 0],
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    aoDirs: [
      [[-1, -1, 0], [0, -1, -1], [-1, -1, -1]],
      [[1, -1, 0], [0, -1, -1], [1, -1, -1]],
      [[1, -1, 0], [0, -1, 1], [1, -1, 1]],
      [[-1, -1, 0], [0, -1, 1], [-1, -1, 1]],
    ],
  },
  {
    n: [0, 0, 1],
    corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    aoDirs: [
      [[-1, 0, 1], [0, -1, 1], [-1, -1, 1]],
      [[1, 0, 1], [0, -1, 1], [1, -1, 1]],
      [[1, 0, 1], [0, 1, 1], [1, 1, 1]],
      [[-1, 0, 1], [0, 1, 1], [-1, 1, 1]],
    ],
  },
  {
    n: [0, 0, -1],
    corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
    aoDirs: [
      [[1, 0, -1], [0, -1, -1], [1, -1, -1]],
      [[-1, 0, -1], [0, -1, -1], [-1, -1, -1]],
      [[-1, 0, -1], [0, 1, -1], [-1, 1, -1]],
      [[1, 0, -1], [0, 1, -1], [1, 1, -1]],
    ],
  },
];

const QUAD_UVS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

const rgbCache = new Map();
export function parseColorLinear(hexOrName) {
  const safeName = typeof hexOrName === "string" ? hexOrName : "";
  const key = (Object.hasOwn(PALETTE, safeName) ? PALETTE[safeName] : safeName) || "#eae4d7";
  let cached = rgbCache.get(key);
  if (!cached) {
    const c = new THREE.Color();
    try {
      c.set(key);
    } catch {
      c.set("#eae4d7");
    }
    const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    const sat = 1.14;
    cached = [
      Math.max(0, Math.min(1, lum + (c.r - lum) * sat)),
      Math.max(0, Math.min(1, lum + (c.g - lum) * sat)),
      Math.max(0, Math.min(1, lum + (c.b - lum) * sat)),
    ];
    rgbCache.set(key, cached);
  }
  return cached;
}

export function hashCoords(x, y, z, seed = 1) {
  let n =
    Math.imul(x | 0, 73856093) ^
    Math.imul(y | 0, 19349663) ^
    Math.imul(z | 0, 83492791) ^
    Math.imul(seed | 0, 2654435761);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

const keyOf = (x, y, z) => `${x | 0},${y | 0},${z | 0}`;

export class Vox {
  constructor(seed = 1) {
    this.v = new Map();
    this.seed = seed;
  }

  get size() {
    return this.v.size;
  }

  resolveColor(color, x, y, z) {
    const raw = typeof color === "function" ? color(x, y, z) : color;
    if (!raw) return null;
    return PALETTE[raw] || raw;
  }

  put(x, y, z, color, emit = 0) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    const zi = Math.round(z);
    const col = this.resolveColor(color, xi, yi, zi);
    const k = keyOf(xi, yi, zi);
    if (!col) this.v.delete(k);
    else this.v.set(k, { x: xi, y: yi, z: zi, color: col, emit: Number(emit) || 0 });
    return this;
  }

  box(x0, y0, z0, x1, y1, z1, color, emit = 0) {
    const ax0 = Math.round(Math.min(x0, x1)), ax1 = Math.round(Math.max(x0, x1));
    const ay0 = Math.round(Math.min(y0, y1)), ay1 = Math.round(Math.max(y0, y1));
    const az0 = Math.round(Math.min(z0, z1)), az1 = Math.round(Math.max(z0, z1));
    for (let x = ax0; x < ax1; x++) {
      for (let y = ay0; y < ay1; y++) {
        for (let z = az0; z < az1; z++) {
          this.put(x, y, z, color, emit);
        }
      }
    }
    return this;
  }

  roundedBox(x0, y0, z0, x1, y1, z1, radius, color, emit = 0) {
    const ax0 = Math.round(Math.min(x0, x1)), ax1 = Math.round(Math.max(x0, x1));
    const ay0 = Math.round(Math.min(y0, y1)), ay1 = Math.round(Math.max(y0, y1));
    const az0 = Math.round(Math.min(z0, z1)), az1 = Math.round(Math.max(z0, z1));
    const r = Math.max(0.5, Math.min(radius, (ax1 - ax0) / 2, (ay1 - ay0) / 2, (az1 - az0) / 2));
    const ix0 = ax0 + r, ix1 = ax1 - r;
    const iy0 = ay0 + r, iy1 = ay1 - r;
    const iz0 = az0 + r, iz1 = az1 - r;
    const r2 = (r + 0.15) * (r + 0.15);
    for (let x = ax0; x < ax1; x++) {
      const px = x + 0.5;
      const dx = px < ix0 ? ix0 - px : px > ix1 ? px - ix1 : 0;
      for (let y = ay0; y < ay1; y++) {
        const py = y + 0.5;
        const dy = py < iy0 ? iy0 - py : py > iy1 ? py - iy1 : 0;
        for (let z = az0; z < az1; z++) {
          const pz = z + 0.5;
          const dz = pz < iz0 ? iz0 - pz : pz > iz1 ? pz - iz1 : 0;
          if (dx * dx + dy * dy + dz * dz <= r2) {
            this.put(x, y, z, color, emit);
          }
        }
      }
    }
    return this;
  }

  clear(x0, y0, z0, x1, y1, z1) {
    return this.box(x0, y0, z0, x1, y1, z1, null);
  }

  pillars(x0, y0, z0, x1, y1, z1, color) {
    const ax0 = Math.round(Math.min(x0, x1)), ax1 = Math.round(Math.max(x0, x1));
    const az0 = Math.round(Math.min(z0, z1)), az1 = Math.round(Math.max(z0, z1));
    for (const px of [ax0, ax1 - 1]) {
      for (const pz of [az0, az1 - 1]) {
        this.box(px, y0, pz, px + 1, y1, pz + 1, color);
      }
    }
    return this;
  }

  hollowBox(x0, y0, z0, x1, y1, z1, wall = 1, color = "plaster", trim = null) {
    const ax0 = Math.round(Math.min(x0, x1)), ax1 = Math.round(Math.max(x0, x1));
    const ay0 = Math.round(Math.min(y0, y1)), ay1 = Math.round(Math.max(y0, y1));
    const az0 = Math.round(Math.min(z0, z1)), az1 = Math.round(Math.max(z0, z1));
    this.box(ax0, ay0, az0, ax1, ay1, az1, color);
    if (ax1 - ax0 > wall * 2 && az1 - az0 > wall * 2 && ay1 - ay0 > wall) {
      this.clear(ax0 + wall, ay0 + wall, az0 + wall, ax1 - wall, ay1, az1 - wall);
    }
    if (trim) {
      this.pillars(ax0, ay0, az0, ax1, ay1, az1, trim);
      this.box(ax0, ay1 - 1, az0, ax1, ay1, az0 + 1, trim);
      this.box(ax0, ay1 - 1, az1 - 1, ax1, ay1, az1, trim);
      this.box(ax0, ay1 - 1, az0, ax0 + 1, ay1, az1, trim);
      this.box(ax1 - 1, ay1 - 1, az0, ax1, ay1, az1, trim);
    }
    return this;
  }

  plinth(sizeX = 16, heightY = 2, sizeZ = 16, baseCol = "concrete2", topCol = "limestone", cornerCol = "brass") {
    const hx = Math.floor(sizeX / 2), hz = Math.floor(sizeZ / 2);
    this.box(-hx - 1, 0, -hz - 1, hx + 1, 1, hz + 1, baseCol);
    if (heightY >= 2) {
      this.box(-hx, 1, -hz, hx, heightY, hz, topCol);
      for (const [cx, cz] of [[-hx, -hz], [hx - 1, -hz], [-hx, hz - 1], [hx - 1, hz - 1]]) {
        this.put(cx, heightY - 1, cz, cornerCol);
      }
    }
    return this;
  }

  cylinderAxis(axis, c1, c2, s0, s1, radius, color, emit = 0) {
    const ri = Math.ceil(Math.max(0.5, radius)) + 1;
    const as0 = Math.round(Math.min(s0, s1));
    const as1 = Math.max(as0 + 1, Math.round(Math.max(s0, s1)));
    const r2 = radius * radius + 0.18;
    for (let u = Math.floor(c1 - ri); u <= Math.ceil(c1 + ri); u++) {
      for (let v = Math.floor(c2 - ri); v <= Math.ceil(c2 + ri); v++) {
        if ((u + 0.5 - c1) ** 2 + (v + 0.5 - c2) ** 2 <= r2) {
          for (let s = as0; s < as1; s++) {
            if (axis === "y") this.put(u, s, v, color, emit);
            else if (axis === "x") this.put(s, u, v, color, emit);
            else this.put(u, v, s, color, emit);
          }
        }
      }
    }
    return this;
  }

  ringAxis(axis, c1, c2, s0, s1, outerR, innerR, color, emit = 0) {
    const ri = Math.ceil(Math.max(0.5, outerR)) + 1;
    const as0 = Math.round(Math.min(s0, s1));
    const as1 = Math.max(as0 + 1, Math.round(Math.max(s0, s1)));
    const o2 = outerR * outerR + 0.18;
    const i2 = innerR * innerR;
    for (let u = Math.floor(c1 - ri); u <= Math.ceil(c1 + ri); u++) {
      for (let v = Math.floor(c2 - ri); v <= Math.ceil(c2 + ri); v++) {
        const d2 = (u + 0.5 - c1) ** 2 + (v + 0.5 - c2) ** 2;
        if (d2 <= o2 && d2 >= i2) {
          for (let s = as0; s < as1; s++) {
            if (axis === "y") this.put(u, s, v, color, emit);
            else if (axis === "x") this.put(s, u, v, color, emit);
            else this.put(u, v, s, color, emit);
          }
        }
      }
    }
    return this;
  }

  cone(cx, y0, y1, cz, rBottom, rTop, color, emit = 0) {
    const ay0 = Math.round(Math.min(y0, y1)), ay1 = Math.max(ay0 + 1, Math.round(Math.max(y0, y1)));
    const span = Math.max(1, ay1 - ay0);
    for (let y = ay0; y < ay1; y++) {
      const t = (y - ay0) / span;
      const r = rBottom + (rTop - rBottom) * t;
      this.cylinderAxis("y", cx, cz, y, y + 1, Math.max(0.45, r), color, emit);
    }
    return this;
  }

  sphere(cx, cy, cz, rx, ry = rx, rz = rx, color = "leaf", emit = 0) {
    const arx = Math.max(0.5, rx), ary = Math.max(0.5, ry), arz = Math.max(0.5, rz);
    for (let x = Math.floor(cx - arx) - 1; x <= Math.ceil(cx + arx) + 1; x++) {
      for (let y = Math.floor(cy - ary) - 1; y <= Math.ceil(cy + ary) + 1; y++) {
        for (let z = Math.floor(cz - arz) - 1; z <= Math.ceil(cz + arz) + 1; z++) {
          const d = ((x + 0.5 - cx) / arx) ** 2 + ((y + 0.5 - cy) / ary) ** 2 + ((z + 0.5 - cz) / arz) ** 2;
          if (d <= 1.0) this.put(x, y, z, color, emit);
        }
      }
    }
    return this;
  }

  dome(cx, yBase, cz, radius, color, emit = 0) {
    const r = Math.max(0.5, radius);
    const yb = Math.round(yBase);
    for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
      for (let y = yb; y <= Math.ceil(yb + r) + 1; y++) {
        for (let z = Math.floor(cz - r) - 1; z <= Math.ceil(cz + r) + 1; z++) {
          const d = ((x + 0.5 - cx) / r) ** 2 + ((y + 0.5 - yb) / r) ** 2 + ((z + 0.5 - cz) / r) ** 2;
          if (d <= 1.0) this.put(x, y, z, color, emit);
        }
      }
    }
    return this;
  }

  roofGable(x0, yBase, z0, x1, z1, rise = 4, axis = "x", roofCol = "terracotta", trimCol = "cream") {
    const ax0 = Math.round(Math.min(x0, x1)), ax1 = Math.round(Math.max(x0, x1));
    const az0 = Math.round(Math.min(z0, z1)), az1 = Math.round(Math.max(z0, z1));
    for (let step = 0; step < rise; step++) {
      if (axis === "x") {
        if (az0 + step >= az1 - step) break;
        this.box(ax0, yBase + step, az0 + step, ax1, yBase + step + 1, az1 - step, roofCol);
        if (trimCol) {
          this.box(ax0, yBase + step, az0 + step, ax0 + 1, yBase + step + 1, az1 - step, trimCol);
          this.box(ax1 - 1, yBase + step, az0 + step, ax1, yBase + step + 1, az1 - step, trimCol);
        }
      } else {
        if (ax0 + step >= ax1 - step) break;
        this.box(ax0 + step, yBase + step, az0, ax1 - step, yBase + step + 1, az1, roofCol);
        if (trimCol) {
          this.box(ax0 + step, yBase + step, az0, ax1 - step, yBase + step + 1, az0 + 1, trimCol);
          this.box(ax0 + step, yBase + step, az1 - 1, ax1 - step, yBase + step + 1, az1, trimCol);
        }
      }
    }
    return this;
  }

  roofPyramid(x0, yBase, z0, x1, z1, roofCol = "slate", trimCol = "gold") {
    const ax0 = Math.round(Math.min(x0, x1)), ax1 = Math.round(Math.max(x0, x1));
    const az0 = Math.round(Math.min(z0, z1)), az1 = Math.round(Math.max(z0, z1));
    for (let s = 0; ax0 + s < ax1 - s && az0 + s < az1 - s; s++) {
      this.box(ax0 + s, yBase + s, az0 + s, ax1 - s, yBase + s + 1, az1 - s, s === 0 && trimCol ? trimCol : roofCol);
    }
    return this;
  }

  stairs(x0, y0, z0, steps, width, dir = "+z", color = "limestone") {
    for (let i = 0; i < steps; i++) {
      if (dir === "+z") this.box(x0, y0, z0 + i, x0 + width, y0 + steps - i, z0 + i + 1, color);
      else if (dir === "-z") this.box(x0, y0, z0 - i, x0 + width, y0 + steps - i, z0 - i + 1, color);
      else if (dir === "+x") this.box(x0 + i, y0, z0, x0 + i + 1, y0 + steps - i, z0 + width, color);
      else this.box(x0 - i, y0, z0, x0 - i + 1, y0 + steps - i, z0 + width, color);
    }
    return this;
  }

  arch(cx, y0, cz, halfSpan = 3, height = 6, depth = 2, axis = "z", color = "brick") {
    for (let u = -halfSpan; u <= halfSpan; u++) {
      const archTop = y0 + height - Math.round((u / Math.max(1, halfSpan)) ** 2 * 2);
      for (let y = y0; y <= archTop; y++) {
        const isPillar = Math.abs(u) >= halfSpan - 1;
        const isCrown = y >= archTop - 1;
        if (!isPillar && !isCrown) continue;
        if (axis === "z") this.box(cx + u, y, cz, cx + u + 1, y + 1, cz + depth, color);
        else this.box(cx, y, cz + u, cx + depth, y + 1, cz + u + 1, color);
      }
    }
    return this;
  }

  line(x0, y0, z0, x1, y1, z1, radius = 0, color = "steel", emit = 0) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) * 1.6));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + dx * t, py = y0 + dy * t, pz = z0 + dz * t;
      if (radius <= 0.5) this.put(Math.floor(px), Math.floor(py), Math.floor(pz), color, emit);
      else this.sphere(px, py, pz, radius, radius, radius, color, emit);
    }
    return this;
  }

  bounds() {
    if (!this.v.size) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0, count: 0 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of this.v.values()) {
      if (p.x < minX) minX = p.x;
      if (p.x + 1 > maxX) maxX = p.x + 1;
      if (p.y < minY) minY = p.y;
      if (p.y + 1 > maxY) maxY = p.y + 1;
      if (p.z < minZ) minZ = p.z;
      if (p.z + 1 > maxZ) maxZ = p.z + 1;
    }
    return { minX, maxX, minY, maxY, minZ, maxZ, count: this.v.size };
  }
}

export function mirrorOpX(op) {
  switch (op.op) {
    case "box":
    case "roundedBox":
    case "clear":
      return { ...op, x0: -op.x1, x1: -op.x0, mirrorX: false };
    case "cylinder":
    case "ring": {
      const axis = op.axis ?? "y";
      if (axis === "x") {
        const s0 = op.x0 ?? -2, s1 = op.x1 ?? 2;
        return { ...op, x0: -s1, x1: -s0, mirrorX: false };
      }
      return { ...op, cx: -(op.cx ?? 0), mirrorX: false };
    }
    case "cone":
    case "sphere":
    case "dome":
      return { ...op, cx: -op.cx, mirrorX: false };
    case "line":
      return { ...op, x0: -op.x0, x1: -op.x1, mirrorX: false };
    case "voxels":
      return { ...op, list: (op.list || []).map(([x, y, z, c, e]) => [-(x + 1), y, z, c, e]), mirrorX: false };
    default:
      return null;
  }
}

export function applyOps(vox, ops = [], customPalette = {}) {
  const col = (c) =>
    (typeof c === "string" && customPalette && Object.hasOwn(customPalette, c) ? customPalette[c] : undefined) ||
    (typeof c === "string" && Object.hasOwn(PALETTE, c) ? PALETTE[c] : undefined) ||
    c;
  const runOne = (op) => {
    if (!op || typeof op !== "object") return;
    const emit = Number(op.emit) || 0;
    switch (op.op) {
      case "plinth":
        vox.plinth(op.sizeX ?? 16, op.heightY ?? 2, op.sizeZ ?? 16, col(op.base ?? "concrete2"), col(op.top ?? "limestone"), col(op.corner ?? "brass"));
        break;
      case "box":
        vox.box(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1, col(op.color), emit);
        break;
      case "roundedBox":
        vox.roundedBox(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1, op.radius ?? 1.5, col(op.color), emit);
        break;
      case "clear":
        vox.clear(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1);
        break;
      case "hollowBox":
        vox.hollowBox(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1, op.wall ?? 1, col(op.color), op.trim ? col(op.trim) : null);
        break;
      case "pillars":
        vox.pillars(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1, col(op.color));
        break;
      case "cylinder": {
        const axis = op.axis ?? "y";
        if (axis === "x") vox.cylinderAxis("x", op.cy ?? 0, op.cz ?? 0, op.x0 ?? -2, op.x1 ?? 2, op.radius ?? 2.5, col(op.color), emit);
        else if (axis === "z") vox.cylinderAxis("z", op.cx ?? 0, op.cy ?? 2, op.z0 ?? -2, op.z1 ?? 2, op.radius ?? 2.5, col(op.color), emit);
        else vox.cylinderAxis("y", op.cx ?? 0, op.cz ?? 0, op.y0 ?? 0, op.y1 ?? 6, op.radius ?? 2.5, col(op.color), emit);
        break;
      }
      case "ring": {
        const axis = op.axis ?? "y";
        if (axis === "x") vox.ringAxis("x", op.cy ?? 0, op.cz ?? 0, op.x0 ?? -2, op.x1 ?? 2, op.outerR ?? 3, op.innerR ?? 1.6, col(op.color), emit);
        else if (axis === "z") vox.ringAxis("z", op.cx ?? 0, op.cy ?? 2, op.z0 ?? -2, op.z1 ?? 2, op.outerR ?? 3, op.innerR ?? 1.6, col(op.color), emit);
        else vox.ringAxis("y", op.cx ?? 0, op.cz ?? 0, op.y0 ?? 0, op.y1 ?? 2, op.outerR ?? 3, op.innerR ?? 1.6, col(op.color), emit);
        break;
      }
      case "cone":
        vox.cone(op.cx, op.y0, op.y1, op.cz, op.rBottom, op.rTop ?? 0.5, col(op.color), emit);
        break;
      case "sphere":
        vox.sphere(op.cx, op.cy, op.cz, op.rx, op.ry ?? op.rx, op.rz ?? op.rx, col(op.color), emit);
        break;
      case "dome":
        vox.dome(op.cx, op.yBase, op.cz, op.radius, col(op.color), emit);
        break;
      case "roofGable":
        vox.roofGable(op.x0, op.yBase, op.z0, op.x1, op.z1, op.rise ?? 4, op.axis ?? "x", col(op.color ?? "terracotta"), op.trim ? col(op.trim) : null);
        break;
      case "roofPyramid":
        vox.roofPyramid(op.x0, op.yBase, op.z0, op.x1, op.z1, col(op.color ?? "slate"), op.trim ? col(op.trim) : null);
        break;
      case "stairs":
        vox.stairs(op.x0, op.y0, op.z0, op.steps ?? 2, op.width ?? 4, op.dir ?? "+z", col(op.color ?? "limestone"));
        break;
      case "arch":
        vox.arch(op.cx, op.y0, op.cz, op.halfSpan ?? 3, op.height ?? 6, op.depth ?? 2, op.axis ?? "z", col(op.color ?? "brick"));
        break;
      case "line":
        vox.line(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1, op.radius ?? 0, col(op.color ?? "steel"), emit);
        break;
      case "voxels":
        for (const v of op.list || []) {
          vox.put(v[0], v[1], v[2], col(v[3]), v[4] || 0);
        }
        break;
    }
  };

  for (const op of ops) {
    runOne(op);
    if (op?.mirrorX) {
      const m = mirrorOpX(op);
      if (m) runOne(m);
    }
  }
  return vox;
}

const voxelLayerMaterials = new Map();

function createVoxelStandardMaterial(layerIndex = 0) {
  const layer = Math.max(0, Math.min(7, layerIndex | 0));
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.06,
    dithering: true,
    ...(layer > 0
      ? {
          polygonOffset: true,
          polygonOffsetFactor: -layer,
          polygonOffsetUnits: -layer * 1.5,
        }
      : {}),
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float aEmit;
        varying float vEmit;
        varying vec2 vVoxUv;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vEmit = aEmit;
        vVoxUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vEmit;
        varying vec2 vVoxUv;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float voxPx = max(fwidth(vVoxUv.x), fwidth(vVoxUv.y));
        float voxDetail = 1.0 - smoothstep(0.04, 0.14, voxPx);
        float edgeDist = min(min(vVoxUv.x, 1.0 - vVoxUv.x), min(vVoxUv.y, 1.0 - vVoxUv.y));
        float seam = smoothstep(0.0, max(0.085, voxPx * 1.45), edgeDist);
        float hi = smoothstep(0.14, 0.02, edgeDist) * (vVoxUv.y * 0.6 + 0.4);
        diffuseColor.rgb *= mix(1.0 - 0.22 * voxDetail, 1.0, seam);
        diffuseColor.rgb += hi * 0.05 * voxDetail;
        if (vEmit > 0.05) {
          diffuseColor.rgb *= 0.48;
        }`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        vec3 dPosX = dFdx(vViewPosition);
        vec3 dPosY = dFdy(vViewPosition);
        vec2 dUvX = dFdx(vVoxUv);
        vec2 dUvY = dFdy(vVoxUv);
        float bevW = 0.115;
        float bx = smoothstep(bevW, 0.0, vVoxUv.x) - smoothstep(1.0 - bevW, 1.0, vVoxUv.x);
        float by = smoothstep(bevW, 0.0, vVoxUv.y) - smoothstep(1.0 - bevW, 1.0, vVoxUv.y);
        vec3 surfT = normalize(dPosX * dUvY.y - dPosY * dUvX.y + 1e-6);
        vec3 surfB = normalize(-dPosX * dUvY.x + dPosY * dUvX.x + 1e-6);
        normal = normalize(normal - (surfT * bx + surfB * by) * 0.26 * (1.0 - smoothstep(0.04, 0.14, max(fwidth(vVoxUv.x), fwidth(vVoxUv.y)))));`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * min(vEmit * 0.9, 1.35);`,
      );
  };
  mat.customProgramCacheKey = () => "meadow-voxel-bevel-ao-v1";
  return mat;
}

export function getVoxelMaterialForLayer(layerIndex = 0) {
  const layer = Math.max(0, Math.min(7, layerIndex | 0));
  if (!voxelLayerMaterials.has(layer)) {
    voxelLayerMaterials.set(layer, createVoxelStandardMaterial(layer));
  }
  return voxelLayerMaterials.get(layer);
}

export function getSharedVoxelMaterial() {
  return getVoxelMaterialForLayer(0);
}

let ghostMat = null;
function getGhostVoxelMaterial() {
  if (!ghostMat) {
    ghostMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.05,
      transparent: true,
      opacity: 0.78,
      emissive: new THREE.Color("#429867"),
      emissiveIntensity: 0.18,
    });
  }
  return ghostMat;
}

export function buildVoxelMesh(vox, options = {}) {
  const {
    jitter = 0.036,
    ao = true,
    scale = 1,
    castShadow = true,
    receiveShadow = true,
    ghost = false,
    depthLayer = 0,
  } = options;

  const positions = [];
  const normals = [];
  const colors = [];
  const uvs = [];
  const emits = [];
  const indices = [];

  const map = vox.v;
  let vertCount = 0;

  for (const cell of map.values()) {
    const { x, y, z, color, emit } = cell;
    const [br, bg, bb] = parseColorLinear(color);
    const j = 1.0 + (hashCoords(x, y, z, vox.seed) - 0.5) * 2 * jitter;

    for (let fi = 0; fi < 6; fi++) {
      const face = FACES[fi];
      const [nx, ny, nz] = face.n;
      if (map.has(keyOf(x + nx, y + ny, z + nz))) continue;

      const cornerAO = [1, 1, 1, 1];
      if (ao && emit < 0.5) {
        for (let ci = 0; ci < 4; ci++) {
          const [d1, d2, dc] = face.aoDirs[ci];
          const s1 = map.has(keyOf(x + d1[0], y + d1[1], z + d1[2]));
          const s2 = map.has(keyOf(x + d2[0], y + d2[1], z + d2[2]));
          const sc = map.has(keyOf(x + dc[0], y + dc[1], z + dc[2]));
          const lvl = s1 && s2 ? 0 : 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (sc ? 1 : 0));
          cornerAO[ci] = AO_LEVELS[lvl];
        }
      }

      const dirShade = ny > 0 ? 1.04 : ny < 0 ? 0.64 : nz > 0 ? 0.96 : nx > 0 ? 0.89 : nx < 0 ? 0.83 : 0.79;
      for (let ci = 0; ci < 4; ci++) {
        const c = face.corners[ci];
        positions.push((x + c[0]) * scale, (y + c[1]) * scale, (z + c[2]) * scale);
        normals.push(nx, ny, nz);
        const shade = cornerAO[ci] * j * dirShade;
        colors.push(Math.min(1, br * shade), Math.min(1, bg * shade), Math.min(1, bb * shade));
        uvs.push(QUAD_UVS[ci][0], QUAD_UVS[ci][1]);
        emits.push(emit);
      }

      if (cornerAO[0] + cornerAO[2] < cornerAO[1] + cornerAO[3]) {
        indices.push(vertCount + 1, vertCount + 2, vertCount + 3, vertCount + 1, vertCount + 3, vertCount + 0);
      } else {
        indices.push(vertCount + 0, vertCount + 1, vertCount + 2, vertCount + 0, vertCount + 2, vertCount + 3);
      }
      vertCount += 4;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aEmit", new THREE.Float32BufferAttribute(emits, 1));
  geo.setIndex(indices);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(
    geo,
    ghost ? getGhostVoxelMaterial() : getVoxelMaterialForLayer(depthLayer),
  );
  mesh.castShadow = castShadow && !ghost;
  mesh.receiveShadow = receiveShadow && !ghost;
  return mesh;
}

/**
 * Compile a VoxelBlueprint into a scaled, articulated THREE.Group ready for world simulation or modal turntable.
 */
export function buildCreationGroup(blueprint, options = {}) {
  const { seed = 11, ghost = false, useWorldScale = true } = options;
  const group = new THREE.Group();
  const animators = [];
  const pal = blueprint?.palette || {};

  const scaleFactor = useWorldScale ? (SCALE_FACTORS[blueprint?.scaleClass] || SCALE_FACTORS.medium) : 1.0;
  const voxScale = VOXEL_UNIT * scaleFactor;

  const baseVox = new Vox(seed);
  applyOps(baseVox, blueprint?.ops || [], pal);
  if (baseVox.size > 0) {
    const baseMesh = buildVoxelMesh(baseVox, { scale: voxScale, ghost });
    group.add(baseMesh);
  }

  let maxTopY = baseVox.bounds().maxY * voxScale;

  for (let i = 0; i < (blueprint?.parts || []).length; i++) {
    const part = blueprint.parts[i];
    const pv = new Vox(seed + 17 + i * 7);
    applyOps(pv, part.ops || [], pal);
    if (!pv.size) continue;

    const pivot = new THREE.Group();
    const [px, py, pz] = part.pivot || [0, 0, 0];
    pivot.position.set(px * voxScale, py * voxScale, pz * voxScale);
    const pMesh = buildVoxelMesh(pv, {
      scale: voxScale,
      ghost,
      depthLayer: (i % 6) + 1,
    });
    // Microscopic scale inset + per-part polygonOffset prevents coplanar depth shimmer on grazing joints
    pMesh.scale.setScalar(0.9985);
    pivot.add(pMesh);
    group.add(pivot);

    maxTopY = Math.max(maxTopY, (py + pv.bounds().maxY) * voxScale);

    const speed = Number(part.speed) || 1.2;
    const amp = Number(part.amp) || 0.38;
    const phase = Number(part.phase) || 0;
    const kind = part.kind || "bob";

    animators.push((t, motion = null) => {
      const moveFactor = motion?.moveFactor ?? 1.0;
      if (kind === "wheel") {
        // In the world, roll wheels strictly by distance traveled along the ground!
        const angle = motion && typeof motion.wheelAngle === "number" ? motion.wheelAngle * speed : t * 2.4 * speed;
        pivot.rotation.x = angle;
      } else if (kind === "spinY") {
        pivot.rotation.y = t * speed + phase;
      } else if (kind === "spinZ") {
        pivot.rotation.z = t * speed + phase;
      } else if (kind === "spinX") {
        pivot.rotation.x = t * speed + phase;
      } else if (kind === "bob") {
        pivot.position.y = py * voxScale + Math.sin(t * speed * 2.2 + phase) * amp * voxScale * 2.5;
      } else if (kind === "swingX") {
        const effAmp = amp * (0.18 + 0.82 * moveFactor);
        pivot.rotation.x = Math.sin(t * speed * 2.6 + phase) * effAmp;
      } else if (kind === "swingY") {
        pivot.rotation.y = Math.sin(t * speed * 2.4 + phase) * amp;
      } else if (kind === "swingZ") {
        pivot.rotation.z = Math.sin(t * speed * 2.2 + phase) * amp;
      }
    });
  }

  group.userData.topY = Math.max(1.0, maxTopY);
  group.userData.voxScale = voxScale;
  group.userData.animate = (t, motion = null) => {
    for (const fn of animators) fn(t, motion);
  };
  group.userData.dispose = () => {
    group.traverse((obj) => {
      if (obj.isMesh && obj.geometry) obj.geometry.dispose();
    });
  };
  return group;
}
