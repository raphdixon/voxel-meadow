import { sculptWithArgon } from "./argon_sculptor";
import { resolveWorldLiveFeeds } from "./live_feeds";
import { refreshDailyOgScreenshotsIfDue } from "./og_renderer";
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
import {
  renderBlueprintContactSheetPng,
  reviewBlueprintWithCritic,
  summarizeBlueprintCrossSections,
} from "./voxel_critic";
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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

const OG_ROUTE_VARIANTS: Record<string, "vertical" | "square" | "landscape"> = {
  "/og-vertical.jpg": "vertical",
  "/og-square.jpg": "square",
  "/og-image.jpg": "landscape",
};

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const isHttps = url.protocol === "https:";

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

      // Dynamic 24-hour live island social media pull-through images (GET + HEAD for unfurl crawlers)
      const ogVariant = OG_ROUTE_VARIANTS[url.pathname];
      if (ogVariant && (request.method === "GET" || request.method === "HEAD")) {
        const stub = getWorldStub(env);
        const snap = await stub.getOgSnapshot(ogVariant).catch(() => null);
        if (snap && snap.b64) {
          const bytes = base64ToBytes(snap.b64);
          return new Response(request.method === "HEAD" ? null : bytes, {
            status: 200,
            headers: {
              ...buildSecurityHeaders(isHttps),
              "content-type": "image/jpeg",
              "content-length": String(bytes.byteLength),
              "cache-control": "public, max-age=3600, s-maxage=86400",
              "cross-origin-resource-policy": "cross-origin",
            },
          });
        }
        // Fallback to bundled baseline public/og-*.jpg if DO snapshot hasn't run yet
        const assetRes = await env.ASSETS.fetch(request);
        const headers = new Headers(assetRes.headers);
        for (const [k, v] of Object.entries(buildSecurityHeaders(isHttps))) {
          if (!headers.has(k)) headers.set(k, v);
        }
        headers.set("cross-origin-resource-policy", "cross-origin");
        headers.set("cache-control", "public, max-age=3600, s-maxage=86400");
        return new Response(request.method === "HEAD" ? null : assetRes.body, {
          status: assetRes.status,
          headers,
        });
      }

      // Serve / and /index.html with daily cache-busted OG image URLs so social crawlers refresh every 24h
      if (
        (url.pathname === "/" || url.pathname === "/index.html") &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const assetUrl = new URL("/index.html", request.url);
        const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
        const stub = getWorldStub(env);
        const lastOgAt = await stub.getLastOgCaptureAt().catch(() => 0);
        const versionTag =
          lastOgAt > 0
            ? String(Math.floor(lastOgAt / 1000))
            : String(Math.floor(Date.now() / (24 * 60 * 60 * 1000)));

        const htmlRaw = await assetRes.text();
        const html = htmlRaw
          .replace(/\/og-vertical\.jpg(?!\?)/g, `/og-vertical.jpg?v=${versionTag}`)
          .replace(/\/og-square\.jpg(?!\?)/g, `/og-square.jpg?v=${versionTag}`)
          .replace(/\/og-image\.jpg(?!\?)/g, `/og-image.jpg?v=${versionTag}`);

        const headers = new Headers(assetRes.headers);
        headers.set("content-type", "text/html; charset=utf-8");
        headers.set("cache-control", "public, max-age=300");
        for (const [k, v] of Object.entries(buildSecurityHeaders(isHttps))) {
          headers.set(k, v);
        }
        return new Response(request.method === "HEAD" ? null : html, {
          status: 200,
          headers,
        });
      }

      // Read full shared world state + today's creation + active queue job if building
      if (url.pathname === "/api/world") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const id = await resolveVisitorIdentity(request, env);
        const stub = getWorldStub(env);
        const snapshot = await stub.getWorldSnapshot(id.cookieId, id.dayKey);
        return jsonResponse(
          request,
          snapshot,
          200,
          id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
        );
      }

      // Live build queue status + ETA polling endpoint for waiting/sculpting visitors
      if (url.pathname === "/api/job") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const id = await resolveVisitorIdentity(request, env);
        const jobId = sanitizePlainText(url.searchParams.get("id") ?? "", 64, true);
        const stub = getWorldStub(env);
        const statusRes = await stub.getBuildJobStatus(jobId || null, id.cookieId, id.dayKey);
        const feeds = statusRes.world
          ? await resolveWorldLiveFeeds(statusRes.world.creations)
          : undefined;
        return jsonResponse(
          request,
          {
            ok: true,
            job: statusRes.job,
            ...(statusRes.world ? { world: statusRes.world } : {}),
            ...(feeds ? { feeds } : {}),
          },
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

      // Live adaptive build telemetry, model cascade & recent failure diagnostics
      if (url.pathname === "/api/eta") {
        if (request.method !== "GET") {
          return jsonResponse(request, { ok: false, error: "Method not allowed." }, 405);
        }
        const stub = getWorldStub(env);
        const [telemetry, diagnostics] = await Promise.all([
          stub.getBuildEtaTelemetry(),
          stub.getBuildDiagnostics(),
        ]);
        return jsonResponse(
          request,
          { ok: true, telemetry, diagnostics },
          200,
          { "cache-control": "public, max-age=5" },
        );
      }

      // Enqueue build into the multi-user FIFO workshop queue (handles 10-40+ simultaneous builders cleanly)
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

        const enqueued = await stub.enqueueBuildJob({
          ipHash: id.ipHash,
          cookieId: id.cookieId,
          dayKey: id.dayKey,
          prompt,
          imageBase64: imgCheck.base64,
          imageMimeType: imgCheck.mimeType,
          x: typeof body.x === "number" && Number.isFinite(body.x) ? body.x : null,
          z: typeof body.z === "number" && Number.isFinite(body.z) ? body.z : null,
          yaw: typeof body.yaw === "number" && Number.isFinite(body.yaw) ? body.yaw : null,
        });

        if (!enqueued.ok) {
          const extra = {
            ...(cookieHeaders ?? {}),
            ...(enqueued.retryAfterSec ? { "Retry-After": String(enqueued.retryAfterSec) } : {}),
          };
          return jsonResponse(
            request,
            {
              ok: false,
              ...(enqueued.alreadyPlaced
                ? { alreadyPlaced: true, myCreationId: enqueued.myCreationId }
                : {}),
              error: enqueued.error,
            },
            enqueued.status,
            extra,
          );
        }

        return jsonResponse(
          request,
          {
            ok: true,
            queued: true,
            job: enqueued.job,
          },
          200,
          cookieHeaders,
        );
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
        if (url.pathname === "/api/dev/critic-test" && request.method === "POST") {
          const parsed = await readBoundedJsonBody(request, 512_000);
          if (!parsed.ok) return jsonResponse(request, { ok: false, error: parsed.error }, 400);
          const body = parsed.data;
          const prompt = typeof body.prompt === "string" ? body.prompt : "Meadow Creation";

          if (body.sculptFromScratch === true) {
            if (!env.GEMINI_API_KEY) {
              return jsonResponse(request, { ok: false, error: "Missing GEMINI_API_KEY" }, 503);
            }
            const overrideModels = Array.isArray(body.overrideModels)
              ? body.overrideModels.filter((m): m is string => typeof m === "string")
              : undefined;
            const phases: string[] = [];
            const sculpted = await sculptWithArgon(
              {
                prompt,
                overrideModels,
                onPhase: (ph) => phases.push(ph),
              },
              env.GEMINI_API_KEY,
              env.ARGON_MODEL,
              env.FALLBACK_MODEL,
              env.BARIUM_MODELS,
            );
            if (!sculpted.ok) {
              return jsonResponse(
                request,
                { ok: false, error: sculpted.error, errorDetail: sculpted.errorDetail, phases },
                200,
              );
            }
            const contactSheetPngBase64 = await renderBlueprintContactSheetPng(sculpted.blueprint);
            const crossSectionSummary = summarizeBlueprintCrossSections(sculpted.blueprint);
            return jsonResponse(request, {
              ok: true,
              phases,
              sculpted,
              contactSheetPngBase64,
              crossSectionSummary,
            });
          }

          if (!body.blueprint || typeof body.blueprint !== "object") {
            return jsonResponse(request, { ok: false, error: "blueprint required" }, 400);
          }

          const bp = normalizeAndGroundBlueprint(
            body.blueprint as Record<string, unknown>,
            prompt,
          );
          const contactSheetPngBase64 = await renderBlueprintContactSheetPng(bp);
          const crossSectionSummary = summarizeBlueprintCrossSections(bp);

          if (body.renderOnly === true) {
            return jsonResponse(request, {
              ok: true,
              stats: bp.stats,
              contactSheetPngBase64,
              crossSectionSummary,
            });
          }

          if (!env.GEMINI_API_KEY) {
            return jsonResponse(request, { ok: false, error: "Missing GEMINI_API_KEY" }, 503);
          }

          const review = await reviewBlueprintWithCritic({
            blueprint: bp,
            promptText: prompt,
            apiKey: env.GEMINI_API_KEY,
            primaryModel: env.ARGON_MODEL,
            bariumModels: env.BARIUM_MODELS,
            fallbackModel: env.FALLBACK_MODEL,
          });

          let resculpted: Awaited<ReturnType<typeof sculptWithArgon>> | null = null;
          let resculptedContactSheetPngBase64: string | null = null;
          let resculptedCrossSectionSummary: string | null = null;

          if (!review.approved && body.resculptIfRejected === true) {
            resculpted = await sculptWithArgon(
              {
                prompt,
                initialCriticHint: `${review.diagnosis}\n${review.rebuildInstructions}`,
                initialCriticRenderPngBase64: review.contactSheetPngBase64,
              },
              env.GEMINI_API_KEY,
              env.ARGON_MODEL,
              env.FALLBACK_MODEL,
              env.BARIUM_MODELS,
            );
            if (resculpted.ok) {
              resculptedContactSheetPngBase64 = await renderBlueprintContactSheetPng(
                resculpted.blueprint,
              );
              resculptedCrossSectionSummary = summarizeBlueprintCrossSections(resculpted.blueprint);
            }
          }

          return jsonResponse(request, {
            ok: true,
            review,
            crossSectionSummary,
            resculpted,
            resculptedContactSheetPngBase64,
            resculptedCrossSectionSummary,
          });
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
        if (url.pathname === "/api/dev/place-raw" && request.method === "POST") {
          const parsed = await readBoundedJsonBody(request, 512_000);
          if (!parsed.ok) return jsonResponse(request, { ok: false, error: parsed.error }, 400);
          const body = parsed.data;
          const id = await resolveVisitorIdentity(request, env);
          const stub = getWorldStub(env);
          const placed = await stub.placeCreation({
            ipHash: id.ipHash,
            cookieId: typeof body.cookieId === "string" ? body.cookieId : id.cookieId,
            dayKey: id.dayKey,
            creatorPrompt: typeof body.creatorPrompt === "string" ? body.creatorPrompt : "",
            blueprintRaw: (body.blueprint as Record<string, unknown>) || {},
            x: typeof body.x === "number" ? body.x : null,
            z: typeof body.z === "number" ? body.z : null,
            yaw: typeof body.yaw === "number" ? body.yaw : null,
          });
          return jsonResponse(request, placed, placed.ok ? 200 : 400);
        }
        if (url.pathname === "/api/dev/enqueue-batch" && request.method === "POST") {
          const parsed = await readBoundedJsonBody(request, 512_000);
          if (!parsed.ok) return jsonResponse(request, { ok: false, error: parsed.error }, 400);
          const id = await resolveVisitorIdentity(request, env);
          const itemsRaw = Array.isArray(parsed.data.items) ? parsed.data.items.slice(0, 25) : [];
          const items = itemsRaw.map((rawItem, idx) => {
            const rec = rawItem && typeof rawItem === "object" ? (rawItem as Record<string, unknown>) : {};
            return {
              cookieId:
                rec.cookieId === "SELF"
                  ? id.cookieId
                  : typeof rec.cookieId === "string" && rec.cookieId
                    ? rec.cookieId
                    : idx === 0
                      ? id.cookieId
                      : `sim-visitor-${idx}-${Date.now()}`,
              prompt: typeof rec.prompt === "string" ? rec.prompt : `Simulated Creation #${idx + 1}`,
              delayMs: typeof rec.delayMs === "number" ? rec.delayMs : 4500,
              refineAfterMs: typeof rec.refineAfterMs === "number" ? rec.refineAfterMs : undefined,
              placeBlueprint:
                rec.placeBlueprint && typeof rec.placeBlueprint === "object"
                  ? (rec.placeBlueprint as Record<string, unknown>)
                  : null,
            };
          });
          const stub = getWorldStub(env);
          const jobs = await stub.enqueueDevSimulatedBatch(items, id.dayKey);
          return jsonResponse(
            request,
            { ok: true, jobs },
            200,
            id.setCookieHeader ? { "Set-Cookie": id.setCookieHeader } : undefined,
          );
        }
        if (url.pathname === "/api/dev/seed-telemetry" && request.method === "POST") {
          const parsed = await readBoundedJsonBody(request, 256_000);
          if (!parsed.ok) return jsonResponse(request, { ok: false, error: parsed.error }, 400);
          const samples = Array.isArray(parsed.data.samples) ? parsed.data.samples.slice(0, 50) : [];
          const stub = getWorldStub(env);
          for (const raw of samples) {
            if (!raw || typeof raw !== "object") continue;
            const s = raw as Record<string, unknown>;
            const comp =
              s.complexity === "compact" || s.complexity === "complex" ? s.complexity : "standard";
            await stub.recordBuildTelemetry({
              durationMs: Number(s.durationMs) || 48_000,
              round1Ms: Number(s.round1Ms) || Number(s.durationMs) || 48_000,
              hadRefinementPass: Boolean(s.hadRefinementPass),
              usedFallback: Boolean(s.usedFallback),
              hasImage: Boolean(s.hasImage),
              complexity: comp,
              scaleClass: typeof s.scaleClass === "string" ? s.scaleClass : null,
            });
          }
          const telemetry = await stub.getBuildEtaTelemetry();
          return jsonResponse(request, { ok: true, telemetry }, 200);
        }
        if (url.pathname === "/api/dev/refresh-og" && request.method === "POST") {
          const stub = getWorldStub(env);
          const res = await refreshDailyOgScreenshotsIfDue(env, stub, {
            force: true,
            siteOrigin: url.origin,
          });
          return jsonResponse(request, { ok: true, ...res }, 200);
        }
        if (url.pathname === "/api/dev/load-world-snapshot" && request.method === "POST") {
          const parsed = await readBoundedJsonBody(request, 8_000_000);
          if (!parsed.ok) return jsonResponse(request, { ok: false, error: parsed.error }, 400);
          const stub = getWorldStub(env);
          const loaded = await stub.loadDevWorldSnapshot(parsed.data as Record<string, unknown>);
          return jsonResponse(request, { ok: true, ...loaded }, 200);
        }
      }

      // Reject any unknown /api/* route cleanly (never fall through to static assets)
      if (url.pathname.startsWith("/api/")) {
        return jsonResponse(request, { ok: false, error: "Not found." }, 404);
      }

      // Serve static assets with hardened security headers attached as belt-and-suspenders alongside _headers
      const assetRes = await env.ASSETS.fetch(request);
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
      Promise.allSettled([
        stub.runCronWeaver(),
        refreshDailyOgScreenshotsIfDue(env, stub, {
          siteOrigin: "https://geminisland.raph.plus",
        }),
      ]).catch((err) => {
        safeLogError("scheduled_cron", err, [env.GEMINI_API_KEY, env.CREATOR_HMAC_SECRET]);
      }),
    );
  },
} satisfies ExportedHandler<AppEnv>;
