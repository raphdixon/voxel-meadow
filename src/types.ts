export type CreationCategory = "vehicle" | "creature" | "building" | "prop" | "aircraft" | "watercraft";
export type ScaleClass = "small" | "medium" | "large";

export type LiveFeedKind = "weather" | "surf" | "wind" | "time" | "moon" | "iss";

export interface LiveFeedSpec {
  kind: LiveFeedKind;
  place?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
}

export interface LiveFeedReading {
  kind: LiveFeedKind;
  badge: string;
  summary: string;
  value?: number;
  updatedAt: number;
}

export type VoxelPartKind =
  | "wheel"
  | "spinY"
  | "spinZ"
  | "spinX"
  | "bob"
  | "swingX"
  | "swingY"
  | "swingZ";

export type VoxelOp =
  | { op: "plinth"; sizeX: number; heightY: number; sizeZ: number; base: string; top: string; corner: string }
  | { op: "box"; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; color: string; emit?: number; mirrorX?: boolean }
  | { op: "roundedBox"; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; radius: number; color: string; emit?: number; mirrorX?: boolean }
  | { op: "clear"; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; mirrorX?: boolean }
  | { op: "hollowBox"; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; wall: number; color: string; trim?: string }
  | { op: "pillars"; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; color: string }
  | {
      op: "cylinder";
      axis?: "x" | "y" | "z";
      cx?: number;
      cy?: number;
      cz?: number;
      x0?: number;
      x1?: number;
      y0?: number;
      y1?: number;
      z0?: number;
      z1?: number;
      radius: number;
      color: string;
      emit?: number;
      mirrorX?: boolean;
    }
  | {
      op: "ring";
      axis?: "x" | "y" | "z";
      cx?: number;
      cy?: number;
      cz?: number;
      x0?: number;
      x1?: number;
      y0?: number;
      y1?: number;
      z0?: number;
      z1?: number;
      outerR: number;
      innerR: number;
      color: string;
      emit?: number;
      mirrorX?: boolean;
    }
  | { op: "cone"; cx: number; y0: number; y1: number; cz: number; rBottom: number; rTop: number; color: string; emit?: number; mirrorX?: boolean }
  | { op: "sphere"; cx: number; cy: number; cz: number; rx: number; ry: number; rz: number; color: string; emit?: number; mirrorX?: boolean }
  | { op: "dome"; cx: number; yBase: number; cz: number; radius: number; color: string; emit?: number; mirrorX?: boolean }
  | { op: "roofGable"; x0: number; yBase: number; z0: number; x1: number; z1: number; rise: number; axis: "x" | "z"; color: string; trim?: string }
  | { op: "roofPyramid"; x0: number; yBase: number; z0: number; x1: number; z1: number; color: string; trim?: string }
  | { op: "stairs"; x0: number; y0: number; z0: number; steps: number; width: number; dir: "+z" | "-z" | "+x" | "-x"; color: string }
  | { op: "arch"; cx: number; y0: number; cz: number; halfSpan: number; height: number; depth: number; axis: "x" | "z"; color: string }
  | { op: "line"; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; radius: number; color: string; emit?: number; mirrorX?: boolean }
  | { op: "voxels"; list: [number, number, number, string, number?][]; mirrorX?: boolean };

export interface VoxelPart {
  name: string;
  kind: VoxelPartKind;
  speed: number;
  amp?: number;
  phase?: number;
  pivot: [number, number, number];
  ops: VoxelOp[];
}

export interface VoxelBlueprint {
  version: 1;
  name: string;
  description: string;
  category: CreationCategory;
  scaleClass: ScaleClass;
  palette: Record<string, string>;
  ops: VoxelOp[];
  parts: VoxelPart[];
  liveFeed?: LiveFeedSpec | null;
  stats: {
    voxels: number;
    footprintX: number;
    footprintZ: number;
    maxY: number;
  };
}

export interface RouteStop {
  id: string;
  name: string;
  x: number;
  z: number;
  dwellSec: number;
  nearCreationId?: string;
}

export type CreationBehavior =
  | {
      type: "vehicle_route";
      speed: number;
      waypoints: [number, number][];
      stops: RouteStop[];
      statusLine: string;
    }
  | {
      type: "wander";
      style: "walk" | "hop" | "trot" | "glide";
      speed: number;
      homeX: number;
      homeZ: number;
      radius: number;
      hoverHeight?: number;
      targets?: [number, number][];
      statusLine: string;
    }
  | {
      type: "fly_circle";
      speed: number;
      altitude: number;
      centerX: number;
      centerZ: number;
      radius: number;
      waypoints?: [number, number, number][];
      statusLine: string;
    }
  | {
      type: "water_float";
      speed: number;
      pondX: number;
      pondZ: number;
      radius: number;
      statusLine: string;
    }
  | {
      type: "landmark";
      facingYaw: number;
      activity: string;
      statusLine: string;
    };

export interface BlueprintAmendment {
  category?: CreationCategory;
  scaleClass?: ScaleClass;
  stripPlinth?: boolean;
  clearOps?: VoxelOp[];
  upsertParts?: VoxelPart[];
}

export interface WorldCreation {
  id: string;
  name: string;
  description: string;
  creatorPrompt?: string;
  category: CreationCategory;
  scaleClass: ScaleClass;
  x: number;
  z: number;
  yaw: number;
  blueprint: VoxelBlueprint;
  behavior: CreationBehavior;
  liveFeed?: LiveFeedSpec | null;
  integratedLevel: number;
  createdAt: number;
  isSeed?: boolean;
}

export interface WorldPath {
  id: string;
  kind: "road" | "footpath";
  points: [number, number][];
  closed?: boolean;
}

export interface WorldProp {
  id: string;
  kind: "bus_stop" | "lamp_post" | "bench" | "pond" | "tree_cluster" | "flower_patch" | "signpost";
  x: number;
  z: number;
  yaw: number;
  label?: string;
  radius?: number;
}

export interface WorldVillager {
  id: string;
  name: string;
  role: "commuter" | "student" | "baker" | "gardener" | "artist" | "explorer";
  hatColor: string;
  shirtColor: string;
  homeX: number;
  homeZ: number;
  stops: [number, number][];
  usesTransit: boolean;
}

export interface WorldStateSnapshot {
  version: number;
  creations: WorldCreation[];
  paths: WorldPath[];
  props: WorldProp[];
  villagers: WorldVillager[];
  contributorCount: number;
  myCreationId: string | null;
  lastWeaveNote: string;
}
