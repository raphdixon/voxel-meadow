import { DurableObject } from "cloudflare:workers";
import {
  buildInitialIntegration,
  CITY_SIGN_POS,
  inferBiomeAndPathStyle,
  integrateCreationWithArgon,
  needsMobilityAmendment,
  weaveWorldCronWithArgon,
  type WorldPatch,
} from "./argon_director";
import { sculptWithArgon } from "./argon_sculptor";
import {
  type BuildComplexityBucket,
  type BuildEtaTelemetrySummary,
  type BuildTelemetrySample,
  classifyBuildFeatures,
  estimateInitialBuildMs,
  estimateMultiSlotQueueEtaMs,
  estimateRemainingBuildMs,
  summarizeTelemetryStats,
} from "./eta_estimator";
import { buildGeminiModelCascade } from "./gemini_models";
import { buildSeedWorld } from "./seed_world";
import {
  formatDayKeyInTz,
  redactSecrets,
  safeLogError,
  sanitizePlainText,
  verifyWebSocketOrigin,
} from "./security";
import type {
  BuildQueueJobInfo,
  WorldCreation,
  WorldPath,
  WorldProp,
  WorldStateSnapshot,
  WorldTerrainZone,
  WorldVillager,
} from "./types";
import {
  auditAndRepairWorldSpatial,
  auditBlueprintOverlaps,
  autoRepairBlueprintOverlaps,
  detectPathCrossings,
  distPointToPolyline2D,
  sampleCatmullRom2D,
} from "./voxel_audit";
import { reviewBlueprintWithCritic } from "./voxel_critic";
import {
  applyBlueprintAmendment,
  getCreationFootprintRadius,
  normalizeAndGroundBlueprint,
} from "./voxel_dsl";

const MAX_CONCURRENT_SCULPTS = 3;
const MAX_QUEUE_DEPTH = 40;
const DEFAULT_AVG_SCULPT_MS = 52_000;

export interface WorldCreationAuditEntry {
  id: string;
  name: string;
  clean: boolean;
  overlapCells: number;
  coplanarFaces: number;
  groundClips: number;
  partsCount: number;
}

export interface WorldAuditSummary {
  ok: true;
  clean: boolean;
  creationsChecked: number;
  blueprintConflicts: number;
  spatialConflicts: number;
  pathCrossings: number;
  totalAutoRepairs: number;
  lastAuditAt: number;
  lastAuditNote: string;
  creations: WorldCreationAuditEntry[];
}

export interface PlaceCreationInput {
  ipHash: string;
  cookieId: string;
  dayKey: string;
  creatorPrompt?: string;
  blueprintRaw: Record<string, unknown>;
  x?: number | null;
  z?: number | null;
  yaw?: number | null;
}

export type PlaceCreationResult =
  | { ok: true; creation: WorldCreation; world: WorldStateSnapshot }
  | { ok: false; alreadyPlaced?: boolean; myCreationId?: string; error: string };

export interface EnqueueBuildInput {
  ipHash: string;
  cookieId: string;
  dayKey: string;
  prompt: string;
  imageBase64?: string;
  imageMimeType?: string;
  x?: number | null;
  z?: number | null;
  yaw?: number | null;
}

export type EnqueueBuildResult =
  | { ok: true; queued: true; job: BuildQueueJobInfo }
  | {
      ok: false;
      status: 400 | 403 | 429 | 503;
      alreadyPlaced?: boolean;
      myCreationId?: string;
      retryAfterSec?: number;
      error: string;
    };

interface BuildJobRow {
  job_id: string;
  cookie_id: string;
  ip_hash: string;
  day_key: string;
  status: "queued" | "sculpting" | "done" | "failed";
  phase: "queued" | "sculpting" | "reviewing" | "refining";
  round1_ms: number | null;
  has_image: number;
  prompt: string;
  image_base64: string | null;
  image_mime: string | null;
  req_x: number | null;
  req_z: number | null;
  req_yaw: number | null;
  sim_delay_ms: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  creation_id: string | null;
  model_used: string | null;
  error_msg: string | null;
  error_detail: string | null;
}

export interface SanitizedBuildJobDiagnostic {
  jobId: string;
  status: "done" | "failed";
  phase: string;
  hasImage: boolean;
  complexity: BuildComplexityBucket;
  round1Ms: number | null;
  durationMs: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  modelUsed: string | null;
  failureKind?: "safety_policy" | "upstream_or_timeout";
  errorMsg?: string | null;
  errorDetail?: string | null;
}

export interface BuildDiagnosticsSummary {
  modelCascade: string[];
  fallbackRate: number;
  countsLast36h: {
    done: number;
    failed: number;
    active: number;
    queued: number;
  };
  recentFailures: SanitizedBuildJobDiagnostic[];
  recentCompleted: SanitizedBuildJobDiagnostic[];
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const len2 = vx * vx + vz * vz;
  if (len2 < 0.001) return Math.hypot(px - ax, pz - az);
  const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2));
  return Math.hypot(px - (ax + t * vx), pz - (az + t * vz));
}

