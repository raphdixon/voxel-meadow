import type {
  VoxelBlueprint,
  VoxelOp,
  VoxelPart,
  VoxelPartKind,
  WorldCreation,
  WorldPath,
  WorldProp,
} from "./types";
import { applySimOps, getCreationFootprintRadius, SimVox, translateOp } from "./voxel_dsl";

export interface PartOverlapReport {
  partIndex: number;
  name: string;
  kind: VoxelPartKind;
  pivot: [number, number, number];
  overlapCells: number;
  coplanarFaces: number;
  groundClips: number;
  totalIssues: number;
  conflictSampleBox: [number, number, number, number, number, number] | null;
}

export interface BlueprintAuditReport {
  clean: boolean;
  totalConflicts: number;
  overlapCells: number;
  coplanarFaces: number;
  groundClips: number;
  partReports: PartOverlapReport[];
}

export interface BlueprintRepairResult {
  blueprint: VoxelBlueprint;
  reportBefore: BlueprintAuditReport;
  reportAfter: BlueprintAuditReport;
  repairsApplied: string[];
}

export interface WorldSpatialAuditReport {
  clean: boolean;
  footpathTrimCount: number;
  propNudgeCount: number;
  details: string[];
}

const FACE_DIRS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const INSET_OFFSETS: readonly [number, number, number][] = [
  [0.5, 0.5, 0.5],
  [0.16, 0.16, 0.16],
  [0.84, 0.16, 0.16],
  [0.16, 0.84, 0.16],
  [0.84, 0.84, 0.16],
  [0.16, 0.16, 0.84],
  [0.84, 0.16, 0.84],
  [0.16, 0.84, 0.84],
  [0.84, 0.84, 0.84],
];

function cellKey(x: number, y: number, z: number): string {
  return `${x | 0},${y | 0},${z | 0}`;
}

interface PoseTransform {
  rx: number;
  ry: number;
  rz: number;
  dy: number;
}

function samplePartPoses(part: VoxelPart): PoseTransform[] {
  const amp = typeof part.amp === "number" ? part.amp : 0.38;
  switch (part.kind) {
    case "wheel":
    case "spinX": {
      const out: PoseTransform[] = [];
      for (let i = 0; i < 16; i++) {
        out.push({ rx: (i / 16) * Math.PI * 2, ry: 0, rz: 0, dy: 0 });
      }
      return out;
    }
    case "spinY": {
      const out: PoseTransform[] = [];
      for (let i = 0; i < 16; i++) {
        out.push({ rx: 0, ry: (i / 16) * Math.PI * 2, rz: 0, dy: 0 });
      }
      return out;
    }
    case "spinZ": {
      const out: PoseTransform[] = [];
      for (let i = 0; i < 16; i++) {
        out.push({ rx: 0, ry: 0, rz: (i / 16) * Math.PI * 2, dy: 0 });
      }
      return out;
    }
    case "swingX": {
      const out: PoseTransform[] = [];
      for (let i = -4; i <= 4; i++) {
        out.push({ rx: (i / 4) * amp, ry: 0, rz: 0, dy: 0 });
      }
      return out;
    }
    case "swingY": {
      const out: PoseTransform[] = [];
      for (let i = -4; i <= 4; i++) {
        out.push({ rx: 0, ry: (i / 4) * amp, rz: 0, dy: 0 });
      }
      return out;
    }
    case "swingZ": {
      const out: PoseTransform[] = [];
      for (let i = -4; i <= 4; i++) {
        out.push({ rx: 0, ry: 0, rz: (i / 4) * amp, dy: 0 });
      }
      return out;
    }
    case "bob":
    default: {
      const out: PoseTransform[] = [];
      for (let i = -3; i <= 3; i++) {
        out.push({ rx: 0, ry: 0, rz: 0, dy: (i / 3) * amp * 2.5 });
      }
      return out;
    }
  }
}

