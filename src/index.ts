import { sculptWithArgon } from "./argon_sculptor";
import { resolveWorldLiveFeeds } from "./live_feeds";
import {
  buildSecurityHeaders,
  isLocalDevRequest,
  readBoundedJsonBody,
  resolveVisitorIdentity,
  safeLogError,
  sanitizePlainText,
  validateImageDataUrl,
  verifyMutationSecurity,
  verifyWebSocketOrigin,
} from "./security";
import { autoRepairBlueprintOverlaps } from "./voxel_audit";
import { normalizeAndGroundBlueprint } from "./voxel_dsl";
import { WorldDO } from "./world_do";

export { WorldDO };

type AppEnv = Env & { ENABLE_DEV_ENDPOINTS?: string };

function jsonResponse(
  request: Request,
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const isHttps = new URL(request.url).protocol === "https:";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...buildSecurityHeaders(isHttps),
      ...(extraHeaders ?? {}),
    },
  });
}

function getWorldStub(env: Env): DurableObjectStub<WorldDO> {
  const id = env.WORLD_DO.idFromName("global-meadow-v1");
  return env.WORLD_DO.get(id);
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Real-time WebSocket stream to shared living world DO (origin-verified)
      if (url.pathname === "/ws") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const wsOriginErr = verifyWebSocketOrigin(request);
        if (wsOriginErr) {
          return jsonResponse(request, { ok: false, error: wsOriginErr }, 403);
        }
        const stub = getWorldStub(env);
        return stub.fetch(request);
      }

      // Read full shared world state + whether this visitor has already placed their 1 creation
      if (url.pathname === "/api/world") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const id = await resolveVisitorIdentity(request, env);
        const stub = getWorldStub(env);
        const snapshot = await stub.getWorldSnapshot(id.ipHash, id.cookieId);
        return jsonResponse(
          request,
          snapshot,
          200,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      // Resolve simple cached live feeds (weather, surf, wind, time, moon, ISS) for creations that opted in
      if (url.pathname === "/api/feeds") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const stub = getWorldStub(env);
        const snapshot = await stub.getWorldSnapshot("", "");
        const feeds = await resolveWorldLiveFeeds(snapshot.creations);
        return jsonResponse(request, { ok: true, feeds }, 200, {
          "cache-control": "public, max-age=20",
        });
      }

      // Automated voxel & spatial Z-fighting audit status across the entire live world
      if (url.pathname === "/api/audit") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const stub = getWorldStub(env);
        const report = await stub.getWorldAuditReport();
        return jsonResponse(request, report, 200, {
          "cache-control": "public, max-age=10",
        });
      }

      // Atomic background build + permanent placement at visitor's chosen grass spot
      if (url.pathname === "/api/build") {
        if (request.method !== "POST") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }

        const csrfErr = verifyMutationSecurity(request);
        if (csrfErr) {
          return jsonResponse(request, { ok: false, error: csrfErr }, 403);
        }

        if (!env.GEMINI_API_KEY) {
          return jsonResponse(
            request,
            { ok: false, error: "Sculpting service is temporarily unavailable." },
            503,
          );
        }

        // Validate body size, UTF-8 JSON, prompt, and image magic bytes BEFORE acquiring quota/lock
        const parsedBody = await readBoundedJsonBody(request, 5_000_000);
        if (!parsedBody.ok) {
          return jsonResponse(request, { ok: false, error: parsedBody.error }, parsedBody.status);
        }
        const body = parsedBody.data;

        const prompt = sanitizePlainText(body.prompt, 480, true);
        const imgCheck = validateImageDataUrl(body.imageDataUrl);
        if (!imgCheck.ok) {
          return jsonResponse(request, { ok: false, error: imgCheck.error }, imgCheck.status);
        }
        if (!prompt && !imgCheck.base64) {
          return jsonResponse(
            request,
            { ok: false, error: "Add a photo or short description first." },
            400,
          );
        }

        const id = await resolveVisitorIdentity(request, env);
        const stub = getWorldStub(env);
        const cookieHeaders = id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined;

        const slot = await stub.acquireBuildSlot(id.ipHash, id.cookieId);
        if (!slot.ok) {
          const extra = {
            ...(cookieHeaders ?? {}),
            ...(slot.retryAfterSec ? { "Retry-After": String(slot.retryAfterSec) } : {}),
          };
          return jsonResponse(
            request,
            {
              ok: false,
              ...(slot.alreadyPlaced ? { alreadyPlaced: true, myCreationId: slot.myCreationId } : {}),
              error: slot.error,
            },
            slot.status,
            extra,
          );
        }

        try {
          const sculpted = await sculptWithArgon(
            {
              prompt,
              imageBase64: imgCheck.base64,
              imageMimeType: imgCheck.mimeType,
            },
            env.GEMINI_API_KEY,
            env.ARGON_MODEL,
            env.FALLBACK_MODEL,
          );

          if (!sculpted.ok) {
            const status = sculpted.unsafe ? 422 : 400;
            return jsonResponse(request, sculpted, status, cookieHeaders);
          }

          const placed = await stub.placeCreation({
            ipHash: id.ipHash,
            cookieId: id.cookieId,
            blueprintRaw: sculpted.blueprint as unknown as Record<string, unknown>,
            x: typeof body.x === "number" && Number.isFinite(body.x) ? body.x : null,
            z: typeof body.z === "number" && Number.isFinite(body.z) ? body.z : null,
            yaw: typeof body.yaw === "number" && Number.isFinite(body.yaw) ? body.yaw : null,
          });

          if (!placed.ok) {
            const status = placed.alreadyPlaced ? 409 : 400;
            return jsonResponse(request, placed, status, cookieHeaders);
          }

          const feeds = await resolveWorldLiveFeeds(placed.world.creations);
          return jsonResponse(request, { ...placed, feeds }, 200, cookieHeaders);
        } catch (err) {
          safeLogError("api_build", err, [env.GEMINI_API_KEY, env.CREATOR_HMAC_SECRET]);
          return jsonResponse(
            request,
            { ok: false, error: "Argon took a moment too long building that — please try once more." },
            502,
            cookieHeaders,
          );
        } finally {
          await stub.releaseBuildSlot(slot.lockToken).catch(() => {});
        }
      }

      // Local-only test endpoints: strictly disabled in production AND unless ENABLE_DEV_ENDPOINTS="1"
      if (
        url.pathname.startsWith("/api/dev/") &&
        isLocalDevRequest(request) &&
        env.ENABLE_DEV_ENDPOINTS === "1"
      ) {
        if (url.pathname === "/api/dev/weave" && request.method === "POST") {
          const stub = getWorldStub(env);
          const res = await stub.runCronWeaver();
          return jsonResponse(request, res, 200);
        }
        if (url.pathname === "/api/dev/audit-repair" && request.method === "POST") {
          const parsed = await readBoundedJsonBody(request, 512_000);
          const body = parsed.ok ? parsed.data : {};
          if (body.blueprint && typeof body.blueprint === "object") {
            const rawBp = normalizeAndGroundBlueprint(
              body.blueprint as Record<string, unknown>,
              "Test Overlapping Creation",
              { skipAutoRepair: true },
            );
            const result = autoRepairBlueprintOverlaps(rawBp);
            return jsonResponse(request, {
              ok: true,
              reportBefore: result.reportBefore,
              reportAfter: result.reportAfter,
              repairsApplied: result.repairsApplied,
              repairedBlueprint: result.blueprint,
            });
          }
          const stub = getWorldStub(env);
          const worldRepair = await stub.runWorldAuditAndRepair();
          return jsonResponse(request, { ok: true, ...worldRepair });
        }
      }

      // Reject any unknown /api/* route cleanly (never fall through to static assets)
      if (url.pathname.startsWith("/api/")) {
        return jsonResponse(request, { ok: false, error: "Not found." }, 404);
      }

      // Serve static assets with hardened security headers attached as belt-and-suspenders alongside _headers
      const assetRes = await env.ASSETS.fetch(request);
      const isHttps = url.protocol === "https:";
      const headers = new Headers(assetRes.headers);
      for (const [k, v] of Object.entries(buildSecurityHeaders(isHttps))) {
        if (!headers.has(k)) {
          headers.set(k, v);
        }
      }
      return new Response(assetRes.body, {
        status: assetRes.status,
        statusText: assetRes.statusText,
        headers,
      });
    } catch (err) {
      safeLogError("unhandled_fetch", err, [env.GEMINI_API_KEY, env.CREATOR_HMAC_SECRET]);
      return jsonResponse(request, { ok: false, error: "Internal server error." }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    const stub = getWorldStub(env);
    ctx.waitUntil(
      stub.runCronWeaver().catch((err) => {
        safeLogError("scheduled_cron", err, [env.GEMINI_API_KEY, env.CREATOR_HMAC_SECRET]);
      }),
    );
  },
} satisfies ExportedHandler<AppEnv>;
