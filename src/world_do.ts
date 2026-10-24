import { DurableObject } from "cloudflare:workers";
import {
  buildInitialIntegration,
  CITY_SIGN_POS,
  integrateCreationWithArgon,
  weaveWorldCronWithArgon,
  type WorldPatch,
} from "./argon_director";
import { buildSeedWorld } from "./seed_world";
import { formatDayKeyInTz, safeLogError, verifyWebSocketOrigin } from "./security";
import type {
  WorldCreation,
  WorldPath,
  WorldProp,
  WorldStateSnapshot,
  WorldVillager,
} from "./types";
import {
  auditAndRepairWorldSpatial,
  auditBlueprintOverlaps,
  autoRepairBlueprintOverlaps,
} from "./voxel_audit";
import { normalizeAndGroundBlueprint } from "./voxel_dsl";

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
  totalAutoRepairs: number;
  lastAuditAt: number;
  lastAuditNote: string;
  creations: WorldCreationAuditEntry[];
}

export interface PlaceCreationInput {
  ipHash: string;
  cookieId: string;
  dayKey: string;
  blueprintRaw: Record<string, unknown>;
  x?: number | null;
  z?: number | null;
  yaw?: number | null;
}

export type PlaceCreationResult =
  | { ok: true; creation: WorldCreation; world: WorldStateSnapshot }
  | { ok: false; alreadyPlaced?: boolean; myCreationId?: string; error: string };