function rotatePoint(
  lx: number,
  ly: number,
  lz: number,
  pose: PoseTransform,
): [number, number, number] {
  let x = lx;
  let y = ly;
  let z = lz;
  if (pose.rx !== 0) {
    const c = Math.cos(pose.rx);
    const s = Math.sin(pose.rx);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny;
    z = nz;
  }
  if (pose.ry !== 0) {
    const c = Math.cos(pose.ry);
    const s = Math.sin(pose.ry);
    const nx = x * c + z * s;
    const nz = -x * s + z * c;
    x = nx;
    z = nz;
  }
  if (pose.rz !== 0) {
    const c = Math.cos(pose.rz);
    const s = Math.sin(pose.rz);
    const nx = x * c - y * s;
    const ny = x * s + y * c;
    x = nx;
    y = ny;
  }
  return [x, y + pose.dy, z];
}

interface ExposedFace {
  cx: number;
  cy: number;
  cz: number;
  nx: number;
  ny: number;
  nz: number;
}

function collectExposedFaces(vox: SimVox): ExposedFace[] {
  const faces: ExposedFace[] = [];
  for (const cell of vox.v.values()) {
    for (const [nx, ny, nz] of FACE_DIRS) {
      if (!vox.v.has(cellKey(cell.x + nx, cell.y + ny, cell.z + nz))) {
        faces.push({
          cx: cell.x + 0.5 + nx * 0.5,
          cy: cell.y + 0.5 + ny * 0.5,
          cz: cell.z + 0.5 + nz * 0.5,
          nx,
          ny,
          nz,
        });
      }
    }
  }
  return faces;
}

/**
 * Checks whether a plane-aligned face center (wx, wy, wz) with unit axis normal
 * lies coplanar (within ~0.06 voxels) with an exposed face of `occMap` (either flush contact
 * or overlapping same-facing skin, both of which cause GPU depth Z-fighting).
 */
function hasCoplanarBoundaryOnGrid(
  occMap: Map<string, unknown>,
  wx: number,
  wy: number,
  wz: number,
  wnx: number,
  wny: number,
  wnz: number,
): boolean {
  const eps = 0.065;
  if (Math.abs(wnx) > 0.96) {
    const planeX = Math.round(wx);
    if (Math.abs(wx - planeX) > eps) return false;
    const iy = Math.floor(wy);
    const iz = Math.floor(wz);
    const leftHas = occMap.has(cellKey(planeX - 1, iy, iz));
    const rightHas = occMap.has(cellKey(planeX, iy, iz));
    return leftHas !== rightHas;
  }
  if (Math.abs(wny) > 0.96) {
    const planeY = Math.round(wy);
    if (Math.abs(wy - planeY) > eps) return false;
    const ix = Math.floor(wx);
    const iz = Math.floor(wz);
    const downHas = occMap.has(cellKey(ix, planeY - 1, iz));
    const upHas = occMap.has(cellKey(ix, planeY, iz));
    return downHas !== upHas;
  }
  if (Math.abs(wnz) > 0.96) {
    const planeZ = Math.round(wz);
    if (Math.abs(wz - planeZ) > eps) return false;
    const ix = Math.floor(wx);
    const iy = Math.floor(wy);
    const backHas = occMap.has(cellKey(ix, iy, planeZ - 1));
    const frontHas = occMap.has(cellKey(ix, iy, planeZ));
    return backHas !== frontHas;
  }
  return false;
}

