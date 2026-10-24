import { sculptWithArgon } from "./argon_sculptor";
import { resolveWorldLiveFeeds } from "./live_feeds";
import { autoRepairBlueprintOverlaps } from "./voxel_audit";
import { normalizeAndGroundBlueprint } from "./voxel_dsl";
import { WorldDO } from "./world_do";

export { WorldDO };

const COOKIE_NAME = "meadow_cid";

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret || "meadow-fallback-hmac-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function resolveVisitorIdentity(
  request: Request,
  env: Env,
): Promise<{ ipHash: string; cookieId: string; setCookieHeader?: string }> {
  const url = new URL(request.url);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const secret = env.CREATOR_HMAC_SECRET || "meadow-default-hmac-secret-2026";

  const rawIp =
    (!isLocal ? request.headers.get("CF-Connecting-IP") : null) ||
    (isLocal ? request.headers.get("X-Test-Visitor") : null) ||
    request.headers.get("CF-Connecting-IP") ||
    "127.0.0.1";

  const ipHash = (await hmacHex(secret, `ip:${rawIp.trim()}`)).slice(0, 32);

  const cookies = parseCookies(request.headers.get("Cookie"));
  const existingToken = cookies[COOKIE_NAME] || "";
  if (existingToken.includes(".")) {
    const [cid, sig] = existingToken.split(".", 2);
    if (cid && sig && cid.length >= 12) {
      const expected = (await hmacHex(secret, `cid:${cid}`)).slice(0, 28);
      if (sig === expected) {
        return { ipHash, cookieId: cid };
      }
    }
  }

  const freshCid = crypto.randomUUID().replace(/-/g, "");
  const freshSig = (await hmacHex(secret, `cid:${freshCid}`)).slice(0, 28);
  const signedVal = `${freshCid}.${freshSig}`;
  const secureFlag = isLocal ? "" : " Secure;";
  const setCookieHeader = `${COOKIE_NAME}=${signedVal}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax;${secureFlag}`;

  return { ipHash, cookieId: freshCid, setCookieHeader };
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extraHeaders ?? {}),
    },
  });
}