export type AcquireBuildSlotResult =
  | { ok: true; lockToken: string }
  | {
      ok: false;
      status: 403 | 429;
      alreadyPlaced?: boolean;
      myCreationId?: string;
      retryAfterSec?: number;
      error: string;
    };

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
        "seed-windmill-bakery": { kind: "wind", place: "Meadow", lat: -33.87, lon: 151.21 },
        "seed-clocktower-station": { kind: "time", place: "Meadow", timezone: "Australia/Sydney" },
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

      const allCreations = sql
        .exec(`SELECT json FROM creations`)
        .toArray()
        .map((r) => JSON.parse(String(r.json)) as WorldCreation);
      const contributors = allCreations.filter((c) => !c.isSeed).length;
      const cap = Math.min(18, 6 + contributors * 2);

      const allVillagers = sql
        .exec(`SELECT id, json FROM villagers`)
        .toArray()
        .map((r) => ({ id: String(r.id), v: JSON.parse(String(r.json)) as WorldVillager }));

      if (allVillagers.length > cap) {
        const seedIds = new Set([
          "villager-milo",
          "villager-clara",
          "villager-theo",
          "villager-hana",
          "villager-pip",
          "villager-iris",
        ]);
        const kept: string[] = [];
        for (const item of allVillagers) {
          if (seedIds.has(item.id)) kept.push(item.id);
        }
        for (let i = allVillagers.length - 1; i >= 0 && kept.length < cap; i--) {
          if (!seedIds.has(allVillagers[i].id)) {
            kept.push(allVillagers[i].id);
          }
        }
        const keepSet = new Set(kept);
        for (const item of allVillagers) {
          if (!keepSet.has(item.id)) {
            sql.exec(`DELETE FROM villagers WHERE id = ?`, item.id);
          }
        }
      }

      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v3', '1')`);
      this.bumpVersion();
    }

    // Non-destructive v4 cleanup: trim excess idle-cron footpath/prop/villager clutter while preserving all creations & roads
    const upgradedV4 = sql.exec(`SELECT value FROM meta WHERE key = 'upgrade_v4'`).toArray();
    if (upgradedV4.length === 0) {
      const allCreations = sql
        .exec(`SELECT json FROM creations`)
        .toArray()
        .map((r) => JSON.parse(String(r.json)) as WorldCreation);
      const contributors = allCreations.filter((c) => !c.isSeed).length;

      // Trim excess footpaths (keep seed paths, all roads, and up to 4 footpaths per contributor)
      const allPaths = sql
        .exec(`SELECT id, json FROM paths`)
        .toArray()
        .map((r) => ({ id: String(r.id), p: JSON.parse(String(r.json)) as WorldPath }));
      const maxExtraFootpaths = Math.max(4, contributors * 4);
      const removableFootpaths = allPaths.filter(
        (x) => x.p.kind === "footpath" && !x.id.startsWith("path-"),
      );
      if (removableFootpaths.length > maxExtraFootpaths) {
        const toDelete = removableFootpaths.slice(0, removableFootpaths.length - maxExtraFootpaths);
        for (const item of toDelete) {
          sql.exec(`DELETE FROM paths WHERE id = ?`, item.id);
        }
      }

      // Trim excess minor props (keep seed props, ponds, bus stops, and up to 5 accent props per contributor)
      const allProps = sql
        .exec(`SELECT id, json FROM props`)
        .toArray()
        .map((r) => ({ id: String(r.id), pr: JSON.parse(String(r.json)) as WorldProp }));
      const maxExtraProps = Math.max(5, contributors * 5);
      const removableProps = allProps.filter(
        (x) =>
          !x.id.startsWith("prop-central-") &&
          !x.id.startsWith("prop-stop-") &&
          !x.id.startsWith("prop-lamp-") &&
          !x.id.startsWith("prop-bench-pond") &&
          !x.id.startsWith("prop-flowers-") &&
          x.pr.kind !== "pond" &&
          x.pr.kind !== "bus_stop",
      );
      if (removableProps.length > maxExtraProps) {
        const toDelete = removableProps.slice(0, removableProps.length - maxExtraProps);
        for (const item of toDelete) {
          sql.exec(`DELETE FROM props WHERE id = ?`, item.id);
        }
      }

      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastWeaveCount', ?)`, String(allCreations.length));
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v4', '1')`);
      this.bumpVersion();
    }

    // Non-destructive v5 upgrade: refresh seed blueprints (fixes Windmill Bakery sail/roof Z-fighting)
    // and run full kinematic voxel overlap + spatial plinth audit across all creations, paths, and props.
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
    } else {
      // Lightweight startup self-check (< 3ms, zero LLM calls) so the world stays overlap-free across restarts
      this.auditAndRepairWorld();
    }

    // Non-destructive v6 upgrade: switch from permanent shared-IP lock to 1 creation per individual (cookie) per day
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
      // Remove legacy shared-IP locks so multiple individuals/devices on the same Wi-Fi/office IP can build independently
      sql.exec(`DELETE FROM creators WHERE token LIKE 'ip:%'`);
      sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('upgrade_v6_daily_individual', '1')`);
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
      for (const p of spatial.paths) {
        sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, p.id, JSON.stringify(p));
      }
      for (const pr of spatial.props) {
        sql.exec(`INSERT OR REPLACE INTO props (id, json) VALUES (?, ?)`, pr.id, JSON.stringify(pr));
      }
      repairs.push(...spatial.report.details);
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
    const spatialConflicts = spatial.report.footpathTrimCount + spatial.report.propNudgeCount;

    return {
      ok: true,
      clean: blueprintConflicts === 0 && spatialConflicts === 0,
      creationsChecked: world.creations.length,
      blueprintConflicts,
      spatialConflicts,
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
      villagers,
      contributorCount,
      lastWeaveNote: this.getMeta("lastWeaveNote", "Meadow humming quietly in the sun."),
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

  /**
   * Atomically verifies daily per-individual eligibility (1 creation per browser cookie per day),
   * household-safe concurrency & anti-abuse IP caps, and global Gemini API spend circuit breakers.
   */
  public acquireBuildSlot(ipHash: string, cookieId: string, dayKey: string): AcquireBuildSlotResult {
    const sql = this.ctx.storage.sql;
    const now = Date.now();

    // 1. Clean expired in-flight locks and stale rate-limit buckets
    sql.exec(`DELETE FROM inflight_locks WHERE expires_at <= ?`, now);
    if (now % 17 === 0) {
      sql.exec(`DELETE FROM rate_limits WHERE window_start < ?`, now - 25 * 60 * 60 * 1000);
    }

    // 2. Reject if THIS individual browser has already placed their 1 creation today
    const existingTodayId = this.lookupTodayCreation(cookieId, dayKey);
    if (existingTodayId) {
      return {
        ok: false,
        status: 403,
        alreadyPlaced: true,
        myCreationId: existingTodayId,
        error: "You've already added your creation for today — come back tomorrow to add another!",
      };
    }

    // 3. Concurrency lock: 1 in-flight build per browser cookie, up to 3 simultaneous on the same Wi-Fi/office IP
    const cidLockKey = `cid:${cookieId}`;
    const activeCookieLock = sql
      .exec(`SELECT lock_key FROM inflight_locks WHERE lock_key = ? LIMIT 1`, cidLockKey)
      .toArray();
    if (activeCookieLock.length > 0) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: 15,
        error: "Your creation is already being sculpted — hang tight!",
      };
    }

    if (ipHash) {
      const activeIpCount =
        Number(
          sql
            .exec(`SELECT COUNT(*) AS c FROM inflight_locks WHERE lock_key LIKE ?`, `ip:${ipHash}:%`)
            .toArray()[0]?.c,
        ) || 0;
      if (activeIpCount >= 3) {
        return {
          ok: false,
          status: 429,
          retryAfterSec: 12,
          error: "A few builds are running on your network right now — try again in a few seconds.",
        };
      }
    }

    // 4. Global concurrent Argon build cap (max 4 simultaneous builds across all visitors)
    const activeGlobalCount =
      Number(sql.exec(`SELECT COUNT(DISTINCT lock_token) AS c FROM inflight_locks`).toArray()[0]?.c) || 0;
    if (activeGlobalCount >= 4) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: 12,
        error: "A few visitors are sculpting at the exact same moment — please try again in 10 seconds.",
      };
    }

    // 5. Per-browser & household-friendly per-IP anti-abuse limits
    const visitorWindowMs = 15 * 60 * 1000;
    const dayWindowMs = 24 * 60 * 60 * 1000;

    const cidCheck = this.checkWindowBucket(`gen_cid:${cookieId}`, 4, visitorWindowMs, now);
    if (!cidCheck.allowed) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: cidCheck.retryAfterSec,
        error: `Please wait ${cidCheck.retryAfterSec ?? 60}s before building again.`,
      };
    }

    if (ipHash) {
      const ipBurstCheck = this.checkWindowBucket(`gen_ip:${ipHash}`, 12, visitorWindowMs, now);
      if (!ipBurstCheck.allowed) {
        return {
          ok: false,
          status: 429,
          retryAfterSec: ipBurstCheck.retryAfterSec,
          error: `Please wait ${ipBurstCheck.retryAfterSec ?? 60}s before building again.`,
        };
      }
      const ipDailyPlaced = this.checkWindowBucket(`placed_ip:${ipHash}`, 15, dayWindowMs, now);
      if (!ipDailyPlaced.allowed) {
        return {
          ok: false,
          status: 429,
          retryAfterSec: ipDailyPlaced.retryAfterSec,
          error: "Daily network build limit reached — check back tomorrow!",
        };
      }
    }

    // 6. Global Gemini API spend circuit-breaker (max 45 builds/hour & max 240 builds/24h globally)
    const hourWindowMs = 60 * 60 * 1000;
    const globalHour = this.checkWindowBucket("global:hour", 45, hourWindowMs, now);
    if (!globalHour.allowed) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: globalHour.retryAfterSec,
        error: "The meadow workshop is resting briefly — please try again shortly.",
      };
    }
    const globalDay = this.checkWindowBucket("global:day", 240, dayWindowMs, now);
    if (!globalDay.allowed) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: globalDay.retryAfterSec,
        error: "Today's meadow build capacity has been reached — check back soon!",
      };
    }

    // Commit attempt counters & acquire 90s in-flight lock
    if (ipHash) {
      this.incrementWindowBucket(`gen_ip:${ipHash}`, visitorWindowMs, now);
    }
    this.incrementWindowBucket(`gen_cid:${cookieId}`, visitorWindowMs, now);
    this.incrementWindowBucket("global:hour", hourWindowMs, now);
    this.incrementWindowBucket("global:day", dayWindowMs, now);

    const lockToken = crypto.randomUUID();
    const expiresAt = now + 90_000;
    if (ipHash) {
      sql.exec(
        `INSERT OR REPLACE INTO inflight_locks (lock_key, lock_token, expires_at) VALUES (?, ?, ?)`,
        `ip:${ipHash}:${lockToken}`,
        lockToken,
        expiresAt,
      );
    }
    sql.exec(
      `INSERT OR REPLACE INTO inflight_locks (lock_key, lock_token, expires_at) VALUES (?, ?, ?)`,
      cidLockKey,
      lockToken,
      expiresAt,
    );

    return { ok: true, lockToken };
  }

  public releaseBuildSlot(lockToken: string): void {
    if (!lockToken) return;
    this.ctx.storage.sql.exec(`DELETE FROM inflight_locks WHERE lock_token = ?`, lockToken);
  }

  public getWorldSnapshot(cookieId: string, dayKey: string): WorldStateSnapshot {
    const base = this.readBaseWorld();
    const myCreationId = this.lookupTodayCreation(cookieId, dayKey);
    return {
      ...base,
      myCreationId,
    };
  }

  private isSpotClear(
    x: number,
    z: number,
    category: WorldCreation["category"],
    world: Omit<WorldStateSnapshot, "myCreationId">,
  ): boolean {
    if (Math.abs(x) > 135 || Math.abs(z) > 135) return false;
    if (Math.hypot(x - CITY_SIGN_POS[0], z - CITY_SIGN_POS[1]) < 5.0) return false;
    const minBuildingSep = category === "building" ? 11.0 : 6.8;
    for (const c of world.creations) {
      const sep = c.category === "building" || category === "building" ? minBuildingSep : 6.0;
      if (Math.hypot(x - c.x, z - c.z) < sep) return false;
    }
    if (category !== "watercraft") {
      for (const pr of world.props) {
        if (pr.kind === "pond" && Math.hypot(x - pr.x, z - pr.z) < (pr.radius ?? 6.5) + 4.0) {
          return false;
        }
      }
    }
    if (category === "building" || category === "prop") {
      for (const p of world.paths) {
        if (p.kind !== "road") continue;
        for (let i = 0; i < p.points.length; i++) {
          const a = p.points[i];
          const b = p.points[(i + 1) % p.points.length];
          if (!p.closed && i === p.points.length - 1) break;
          if (distToSegment(x, z, a[0], a[1], b[0], b[1]) < 5.6) return false;
        }
      }
    }
    return true;
  }

  private chooseMeadowSpot(
    reqX: number | null | undefined,
    reqZ: number | null | undefined,
    category: WorldCreation["category"],
    world: Omit<WorldStateSnapshot, "myCreationId">,
  ): [number, number] {
    if (typeof reqX === "number" && Number.isFinite(reqX) && typeof reqZ === "number" && Number.isFinite(reqZ)) {
      const cx = Math.max(-130, Math.min(130, reqX));
      const cz = Math.max(-130, Math.min(130, reqZ));
      if (this.isSpotClear(cx, cz, category, world)) {
        return [Number(cx.toFixed(1)), Number(cz.toFixed(1))];
      }
      // Spiral gently around the clicked spot to find the closest non-colliding grass patch
      for (let r = 3; r <= 42; r += 2.5) {
        for (let k = 0; k < 16; k++) {
          const ang = (k / 16) * Math.PI * 2;
          const tx = cx + Math.cos(ang) * r;
          const tz = cz + Math.sin(ang) * r;
          if (this.isSpotClear(tx, tz, category, world)) {
            return [Number(tx.toFixed(1)), Number(tz.toFixed(1))];
          }
        }
      }
    }

    // Golden-angle spiral around the sunlit village perimeter
    const startR = category === "building" ? 28 : 14;
    for (let i = 0; i < 180; i++) {
      const r = startR + Math.sqrt(i) * 5.2;
      const theta = i * 2.399963;
      const tx = Math.cos(theta) * r;
      const tz = Math.sin(theta) * r;
      if (this.isSpotClear(tx, tz, category, world)) {
        return [Number(tx.toFixed(1)), Number(tz.toFixed(1))];
      }
    }
    return [32, -26];
  }

  private applyWorldPatch(patch: WorldPatch): void {
    const sql = this.ctx.storage.sql;
    const hasCustomRoad = patch.newPaths.some((p) => p.kind === "road");

    for (const upd of patch.updatedBehaviors) {
      const rows = sql.exec(`SELECT json FROM creations WHERE id = ?`, upd.creationId).toArray();
      if (!rows.length) continue;
      const existing = JSON.parse(String(rows[0].json)) as WorldCreation;
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

    const pathCount = Number(sql.exec(`SELECT COUNT(*) AS c FROM paths`).toArray()[0]?.c ?? 0);
    if (pathCount < 56) {
      for (const p of patch.newPaths) {
        sql.exec(`INSERT OR REPLACE INTO paths (id, json) VALUES (?, ?)`, p.id, JSON.stringify(p));
      }
    }

    const propCount = Number(sql.exec(`SELECT COUNT(*) AS c FROM props`).toArray()[0]?.c ?? 0);
    if (propCount < 72) {
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

    const bp = normalizeAndGroundBlueprint(input.blueprintRaw, "Meadow Creation");
    if (bp.stats.voxels < 20) {
      return { ok: false, error: "Blueprint has too few voxels to place." };
    }

    const worldBefore = this.readBaseWorld();
    const [x, z] = this.chooseMeadowSpot(input.x, input.z, bp.category, worldBefore);
    const yaw =
      typeof input.yaw === "number" && Number.isFinite(input.yaw)
        ? input.yaw
        : Number(Math.atan2(-x, -z).toFixed(2));

    const now = Date.now();
    const id = `c-${now.toString(36)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;

    const creation: WorldCreation = {
      id,
      name: bp.name,
      description: bp.description,
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
        activity: "arriving in the meadow",
        statusLine: "Just arrived — Argon is weaving it into the village...",
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

    // Apply instant 0ms deterministic behavior so it immediately animates upon placement!
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

  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec(`SELECT creation_id FROM integration_queue ORDER BY queued_at ASC LIMIT 2`)
      .toArray();

    if (rows.length === 0) return;

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

    const remaining = sql.exec(`SELECT COUNT(*) AS c FROM integration_queue`).toArray();
    if (Number(remaining[0]?.c ?? 0) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 500);
    }
  }

  public async runCronWeaver(): Promise<{ ok: boolean; note: string }> {
    // Always run deterministic voxel & spatial overlap check + auto-repair on every orchestrator tick
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
    const world = this.readBaseWorld();
    const hasUnintegrated = world.creations.some((c) => c.integratedLevel < 2);
    const lastWeaveCount = Number(this.getMeta("lastWeaveCount", "0")) || 0;
    const hasNewCreations = world.creations.length > lastWeaveCount;

    // Only run background Cron World-Weaver LLM call when unintegrated or newly added creations exist!
    if (!hasUnintegrated && !hasNewCreations) {
      return {
        ok: true,
        note:
          auditRes.repairedCount > 0
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