export class WorldDO extends DurableObject<Env> {
  private activeJobPromises = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", JSON.stringify({ type: "pong" })),
    );
    this.ctx.blockConcurrencyWhile(async () => {
      this.initSchemaAndSeed();
    });
  }

  private initSchemaAndSeed(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS creations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        integrated_level INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paths (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS props (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS terrain_zones (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS villagers (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS creators (
        token TEXT PRIMARY KEY,
        creation_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS creator_builds (
        creation_id TEXT PRIMARY KEY,
        cookie_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_creator_builds_cookie_day
        ON creator_builds (cookie_id, day_key);
      CREATE TABLE IF NOT EXISTS integration_queue (
        creation_id TEXT PRIMARY KEY,
        queued_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inflight_locks (
        lock_key TEXT PRIMARY KEY,
        lock_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS build_jobs (
        job_id TEXT PRIMARY KEY,
        cookie_id TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        day_key TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'queued',
        round1_ms INTEGER,
        has_image INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        image_base64 TEXT,
        image_mime TEXT,
        req_x REAL,
        req_z REAL,
        req_yaw REAL,
        sim_delay_ms INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        creation_id TEXT,
        model_used TEXT,
        error_msg TEXT,
        error_detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_build_jobs_cookie_day
        ON build_jobs (cookie_id, day_key);
      CREATE INDEX IF NOT EXISTS idx_build_jobs_status_created
        ON build_jobs (status, created_at);
      CREATE TABLE IF NOT EXISTS build_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        duration_ms INTEGER NOT NULL,
        round1_ms INTEGER NOT NULL,
        had_refinement INTEGER NOT NULL DEFAULT 0,
        used_fallback INTEGER NOT NULL DEFAULT 0,
        has_image INTEGER NOT NULL DEFAULT 0,
        complexity TEXT NOT NULL DEFAULT 'standard',
        scale_class TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_build_telemetry_created
        ON build_telemetry (created_at DESC);
      CREATE TABLE IF NOT EXISTS og_snapshots (
        variant TEXT PRIMARY KEY,
        b64 TEXT NOT NULL,
        captured_at INTEGER NOT NULL
      );
    `);

    const seeded = sql.exec(`SELECT value FROM meta WHERE key = 'seeded'`).toArray();
    if (seeded.length === 0) {
      const seed = buildSeedWorld();
      for (const c of seed.creations) {
        sql.exec(
          `INSERT OR REPLACE INTO creations (id, created_at, integrated_level, json) VALUES (?, ?, ?, ?)`,
          c.id,
          c.createdAt,
          c.integratedLevel,
          JSON.stringify(c),
        );
      }
      for (const p of seed.paths) {
        sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, p.id, JSON.stringify(p));
      }
      for (const pr of seed.props) {
        sql.exec(`INSERT OR REPLACE INTO props (id, json) VALUES (?, ?)`, pr.id, JSON.stringify(pr));
      }
      for (const tz of seed.terrainZones) {
        sql.exec(
          `INSERT OR REPLACE INTO terrain_zones (id, json) VALUES (?, ?)`,
          tz.id,
          JSON.stringify(tz),
        );
      }
      for (const v of seed.villagers) {
        sql.exec(`INSERT OR REPLACE INTO villagers (id, json) VALUES (?, ?)`, v.id, JSON.stringify(v));
      }
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('version', '1')`);
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastWeaveNote', ?)`, seed.lastWeaveNote);
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastWeaveAt', ?)`, String(Date.now()));
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '1')`);
    }

    // Non-destructive v3 upgrade: backfill liveFeed on seed landmarks & trim excess cron-spawned villagers
    const upgradedV3 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v3'`).toArray();
    if (upgradedV3.length === 0) {
      const seedFeedDefaults: Record<string, WorldCreation["liveFeed"]> = {
        "seed-windmill-bakery": { kind: "wind", place: "GeminIsland", lat: -33.87, lon: 151.21 },
        "seed-clocktower-station": { kind: "time", place: "GeminIsland", timezone: "Australia/Sydney" },
      };
      for (const [seedId, feed] of Object.entries(seedFeedDefaults)) {
        const rows = sql.exec(`SELECT json FROM creations WHERE id = ?`, seedId).toArray();
        if (rows.length > 0) {
          const parsed = JSON.parse(String(rows[0].json)) as WorldCreation;
          if (!parsed.liveFeed) {
            parsed.liveFeed = feed;
            sql.exec(`UPDATE creations SET json = ? WHERE id = ?`, JSON.stringify(parsed), seedId);
          }
        }
      }
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v3', '1')`);
      this.bumpVersion();
    }

    // Non-destructive v4 cleanup: trim excess idle-cron footpath/prop/villager clutter
    const upgradedV4 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v4'`).toArray();
    if (upgradedV4.length === 0) {
      const allCreations = sql
        .exec(`SELECT json FROM creations`)
        .toArray()
        .map((r) => JSON.parse(String(r.json)) as WorldCreation);
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastWeaveCount', ?)`, String(allCreations.length));
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v4', '1')`);
      this.bumpVersion();
    }

    // Non-destructive v5 upgrade: refresh seed blueprints and run kinematic voxel overlap audit
    const upgradedV5 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v5_voxel_audit'`).toArray();
    if (upgradedV5.length === 0) {
      const freshSeed = buildSeedWorld();
      const seedBlueprintMap = new Map(freshSeed.creations.map((c) => [c.id, c.blueprint]));

      const existingRows = sql.exec(`SELECT id, json FROM creations`).toArray();
      for (const row of existingRows) {
        const cid = String(row.id);
        const cleanSeedBp = seedBlueprintMap.get(cid);
        if (cleanSeedBp) {
          const parsed = JSON.parse(String(row.json)) as WorldCreation;
          parsed.blueprint = cleanSeedBp;
          sql.exec(`UPDATE creations SET json = ? WHERE id = ?`, JSON.stringify(parsed), cid);
        }
      }

      this.auditAndRepairWorld();
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v5_voxel_audit', '1')`);
      this.bumpVersion();
    }

    // Non-destructive v6 upgrade: 1 creation per individual (cookie) per day
    const upgradedV6 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v6_daily_individual'`).toArray();
    if (upgradedV6.length === 0) {
      const legacyCookieRows = sql
        .exec(`SELECT token, creation_id, created_at FROM creators WHERE token LIKE 'cid:%'`)
        .toArray();
      for (const row of legacyCookieRows) {
        const cookieId = String(row.token).slice(4);
        const creationId = String(row.creation_id);
        const createdAt = Number(row.created_at) || Date.now();
        if (cookieId && creationId) {
          const dayKey = formatDayKeyInTz(createdAt, "Australia/Sydney");
          sql.exec(
            `INSERT OR IGNORE INTO creator_builds (creation_id, cookie_id, day_key, created_at) VALUES (?, ?, ?, ?)`,
            creationId,
            cookieId,
            dayKey,
            createdAt,
          );
        }
      }
      sql.exec(`DELETE FROM creators WHERE token LIKE 'ip:%'`);
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v6_daily_individual', '1')`);
    }

    // Non-destructive v8 upgrade: seed organic ground biome zones & varied path materials on existing GeminIsland worlds
    const upgradedV8 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v8_biomes_and_queue'`).toArray();
    if (upgradedV8.length === 0) {
      const freshSeed = buildSeedWorld();
      for (const tz of freshSeed.terrainZones) {
        sql.exec(
          `INSERT OR IGNORE INTO terrain_zones (id, json) VALUES (?, ?)`,
          tz.id,
          JSON.stringify(tz),
        );
      }
      // Upgrade seed spur materials (cobblestone for Clocktower, dirt_trail for Windmill Bakery & Green walk)
      for (const sp of freshSeed.paths) {
        if (sp.id === "path-clocktower-spur" || sp.id === "path-bakery-spur" || sp.id === "path-green-walk") {
          const pRows = sql.exec(`SELECT json FROM paths WHERE id = ?`, sp.id).toArray();
          if (pRows.length > 0) {
            const existingP = JSON.parse(String(pRows[0].json)) as WorldPath;
            existingP.kind = sp.kind;
            sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, sp.id, JSON.stringify(existingP));
          }
        }
      }
      // Backfill biome zones & contextual path styles for existing user-created landmarks
      const allCreations = sql
        .exec(`SELECT json FROM creations`)
        .toArray()
        .map((r) => JSON.parse(String(r.json)) as WorldCreation);
      for (const c of allCreations) {
        if (c.isSeed || c.behavior.type !== "landmark") continue;
        const { biome, pathKind } = inferBiomeAndPathStyle(c);
        if (biome) {
          const footR = getCreationFootprintRadius(
            c.scaleClass,
            c.blueprint?.stats?.footprintX ?? 14,
            c.blueprint?.stats?.footprintZ ?? 14,
          );
          const zone: WorldTerrainZone = {
            id: `initzone-${c.id}`,
            biome,
            x: c.x,
            z: c.z,
            radius: Number(Math.min(22, Math.max(7.0, footR * 1.65)).toFixed(1)),
            intensity: 0.9,
          };
          sql.exec(
            `INSERT OR IGNORE INTO terrain_zones (id, json) VALUES (?, ?)`,
            zone.id,
            JSON.stringify(zone),
          );
        }
        if (pathKind !== "footpath") {
          const initPathRows = sql.exec(`SELECT json FROM paths WHERE id = ?`, `initpath-${c.id}`).toArray();
          if (initPathRows.length > 0) {
            const p = JSON.parse(String(initPathRows[0].json)) as WorldPath;
            p.kind = pathKind;
            sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, p.id, JSON.stringify(p));
          }
        }
      }
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v8_biomes_and_queue', '1')`);
      this.bumpVersion();
    }

    const upgradedOgV2 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v8_og_v2'`).toArray();
    if (upgradedOgV2.length === 0) {
      sql.exec(`DELETE FROM og_snapshots`);
      sql.exec(`DELETE FROM meta WHERE key = 'lastOgCaptureAt'`);
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v8_og_v2', '1')`);
    }

    // Non-destructive v9 upgrade: add phase/round1_ms/has_image columns to existing build_jobs & backfill telemetry
    const jobCols = new Set(
      sql
        .exec(`PRAGMA table_info(build_jobs)`)
        .toArray()
        .map((r) => String(r.name)),
    );
    if (!jobCols.has("phase")) {
      sql.exec(`ALTER TABLE build_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'`);
    }
    if (!jobCols.has("round1_ms")) {
      sql.exec(`ALTER TABLE build_jobs ADD COLUMN round1_ms INTEGER`);
    }
    if (!jobCols.has("has_image")) {
      sql.exec(`ALTER TABLE build_jobs ADD COLUMN has_image INTEGER NOT NULL DEFAULT 0`);
    }
    if (!jobCols.has("model_used")) {
      sql.exec(`ALTER TABLE build_jobs ADD COLUMN model_used TEXT`);
    }
    if (!jobCols.has("error_detail")) {
      sql.exec(`ALTER TABLE build_jobs ADD COLUMN error_detail TEXT`);
    }

    const upgradedV9 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v9_eta_telemetry'`).toArray();
    if (upgradedV9.length === 0) {
      const doneJobs = sql
        .exec(
          `SELECT prompt, image_mime, started_at, finished_at
           FROM build_jobs
           WHERE status = 'done'
             AND started_at IS NOT NULL
             AND finished_at IS NOT NULL
             AND sim_delay_ms IS NULL
             AND (image_mime IS NULL OR image_mime != '__dev_sim_bp__')
           ORDER BY finished_at ASC`,
        )
        .toArray();
      for (const r of doneJobs) {
        const dur = Number(r.finished_at) - Number(r.started_at);
        if (dur >= 4_000 && dur <= 240_000) {
          const hasImg = typeof r.image_mime === "string" && r.image_mime.length > 0;
          const feat = classifyBuildFeatures(String(r.prompt ?? ""), hasImg);
          sql.exec(
            `INSERT INTO build_telemetry (
               duration_ms, round1_ms, had_refinement, used_fallback, has_image, complexity, scale_class, created_at
             ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?)`,
            dur,
            dur > 68_000 ? Math.round(dur * 0.54) : dur,
            dur > 68_000 ? 1 : 0,
            hasImg ? 1 : 0,
            feat.complexity,
            Number(r.finished_at) || Date.now(),
          );
        }
      }
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v9_eta_telemetry', '1')`);
    }

    // Recover any interrupted sculpting jobs after a cold Worker/DO restart
    const orphaned = sql
      .exec(`SELECT job_id FROM build_jobs WHERE status = 'sculpting'`)
      .toArray();
    if (orphaned.length > 0) {
      sql.exec(
        `UPDATE build_jobs SET status = 'queued', phase = 'queued', started_at = NULL, round1_ms = NULL WHERE status = 'sculpting'`,
      );
    }

    // Prune completed/failed build jobs older than 36 hours
    sql.exec(
      `DELETE FROM build_jobs WHERE status IN ('done', 'failed') AND created_at < ?`,
      Date.now() - 36 * 60 * 60 * 1000,
    );

    // Lightweight startup overlap & planar road-crossing repair (< 4ms, zero LLM calls)
    const bootAudit = this.auditAndRepairWorld();
    const upgradedV14 = sql
      .exec(`SELECT value FROM meta WHERE key = 'upgrade_v14_refined_roads' LIMIT 1`)
      .toArray();
    if (upgradedV14.length === 0) {
      if (bootAudit.repairedCount > 0) {
        sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastOgCaptureAt', '0')`);
      }
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v14_refined_roads', '1')`);
    }

    // Resume queue if any jobs are waiting
    const pendingJobs = Number(
      sql.exec(`SELECT COUNT(*) AS c FROM build_jobs WHERE status = 'queued'`).toArray()[0]?.c ?? 0,
    );
    if (pendingJobs > 0) {
      void this.pumpBuildQueue();
    }
  }

  private auditAndRepairWorld(): { repairedCount: number; repairs: string[] } {
    const sql = this.ctx.storage.sql;
    const repairs: string[] = [];

    const creationRows = sql.exec(`SELECT id, json FROM creations ORDER BY created_at ASC`).toArray();
    const creations: WorldCreation[] = [];

    for (const row of creationRows) {
      const cid = String(row.id);
      const parsed = JSON.parse(String(row.json)) as WorldCreation;
      const audit = auditBlueprintOverlaps(parsed.blueprint);
      if (!audit.clean) {
        const healed = autoRepairBlueprintOverlaps(parsed.blueprint);
        parsed.blueprint = healed.blueprint;
        sql.exec(`UPDATE creations SET json = ? WHERE id = ?`, JSON.stringify(parsed), cid);
        repairs.push(
          `${parsed.name} (${cid}): ${healed.repairsApplied.join("; ") || "cleared voxel overlap"}`,
        );
      }
      creations.push(parsed);
    }

    const pathRows = sql.exec(`SELECT id, json FROM paths`).toArray();
    const paths = pathRows.map((r) => JSON.parse(String(r.json)) as WorldPath);
    const propRows = sql.exec(`SELECT id, json FROM props`).toArray();
    const props = propRows.map((r) => JSON.parse(String(r.json)) as WorldProp);

    const spatial = auditAndRepairWorldSpatial(creations, paths, props);
    if (!spatial.report.clean) {
      const keptPathIds = new Set(spatial.paths.map((p) => p.id));
      for (const row of pathRows) {
        const oldId = String(row.id);
        if (!keptPathIds.has(oldId)) {
          sql.exec(`DELETE FROM paths WHERE id = ?`, oldId);
        }
      }
      for (const p of spatial.paths) {
        sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, p.id, JSON.stringify(p));
      }
      const keptPropIds = new Set(spatial.props.map((pr) => pr.id));
      for (const row of propRows) {
        const oldPropId = String(row.id);
        if (!keptPropIds.has(oldPropId)) {
          sql.exec(`DELETE FROM props WHERE id = ?`, oldPropId);
        }
      }
      for (const pr of spatial.props) {
        sql.exec(`INSERT OR REPLACE INTO props (id, json) VALUES (?, ?)`, pr.id, JSON.stringify(pr));
      }
      repairs.push(...spatial.report.details);
    }

    // Ensure every active vehicle_route creation cruises strictly on accepted asphalt roads (no off-road detours!)
    const acceptedRoadCurves = spatial.paths
      .filter((p) => p.kind === "road" && p.points.length >= 3)
      .map((p) => ({
        path: p,
        curve: sampleCatmullRom2D(p.points, Boolean(p.closed), 0.7),
      }));
    const mainLoopEntry =
      acceptedRoadCurves.find((r) => r.path.id === "path-main-loop") ?? acceptedRoadCurves[0];
    if (mainLoopEntry) {
      let vehIdx = 0;
      for (const c of creations) {
        if (c.behavior?.type !== "vehicle_route") continue;
        const myVehSlot = vehIdx++;
        const wps = c.behavior.waypoints ?? [];
        const hasOffRoadWaypoint =
          wps.length < 4 ||
          wps.some(
            ([wx, wz]) =>
              !acceptedRoadCurves.some(
                (rc) => distPointToPolyline2D(wx, wz, rc.curve).dist <= 3.2,
              ),
          );
        if (hasOffRoadWaypoint) {
          const basePts = mainLoopEntry.path.points;
          const shift = (myVehSlot * Math.floor(basePts.length / 2)) % basePts.length;
          const alignedWps: [number, number][] = basePts.map((_, idx) => {
            const p = basePts[(idx + shift) % basePts.length];
            return [p[0], p[1]];
          });
          const rawStops = c.behavior.stops ?? [];
          const alignedStops = rawStops
            .map((st) => {
              const h = distPointToPolyline2D(st.x, st.z, mainLoopEntry.curve);
              return {
                ...st,
                x: Math.round(h.closestX * 10) / 10,
                z: Math.round(h.closestZ * 10) / 10,
              };
            })
            .filter(
              (st, idx, arr) =>
                arr.findIndex((o) => Math.hypot(o.x - st.x, o.z - st.z) < 6.0) === idx,
            )
            .slice(0, 5);
          c.x = alignedWps[0][0];
          c.z = alignedWps[0][1];
          c.behavior = {
            ...c.behavior,
            waypoints: alignedWps,
            stops:
              alignedStops.length >= 2
                ? alignedStops
                : [
                    {
                      id: `stop-${c.id}-north`,
                      name: "Clocktower Station",
                      x: basePts[1][0],
                      z: basePts[1][1],
                      dwellSec: 4.0,
                    },
                    {
                      id: `stop-${c.id}-south`,
                      name: "Clover Pond South",
                      x: basePts[5 % basePts.length][0],
                      z: basePts[5 % basePts.length][1],
                      dwellSec: 4.0,
                    },
                  ],
          };
          sql.exec(`UPDATE creations SET json = ? WHERE id = ?`, JSON.stringify(c), c.id);
          repairs.push(`aligned vehicle "${c.name}" (${c.id}) cleanly onto village ring road`);
        }
      }
    }

    const now = Date.now();
    this.setMeta("lastAuditAt", String(now));
    if (repairs.length > 0) {
      const prevTotal = Number(this.getMeta("totalAutoRepairs", "0")) || 0;
      this.setMeta("totalAutoRepairs", String(prevTotal + repairs.length));
      this.setMeta("lastAuditNote", `Auto-repaired ${repairs.length} overlap(s): ${repairs.slice(0, 3).join(" | ")}`);
      this.bumpVersion();
    } else if (!this.getMeta("lastAuditNote")) {
      this.setMeta("lastAuditNote", "All voxel blueprints, parts, paths, and plinths verified overlap-free.");
    }

    return { repairedCount: repairs.length, repairs };
  }

  public getWorldAuditReport(): WorldAuditSummary {
    const world = this.readBaseWorld();
    let blueprintConflicts = 0;
    const creationEntries: WorldCreationAuditEntry[] = [];

    for (const c of world.creations) {
      const r = auditBlueprintOverlaps(c.blueprint);
      blueprintConflicts += r.totalConflicts;
      creationEntries.push({
        id: c.id,
        name: c.name,
        clean: r.clean,
        overlapCells: r.overlapCells,
        coplanarFaces: r.coplanarFaces,
        groundClips: r.groundClips,
        partsCount: c.blueprint.parts.length,
      });
    }

    const spatial = auditAndRepairWorldSpatial(world.creations, world.paths, world.props);
    const crossings = detectPathCrossings(world.paths);
    const spatialConflicts =
      spatial.report.footpathTrimCount +
      spatial.report.pathCrossingsFixed +
      spatial.report.redundantPathsRemoved +
      spatial.report.propNudgeCount +
      crossings.count;

    return {
      ok: true,
      clean: blueprintConflicts === 0 && spatialConflicts === 0,
      creationsChecked: world.creations.length,
      blueprintConflicts,
      spatialConflicts,
      pathCrossings: crossings.count,
      totalAutoRepairs: Number(this.getMeta("totalAutoRepairs", "0")) || 0,
      lastAuditAt: Number(this.getMeta("lastAuditAt", String(Date.now()))) || Date.now(),
      lastAuditNote: this.getMeta("lastAuditNote", "Verified clean"),
      creations: creationEntries,
    };
  }

  public runWorldAuditAndRepair(): {
    repairedCount: number;
    repairs: string[];
    audit: WorldAuditSummary;
  } {
    const res = this.auditAndRepairWorld();
    if (res.repairedCount > 0) {
      const refreshed = this.readBaseWorld();
      this.broadcast({
        type: "world_updated",
        note: `Orchestrator repaired ${res.repairedCount} voxel overlap(s).`,
        world: { ...refreshed, myCreationId: null },
      });
    }
    return {
      repairedCount: res.repairedCount,
      repairs: res.repairs,
      audit: this.getWorldAuditReport(),
    };
  }

  public loadDevWorldSnapshot(snapshot: {
    creations?: WorldCreation[];
    paths?: WorldPath[];
    props?: WorldProp[];
    terrainZones?: WorldTerrainZone[];
    villagers?: WorldVillager[];
  }): {
    repairedCount: number;
    repairs: string[];
    pathsAfter: number;
    propsAfter: number;
    audit: WorldAuditSummary;
  } {
    const sql = this.ctx.storage.sql;
    if (Array.isArray(snapshot.creations)) {
      sql.exec(`DELETE FROM creations`);
      for (const c of snapshot.creations) {
        sql.exec(
          `INSERT OR REPLACE INTO creations (id, created_at, integrated_level, json)
           VALUES (?, ?, ?, ?)`,
          c.id,
          c.createdAt || Date.now(),
          c.integratedLevel ?? 2,
          JSON.stringify(c),
        );
      }
    }
    if (Array.isArray(snapshot.paths)) {
      sql.exec(`DELETE FROM paths`);
      for (const p of snapshot.paths) {
        sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, p.id, JSON.stringify(p));
      }
    }
    if (Array.isArray(snapshot.props)) {
      sql.exec(`DELETE FROM props`);
      for (const pr of snapshot.props) {
        sql.exec(`INSERT OR REPLACE INTO props (id, json) VALUES (?, ?)`, pr.id, JSON.stringify(pr));
      }
    }
    if (Array.isArray(snapshot.terrainZones)) {
      sql.exec(`DELETE FROM terrain_zones`);
      for (const tz of snapshot.terrainZones) {
        sql.exec(
          `INSERT OR REPLACE INTO terrain_zones (id, json) VALUES (?, ?)`,
          tz.id,
          JSON.stringify(tz),
        );
      }
    }
    if (Array.isArray(snapshot.villagers)) {
      sql.exec(`DELETE FROM villagers`);
      for (const v of snapshot.villagers) {
        sql.exec(`INSERT OR REPLACE INTO villagers (id, json) VALUES (?, ?)`, v.id, JSON.stringify(v));
      }
    }
    const repairRes = this.auditAndRepairWorld();
    const after = this.readBaseWorld();
    this.bumpVersion();
    return {
      ...repairRes,
      pathsAfter: after.paths.length,
      propsAfter: after.props.length,
      audit: this.getWorldAuditReport(),
    };
  }

  private getMeta(key: string, fallback = ""): string {
    const rows = this.ctx.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    return rows.length > 0 ? String(rows[0].value) : fallback;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, value);
  }

  private bumpVersion(): number {
    const next = (parseInt(this.getMeta("version", "1"), 10) || 1) + 1;
    this.setMeta("version", String(next));
    return next;
  }

  private readTelemetryHistory(): BuildTelemetrySample[] {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT duration_ms, round1_ms, had_refinement, used_fallback, has_image, complexity, created_at
         FROM build_telemetry
         ORDER BY created_at DESC, id DESC
         LIMIT 90`,
      )
      .toArray();
    return rows.map((r) => {
      const rawComp = String(r.complexity ?? "standard");
      const complexity: BuildComplexityBucket =
        rawComp === "compact" || rawComp === "complex" ? rawComp : "standard";
      return {
        durationMs: Number(r.duration_ms) || DEFAULT_AVG_SCULPT_MS,
        round1Ms: Number(r.round1_ms) || Number(r.duration_ms) || DEFAULT_AVG_SCULPT_MS,
        hadRefinementPass: Number(r.had_refinement) === 1,
        usedFallback: Number(r.used_fallback) === 1,
        hasImage: Number(r.has_image) === 1,
        complexity,
        createdAt: Number(r.created_at) || Date.now(),
      };
    });
  }

  public recordBuildTelemetry(sample: {
    durationMs: number;
    round1Ms: number;
    hadRefinementPass: boolean;
    usedFallback: boolean;
    hasImage: boolean;
    complexity: BuildComplexityBucket;
    scaleClass?: string | null;
  }): void {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 4_000 || sample.durationMs > 240_000) {
      return;
    }
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const totalMs = Math.round(sample.durationMs);
    const r1Ms = Math.max(1_000, Math.min(totalMs, Math.round(sample.round1Ms || totalMs)));
    sql.exec(
      `INSERT INTO build_telemetry (
         duration_ms, round1_ms, had_refinement, used_fallback, has_image, complexity, scale_class, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      totalMs,
      r1Ms,
      sample.hadRefinementPass ? 1 : 0,
      sample.usedFallback ? 1 : 0,
      sample.hasImage ? 1 : 0,
      sample.complexity,
      sample.scaleClass ?? null,
      now,
    );
    // Keep table compact (most recent 150 builds)
    sql.exec(
      `DELETE FROM build_telemetry
       WHERE id NOT IN (
         SELECT id FROM build_telemetry ORDER BY created_at DESC, id DESC LIMIT 150
       )`,
    );
    const updatedStandardMs = estimateInitialBuildMs(
      { complexity: "standard", hasImage: false },
      this.readTelemetryHistory(),
    );
    this.setMeta("avgSculptMs", String(updatedStandardMs));
  }

  public getBuildEtaTelemetry(): BuildEtaTelemetrySummary {
    return summarizeTelemetryStats(this.readTelemetryHistory());
  }

  public getBuildDiagnostics(): BuildDiagnosticsSummary {
    const sql = this.ctx.storage.sql;
    const history = this.readTelemetryHistory();
    const fallbackCount = history.filter((s) => s.usedFallback).length;
    const fallbackRate =
      history.length > 0 ? Number((fallbackCount / history.length).toFixed(3)) : 0;

    const statusRows = sql
      .exec(`SELECT status, COUNT(*) AS c FROM build_jobs GROUP BY status`)
      .toArray();
    const counts = { done: 0, failed: 0, active: 0, queued: 0 };
    for (const r of statusRows) {
      const st = String(r.status);
      const c = Number(r.c) || 0;
      if (st === "done") counts.done = c;
      else if (st === "failed") counts.failed = c;
      else if (st === "sculpting") counts.active = c;
      else if (st === "queued") counts.queued = c;
    }

    const toDiagnostic = (r: Record<string, unknown>, status: "done" | "failed"): SanitizedBuildJobDiagnostic => {
      const hasImage = Number(r.has_image) === 1;
      const feat = classifyBuildFeatures(String(r.prompt ?? ""), hasImage);
      const startedAt = typeof r.started_at === "number" ? r.started_at : null;
      const finishedAt = typeof r.finished_at === "number" ? r.finished_at : null;
      const durationMs =
        startedAt !== null && finishedAt !== null && finishedAt >= startedAt
          ? finishedAt - startedAt
          : null;
      const rawErrMsg =
        typeof r.error_msg === "string"
          ? redactSecrets(r.error_msg, [this.env.GEMINI_API_KEY, this.env.CREATOR_HMAC_SECRET])
          : null;
      const isSafetyRejection =
        typeof rawErrMsg === "string" &&
        /^(I cannot|That creation doesn't fit|Let's keep our shared meadow|Please try creating something family-friendly)/i.test(
          rawErrMsg.trim(),
        );
      return {
        jobId: String(r.job_id),
        status,
        phase: String(r.phase ?? "queued"),
        hasImage,
        complexity: feat.complexity,
        round1Ms: typeof r.round1_ms === "number" ? r.round1_ms : null,
        durationMs,
        createdAt: Number(r.created_at) || 0,
        startedAt,
        finishedAt,
        modelUsed: typeof r.model_used === "string" ? r.model_used : null,
        ...(status === "failed"
          ? {
              failureKind: isSafetyRejection ? "safety_policy" : "upstream_or_timeout",
              errorMsg: isSafetyRejection ? "Blocked by family-friendly safety filter." : rawErrMsg,
              errorDetail:
                typeof r.error_detail === "string"
                  ? redactSecrets(r.error_detail, [this.env.GEMINI_API_KEY, this.env.CREATOR_HMAC_SECRET])
                  : null,
            }
          : {}),
      };
    };

    const failedRows = sql
      .exec(
        `SELECT job_id, status, phase, round1_ms, has_image, prompt, created_at, started_at, finished_at, model_used, error_msg, error_detail
         FROM build_jobs
         WHERE status = 'failed'
         ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
         LIMIT 10`,
      )
      .toArray();

    const completedRows = sql
      .exec(
        `SELECT job_id, status, phase, round1_ms, has_image, prompt, created_at, started_at, finished_at, model_used
         FROM build_jobs
         WHERE status = 'done'
           AND sim_delay_ms IS NULL
           AND (image_mime IS NULL OR image_mime != '__dev_sim_bp__')
         ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
         LIMIT 8`,
      )
      .toArray();

    return {
      modelCascade: buildGeminiModelCascade({
        primaryModel: this.env.ARGON_MODEL,
        bariumModels: this.env.BARIUM_MODELS,
        fallbackModel: this.env.FALLBACK_MODEL,
      }),
      fallbackRate,
      countsLast36h: counts,
      recentFailures: failedRows.map((r) => toDiagnostic(r as Record<string, unknown>, "failed")),
      recentCompleted: completedRows.map((r) => toDiagnostic(r as Record<string, unknown>, "done")),
    };
  }

  private getAvgSculptMs(): number {
    return estimateInitialBuildMs(
      { complexity: "standard", hasImage: false },
      this.readTelemetryHistory(),
    );
  }

  private readBaseWorld(): Omit<WorldStateSnapshot, "myCreationId"> {
    const sql = this.ctx.storage.sql;
    const creations = sql
      .exec(`SELECT json FROM creations ORDER BY created_at ASC`)
      .toArray()
      .map((r) => JSON.parse(String(r.json)) as WorldCreation);
    const paths = sql
      .exec(`SELECT json FROM paths`)
      .toArray()
      .map((r) => JSON.parse(String(r.json)) as WorldPath);
    const props = sql
      .exec(`SELECT json FROM props`)
      .toArray()
      .map((r) => JSON.parse(String(r.json)) as WorldProp);
    const terrainZones = sql
      .exec(`SELECT json FROM terrain_zones`)
      .toArray()
      .map((r) => JSON.parse(String(r.json)) as WorldTerrainZone);
    const villagers = sql
      .exec(`SELECT json FROM villagers`)
      .toArray()
      .map((r) => JSON.parse(String(r.json)) as WorldVillager);
    const distinctContributors =
      Number(sql.exec(`SELECT COUNT(DISTINCT cookie_id) AS c FROM creator_builds`).toArray()[0]?.c) || 0;
    const unattributedNonSeed =
      Number(
        sql
          .exec(
            `SELECT COUNT(*) AS c FROM creations c
             WHERE c.id NOT LIKE 'seed-%'
               AND NOT EXISTS (SELECT 1 FROM creator_builds cb WHERE cb.creation_id = c.id)`,
          )
          .toArray()[0]?.c,
      ) || 0;
    const contributorCount = distinctContributors + unattributedNonSeed;

    return {
      version: parseInt(this.getMeta("version", "1"), 10) || 1,
      creations,
      paths,
      props,
      terrainZones,
      villagers,
      contributorCount,
      lastWeaveNote: this.getMeta("lastWeaveNote", "GeminIsland humming quietly in the sun."),
    };
  }

  public lookupTodayCreation(cookieId: string, dayKey: string): string | null {
    if (!cookieId || !dayKey) return null;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT creation_id FROM creator_builds
         WHERE cookie_id = ? AND day_key = ?
         ORDER BY created_at DESC LIMIT 1`,
        cookieId,
        dayKey,
      )
      .toArray();
    return rows.length > 0 ? String(rows[0].creation_id) : null;
  }

  private checkWindowBucket(
    bucket: string,
    maxCount: number,
    windowMs: number,
    now: number,
  ): { allowed: boolean; retryAfterSec?: number } {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec(`SELECT count, window_start FROM rate_limits WHERE bucket = ?`, bucket)
      .toArray();
    if (rows.length === 0) {
      return { allowed: true };
    }
    const count = Number(rows[0].count) || 0;
    const start = Number(rows[0].window_start) || now;
    if (now - start > windowMs) {
      return { allowed: true };
    }
    if (count >= maxCount) {
      return { allowed: false, retryAfterSec: Math.max(5, Math.ceil((windowMs - (now - start)) / 1000)) };
    }
    return { allowed: true };
  }

  private incrementWindowBucket(bucket: string, windowMs: number, now: number): void {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec(`SELECT count, window_start FROM rate_limits WHERE bucket = ?`, bucket)
      .toArray();
    if (rows.length === 0 || now - (Number(rows[0].window_start) || 0) > windowMs) {
      sql.exec(
        `INSERT OR REPLACE INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)`,
        bucket,
        now,
      );
      return;
    }
    const count = Number(rows[0].count) || 0;
    sql.exec(`UPDATE rate_limits SET count = ? WHERE bucket = ?`, count + 1, bucket);
  }

  private parseJobRow(r: Record<string, unknown>): BuildJobRow {
    const rawPhase = String(r.phase ?? "queued");
    const phase: BuildJobRow["phase"] =
      rawPhase === "refining" || rawPhase === "reviewing" || rawPhase === "sculpting"
        ? rawPhase
        : "queued";
    const hasImg =
      Number(r.has_image) === 1 ||
      (typeof r.image_base64 === "string" &&
        r.image_base64.length > 0 &&
        r.image_mime !== "__dev_sim_bp__")
        ? 1
        : 0;
    return {
      job_id: String(r.job_id),
      cookie_id: String(r.cookie_id),
      ip_hash: String(r.ip_hash ?? ""),
      day_key: String(r.day_key),
      status: String(r.status) as BuildJobRow["status"],
      phase,
      round1_ms: typeof r.round1_ms === "number" ? r.round1_ms : null,
      has_image: hasImg,
      prompt: String(r.prompt ?? ""),
      image_base64: typeof r.image_base64 === "string" ? r.image_base64 : null,
      image_mime: typeof r.image_mime === "string" ? r.image_mime : null,
      req_x: typeof r.req_x === "number" ? r.req_x : null,
      req_z: typeof r.req_z === "number" ? r.req_z : null,
      req_yaw: typeof r.req_yaw === "number" ? r.req_yaw : null,
      sim_delay_ms: typeof r.sim_delay_ms === "number" ? r.sim_delay_ms : null,
      created_at: Number(r.created_at) || Date.now(),
      started_at: typeof r.started_at === "number" ? r.started_at : null,
      finished_at: typeof r.finished_at === "number" ? r.finished_at : null,
      creation_id: typeof r.creation_id === "string" ? r.creation_id : null,
      model_used: typeof r.model_used === "string" ? r.model_used : null,
      error_msg: typeof r.error_msg === "string" ? r.error_msg : null,
      error_detail: typeof r.error_detail === "string" ? r.error_detail : null,
    };
  }

  private computeJobInfo(target: BuildJobRow): BuildQueueJobInfo {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const activeRows = sql
      .exec(
        `SELECT job_id, status, phase, round1_ms, has_image, prompt, started_at, sim_delay_ms, created_at
         FROM build_jobs
         WHERE status IN ('sculpting', 'queued')
         ORDER BY CASE WHEN status = 'sculpting' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`,
      )
      .toArray();

    const sculptingRows = activeRows.filter((r) => r.status === "sculpting");
    const queuedRows = activeRows.filter((r) => r.status === "queued");
    const activeCount = sculptingRows.length;
    const queuedCount = queuedRows.length;

    if (target.status === "done") {
      let creation: WorldCreation | null = null;
      if (target.creation_id) {
        const cRows = sql.exec(`SELECT json FROM creations WHERE id = ?`, target.creation_id).toArray();
        if (cRows.length > 0) {
          creation = JSON.parse(String(cRows[0].json)) as WorldCreation;
        }
      }
      return {
        jobId: target.job_id,
        status: "done",
        position: 0,
        activeCount,
        queuedCount,
        etaSeconds: 0,
        creationId: target.creation_id,
        creation,
      };
    }

    if (target.status === "failed") {
      return {
        jobId: target.job_id,
        status: "failed",
        position: 0,
        activeCount,
        queuedCount,
        etaSeconds: 0,
        error: target.error_msg || "Argon couldn't sculpt that — try again.",
      };
    }

    const history = this.readTelemetryHistory();
    const targetFeatures = classifyBuildFeatures(target.prompt, target.has_image === 1);

    if (target.status === "sculpting") {
      const elapsed = Math.max(0, now - (target.started_at ?? now));
      const activePhase: "sculpting" | "reviewing" | "refining" =
        target.phase === "refining"
          ? "refining"
          : target.phase === "reviewing"
            ? "reviewing"
            : "sculpting";
      const remainingMs =
        typeof target.sim_delay_ms === "number" && target.sim_delay_ms > 0
          ? Math.max(1_500, target.sim_delay_ms - elapsed)
          : estimateRemainingBuildMs({
              elapsedMs: elapsed,
              phase: activePhase,
              round1Ms: target.round1_ms,
              features: targetFeatures,
              history,
            });
      return {
        jobId: target.job_id,
        status: "sculpting",
        phase: activePhase,
        position: 0,
        activeCount,
        queuedCount,
        etaSeconds: Math.max(3, Math.ceil(remainingMs / 1000)),
        basedOnBuilds: history.length,
      };
    }

    // Target is waiting in FIFO queue: simulate completion across MAX_CONCURRENT_SCULPTS worker slots
    const activeSlots = sculptingRows.map((r) => ({
      elapsedMs: Math.max(0, now - (Number(r.started_at) || now)),
      phase: String(r.phase ?? "sculpting"),
      round1Ms: typeof r.round1_ms === "number" ? r.round1_ms : null,
      simDelayMs: typeof r.sim_delay_ms === "number" && r.sim_delay_ms > 0 ? r.sim_delay_ms : null,
      features: classifyBuildFeatures(String(r.prompt ?? ""), Number(r.has_image) === 1),
    }));

    const queuedItems = queuedRows.map((r) => ({
      jobId: String(r.job_id),
      simDelayMs: typeof r.sim_delay_ms === "number" && r.sim_delay_ms > 0 ? r.sim_delay_ms : null,
      features: classifyBuildFeatures(String(r.prompt ?? ""), Number(r.has_image) === 1),
    }));

    const sim = estimateMultiSlotQueueEtaMs({
      workerConcurrency: MAX_CONCURRENT_SCULPTS,
      activeSlots,
      queuedItems,
      targetJobId: target.job_id,
      targetFallbackFeatures: targetFeatures,
      history,
    });

    return {
      jobId: target.job_id,
      status: "queued",
      phase: "queued",
      position: sim.position,
      activeCount,
      queuedCount,
      etaSeconds: Math.max(4, Math.ceil(sim.totalEtaMs / 1000)),
      basedOnBuilds: history.length,
    };
  }

  private lookupActiveJobForCookie(cookieId: string, dayKey: string): BuildQueueJobInfo | null {
    if (!cookieId) return null;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT * FROM build_jobs
         WHERE cookie_id = ? AND day_key = ? AND status IN ('queued', 'sculpting')
         ORDER BY created_at DESC LIMIT 1`,
        cookieId,
        dayKey,
      )
      .toArray();
    if (rows.length === 0) return null;
    return this.computeJobInfo(this.parseJobRow(rows[0] as Record<string, unknown>));
  }

  public getBuildJobStatus(
    jobId: string | null | undefined,
    cookieId: string,
    dayKey: string,
  ): { job: BuildQueueJobInfo | null; world?: WorldStateSnapshot } {
    const sql = this.ctx.storage.sql;
    let row: BuildJobRow | null = null;
    if (jobId) {
      const rows = sql.exec(`SELECT * FROM build_jobs WHERE job_id = ? LIMIT 1`, jobId).toArray();
      if (rows.length > 0) {
        row = this.parseJobRow(rows[0] as Record<string, unknown>);
      }
    }
    if (!row && cookieId && dayKey) {
      const rows = sql
        .exec(
          `SELECT * FROM build_jobs
           WHERE cookie_id = ? AND day_key = ?
           ORDER BY created_at DESC LIMIT 1`,
          cookieId,
          dayKey,
        )
        .toArray();
      if (rows.length > 0) {
        row = this.parseJobRow(rows[0] as Record<string, unknown>);
      }
    }
    if (!row) {
      return { job: null };
    }
    const job = this.computeJobInfo(row);
    if (job.status === "done") {
      return {
        job,
        world: this.getWorldSnapshot(cookieId || row.cookie_id, dayKey || row.day_key),
      };
    }
    return { job };
  }

  /**
   * Enqueues a visitor build into the persistent FIFO multi-user queue so 10–40+ concurrent
   * builders never hit 429 concurrency errors and receive live queue positions + countdown ETAs.
   */
  public async enqueueBuildJob(input: EnqueueBuildInput): Promise<EnqueueBuildResult> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();

    if (now % 19 === 0) {
      sql.exec(`DELETE FROM rate_limits WHERE window_start < ?`, now - 25 * 60 * 60 * 1000);
    }

    // 1. Reject if THIS individual browser has already placed their 1 creation today
    const existingTodayId = this.lookupTodayCreation(input.cookieId, input.dayKey);
    if (existingTodayId) {
      return {
        ok: false,
        status: 403,
        alreadyPlaced: true,
        myCreationId: existingTodayId,
        error: "You've already added your creation for today — come back tomorrow to add another!",
      };
    }

    // 2. Idempotent resume if this browser already has a job queued or sculpting right now
    const existingJob = this.lookupActiveJobForCookie(input.cookieId, input.dayKey);
    if (existingJob) {
      void this.pumpBuildQueue();
      return { ok: true, queued: true, job: existingJob };
    }

    // 3. Bound total waiting queue depth (protects memory while comfortably handling 10-40 simultaneous builders)
    const activeTotal = Number(
      sql
        .exec(`SELECT COUNT(*) AS c FROM build_jobs WHERE status IN ('queued', 'sculpting')`)
        .toArray()[0]?.c ?? 0,
    );
    if (activeTotal >= MAX_QUEUE_DEPTH) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: 20,
        error: "The GeminIsland build queue is full right now — please try again in 20 seconds.",
      };
    }

    // 4. Multi-user office/event-friendly anti-abuse rate limits
    const visitorWindowMs = 15 * 60 * 1000;
    const hourWindowMs = 60 * 60 * 1000;
    const dayWindowMs = 24 * 60 * 60 * 1000;

    const cidCheck = this.checkWindowBucket(`gen_cid:${input.cookieId}`, 8, visitorWindowMs, now);
    if (!cidCheck.allowed) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: cidCheck.retryAfterSec,
        error: `Please wait ${cidCheck.retryAfterSec ?? 45}s before trying again.`,
      };
    }

    if (input.ipHash) {
      const ipBurstCheck = this.checkWindowBucket(`gen_ip:${input.ipHash}`, 48, visitorWindowMs, now);
      if (!ipBurstCheck.allowed) {
        return {
          ok: false,
          status: 429,
          retryAfterSec: ipBurstCheck.retryAfterSec,
          error: `Network burst limit reached — please wait ${ipBurstCheck.retryAfterSec ?? 45}s.`,
        };
      }
      const ipDailyPlaced = this.checkWindowBucket(`placed_ip:${input.ipHash}`, 60, dayWindowMs, now);
      if (!ipDailyPlaced.allowed) {
        return {
          ok: false,
          status: 429,
          retryAfterSec: ipDailyPlaced.retryAfterSec,
          error: "Daily network build limit reached — check back tomorrow!",
        };
      }
    }

    const globalHour = this.checkWindowBucket("global:hour", 180, hourWindowMs, now);
    if (!globalHour.allowed) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: globalHour.retryAfterSec,
        error: "The island workshop is resting briefly — please try again shortly.",
      };
    }
    const globalDay = this.checkWindowBucket("global:day", 800, dayWindowMs, now);
    if (!globalDay.allowed) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: globalDay.retryAfterSec,
        error: "Today's island build capacity has been reached — check back soon!",
      };
    }

    if (input.ipHash) {
      this.incrementWindowBucket(`gen_ip:${input.ipHash}`, visitorWindowMs, now);
    }
    this.incrementWindowBucket(`gen_cid:${input.cookieId}`, visitorWindowMs, now);
    this.incrementWindowBucket("global:hour", hourWindowMs, now);
    this.incrementWindowBucket("global:day", dayWindowMs, now);

    const jobId = `job-${now.toString(36)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
    const hasImgFlag = input.imageBase64 && input.imageMimeType ? 1 : 0;
    sql.exec(
      `INSERT INTO build_jobs (
        job_id, cookie_id, ip_hash, day_key, status, phase, has_image, prompt, image_base64, image_mime,
        req_x, req_z, req_yaw, sim_delay_ms, created_at
      ) VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      jobId,
      input.cookieId,
      input.ipHash || "",
      input.dayKey,
      hasImgFlag,
      input.prompt,
      input.imageBase64 ?? null,
      input.imageMimeType ?? null,
      typeof input.x === "number" && Number.isFinite(input.x) ? input.x : null,
      typeof input.z === "number" && Number.isFinite(input.z) ? input.z : null,
      typeof input.yaw === "number" && Number.isFinite(input.yaw) ? input.yaw : null,
      now,
    );

    // Immediately promote up to MAX_CONCURRENT_SCULPTS jobs before computing the caller's live position!
    await this.pumpBuildQueue();

    const freshRows = sql.exec(`SELECT * FROM build_jobs WHERE job_id = ? LIMIT 1`, jobId).toArray();
    const jobInfo = this.computeJobInfo(this.parseJobRow(freshRows[0] as Record<string, unknown>));
    return { ok: true, queued: true, job: jobInfo };
  }

  /**
   * Local-dev-only deterministic multi-user queue harness: enqueues N simulated builders
   * so we can test 12+ simultaneous visitors in real Chrome without burning 12 LLM calls.
   */
  public async enqueueDevSimulatedBatch(
    items: {
      cookieId: string;
      prompt: string;
      delayMs: number;
      refineAfterMs?: number;
      placeBlueprint?: Record<string, unknown> | null;
    }[],
    dayKey: string,
  ): Promise<BuildQueueJobInfo[]> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const createdIds: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const jobId = `simjob-${now.toString(36)}-${i}-${crypto.randomUUID().slice(0, 4)}`;
      const encodedPayload = it.placeBlueprint ? JSON.stringify(it.placeBlueprint) : null;
      const refineAt =
        typeof it.refineAfterMs === "number" && it.refineAfterMs > 0
          ? Math.round(it.refineAfterMs)
          : null;
      sql.exec(
        `INSERT INTO build_jobs (
          job_id, cookie_id, ip_hash, day_key, status, phase, round1_ms, has_image, prompt, image_base64, image_mime,
          req_x, req_z, req_yaw, sim_delay_ms, created_at
        ) VALUES (?, ?, 'sim', ?, 'queued', 'queued', ?, 0, ?, ?, '__dev_sim_bp__', NULL, NULL, NULL, ?, ?)`,
        jobId,
        it.cookieId,
        dayKey,
        refineAt,
        it.prompt,
        encodedPayload,
        Math.max(800, Math.min(30_000, it.delayMs)),
        now + i,
      );
      createdIds.push(jobId);
    }

    await this.pumpBuildQueue();

    return createdIds.map((jid) => {
      const r = sql.exec(`SELECT * FROM build_jobs WHERE job_id = ?`, jid).toArray()[0] as Record<string, unknown>;
      return this.computeJobInfo(this.parseJobRow(r));
    });
  }

  private broadcastQueueTick(): void {
    const sql = this.ctx.storage.sql;
    const history = this.readTelemetryHistory();
    const avgMs = estimateInitialBuildMs({ complexity: "standard", hasImage: false }, history);
    const activeRows = sql
      .exec(
        `SELECT job_id, status, phase, has_image, prompt, started_at, sim_delay_ms
         FROM build_jobs
         WHERE status IN ('sculpting', 'queued')
         ORDER BY CASE WHEN status = 'sculpting' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`,
      )
      .toArray();
    const sculpting = activeRows
      .filter((r) => r.status === "sculpting")
      .map((r) => ({
        jobId: String(r.job_id),
        phase: String(r.phase ?? "sculpting"),
        startedAt: Number(r.started_at) || Date.now(),
        expectedMs:
          typeof r.sim_delay_ms === "number" && r.sim_delay_ms > 0
            ? r.sim_delay_ms
            : estimateInitialBuildMs(
                classifyBuildFeatures(String(r.prompt ?? ""), Number(r.has_image) === 1),
                history,
              ),
      }));
    const queuedIds = activeRows.filter((r) => r.status === "queued").map((r) => String(r.job_id));

    this.broadcast({
      type: "queue_tick",
      activeCount: sculpting.length,
      sculpting,
      queuedIds,
      avgSculptMs: avgMs,
    });
  }

  private async pumpBuildQueue(): Promise<void> {
    const sql = this.ctx.storage.sql;
    let promoted = false;

    while (this.activeJobPromises.size < MAX_CONCURRENT_SCULPTS) {
      const nextRows = sql
        .exec(
          `SELECT * FROM build_jobs
           WHERE status = 'queued'
           ORDER BY created_at ASC, rowid ASC
           LIMIT 1`,
        )
        .toArray();
      if (nextRows.length === 0) break;

      const row = this.parseJobRow(nextRows[0] as Record<string, unknown>);
      if (this.activeJobPromises.has(row.job_id)) break;

      const startedAt = Date.now();
      sql.exec(
        `UPDATE build_jobs SET status = 'sculpting', phase = 'sculpting', started_at = ? WHERE job_id = ?`,
        startedAt,
        row.job_id,
      );
      row.status = "sculpting";
      row.phase = "sculpting";
      row.started_at = startedAt;
      promoted = true;

      const p = this.runSingleBuildJob(row).finally(() => {
        this.activeJobPromises.delete(row.job_id);
        void this.pumpBuildQueue();
      });
      this.activeJobPromises.set(row.job_id, p);
    }

    if (promoted) {
      this.broadcastQueueTick();
    }

    const remainingQueued = Number(
      sql.exec(`SELECT COUNT(*) AS c FROM build_jobs WHERE status = 'queued'`).toArray()[0]?.c ?? 0,
    );
    const remainingIntegrations = Number(
      sql.exec(`SELECT COUNT(*) AS c FROM integration_queue`).toArray()[0]?.c ?? 0,
    );
    if (this.activeJobPromises.size > 0 || remainingQueued > 0 || remainingIntegrations > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1200);
    }
  }

  private async runSingleBuildJob(job: BuildJobRow): Promise<void> {
    const sql = this.ctx.storage.sql;
    const t0 = Date.now();

    try {
      // Dev-only simulated queue worker path (never reachable from public routes)
      if (job.image_mime === "__dev_sim_bp__" && job.sim_delay_ms) {
        if (typeof job.round1_ms === "number" && job.round1_ms > 0 && job.round1_ms < job.sim_delay_ms) {
          await new Promise((resolve) => setTimeout(resolve, job.round1_ms!));
          sql.exec(`UPDATE build_jobs SET phase = 'refining' WHERE job_id = ?`, job.job_id);
          this.broadcastQueueTick();
          await new Promise((resolve) => setTimeout(resolve, job.sim_delay_ms! - job.round1_ms!));
        } else {
          await new Promise((resolve) => setTimeout(resolve, job.sim_delay_ms!));
        }
        let creationId: string | null = null;
        if (job.image_base64) {
          const bpRaw = JSON.parse(job.image_base64) as Record<string, unknown>;
          const placed = await this.placeCreation({
            ipHash: job.ip_hash,
            cookieId: job.cookie_id,
            dayKey: job.day_key,
            creatorPrompt: job.prompt,
            blueprintRaw: bpRaw,
            x: job.req_x,
            z: job.req_z,
            yaw: job.req_yaw,
          });
          if (placed.ok) {
            creationId = placed.creation.id;
          }
        }
        sql.exec(
          `UPDATE build_jobs
           SET status = 'done', finished_at = ?, creation_id = ?, image_base64 = NULL, image_mime = NULL
           WHERE job_id = ?`,
          Date.now(),
          creationId,
          job.job_id,
        );
        this.broadcastQueueTick();
        return;
      }

      if (!this.env.GEMINI_API_KEY) {
        sql.exec(
          `UPDATE build_jobs
           SET status = 'failed', finished_at = ?, error_msg = ?, image_base64 = NULL
           WHERE job_id = ?`,
          Date.now(),
          "Sculpting service is temporarily unavailable.",
          job.job_id,
        );
        this.broadcastQueueTick();
        return;
      }

      const hasImg = Boolean(job.has_image || (job.image_base64 && job.image_mime));
      const features = classifyBuildFeatures(job.prompt, hasImg);

      const sculpted = await sculptWithArgon(
        {
          prompt: job.prompt,
          imageBase64: job.image_base64 ?? undefined,
          imageMimeType: job.image_mime ?? undefined,
          onPhase: (phase, r1Ms) => {
            sql.exec(
              `UPDATE build_jobs SET phase = ?, round1_ms = ? WHERE job_id = ?`,
              phase,
              Math.round(r1Ms),
              job.job_id,
            );
            this.broadcastQueueTick();
          },
        },
        this.env.GEMINI_API_KEY,
        this.env.ARGON_MODEL,
        this.env.FALLBACK_MODEL,
        this.env.BARIUM_MODELS,
      );

      if (!sculpted.ok) {
        sql.exec(
          `UPDATE build_jobs
           SET status = 'failed', finished_at = ?, error_msg = ?, error_detail = ?, image_base64 = NULL
           WHERE job_id = ?`,
          Date.now(),
          sculpted.error || "Could not sculpt creation.",
          sculpted.errorDetail
            ? redactSecrets(sculpted.errorDetail, [this.env.GEMINI_API_KEY, this.env.CREATOR_HMAC_SECRET])
            : null,
          job.job_id,
        );
        this.broadcastQueueTick();
        return;
      }

      const placed = await this.placeCreation({
        ipHash: job.ip_hash,
        cookieId: job.cookie_id,
        dayKey: job.day_key,
        creatorPrompt: job.prompt,
        blueprintRaw: sculpted.blueprint as unknown as Record<string, unknown>,
        x: job.req_x,
        z: job.req_z,
        yaw: job.req_yaw,
      });

      const finishedAt = Date.now();
      const totalBuildMs = finishedAt - t0;

      // Record end-to-end build telemetry (including sculpting + spatial placement) so future ETAs self-calibrate!
      this.recordBuildTelemetry({
        durationMs: totalBuildMs,
        round1Ms: sculpted.telemetry.round1Ms,
        hadRefinementPass: sculpted.telemetry.hadRefinementPass,
        usedFallback: sculpted.telemetry.usedFallback,
        hasImage: hasImg,
        complexity: features.complexity,
        scaleClass: placed.ok ? placed.creation.scaleClass : sculpted.blueprint.scaleClass,
      });

      if (!placed.ok) {
        sql.exec(
          `UPDATE build_jobs
           SET status = 'failed', finished_at = ?, model_used = ?, error_msg = ?, creation_id = ?, image_base64 = NULL
           WHERE job_id = ?`,
          finishedAt,
          sculpted.modelUsed,
          placed.error,
          placed.myCreationId ?? null,
          job.job_id,
        );
        this.broadcastQueueTick();
        return;
      }

      sql.exec(
        `UPDATE build_jobs
         SET status = 'done', finished_at = ?, creation_id = ?, model_used = ?, image_base64 = NULL
         WHERE job_id = ?`,
        finishedAt,
        placed.creation.id,
        sculpted.modelUsed,
        job.job_id,
      );
      this.broadcastQueueTick();
    } catch (err) {
      const redactedDetail = redactSecrets(err, [this.env.GEMINI_API_KEY, this.env.CREATOR_HMAC_SECRET]);
      safeLogError("build_queue_worker", err, [this.env.GEMINI_API_KEY, this.env.CREATOR_HMAC_SECRET]);
      sql.exec(
        `UPDATE build_jobs
         SET status = 'failed', finished_at = ?, error_msg = ?, error_detail = ?, image_base64 = NULL
         WHERE job_id = ?`,
        Date.now(),
        "Argon took a moment too long building that — please try once more.",
        redactedDetail,
        job.job_id,
      );
      this.broadcastQueueTick();
    }
  }

  public getWorldSnapshot(cookieId: string, dayKey: string): WorldStateSnapshot {
    const base = this.readBaseWorld();
    const myCreationId = this.lookupTodayCreation(cookieId, dayKey);
    const myActiveJob = !myCreationId ? this.lookupActiveJobForCookie(cookieId, dayKey) : null;
    return {
      ...base,
      myCreationId,
      myActiveJob,
    };
  }

  private isSpotClear(
    x: number,
    z: number,
    category: WorldCreation["category"],
    newRadius: number,
    world: Omit<WorldStateSnapshot, "myCreationId">,
    ignoreId?: string,
  ): boolean {
    const bound = Math.max(115, 142 - newRadius);
    if (Math.abs(x) > bound || Math.abs(z) > bound) return false;
    if (Math.hypot(x - CITY_SIGN_POS[0], z - CITY_SIGN_POS[1]) < newRadius + 2.8) return false;

    for (const c of world.creations) {
      if (c.id === ignoreId) continue;
      if (c.category === "aircraft" || c.behavior.type === "fly_circle") continue;
      if (c.category === "watercraft" || c.behavior.type === "water_float") continue;
      const otherR = getCreationFootprintRadius(
        c.scaleClass,
        c.blueprint?.stats?.footprintX ?? 14,
        c.blueprint?.stats?.footprintZ ?? 14,
      );
      const minSep = newRadius + otherR + 1.8;
      if (Math.hypot(x - c.x, z - c.z) < minSep) return false;
    }

    if (category !== "watercraft") {
      for (const pr of world.props) {
        if (pr.kind === "pond" && Math.hypot(x - pr.x, z - pr.z) < (pr.radius ?? 6.5) + newRadius + 1.4) {
          return false;
        }
      }
    }

    if (category === "building" || category === "prop") {
      const roadClear = newRadius + 2.6;
      for (const p of world.paths) {
        if (p.kind !== "road") continue;
        for (let i = 0; i < p.points.length; i++) {
          const a = p.points[i];
          const b = p.points[(i + 1) % p.points.length];
          if (!p.closed && i === p.points.length - 1) break;
          if (distToSegment(x, z, a[0], a[1], b[0], b[1]) < roadClear) return false;
        }
      }
    }
    return true;
  }

  private chooseMeadowSpot(
    reqX: number | null | undefined,
    reqZ: number | null | undefined,
    category: WorldCreation["category"],
    newRadius: number,
    world: Omit<WorldStateSnapshot, "myCreationId">,
    ignoreId?: string,
  ): [number, number] {
    if (typeof reqX === "number" && Number.isFinite(reqX) && typeof reqZ === "number" && Number.isFinite(reqZ)) {
      const cx = Math.max(-135, Math.min(135, reqX));
      const cz = Math.max(-135, Math.min(135, reqZ));
      if (this.isSpotClear(cx, cz, category, newRadius, world, ignoreId)) {
        return [Number(cx.toFixed(1)), Number(cz.toFixed(1))];
      }
      // Spiral outward from the visitor's chosen spot so massive volcanoes smoothly claim the nearest spacious clearing
      const baseAngle = Math.atan2(cz, cx);
      for (let r = 3.0; r <= 88; r += 2.8) {
        for (let k = 0; k < 20; k++) {
          const ang = baseAngle + (k / 20) * Math.PI * 2;
          const tx = cx + Math.cos(ang) * r;
          const tz = cz + Math.sin(ang) * r;
          if (this.isSpotClear(tx, tz, category, newRadius, world, ignoreId)) {
            return [Number(tx.toFixed(1)), Number(tz.toFixed(1))];
          }
        }
      }
    }

    // Golden-angle spiral around the island perimeter, starting further out for colossal landmarks
    const startR = newRadius >= 8.5 ? 42 : category === "building" ? 28 : 14;
    for (let i = 0; i < 260; i++) {
      const r = startR + Math.sqrt(i) * 5.6;
      const theta = i * 2.399963;
      const tx = Math.cos(theta) * r;
      const tz = Math.sin(theta) * r;
      if (this.isSpotClear(tx, tz, category, newRadius, world, ignoreId)) {
        return [Number(tx.toFixed(1)), Number(tz.toFixed(1))];
      }
    }
    return [46, -42];
  }

  private applyWorldPatch(patch: WorldPatch): void {
    const sql = this.ctx.storage.sql;
    const hasCustomRoad = patch.newPaths.some((p) => p.kind === "road");
    const nonRoadTrailKinds = new Set(["footpath", "dirt_trail", "cobblestone", "boardwalk", "volcanic_trail"]);

    for (const upd of patch.updatedBehaviors) {
      const rows = sql.exec(`SELECT json FROM creations WHERE id = ?`, upd.creationId).toArray();
      if (!rows.length) continue;
      const existing = JSON.parse(String(rows[0].json)) as WorldCreation;
      const wasLandmark = existing.behavior?.type === "landmark";
      const prevScale = existing.scaleClass;

      if (upd.blueprintAmendment) {
        existing.blueprint = applyBlueprintAmendment(existing.blueprint, upd.blueprintAmendment);
        existing.category = existing.blueprint.category;
        existing.scaleClass = existing.blueprint.scaleClass;
      }
      if (upd.category) {
        existing.category = upd.category;
        existing.blueprint.category = upd.category;
      }

      existing.behavior = upd.behavior;
      if (typeof upd.yaw === "number" && Number.isFinite(upd.yaw)) {
        existing.yaw = upd.yaw;
      }
      if (typeof upd.integratedLevel === "number") {
        existing.integratedLevel = Math.max(existing.integratedLevel, upd.integratedLevel);
      }
      if (upd.liveFeed && !existing.liveFeed) {
        existing.liveFeed = upd.liveFeed;
      }

      // If Argon upgraded a stationary landmark's scaleClass (e.g. medium -> colossal), ensure its plot has room!
      if (existing.scaleClass !== prevScale && upd.behavior.type === "landmark") {
        const updatedR = getCreationFootprintRadius(
          existing.scaleClass,
          existing.blueprint.stats.footprintX,
          existing.blueprint.stats.footprintZ,
        );
        const worldSnap = this.readBaseWorld();
        if (!this.isSpotClear(existing.x, existing.z, existing.category, updatedR, worldSnap, existing.id)) {
          const [nx, nz] = this.chooseMeadowSpot(
            existing.x,
            existing.z,
            existing.category,
            updatedR,
            worldSnap,
            existing.id,
          );
          existing.x = nx;
          existing.z = nz;
        }
      }

      if (upd.removeStationaryFootpath || upd.behavior.type !== "landmark") {
        sql.exec(`DELETE FROM paths WHERE id = ?`, `initpath-${upd.creationId}`);
        sql.exec(`DELETE FROM terrain_zones WHERE id = ?`, `initzone-${upd.creationId}`);
        if (wasLandmark && upd.behavior.type !== "landmark") {
          const fpRows = sql.exec(`SELECT id, json FROM paths WHERE id NOT LIKE 'path-%'`).toArray();
          for (const fpr of fpRows) {
            const p = JSON.parse(String(fpr.json)) as WorldPath;
            if (!nonRoadTrailKinds.has(p.kind) || p.points.length === 0) continue;
            const firstPt = p.points[0];
            const lastPt = p.points[p.points.length - 1];
            if (
              Math.hypot(firstPt[0] - existing.x, firstPt[1] - existing.z) < 6.8 ||
              Math.hypot(lastPt[0] - existing.x, lastPt[1] - existing.z) < 6.8
            ) {
              sql.exec(`DELETE FROM paths WHERE id = ?`, String(fpr.id));
            }
          }
        }
      }
      if ((upd.integratedLevel ?? 0) >= 2 && upd.behavior.type === "landmark" && patch.newPaths.length > 0) {
        sql.exec(`DELETE FROM paths WHERE id = ?`, `initpath-${upd.creationId}`);
      }
      if ((upd.integratedLevel ?? 0) >= 2 && (hasCustomRoad || upd.behavior.type === "vehicle_route")) {
        sql.exec(`DELETE FROM paths WHERE id = ?`, `initroad-${upd.creationId}`);
        if (patch.newProps.some((pr) => pr.kind === "bus_stop")) {
          sql.exec(`DELETE FROM props WHERE id = ?`, `initstop-${upd.creationId}`);
        }
      }
      sql.exec(
        `UPDATE creations SET integrated_level = ?, json = ? WHERE id = ?`,
        existing.integratedLevel,
        JSON.stringify(existing),
        existing.id,
      );
    }

    if (patch.removePathIds && patch.removePathIds.length > 0) {
      const protectedSeed = new Set([
        "path-main-loop",
        "path-clocktower-spur",
        "path-bakery-spur",
        "path-bookshop-spur",
        "path-green-walk",
      ]);
      for (const delPid of patch.removePathIds) {
        if (!protectedSeed.has(delPid)) {
          sql.exec(`DELETE FROM paths WHERE id = ?`, delPid);
        }
      }
    }

    const pathCount = Number(sql.exec(`SELECT COUNT(*) AS c FROM paths`).toArray()[0]?.c ?? 0);
    if (pathCount < 64) {
      for (const p of patch.newPaths) {
        sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, p.id, JSON.stringify(p));
      }
    }

    for (const tz of patch.newTerrainZones ?? []) {
      sql.exec(`INSERT OR REPLACE INTO terrain_zones (id, json) VALUES (?, ?)`, tz.id, JSON.stringify(tz));
    }
    // Keep terrain_zones bounded to 28 active zones (matching WebGL shader uniform uZones[28])
    const allZones = sql.exec(`SELECT id FROM terrain_zones`).toArray().map((r) => String(r.id));
    if (allZones.length > 28) {
      const removable = allZones.filter((id) => !id.startsWith("zone-seed-"));
      const excess = allZones.length - 28;
      for (const delId of removable.slice(0, excess)) {
        sql.exec(`DELETE FROM terrain_zones WHERE id = ?`, delId);
      }
    }

    const propCount = Number(sql.exec(`SELECT COUNT(*) AS c FROM props`).toArray()[0]?.c ?? 0);
    if (propCount < 76) {
      for (const pr of patch.newProps) {
        sql.exec(`INSERT OR REPLACE INTO props (id, json) VALUES (?, ?)`, pr.id, JSON.stringify(pr));
      }
    }

    const allCreations = sql
      .exec(`SELECT json FROM creations`)
      .toArray()
      .map((r) => JSON.parse(String(r.json)) as WorldCreation);
    const contributors = allCreations.filter((c) => !c.isSeed).length;
    const maxVillagers = Math.min(18, 6 + contributors * 2);

    const existingVillagers = sql
      .exec(`SELECT json FROM villagers`)
      .toArray()
      .map((r) => JSON.parse(String(r.json)) as WorldVillager);
    let villagerCount = existingVillagers.length;

    if (villagerCount < maxVillagers) {
      for (const v of patch.newVillagers) {
        if (villagerCount >= maxVillagers) break;
        const tooClose = existingVillagers.some(
          (ev) => Math.hypot((ev.homeX ?? 0) - v.homeX, (ev.homeZ ?? 0) - v.homeZ) < 2.2,
        );
        if (tooClose) continue;
        sql.exec(`INSERT OR REPLACE INTO villagers (id, json) VALUES (?, ?)`, v.id, JSON.stringify(v));
        existingVillagers.push(v);
        villagerCount++;
      }
    }

    if (patch.weaveNote) {
      this.setMeta("lastWeaveNote", patch.weaveNote);
    }
    this.setMeta("lastWeaveAt", String(Date.now()));
    this.bumpVersion();
  }

  public async placeCreation(input: PlaceCreationInput): Promise<PlaceCreationResult> {
    const existingId = this.lookupTodayCreation(input.cookieId, input.dayKey);
    if (existingId) {
      return {
        ok: false,
        alreadyPlaced: true,
        myCreationId: existingId,
        error: "You've already added your creation for today — come back tomorrow to add another!",
      };
    }

    const bp = normalizeAndGroundBlueprint(input.blueprintRaw, "Island Creation");
    if (bp.stats.voxels < 20) {
      return { ok: false, error: "Blueprint has too few voxels to place." };
    }

    const newRadius = getCreationFootprintRadius(
      bp.scaleClass,
      bp.stats.footprintX,
      bp.stats.footprintZ,
    );
    const worldBefore = this.readBaseWorld();
    const [x, z] = this.chooseMeadowSpot(input.x, input.z, bp.category, newRadius, worldBefore);
    const yaw =
      typeof input.yaw === "number" && Number.isFinite(input.yaw)
        ? input.yaw
        : Number(Math.atan2(-x, -z).toFixed(2));

    const now = Date.now();
    const id = `c-${now.toString(36)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;

    const cleanPrompt = sanitizePlainText(input.creatorPrompt, 240, true);
    const creation: WorldCreation = {
      id,
      name: bp.name,
      description: bp.description,
      ...(cleanPrompt ? { creatorPrompt: cleanPrompt } : {}),
      category: bp.category,
      scaleClass: bp.scaleClass,
      x,
      z,
      yaw,
      blueprint: bp,
      ...(bp.liveFeed ? { liveFeed: bp.liveFeed } : {}),
      behavior: {
        type: "landmark",
        facingYaw: yaw,
        activity: "arriving on GeminIsland",
        statusLine: "Just arrived — Argon is weaving it into GeminIsland...",
      },
      integratedLevel: 0,
      createdAt: now,
    };

    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO creations (id, created_at, integrated_level, json) VALUES (?, ?, 0, ?)`,
      creation.id,
      creation.createdAt,
      JSON.stringify(creation),
    );
    if (input.cookieId) {
      const dayKey = input.dayKey || formatDayKeyInTz(now, "Australia/Sydney");
      sql.exec(
        `INSERT OR REPLACE INTO creator_builds (creation_id, cookie_id, day_key, created_at) VALUES (?, ?, ?, ?)`,
        creation.id,
        input.cookieId,
        dayKey,
        now,
      );
      sql.exec(
        `INSERT OR REPLACE INTO creators (token, creation_id, created_at) VALUES (?, ?, ?)`,
        `cid:${input.cookieId}`,
        creation.id,
        now,
      );
    }
    if (input.ipHash) {
      this.incrementWindowBucket(`placed_ip:${input.ipHash}`, 24 * 60 * 60 * 1000, now);
    }

    // Apply instant 0ms deterministic behavior, contextual trail, and biome patch so it immediately animates!
    const worldWithNew = this.readBaseWorld();
    const initialPatch = buildInitialIntegration(worldWithNew, creation);
    this.applyWorldPatch(initialPatch);
    this.auditAndRepairWorld();

    // Reload enriched creation & snapshot
    const finalBase = this.readBaseWorld();
    const updatedCreation = finalBase.creations.find((c) => c.id === creation.id) ?? creation;

    // Broadcast live to all viewers
    this.broadcast({
      type: "creation_placed",
      creation: updatedCreation,
      world: { ...finalBase, myCreationId: null },
    });

    // Queue deep Argon background world integration via DO alarm (runs in ~250ms off the user's request path)
    sql.exec(
      `INSERT OR REPLACE INTO integration_queue (creation_id, queued_at) VALUES (?, ?)`,
      creation.id,
      now,
    );
    await this.ctx.storage.setAlarm(Date.now() + 250);

    return {
      ok: true,
      creation: updatedCreation,
      world: {
        ...finalBase,
        myCreationId: creation.id,
      },
    };
  }

  public getLastOgCaptureAt(): number {
    return Number(this.getMeta("lastOgCaptureAt", "0")) || 0;
  }

  public getOgSnapshot(
    variant: "vertical" | "square" | "landscape",
  ): { b64: string; capturedAt: number } | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT b64, captured_at FROM og_snapshots WHERE variant = ? LIMIT 1`, variant)
      .toArray();
    if (rows.length === 0) return null;
    return {
      b64: String(rows[0].b64),
      capturedAt: Number(rows[0].captured_at) || Date.now(),
    };
  }

  public saveOgSnapshots(payload: {
    vertical?: string;
    square?: string;
    landscape?: string;
    capturedAt: number;
  }): void {
    const sql = this.ctx.storage.sql;
    const ts = payload.capturedAt || Date.now();
    for (const variant of ["vertical", "square", "landscape"] as const) {
      const b64 = payload[variant];
      if (typeof b64 === "string" && b64.length > 100) {
        sql.exec(
          `INSERT OR REPLACE INTO og_snapshots (variant, b64, captured_at) VALUES (?, ?, ?)`,
          variant,
          b64,
          ts,
        );
      }
    }
    this.setMeta("lastOgCaptureAt", String(ts));
  }

  override async alarm(): Promise<void> {
    // 1. Keep the build queue moving if any jobs are queued
    await this.pumpBuildQueue();

    // 2. Process background Argon Director world-weaving integrations
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec(`SELECT creation_id FROM integration_queue ORDER BY queued_at ASC LIMIT 2`)
      .toArray();

    for (const row of rows) {
      const creationId = String(row.creation_id);
      sql.exec(`DELETE FROM integration_queue WHERE creation_id = ?`, creationId);
      if (!this.env.GEMINI_API_KEY) continue;
      try {
        const currentWorld = this.readBaseWorld();
        const patch = await integrateCreationWithArgon(
          currentWorld,
          creationId,
          this.env.GEMINI_API_KEY,
          this.env.ARGON_MODEL,
          this.env.FALLBACK_MODEL,
          this.env.BARIUM_MODELS,
        );
        if (patch) {
          this.applyWorldPatch(patch);
          this.auditAndRepairWorld();
          const refreshed = this.readBaseWorld();
          this.broadcast({
            type: "world_updated",
            note: patch.weaveNote,
            world: { ...refreshed, myCreationId: null },
          });
        }
      } catch (err) {
        safeLogError("alarm_integration", err, [this.env.GEMINI_API_KEY, this.env.CREATOR_HMAC_SECRET]);
      }
    }

    const remainingIntegrations = Number(
      sql.exec(`SELECT COUNT(*) AS c FROM integration_queue`).toArray()[0]?.c ?? 0,
    );
    const remainingQueued = Number(
      sql.exec(`SELECT COUNT(*) AS c FROM build_jobs WHERE status = 'queued'`).toArray()[0]?.c ?? 0,
    );
    if (remainingIntegrations > 0 || remainingQueued > 0 || this.activeJobPromises.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 800);
    }
  }

  /**
   * Background 3D Reviewer audit for prompt-backed creations placed prior to the critic loop.
   * Audits at most 1 unreviewed creation per idle cron tick:
   * - Good models (`approved` or `score >= 5`) have `criticReview` stamped without modifying voxels.
   * - Severe geometric misinterpretations (`!approved && score <= 4`, e.g. sliced on wrong axis or
   *   accidental CSG cylinder ceiling over an open-top halfpipe) are automatically re-sculpted in-place.
   */
  private async auditOneUnreviewedCreationWithCritic(): Promise<{
    auditedId?: string;
    healedId?: string;
    note?: string;
  }> {
    if (!this.env.GEMINI_API_KEY || this.activeJobPromises.size > 0) {
      return {};
    }
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec(`SELECT id, integrated_level, json FROM creations ORDER BY created_at DESC`)
      .toArray();

    const unreviewed: WorldCreation[] = [];
    for (const r of rows) {
      const c = JSON.parse(String(r.json)) as WorldCreation;
      if (c.isSeed || !c.creatorPrompt || c.blueprint.criticReview) continue;
      const tries = Number(this.getMeta(`critic_heal_tries:${c.id}`, "0")) || 0;
      if (tries >= 2) continue;
      unreviewed.push(c);
    }

    if (unreviewed.length === 0) return {};

    const priorityTarget =
      unreviewed.find((c) => c.id === "c-mvne3zub-216636") ?? unreviewed[0];

    try {
      const review = await reviewBlueprintWithCritic({
        blueprint: priorityTarget.blueprint,
        promptText: priorityTarget.creatorPrompt!,
        apiKey: this.env.GEMINI_API_KEY,
        primaryModel: this.env.ARGON_MODEL,
        bariumModels: this.env.BARIUM_MODELS,
        fallbackModel: this.env.FALLBACK_MODEL,
      });

      if (review.approved || review.score >= 5) {
        const freshRows = sql
          .exec(`SELECT json FROM creations WHERE id = ?`, priorityTarget.id)
          .toArray();
        if (freshRows.length > 0) {
          const fresh = JSON.parse(String(freshRows[0].json)) as WorldCreation;
          fresh.blueprint.criticReview = {
            approved: true,
            score: review.score,
            attempts: 1,
            summary: review.diagnosis,
            reviewedAt: Date.now(),
          };
          sql.exec(`UPDATE creations SET json = ? WHERE id = ?`, JSON.stringify(fresh), fresh.id);
        }
        return {
          auditedId: priorityTarget.id,
          note: `3D Reviewer verified "${priorityTarget.name}" (${review.score}/10)`,
        };
      }

      const prevTries = Number(this.getMeta(`critic_heal_tries:${priorityTarget.id}`, "0")) || 0;
      this.setMeta(`critic_heal_tries:${priorityTarget.id}`, String(prevTries + 1));

      const resculpted = await sculptWithArgon(
        {
          prompt: priorityTarget.creatorPrompt!,
          initialCriticHint: `${review.diagnosis}\n${review.rebuildInstructions}`,
          initialCriticRenderPngBase64: review.contactSheetPngBase64,
        },
        this.env.GEMINI_API_KEY,
        this.env.ARGON_MODEL,
        this.env.FALLBACK_MODEL,
        this.env.BARIUM_MODELS,
      );

      if (!resculpted.ok) {
        return {
          auditedId: priorityTarget.id,
          note: `3D Reviewer flagged "${priorityTarget.name}" (${review.score}/10); retry deferred`,
        };
      }

      const freshRows = sql
        .exec(`SELECT integrated_level, json FROM creations WHERE id = ?`, priorityTarget.id)
        .toArray();
      if (freshRows.length === 0) return {};

      const fresh = JSON.parse(String(freshRows[0].json)) as WorldCreation;
      const nextBp = resculpted.blueprint;
      if (!nextBp.criticReview) {
        nextBp.criticReview = {
          approved: true,
          score: 8,
          attempts: 2,
          summary: "Re-sculpted in-place after 3D Reviewer audit.",
          reviewedAt: Date.now(),
        };
      }

      fresh.blueprint = nextBp;
      fresh.name = nextBp.name;
      fresh.description = nextBp.description;
      if (fresh.behavior.type !== "landmark" || nextBp.category === "building") {
        fresh.category = nextBp.category;
      }
      fresh.scaleClass = nextBp.scaleClass;
      if (nextBp.liveFeed && !fresh.liveFeed) {
        fresh.liveFeed = nextBp.liveFeed;
      }

      sql.exec(
        `UPDATE creations SET integrated_level = ?, json = ? WHERE id = ?`,
        fresh.integratedLevel,
        JSON.stringify(fresh),
        fresh.id,
      );

      this.auditAndRepairWorld();
      const healNote = `3D Reviewer rebuilt "${fresh.name}" to match "${priorityTarget.creatorPrompt}"`;
      this.setMeta("lastWeaveNote", healNote);
      this.setMeta("lastWeaveAt", String(Date.now()));
      this.bumpVersion();

      const refreshed = this.readBaseWorld();
      this.broadcast({
        type: "world_updated",
        note: healNote,
        world: { ...refreshed, myCreationId: null },
      });

      return {
        auditedId: fresh.id,
        healedId: fresh.id,
        note: healNote,
      };
    } catch (err) {
      safeLogError("cron_critic_audit", err, [
        this.env.GEMINI_API_KEY,
        this.env.CREATOR_HMAC_SECRET,
      ]);
      return {};
    }
  }

  public async runCronWeaver(): Promise<{ ok: boolean; note: string }> {
    void this.pumpBuildQueue();

    const auditRes = this.auditAndRepairWorld();
    if (auditRes.repairedCount > 0) {
      const healedWorld = this.readBaseWorld();
      this.broadcast({
        type: "world_updated",
        note: `Orchestrator auto-repaired ${auditRes.repairedCount} voxel overlap(s).`,
        world: { ...healedWorld, myCreationId: null },
      });
    }

    if (!this.env.GEMINI_API_KEY) {
      return { ok: false, note: "Director unavailable" };
    }

    const criticAudit = await this.auditOneUnreviewedCreationWithCritic();
    if (criticAudit.healedId) {
      return { ok: true, note: criticAudit.note || "3D Reviewer healed creation" };
    }

    const world = this.readBaseWorld();
    const hasUnintegrated = world.creations.some((c) => c.integratedLevel < 2);
    const hasStuckMobile = world.creations.some((c) => !c.isSeed && needsMobilityAmendment(c));
    const lastWeaveCount = Number(this.getMeta("lastWeaveCount", "0")) || 0;
    const hasNewCreations = world.creations.length > lastWeaveCount;

    if (!hasUnintegrated && !hasStuckMobile && !hasNewCreations) {
      return {
        ok: true,
        note: criticAudit.note
          ? criticAudit.note
          : auditRes.repairedCount > 0
            ? `Auto-repaired ${auditRes.repairedCount} overlap(s); no new creations to weave`
            : "Verified 0 voxel overlaps — no new creations since last weave",
      };
    }

    try {
      const patch = await weaveWorldCronWithArgon(
        world,
        this.env.GEMINI_API_KEY,
        this.env.ARGON_MODEL,
        this.env.FALLBACK_MODEL,
        this.env.BARIUM_MODELS,
      );
      if (patch) {
        this.applyWorldPatch(patch);
        this.auditAndRepairWorld();
        this.setMeta("lastWeaveCount", String(world.creations.length));
        const refreshed = this.readBaseWorld();
        this.broadcast({
          type: "world_updated",
          note: patch.weaveNote,
          world: { ...refreshed, myCreationId: null },
        });
        return { ok: true, note: patch.weaveNote };
      }
    } catch (err) {
      safeLogError("cron_weaver", err, [this.env.GEMINI_API_KEY, this.env.CREATOR_HMAC_SECRET]);
      return { ok: false, note: "Cron weave skipped due to transient upstream error" };
    }
    return { ok: true, note: "No changes needed" };
  }

  private broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Closed socket will be cleaned up on close/error
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket Upgrade", { status: 426 });
      }
      const originErr = verifyWebSocketOrigin(request);
      if (originErr) {
        return new Response("Forbidden", { status: 403 });
      }
      const existingSockets = this.ctx.getWebSockets();
      if (existingSockets.length >= 200) {
        try {
          existingSockets[0].close(1000, "Connection limit rotation");
        } catch {
          // ignore
        }
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not Found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const byteLen = typeof message === "string" ? message.length : message.byteLength;
    if (byteLen > 128) {
      try {
        ws.close(1009, "Message too large");
      } catch {
        // ignore
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }
}