function auditSinglePartAgainstOccupied(
  part: VoxelPart,
  partIndex: number,
  palette: Record<string, string>,
  occupied: Map<string, unknown>,
  sweptOut?: Set<string>,
): { report: PartOverlapReport; conflictSum: [number, number, number]; conflictN: number } {
  const pv = new SimVox();
  applySimOps(pv, part.ops, palette);

  const [px, py, pz] = part.pivot;
  const cells = Array.from(pv.v.values());
  if (!cells.length) {
    return {
      report: {
        partIndex,
        name: part.name,
        kind: part.kind,
        pivot: [px, py, pz],
        overlapCells: 0,
        coplanarFaces: 0,
        groundClips: 0,
        totalIssues: 0,
        conflictSampleBox: null,
      },
      conflictSum: [0, 0, 0],
      conflictN: 0,
    };
  }

  const exposedFaces = collectExposedFaces(pv);
  const poses = samplePartPoses(part);

  const overlapSet = new Set<string>();
  const coplanarSet = new Set<string>();
  const groundClipSet = new Set<string>();

  let minCX = Infinity, maxCX = -Infinity;
  let minCY = Infinity, maxCY = -Infinity;
  let minCZ = Infinity, maxCZ = -Infinity;
  let sumX = 0, sumY = 0, sumZ = 0, sumN = 0;

  // Ground clip applies to non-wheel elevated parts (e.g. windmill sails sweeping underground)
  const checkGroundSweep =
    (part.kind === "spinZ" || part.kind === "spinX") && py >= 3.5;

  for (let pi = 0; pi < poses.length; pi++) {
    const pose = poses[pi];
    for (const c of cells) {
      for (let oi = 0; oi < INSET_OFFSETS.length; oi++) {
        const [ox, oy, oz] = INSET_OFFSETS[oi];
        const [rx, ry, rz] = rotatePoint(c.x + ox, c.y + oy, c.z + oz, pose);
        const wx = px + rx;
        const wy = py + ry;
        const wz = pz + rz;
        const gx = Math.floor(wx);
        const gy = Math.floor(wy);
        const gz = Math.floor(wz);
        const gk = cellKey(gx, gy, gz);

        if (oi === 0 && sweptOut) {
          sweptOut.add(gk);
        }

        if (occupied.has(gk)) {
          if (!overlapSet.has(gk)) {
            overlapSet.add(gk);
            if (gx < minCX) minCX = gx;
            if (gx + 1 > maxCX) maxCX = gx + 1;
            if (gy < minCY) minCY = gy;
            if (gy + 1 > maxCY) maxCY = gy + 1;
            if (gz < minCZ) minCZ = gz;
            if (gz + 1 > maxCZ) maxCZ = gz + 1;
            sumX += gx + 0.5;
            sumY += gy + 0.5;
            sumZ += gz + 0.5;
            sumN++;
          }
        }

        if (checkGroundSweep && wy < -0.15) {
          groundClipSet.add(`${gx},${gz}`);
        }
      }
    }

    // Coplanar boundary graze check
    for (const f of exposedFaces) {
      const [rx, ry, rz] = rotatePoint(f.cx, f.cy, f.cz, pose);
      const [wnx, wny, wnz] = rotatePoint(f.nx, f.ny, f.nz, { ...pose, dy: 0 });
      const wx = px + rx;
      const wy = py + ry;
      const wz = pz + rz;
      if (hasCoplanarBoundaryOnGrid(occupied, wx, wy, wz, wnx, wny, wnz)) {
        const fk = `${Math.round(wx * 2)},${Math.round(wy * 2)},${Math.round(wz * 2)}`;
        if (!coplanarSet.has(fk)) {
          coplanarSet.add(fk);
          const gx = Math.floor(wx);
          const gy = Math.floor(wy);
          const gz = Math.floor(wz);
          if (gx < minCX) minCX = gx;
          if (gx + 1 > maxCX) maxCX = gx + 1;
          if (gy < minCY) minCY = gy;
          if (gy + 1 > maxCY) maxCY = gy + 1;
          if (gz < minCZ) minCZ = gz;
          if (gz + 1 > maxCZ) maxCZ = gz + 1;
          sumX += wx;
          sumY += wy;
          sumZ += wz;
          sumN++;
        }
      }
    }
  }

  const overlapCells = overlapSet.size;
  const coplanarFaces = coplanarSet.size;
  const groundClips = groundClipSet.size;
  const totalIssues = overlapCells + coplanarFaces + groundClips;

  return {
    report: {
      partIndex,
      name: part.name,
      kind: part.kind,
      pivot: [px, py, pz],
      overlapCells,
      coplanarFaces,
      groundClips,
      totalIssues,
      conflictSampleBox:
        minCX <= maxCX ? [minCX, minCY, minCZ, maxCX, maxCY, maxCZ] : null,
    },
    conflictSum: [sumX, sumY, sumZ],
    conflictN: sumN,
  };
}

/**
 * Audits a VoxelBlueprint across all kinematic animation poses of all `parts`
 * for volumetric voxel collisions, coplanar Z-fighting faces, and sub-ground blade sweeps.
 */