function getWorldStub(env: Env): DurableObjectStub<WorldDO> {
  const id = env.WORLD_DO.idFromName("global-meadow-v1");
  return env.WORLD_DO.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Real-time WebSocket stream to shared living world DO
    if (url.pathname === "/ws") {
      const stub = getWorldStub(env);
      return stub.fetch(request);
    }

    // Read full shared world state + whether this visitor has already placed their 1 creation
    if (url.pathname === "/api/world" && request.method === "GET") {
      const id = await resolveVisitorIdentity(request, env);
      const stub = getWorldStub(env);
      const snapshot = await stub.getWorldSnapshot(id.ipHash, id.cookieId);
      return jsonResponse(snapshot, 200, id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined);
    }

    // Resolve simple cached live feeds (weather, surf, wind, time, moon, ISS) for creations that opted in
    if (url.pathname === "/api/feeds" && request.method === "GET") {
      const stub = getWorldStub(env);
      const snapshot = await stub.getWorldSnapshot("", "");
      const feeds = await resolveWorldLiveFeeds(snapshot.creations);
      return jsonResponse({ ok: true, feeds }, 200);
    }

    // Automated voxel & spatial Z-fighting audit status across the entire live world
    if (url.pathname === "/api/audit" && request.method === "GET") {
      const stub = getWorldStub(env);
      const report = await stub.getWorldAuditReport();
      return jsonResponse(report, 200);
    }

    // Atomic background build + permanent placement at visitor's chosen grass spot
    if (url.pathname === "/api/build" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ ok: false, error: "Server is missing GEMINI_API_KEY configuration." }, 500);
      }

      const id = await resolveVisitorIdentity(request, env);
      const stub = getWorldStub(env);

      const already = await stub.lookupCreatorCreation(id.ipHash, id.cookieId);
      if (already) {
        return jsonResponse(
          {
            ok: false,
            alreadyPlaced: true,
            myCreationId: already,
            error: "You have already placed your one creation in the shared meadow!",
          },
          403,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      const quota = await stub.checkGenerateQuota(id.ipHash);
      if (!quota.allowed) {
        return jsonResponse(
          {
            ok: false,
            error: `Please wait ${quota.retryAfterSec ?? 60}s before building again.`,
          },
          429,
        );
      }

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
      }

      const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 600) : "";
      let imageBase64: string | undefined;
      let imageMimeType: string | undefined;

      if (typeof body.imageDataUrl === "string" && body.imageDataUrl.startsWith("data:image/")) {
        const commaIdx = body.imageDataUrl.indexOf(",");
        if (commaIdx !== -1) {
          const header = body.imageDataUrl.slice(5, commaIdx);
          const mime = header.split(";")[0]?.trim() || "image/jpeg";
          const b64 = body.imageDataUrl.slice(commaIdx + 1).trim();
          if (b64.length > 5_500_000) {
            return jsonResponse({ ok: false, error: "Image is too large — please use an image under 4 MB." }, 413);
          }
          imageMimeType = mime;
          imageBase64 = b64;
        }
      }

      try {
        const sculpted = await sculptWithArgon(
          { prompt, imageBase64, imageMimeType },
          env.GEMINI_API_KEY,
          env.ARGON_MODEL,
          env.FALLBACK_MODEL,
        );
        if (!sculpted.ok) {
          const status = sculpted.unsafe ? 422 : 400;
          return jsonResponse(sculpted, status, id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined);
        }

        const placed = await stub.placeCreation({
          ipHash: id.ipHash,
          cookieId: id.cookieId,
          blueprintRaw: sculpted.blueprint as unknown as Record<string, unknown>,
          x: typeof body.x === "number" ? body.x : null,
          z: typeof body.z === "number" ? body.z : null,
          yaw: typeof body.yaw === "number" ? body.yaw : null,
        });

        if (!placed.ok) {
          const status = placed.alreadyPlaced ? 409 : 400;
          return jsonResponse(placed, status, id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined);
        }

        const feeds = await resolveWorldLiveFeeds(placed.world.creations);
        return jsonResponse(
          { ...placed, feeds },
          200,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      } catch (err) {
        console.error("Argon build error:", err);
        return jsonResponse(
          { ok: false, error: "Argon took a moment too long building that — please try once more." },
          502,
        );
      }
    }

    // Generate high-detail micro-voxel blueprint from image upload and/or text description via Gemini 4 Argon
    if (url.pathname === "/api/generate" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return jsonResponse({ ok: false, error: "Server is missing GEMINI_API_KEY configuration." }, 500);
      }

      const id = await resolveVisitorIdentity(request, env);
      const stub = getWorldStub(env);

      const already = await stub.lookupCreatorCreation(id.ipHash, id.cookieId);
      if (already) {
        return jsonResponse(
          {
            ok: false,
            alreadyPlaced: true,
            myCreationId: already,
            error: "You have already placed your one creation in the shared meadow!",
          },
          403,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      const quota = await stub.checkGenerateQuota(id.ipHash);
      if (!quota.allowed) {
        return jsonResponse(
          {
            ok: false,
            error: `Slow down just a little — please wait ${quota.retryAfterSec ?? 60}s before sculpting again.`,
          },
          429,
        );
      }

      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
      }

      const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 600) : "";
      let imageBase64: string | undefined;
      let imageMimeType: string | undefined;

      if (typeof body.imageDataUrl === "string" && body.imageDataUrl.startsWith("data:image/")) {
        const commaIdx = body.imageDataUrl.indexOf(",");
        if (commaIdx !== -1) {
          const header = body.imageDataUrl.slice(5, commaIdx);
          const mime = header.split(";")[0]?.trim() || "image/jpeg";
          const b64 = body.imageDataUrl.slice(commaIdx + 1).trim();
          if (b64.length > 5_500_000) {
            return jsonResponse({ ok: false, error: "Image is too large — please use an image under 4 MB." }, 413);
          }
          imageMimeType = mime;
          imageBase64 = b64;
        }
      }

      try {
        const result = await sculptWithArgon(
          { prompt, imageBase64, imageMimeType },
          env.GEMINI_API_KEY,
          env.ARGON_MODEL,
          env.FALLBACK_MODEL,
        );
        const status = result.ok ? 200 : result.unsafe ? 422 : 400;
        return jsonResponse(result, status, id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined);
      } catch (err) {
        console.error("Argon sculpt error:", err);
        return jsonResponse(
          { ok: false, error: "Argon took a moment too long sculpting that — please try once more." },
          502,
        );
      }
    }

    // Permanently place visitor's one creation into the shared meadow (locks IP + cookie)
    if (url.pathname === "/api/place" && request.method === "POST") {
      const id = await resolveVisitorIdentity(request, env);
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
      }

      if (!body.blueprint || typeof body.blueprint !== "object") {
        return jsonResponse({ ok: false, error: "Missing blueprint to place." }, 400);
      }

      const stub = getWorldStub(env);
      const placed = await stub.placeCreation({
        ipHash: id.ipHash,
        cookieId: id.cookieId,
        blueprintRaw: body.blueprint as Record<string, unknown>,
        x: typeof body.x === "number" ? body.x : null,
        z: typeof body.z === "number" ? body.z : null,
        yaw: typeof body.yaw === "number" ? body.yaw : null,
      });

      const status = placed.ok ? 200 : placed.alreadyPlaced ? 409 : 400;
      return jsonResponse(placed, status, id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined);
    }

    // Local dev helper to trigger Cron World-Weaver manually during verification (localhost only)
    if (
      url.pathname === "/api/dev/weave" &&
      request.method === "POST" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      const stub = getWorldStub(env);
      const res = await stub.runCronWeaver();
      return jsonResponse(res, 200);
    }

    // Local dev helper to verify automated voxel overlap detection & orchestrator auto-repair (localhost only)
    if (
      url.pathname === "/api/dev/audit-repair" &&
      request.method === "POST" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        // empty body runs world-level orchestrator repair
      }
      if (body.blueprint && typeof body.blueprint === "object") {
        const rawBp = normalizeAndGroundBlueprint(
          body.blueprint as Record<string, unknown>,
          "Test Overlapping Creation",
          { skipAutoRepair: true },
        );
        const result = autoRepairBlueprintOverlaps(rawBp);
        return jsonResponse({
          ok: true,
          reportBefore: result.reportBefore,
          reportAfter: result.reportAfter,
          repairsApplied: result.repairsApplied,
          repairedBlueprint: result.blueprint,
        });
      }
      const stub = getWorldStub(env);
      const worldRepair = await stub.runWorldAuditAndRepair();
      return jsonResponse({ ok: true, ...worldRepair });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = getWorldStub(env);
    ctx.waitUntil(stub.runCronWeaver());
  },
} satisfies ExportedHandler<Env>;
