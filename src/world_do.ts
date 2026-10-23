import { DurableObject } from "cloudflare:workers";
import {
  buildInitialIntegration,
  integrateCreationWithArgon,
  weaveWorldCronWithArgon,
  type WorldPatch,
} from "./argon_director";
import { buildSeedWorld } from "./seed_world";
import type {
  WorldCreation,
  WorldPath,
  WorldProp,
  WorldStateSnapshot,
  WorldVillager,
} from "./types";
import { normalizeAndGroundBlueprint } from "./voxel_dsl";

export interface PlaceCreationInput {
  ipHash: string;
  cookieId: string;
  blueprintRaw: Record<string, unknown>;
  x?: number | null;
  z?: number | null;
  yaw?: number | null;
}

export type PlaceCreationResult =
  | { ok: true; creation: WorldCreation; world: WorldStateSnapshot }
  | { ok: false; alreadyPlaced?: boolean; myCreationId?: string; error: string };

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
      CREATE TABLE IF NOT EXISTS integration_queue (
        creation_id TEXT PRIMARY KEY,
        queued_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
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

    return {
      version: parseInt(this.getMeta("version", "1"), 10) || 1,
      creations,
      paths,
      props,
      villagers,
      lastWeaveNote: this.getMeta("lastWeaveNote", "Meadow humming quietly in the sun."),
    };
  }

  public lookupCreatorCreation(ipHash: string, cookieId: string): string | null {
    const sql = this.ctx.storage.sql;
    if (cookieId) {
      const byCookie = sql.exec(`SELECT creation_id FROM creators WHERE token = ?`, `cid:${cookieId}`).toArray();
      if (byCookie.length > 0) return String(byCookie[0].creation_id);
    }
    if (ipHash) {
      const byIp = sql.exec(`SELECT creation_id FROM creators WHERE token = ?`, `ip:${ipHash}`).toArray();
      if (byIp.length > 0) return String(byIp[0].creation_id);
    }
    return null;
  }

  public checkGenerateQuota(ipHash: string): { allowed: boolean; retryAfterSec?: number } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const windowMs = 10 * 60 * 1000; // 10 minutes
    const maxAttempts = 12;
    const bucket = `gen:${ipHash}`;
    const rows = sql.exec(`SELECT count, window_start FROM rate_limits WHERE bucket = ?`, bucket).toArray();
    if (rows.length === 0) {
      sql.exec(`INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)`, bucket, now);
      return { allowed: true };
    }
    const count = Number(rows[0].count) || 0;
    const start = Number(rows[0].window_start) || now;
    if (now - start > windowMs) {
      sql.exec(`UPDATE rate_limits SET count = 1, window_start = ? WHERE bucket = ?`, now, bucket);
      return { allowed: true };
    }
    if (count >= maxAttempts) {
      return { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - start)) / 1000) };
    }
    sql.exec(`UPDATE rate_limits SET count = ? WHERE bucket = ?`, count + 1, bucket);
    return { allowed: true };
  }

  public getWorldSnapshot(ipHash: string, cookieId: string): WorldStateSnapshot {
    const base = this.readBaseWorld();
    const myCreationId = this.lookupCreatorCreation(ipHash, cookieId);
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

    const villagerCount = Number(sql.exec(`SELECT COUNT(*) AS c FROM villagers`).toArray()[0]?.c ?? 0);
    if (villagerCount < 30) {
      for (const v of patch.newVillagers) {
        sql.exec(`INSERT OR REPLACE INTO villagers (id, json) VALUES (?, ?)`, v.id, JSON.stringify(v));
      }
    }

    if (patch.weaveNote) {
      this.setMeta("lastWeaveNote", patch.weaveNote);
    }
    this.setMeta("lastWeaveAt", String(Date.now()));
    this.bumpVersion();
  }

  public async placeCreation(input: PlaceCreationInput): Promise<PlaceCreationResult> {
    const existingId = this.lookupCreatorCreation(input.ipHash, input.cookieId);
    if (existingId) {
      return {
        ok: false,
        alreadyPlaced: true,
        myCreationId: existingId,
        error: "You've already added your one creation to the shared meadow — watch it live in the world!",
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
    const id = `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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
    if (input.ipHash) {
      sql.exec(
        `INSERT OR REPLACE INTO creators (token, creation_id, created_at) VALUES (?, ?, ?)`,
        `ip:${input.ipHash}`,
        creation.id,
        now,
      );
    }
    if (input.cookieId) {
      sql.exec(
        `INSERT OR REPLACE INTO creators (token, creation_id, created_at) VALUES (?, ?, ?)`,
        `cid:${input.cookieId}`,
        creation.id,
        now,
      );
    }

    // Apply instant 0ms deterministic behavior so it immediately animates upon placement!
    const worldWithNew = this.readBaseWorld();
    const initialPatch = buildInitialIntegration(worldWithNew, creation);
    this.applyWorldPatch(initialPatch);

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
          const refreshed = this.readBaseWorld();
          this.broadcast({
            type: "world_updated",
            note: patch.weaveNote,
            world: { ...refreshed, myCreationId: null },
          });
        }
      } catch (err) {
        console.error("Argon alarm integration failed:", err);
      }
    }

    const remaining = sql.exec(`SELECT COUNT(*) AS c FROM integration_queue`).toArray();
    if (Number(remaining[0]?.c ?? 0) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 500);
    }
  }

  public async runCronWeaver(): Promise<{ ok: boolean; note: string }> {
    if (!this.env.GEMINI_API_KEY) {
      return { ok: false, note: "Missing GEMINI_API_KEY" };
    }
    const world = this.readBaseWorld();
    const hasUnintegrated = world.creations.some((c) => c.integratedLevel < 2);
    const lastWeaveAt = Number(this.getMeta("lastWeaveAt", "0")) || 0;
    const elapsedMs = Date.now() - lastWeaveAt;

    // Always run immediately if any creation has integratedLevel < 2; otherwise weave periodically
    // when at least 110s elapsed and world still has room to evolve connections.
    if (!hasUnintegrated && elapsedMs < 110_000) {
      return { ok: true, note: "Skipped — recently woven" };
    }
    if (!hasUnintegrated && world.paths.length >= 48 && world.villagers.length >= 26) {
      return { ok: true, note: "Meadow ecosystem at harmonious capacity" };
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
        const refreshed = this.readBaseWorld();
        this.broadcast({
          type: "world_updated",
          note: patch.weaveNote,
          world: { ...refreshed, myCreationId: null },
        });
        return { ok: true, note: patch.weaveNote };
      }
    } catch (err) {
      console.error("Cron weaver error:", err);
      return { ok: false, note: String(err) };
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
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Not Found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
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