export function auditBlueprintOverlaps(bp: VoxelBlueprint): BlueprintAuditReport {
  const baseVox = new SimVox();
  applySimOps(baseVox, bp.ops, bp.palette);

  // Combined occupancy starts with baseVox and accumulates each earlier part's swept volume
  // so part-vs-base AND part-vs-part Z-fighting are both caught.
  const combinedOccupied = new Map<string, boolean>();
  for (const k of baseVox.v.keys()) {
    combinedOccupied.set(k, true);
  }

  const partReports: PartOverlapReport[] = [];
  let overlapCells = 0;
  let coplanarFaces = 0;
  let groundClips = 0;

  for (let i = 0; i < bp.parts.length; i++) {
    const swept = new Set<string>();
    const { report } = auditSinglePartAgainstOccupied(
      bp.parts[i],
      i,
      bp.palette,
      combinedOccupied,
      swept,
    );
    partReports.push(report);
    overlapCells += report.overlapCells;
    coplanarFaces += report.coplanarFaces;
    groundClips += report.groundClips;
    for (const sk of swept) {
      combinedOccupied.set(sk, true);
    }
  }

  const totalConflicts = overlapCells + coplanarFaces + groundClips;
  return {
    clean: totalConflicts === 0,
    totalConflicts,
    overlapCells,
    coplanarFaces,
    groundClips,
    partReports,
  };
}

/**
 * Formats a concise diagnostic summary for Gemini 4 Argon when self-repairing a draft blueprint.
 */
export function formatAuditFeedbackForArgon(report: BlueprintAuditReport): string {
  if (report.clean) return "";
  const lines: string[] = [];
  for (const pr of report.partReports) {
    if (pr.totalIssues === 0) continue;
    const boxNote = pr.conflictSampleBox
      ? ` in region x=[${pr.conflictSampleBox[0]}..${pr.conflictSampleBox[3]}], y=[${pr.conflictSampleBox[1]}..${pr.conflictSampleBox[4]}], z=[${pr.conflictSampleBox[2]}..${pr.conflictSampleBox[5]}]`
      : "";
    lines.push(
      `- Animated part "${pr.name}" (${pr.kind} at pivot [${pr.pivot.join(", ")}]) has ${pr.overlapCells} overlapping voxels, ${pr.coplanarFaces} coplanar Z-fighting faces, and ${pr.groundClips} ground clips${boxNote}. Move its pivot outward or carve >=1 voxel clearance so it spins/swings with zero contact.`,
    );
  }
  return lines.join("\n");
}

function recomputeBlueprintStats(
  bp: VoxelBlueprint,
  ops: VoxelOp[],
  parts: VoxelPart[],
): VoxelBlueprint["stats"] {
  const worldVox = new SimVox();
  applySimOps(worldVox, ops, bp.palette);
  for (const pt of parts) {
    const pv = new SimVox();
    applySimOps(pv, pt.ops, bp.palette);
    worldVox.merge(pv, Math.round(pt.pivot[0]), Math.round(pt.pivot[1]), Math.round(pt.pivot[2]));
  }
  const b = worldVox.bounds();
  return {
    voxels: b.count,
    footprintX: Math.max(2, b.maxX - b.minX),
    footprintZ: Math.max(2, b.maxZ - b.minZ),
    maxY: Math.max(2, b.maxY),
  };
}

/**
 * Carve clean wheel-well arches into `ops` for a `wheel` part so tires spin freely
 * without lifting the wheels off the ground (`Y = 0`).
 */
function carveWheelArches(
  ops: VoxelOp[],
  part: VoxelPart,
  palette: Record<string, string>,
): VoxelOp[] {
  const pv = new SimVox();
  applySimOps(pv, part.ops, palette);
  if (!pv.size) return ops;

  const negCells: { x: number; y: number; z: number }[] = [];
  const posCells: { x: number; y: number; z: number }[] = [];
  for (const c of pv.v.values()) {
    if (c.x < 0) negCells.push(c);
    else posCells.push(c);
  }

  const clusters = [negCells, posCells].filter((cl) => cl.length > 0);
  const nextOps = [...ops];
  const [px, py, pz] = part.pivot;

  for (const cl of clusters) {
    let minLX = Infinity, maxLX = -Infinity;
    let maxR = 1.0;
    for (const c of cl) {
      if (c.x < minLX) minLX = c.x;
      if (c.x + 1 > maxLX) maxLX = c.x + 1;
      const r = Math.hypot(c.y + 0.5, c.z + 0.5) + 0.55;
      if (r > maxR) maxR = r;
    }
    const rPad = Math.ceil(maxR + 0.65);
    const x0 = Math.floor(px + minLX - 0.6);
    const x1 = Math.ceil(px + maxLX + 0.6);
    const y0 = Math.max(0, Math.floor(py - rPad));
    const y1 = Math.ceil(py + rPad);
    const z0 = Math.floor(pz - rPad);
    const z1 = Math.ceil(pz + rPad);
    nextOps.push({
      op: "clear",
      x0,
      y0,
      z0,
      x1,
      y1,
      z1,
    });
  }
  return nextOps;
}

/**
 * Deterministically resolves any part-vs-base and part-vs-part voxel overlaps or coplanar Z-fighting
 * across all animated parts of a `VoxelBlueprint`.
 */
export function autoRepairBlueprintOverlaps(bp: VoxelBlueprint): BlueprintRepairResult {
  const reportBefore = auditBlueprintOverlaps(bp);
  if (reportBefore.clean) {
    return {
      blueprint: bp,
      reportBefore,
      reportAfter: reportBefore,
      repairsApplied: [],
    };
  }

  let ops: VoxelOp[] = bp.ops.map((o) => ({ ...o }));
  const parts: VoxelPart[] = bp.parts.map((p) => ({
    ...p,
    pivot: [...p.pivot] as [number, number, number],
    ops: p.ops.map((o) => ({ ...o })),
  }));
  const repairsApplied: string[] = [];

  // Pass 1: Carve clean wheel arches for any colliding `wheel` parts first (keeps wheels grounded at Y=0)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].kind !== "wheel") continue;
    const baseCheck = new SimVox();
    applySimOps(baseCheck, ops, bp.palette);
    const { report } = auditSinglePartAgainstOccupied(parts[i], i, bp.palette, baseCheck.v);
    if (report.totalIssues > 0) {
      ops = carveWheelArches(ops, parts[i], bp.palette);
      repairsApplied.push(`carved wheel-arch clearance for "${parts[i].name}"`);
    }
  }

  // Rebuild occupancy incrementally for Pass 2 across all parts
  const baseVox = new SimVox();
  applySimOps(baseVox, ops, bp.palette);
  const occupied = new Map<string, boolean>();
  for (const k of baseVox.v.keys()) occupied.set(k, true);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const sweptInitial = new Set<string>();
    const initialEval = auditSinglePartAgainstOccupied(part, i, bp.palette, occupied, sweptInitial);

    if (initialEval.report.totalIssues === 0) {
      for (const sk of sweptInitial) occupied.set(sk, true);
      continue;
    }

    const [origX, origY, origZ] = part.pivot;
    const pv = new SimVox();
    applySimOps(pv, part.ops, bp.palette);
    const pb = pv.bounds();

    // Compute escape hint vector away from colliding voxels
    let escX = 0, escY = 0, escZ = 0;
    if (initialEval.conflictN > 0) {
      const cx = initialEval.conflictSum[0] / initialEval.conflictN;
      const cy = initialEval.conflictSum[1] / initialEval.conflictN;
      const cz = initialEval.conflictSum[2] / initialEval.conflictN;
      escX = origX - cx;
      escY = origY - cy;
      escZ = origZ - cz;
    }

    const candidates: [number, number, number][] = [];

    if (part.kind === "spinZ") {
      // If part ops extend behind local z=0 into the tower wall, shift local ops so back sits at local z=0
      const signZ = origZ >= -0.5 ? 1 : -1;
      if (signZ > 0 && pb.minZ < 0) {
        const zShift = -pb.minZ;
        part.ops = part.ops.map((o) => translateOp(o, 0, 0, zShift));
      } else if (signZ < 0 && pb.maxZ > 0) {
        const zShift = -pb.maxZ;
        part.ops = part.ops.map((o) => translateOp(o, 0, 0, zShift));
      }

      for (let dzStep = 0; dzStep <= 18; dzStep++) {
        const dz = signZ * (dzStep * 0.5);
        for (let dyStep = 0; dyStep <= 16; dyStep++) {
          const dy = dyStep * 0.5;
          candidates.push([0, dy, dz]);
          if (dyStep > 0 && origY - dy >= 6) {
            candidates.push([0, -dy, dz]);
          }
        }
      }
    } else if (part.kind === "spinX") {
      const signX = origX >= 0 ? 1 : -1;
      if (signX > 0 && pb.minX < 0) {
        part.ops = part.ops.map((o) => translateOp(o, -pb.minX, 0, 0));
      } else if (signX < 0 && pb.maxX > 0) {
        part.ops = part.ops.map((o) => translateOp(o, -pb.maxX, 0, 0));
      }
      for (let dxStep = 0; dxStep <= 18; dxStep++) {
        const dx = signX * (dxStep * 0.5);
        for (let dyStep = 0; dyStep <= 14; dyStep++) {
          candidates.push([dx, dyStep * 0.5, 0]);
        }
      }
    } else if (part.kind === "spinY") {
      for (let dyStep = 1; dyStep <= 16; dyStep++) {
        const dy = dyStep * 0.5;
        candidates.push([0, dy, 0]);
        candidates.push([0, dy, 0.5], [0, dy, -0.5], [0.5, dy, 0], [-0.5, dy, 0]);
        candidates.push([0, dy, 1.5], [0, dy, -1.5], [1.5, dy, 0], [-1.5, dy, 0]);
      }
    } else {
      // swingX, swingY, swingZ, bob, or residual wheel
      const isGroundLimb =
        (part.kind === "swingX" || part.kind === "wheel") && origY + pb.minY <= 0.75;
      const sx = Math.abs(escX) > 0.15 ? Math.sign(escX) : origX >= 0 ? 1 : -1;
      const sz = Math.abs(escZ) > 0.15 ? Math.sign(escZ) : origZ >= 0 ? 1 : -1;
      const sy = Math.abs(escY) > 0.15 ? Math.sign(escY) : 1;

      if (isGroundLimb) {
        // Keep Y fixed so paws/wheels stay grounded on Y=0; push outward in X/Z
        for (let step = 1; step <= 12; step++) {
          const d = step * 0.5;
          candidates.push([sx * d, 0, 0]);
          candidates.push([0, 0, sz * d]);
          candidates.push([sx * d, 0, sz * d * 0.5]);
          candidates.push([-sx * d, 0, 0]);
        }
      } else {
        for (let step = 1; step <= 26; step++) {
          const d = step * 0.5;
          candidates.push([0, d, 0]);
          candidates.push([0, 0, sz * d], [0, 0, -sz * d]);
          candidates.push([sx * d, 0, 0], [-sx * d, 0, 0]);
          candidates.push([0, -d, 0]);
          candidates.push([sx * d, 0, sz * d], [-sx * d, 0, -sz * d]);
          candidates.push([0, d, sz * d], [0, d, -sz * d]);
          candidates.push([sx * d, d, 0], [-sx * d, d, 0]);
        }
      }
    }

    // Sort candidates by weighted Euclidean shift so we pick the gentlest clean fix
    candidates.sort((a, b) => {
      const da = a[0] * a[0] + a[1] * a[1] * 1.15 + a[2] * a[2];
      const db = b[0] * b[0] + b[1] * b[1] * 1.15 + b[2] * b[2];
      return da - db;
    });

    let bestPivot: [number, number, number] | null = null;
    let lowestPivot: [number, number, number] = [origX, origY, origZ];
    let lowestScore = initialEval.report.totalIssues;

    for (const [dx, dy, dz] of candidates) {
      const candPivot: [number, number, number] = [
        Number((origX + dx).toFixed(2)),
        Number(Math.max(0, origY + dy).toFixed(2)),
        Number((origZ + dz).toFixed(2)),
      ];
      if (Math.abs(candPivot[0]) > 22 || candPivot[1] > 44 || Math.abs(candPivot[2]) > 22) continue;

      const testPart: VoxelPart = { ...part, pivot: candPivot };
      const { report } = auditSinglePartAgainstOccupied(testPart, i, bp.palette, occupied);
      if (report.totalIssues === 0) {
        bestPivot = candPivot;
        break;
      }
      if (report.totalIssues < lowestScore) {
        lowestScore = report.totalIssues;
        lowestPivot = candPivot;
      }
    }

    if (bestPivot) {
      // If we pushed a front/back spinZ hub outward by >= 2 voxels, add a non-touching support shaft on base
      if (part.kind === "spinZ" && Math.abs(bestPivot[2] - origZ) >= 2.0) {
        const signZ = bestPivot[2] >= origZ ? 1 : -1;
        const zStart = Math.round(origZ - signZ * 2);
        const zEnd = signZ > 0 ? Math.floor(bestPivot[2]) - 1 : Math.ceil(bestPivot[2]) + 1;
        if ((signZ > 0 && zEnd > zStart) || (signZ < 0 && zStart > zEnd)) {
          const axleOp: VoxelOp = {
            op: "cylinder",
            axis: "z",
            cx: Math.round(bestPivot[0]),
            cy: Math.round(bestPivot[1]),
            z0: Math.min(zStart, zEnd),
            z1: Math.max(zStart, zEnd),
            radius: 1.1,
            color: "woodDark",
          };
          ops.push(axleOp);
          applySimOps(baseVox, [axleOp], bp.palette);
          for (const k of baseVox.v.keys()) occupied.set(k, true);
        }
      }
      part.pivot = bestPivot;
      repairsApplied.push(
        `nudged "${part.name}" (${part.kind}) pivot [${origX},${origY},${origZ}] -> [${bestPivot.join(",")}]`,
      );
    } else {
      // Apply best partial pivot shift and carve a full 1-voxel clearance pocket around the swept volume
      part.pivot = lowestPivot;
      const pvSwept = new Set<string>();
      auditSinglePartAgainstOccupied(part, i, bp.palette, occupied, pvSwept);
      let cMinX = Infinity, cMaxX = -Infinity;
      let cMinY = Infinity, cMaxY = -Infinity;
      let cMinZ = Infinity, cMaxZ = -Infinity;
      for (const sk of pvSwept) {
        const [sx, sy, sz] = sk.split(",").map(Number);
        if (sx < cMinX) cMinX = sx;
        if (sx + 1 > cMaxX) cMaxX = sx + 1;
        if (sy < cMinY) cMinY = sy;
        if (sy + 1 > cMaxY) cMaxY = sy + 1;
        if (sz < cMinZ) cMinZ = sz;
        if (sz + 1 > cMaxZ) cMaxZ = sz + 1;
      }
      if (cMinX <= cMaxX) {
        const clearOp: VoxelOp = {
          op: "clear",
          x0: cMinX - 1,
          y0: Math.max(0, cMinY - 1),
          z0: cMinZ - 1,
          x1: cMaxX + 1,
          y1: cMaxY + 1,
          z1: cMaxZ + 1,
        };
        ops.push(clearOp);
        baseVox.clear(clearOp.x0, clearOp.y0, clearOp.z0, clearOp.x1, clearOp.y1, clearOp.z1);
        occupied.clear();
        for (const k of baseVox.v.keys()) occupied.set(k, true);
        for (let j = 0; j < i; j++) {
          const prevSwept = new Set<string>();
          auditSinglePartAgainstOccupied(parts[j], j, bp.palette, occupied, prevSwept);
          for (const pk of prevSwept) occupied.set(pk, true);
        }
        // Verify if any part-vs-part conflict remains after base pocket clear; if so, lift cleanly above
        const postCheck = auditSinglePartAgainstOccupied(part, i, bp.palette, occupied);
        if (postCheck.report.totalIssues > 0) {
          for (let lift = 1; lift <= 24; lift++) {
            const lifted: VoxelPart = {
              ...part,
              pivot: [part.pivot[0], Number((part.pivot[1] + lift).toFixed(2)), part.pivot[2]],
            };
            if (auditSinglePartAgainstOccupied(lifted, i, bp.palette, occupied).report.totalIssues === 0) {
              part.pivot = lifted.pivot;
              break;
            }
          }
        }
        repairsApplied.push(`carved joint socket clearance for "${part.name}"`);
      }
    }

    const finalSwept = new Set<string>();
    auditSinglePartAgainstOccupied(part, i, bp.palette, occupied, finalSwept);
    for (const sk of finalSwept) occupied.set(sk, true);
  }

  const repairedBp: VoxelBlueprint = {
    ...bp,
    ops,
    parts,
    stats: recomputeBlueprintStats(bp, ops, parts),
  };
  const reportAfter = auditBlueprintOverlaps(repairedBp);

  return {
    blueprint: repairedBp,
    reportBefore,
    reportAfter,
    repairsApplied,
  };
}

/**
 * World-level spatial overlap auditor & auto-repair for footpaths and props:
 * - Prevents footpath flagstones from poking inside building plinths (Z-fighting at ground level).
 * - Separates duplicate/stacked props so two prop meshes never Z-fight on the same spot.
 */
export function auditAndRepairWorldSpatial(
  creations: WorldCreation[],
  paths: WorldPath[],
  props: WorldProp[],
): {
  paths: WorldPath[];
  props: WorldProp[];
  report: WorldSpatialAuditReport;
} {
  const details: string[] = [];
  let footpathTrimCount = 0;
  let propNudgeCount = 0;

  const buildings = creations.filter(
    (c) => c.category === "building" || c.behavior?.type === "landmark",
  );

  const plinthRadiusOf = (c: WorldCreation): number =>
    getCreationFootprintRadius(
      c.scaleClass,
      c.blueprint?.stats?.footprintX ?? 14,
      c.blueprint?.stats?.footprintZ ?? 14,
    );

  const repairedPaths: WorldPath[] = paths.map((p) => {
    if (p.kind === "road" || p.closed || p.points.length < 2) return p;
    let changed = false;
    const pts: [number, number][] = p.points.map(([x, z]) => [x, z]);

    for (let idx = 0; idx < pts.length; idx++) {
      for (let pass = 0; pass < 2; pass++) {
        const [px, pz] = pts[idx];
        for (const b of buildings) {
          const minR = plinthRadiusOf(b);
          const dx = px - b.x;
          const dz = pz - b.z;
          const d = Math.hypot(dx, dz);
          if (d < minR) {
            const neighbor = pts[idx === 0 ? 1 : idx - 1];
            const ndx = neighbor[0] - b.x;
            const ndz = neighbor[1] - b.z;
            const nd = Math.hypot(ndx, ndz);
            const ux = d > 0.05 ? dx / d : nd > 0.05 ? ndx / nd : Math.sin(b.yaw || 0);
            const uz = d > 0.05 ? dz / d : nd > 0.05 ? ndz / nd : Math.cos(b.yaw || 0);
            pts[idx] = [
              Number((b.x + ux * (minR + 0.35)).toFixed(1)),
              Number((b.z + uz * (minR + 0.35)).toFixed(1)),
            ];
            changed = true;
          }
        }
      }
    }

    if (changed) {
      footpathTrimCount++;
      details.push(`trimmed footpath "${p.id}" clear of building plinth`);
      return { ...p, points: pts };
    }
    return p;
  });

  const repairedProps: WorldProp[] = [];
  for (const pr of props) {
    let px = pr.x;
    let pz = pr.z;
    let moved = false;

    if (pr.kind !== "pond") {
      for (let pass = 0; pass < 3; pass++) {
        // Keep props outside building plinths
        for (const b of buildings) {
          const minR = plinthRadiusOf(b) + 0.6;
          const dx = px - b.x;
          const dz = pz - b.z;
          const d = Math.hypot(dx, dz);
          if (d < minR) {
            const ux = d > 0.05 ? dx / d : 1;
            const uz = d > 0.05 ? dz / d : 0;
            px = Number((b.x + ux * (minR + 0.35)).toFixed(1));
            pz = Number((b.z + uz * (minR + 0.35)).toFixed(1));
            moved = true;
          }
        }
        // Keep props separated from each other so meshes never stack on the same coordinates
        for (const prev of repairedProps) {
          if (prev.kind === "pond") continue;
          const minSep = 1.65;
          const dx = px - prev.x;
          const dz = pz - prev.z;
          const d = Math.hypot(dx, dz);
          if (d < minSep) {
            const ux = d > 0.05 ? dx / d : 0.707;
            const uz = d > 0.05 ? dz / d : 0.707;
            px = Number((prev.x + ux * (minSep + 0.35)).toFixed(1));
            pz = Number((prev.z + uz * (minSep + 0.35)).toFixed(1));
            moved = true;
          }
        }
      }
    }

    if (moved) {
      propNudgeCount++;
      details.push(`nudged prop "${pr.id}" (${pr.kind}) to [${px}, ${pz}]`);
      repairedProps.push({ ...pr, x: px, z: pz });
    } else {
      repairedProps.push(pr);
    }
  }

  return {
    paths: repairedPaths,
    props: repairedProps,
    report: {
      clean: footpathTrimCount === 0 && propNudgeCount === 0,
      footpathTrimCount,
      propNudgeCount,
      details,
    },
  };
}
