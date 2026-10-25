import { redactSecrets, safeLogWarn } from "./security";

export type GeminiCallMode = "sculpt" | "critic" | "director";

export interface GeminiAttemptRecord {
  model: string;
  ok: boolean;
  ms: number;
  firstChunkMs?: number;
  reason?: string;
}

export const DEFAULT_ARGON_MODELS = ["gemini-4-argon", "gemini-4-argon-eap"] as const;

/**
 * Complete Barium fallback family discovered on `generativelanguage.googleapis.com/v1beta/models`.
 * Ordered by empirical live availability & latency:
 *  - `barium-b`: active 200 OK (~2.5s first SSE chunk, ~8–15s full 3D voxel blueprint)
 *  - `barium-c`: active serving pool (fast ~0.7s 503 if at spike demand, streams when free)
 *  - `barium-bb-v2`, `barium-bb3`, `barium-bb2`, `barium-bb`: extended-output Barium variants
 *    (guarded by fast first-chunk timeout when unscheduled, full 50s budget once streaming)
 *  - `barium-a`, `barium-cc3`: fast ~0.6s failover if unmounted, full 45s budget if mounted
 */
export const DEFAULT_BARIUM_FALLBACK_MODELS = [
  "barium-b",
  "barium-c",
  "barium-bb-v2",
  "barium-bb3",
  "barium-bb2",
  "barium-bb",
  "barium-a",
  "barium-cc3",
] as const;

export const DEFAULT_GEMINI_SAFETY_NET_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
] as const;

const MODEL_ID_RE = /^[a-zA-Z0-9._-]+$/;
const SPECULATIVE_BARIUM_RE = /^barium-(bb|a|cc)/i;

export function parseModelList(raw?: string | readonly string[] | null): string[] {
  if (!raw) return [];
  const items = typeof raw === "string" ? raw.split(",") : raw;
  const out: string[] = [];
  for (const item of items) {
    const clean = String(item ?? "").trim().replace(/^models\//, "");
    if (clean && MODEL_ID_RE.test(clean)) {
      out.push(clean);
    }
  }
  return out;
}

export function buildGeminiModelCascade(opts?: {
  primaryModel?: string;
  bariumModels?: string | readonly string[];
  fallbackModel?: string;
  overrideModels?: readonly string[];
}): string[] {
  if (opts?.overrideModels && opts.overrideModels.length > 0) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of opts.overrideModels) {
      const m = String(raw ?? "").trim().replace(/^models\//, "");
      if (m && MODEL_ID_RE.test(m) && !seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
    return out;
  }

  const configuredBarium = parseModelList(opts?.bariumModels);
  const rawOrder: string[] = [
    opts?.primaryModel?.trim() || DEFAULT_ARGON_MODELS[0],
    ...DEFAULT_ARGON_MODELS.slice(1),
    ...configuredBarium,
    ...DEFAULT_BARIUM_FALLBACK_MODELS,
    opts?.fallbackModel?.trim() || DEFAULT_GEMINI_SAFETY_NET_MODELS[0],
    ...DEFAULT_GEMINI_SAFETY_NET_MODELS,
  ];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of rawOrder) {
    const clean = raw.replace(/^models\//, "").trim();
    if (!clean || !MODEL_ID_RE.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    deduped.push(clean);
  }
  return deduped;
}

export function extractJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const text = String(raw ?? "").trim();
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object");
  }
  const slice = stripped.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    const repaired = slice.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(repaired) as Record<string, unknown>;
  }
}

interface StreamTimeouts {
  firstChunkTimeoutMs: number;
  idleChunkTimeoutMs: number;
  totalTimeoutMs: number;
}

function getModelStreamTimeouts(model: string, mode: GeminiCallMode): StreamTimeouts {
  const isSpeculativeBarium = SPECULATIVE_BARIUM_RE.test(model);
  if (isSpeculativeBarium) {
    return {
      firstChunkTimeoutMs: mode === "critic" ? 3_200 : 3_800,
      idleChunkTimeoutMs: 18_000,
      totalTimeoutMs: mode === "critic" ? 32_000 : 50_000,
    };
  }
  if (model === "barium-c") {
    return {
      firstChunkTimeoutMs: mode === "critic" ? 6_500 : 8_000,
      idleChunkTimeoutMs: 20_000,
      totalTimeoutMs: mode === "critic" ? 34_000 : 50_000,
    };
  }
  if (model.startsWith("gemini-4-argon")) {
    return {
      firstChunkTimeoutMs: mode === "critic" ? 14_000 : 22_000,
      idleChunkTimeoutMs: 28_000,
      totalTimeoutMs: mode === "critic" ? 38_000 : mode === "director" ? 48_000 : 62_000,
    };
  }
  if (model === "barium-b") {
    return {
      firstChunkTimeoutMs: mode === "critic" ? 12_000 : 18_000,
      idleChunkTimeoutMs: 24_000,
      totalTimeoutMs: mode === "critic" ? 36_000 : mode === "director" ? 46_000 : 55_000,
    };
  }
  return {
    firstChunkTimeoutMs: mode === "critic" ? 12_000 : 16_000,
    idleChunkTimeoutMs: 24_000,
    totalTimeoutMs: mode === "critic" ? 36_000 : mode === "director" ? 46_000 : 52_000,
  };
}

interface SseAccumulator {
  nonThoughtText: string;
  allText: string;
  blockReason: string | null;
  streamError: string | null;
  finishReason: string | null;
}

function consumeSseLine(rawLine: string, acc: SseAccumulator): void {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;

  const ev = JSON.parse(payload) as {
    error?: { code?: number; message?: string; status?: string };
    promptFeedback?: { blockReason?: string };
    candidates?: {
      finishReason?: string;
      content?: { parts?: { text?: string; thought?: boolean }[] };
    }[];
  };

  if (ev.error) {
    acc.streamError = `SSE ${ev.error.code ?? ""} ${ev.error.status ?? ""}: ${ev.error.message ?? "stream error"}`.trim();
    return;
  }
  if (ev.promptFeedback?.blockReason) {
    acc.blockReason = ev.promptFeedback.blockReason;
  }
  const cand = ev.candidates?.[0];
  if (cand?.finishReason) {
    acc.finishReason = cand.finishReason;
  }
  for (const part of cand?.content?.parts ?? []) {
    if (typeof part.text === "string") {
      acc.allText += part.text;
      if (!part.thought) {
        acc.nonThoughtText += part.text;
      }
    }
  }
}

async function streamSingleModelAttempt(opts: {
  model: string;
  apiKey: string;
  systemPrompt: string;
  userParts: Record<string, unknown>[];
  temperature: number;
  maxOutputTokens: number;
  thinkingBudget: number | null;
  timeouts: StreamTimeouts;
}): Promise<{
  ok: true;
  rawText: string;
  blockReason: string | null;
  finishReason: string | null;
  firstChunkMs: number;
} | {
  ok: false;
  httpStatus?: number;
  errorBody?: string;
  reason: string;
}> {
  const t0 = Date.now();
  const controller = new AbortController();
  let abortReason = "aborted";

  const totalTimer = setTimeout(() => {
    abortReason = `TotalTimeout(${opts.timeouts.totalTimeoutMs}ms)`;
    controller.abort();
  }, opts.timeouts.totalTimeoutMs);

  let firstChunkTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    abortReason = `FirstByteTimeout(${opts.timeouts.firstChunkTimeoutMs}ms)`;
    controller.abort();
  }, opts.timeouts.firstChunkTimeoutMs);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = `IdleStreamTimeout(${opts.timeouts.idleChunkTimeoutMs}ms)`;
      controller.abort();
    }, opts.timeouts.idleChunkTimeoutMs);
  };

  const clearAllTimers = (): void => {
    clearTimeout(totalTimer);
    if (firstChunkTimer !== null) {
      clearTimeout(firstChunkTimer);
      firstChunkTimer = null;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  try {
    // Security invariant: API key MUST only be sent via x-goog-api-key header, NEVER in URL query parameters
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`;
    const generationConfig: Record<string, unknown> = {
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      responseMimeType: "application/json",
    };
    if (opts.thinkingBudget !== null && opts.thinkingBudget > 0) {
      generationConfig.thinkingConfig = {
        thinkingBudget: opts.thinkingBudget,
        includeThoughts: true,
      };
    }

    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        contents: [{ role: "user", parts: opts.userParts }],
        generationConfig,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      clearAllTimers();
      return {
        ok: false,
        httpStatus: res.status,
        errorBody: errBody,
        reason: `HTTP ${res.status}: ${redactSecrets(errBody.slice(0, 140), [opts.apiKey])}`,
      };
    }

    if (!res.body) {
      clearAllTimers();
      return { ok: false, reason: "Empty response stream body" };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const acc: SseAccumulator = {
      nonThoughtText: "",
      allText: "",
      blockReason: null,
      streamError: null,
      finishReason: null,
    };

    let firstChunkMs = -1;
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (value && value.byteLength > 0) {
        if (firstChunkMs < 0) {
          firstChunkMs = Date.now() - t0;
          if (firstChunkTimer !== null) {
            clearTimeout(firstChunkTimer);
            firstChunkTimer = null;
          }
        }
        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          consumeSseLine(line, acc);
          if (acc.streamError) {
            await reader.cancel().catch(() => {});
            clearAllTimers();
            return {
              ok: false,
              reason: redactSecrets(acc.streamError, [opts.apiKey]),
            };
          }
        }
      }
      if (done) break;
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        consumeSseLine(line, acc);
      }
    }

    clearAllTimers();

    if (acc.streamError) {
      return { ok: false, reason: redactSecrets(acc.streamError, [opts.apiKey]) };
    }

    const rawText = acc.nonThoughtText.trim() || acc.allText.trim();
    return {
      ok: true,
      rawText,
      blockReason: acc.blockReason,
      finishReason: acc.finishReason,
      firstChunkMs: firstChunkMs >= 0 ? firstChunkMs : Date.now() - t0,
    };
  } catch (err) {
    clearAllTimers();
    const msg = controller.signal.aborted
      ? abortReason
      : redactSecrets(err, [opts.apiKey]);
    return { ok: false, reason: msg };
  }
}

export async function callGeminiWithFallbacks(opts: {
  apiKey: string;
  mode?: GeminiCallMode;
  primaryModel?: string;
  bariumModels?: string | readonly string[];
  fallbackModel?: string;
  overrideModels?: readonly string[];
  systemPrompt: string;
  userText: string;
  imageBase64?: string;
  imageMimeType?: string;
  extraImages?: { mimeType: string; data: string }[];
  temperature?: number;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  maxCascadeMs?: number;
}): Promise<{
  json: Record<string, unknown>;
  modelUsed: string;
  attempts: GeminiAttemptRecord[];
}> {
  const mode: GeminiCallMode = opts.mode ?? "sculpt";
  const models = buildGeminiModelCascade({
    primaryModel: opts.primaryModel,
    bariumModels: opts.bariumModels,
    fallbackModel: opts.fallbackModel,
    overrideModels: opts.overrideModels,
  });

  const userParts: Record<string, unknown>[] = [];
  if (opts.imageBase64 && opts.imageMimeType) {
    userParts.push({
      inlineData: {
        mimeType: opts.imageMimeType,
        data: opts.imageBase64,
      },
    });
  }
  if (Array.isArray(opts.extraImages)) {
    for (const img of opts.extraImages) {
      if (img?.data && img?.mimeType) {
        userParts.push({
          inlineData: {
            mimeType: img.mimeType,
            data: img.data,
          },
        });
      }
    }
  }
  userParts.push({ text: opts.userText });

  const cascadeStart = Date.now();
  const maxCascadeMs =
    opts.maxCascadeMs ??
    (mode === "critic" ? 55_000 : mode === "director" ? 75_000 : 135_000);

  const attempts: GeminiAttemptRecord[] = [];

  for (let idx = 0; idx < models.length; idx++) {
    const model = models[idx];
    const elapsedTotal = Date.now() - cascadeStart;

    // If >=72% of total wall-clock cascade budget is already spent, skip speculative secondary
    // Barium variants so guaranteed fast Flash/Pro safety-net models still get clean headroom.
    if (
      idx > 0 &&
      elapsedTotal > maxCascadeMs * 0.72 &&
      SPECULATIVE_BARIUM_RE.test(model)
    ) {
      continue;
    }
    if (idx > 0 && elapsedTotal >= maxCascadeMs) {
      break;
    }

    const attemptStart = Date.now();
    const timeouts = getModelStreamTimeouts(model, mode);
    const desiredThinking = opts.thinkingBudget ?? (mode === "critic" ? 512 : 1024);

    let res = await streamSingleModelAttempt({
      model,
      apiKey: opts.apiKey,
      systemPrompt: opts.systemPrompt,
      userParts,
      temperature: opts.temperature ?? 0.42,
      maxOutputTokens: opts.maxOutputTokens ?? 12288,
      thinkingBudget: desiredThinking,
      timeouts,
    });

    // Automatic compatibility fallback if a model rejects `thinkingConfig` / `includeThoughts` with HTTP 400
    if (
      !res.ok &&
      res.httpStatus === 400 &&
      res.errorBody &&
      /thinking/i.test(res.errorBody)
    ) {
      res = await streamSingleModelAttempt({
        model,
        apiKey: opts.apiKey,
        systemPrompt: opts.systemPrompt,
        userParts,
        temperature: opts.temperature ?? 0.42,
        maxOutputTokens: opts.maxOutputTokens ?? 12288,
        thinkingBudget: null,
        timeouts,
      });
    }

    const attemptMs = Math.max(1, Date.now() - attemptStart);

    if (!res.ok) {
      attempts.push({
        model,
        ok: false,
        ms: attemptMs,
        reason: res.reason,
      });
      continue;
    }

    if (
      !res.rawText &&
      res.blockReason &&
      /^(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|IMAGE_SAFETY)$/i.test(res.blockReason) &&
      mode === "sculpt"
    ) {
      attempts.push({
        model,
        ok: true,
        ms: attemptMs,
        firstChunkMs: res.firstChunkMs,
      });
      return {
        json: {
          safe: false,
          safeReason:
            "That creation doesn't fit our family-friendly shared meadow — please try something else.",
        },
        modelUsed: model,
        attempts,
      };
    }

    try {
      const json = extractJsonObject(res.rawText);
      attempts.push({
        model,
        ok: true,
        ms: attemptMs,
        firstChunkMs: res.firstChunkMs,
      });

      if (idx > 0) {
        const failedSummary = attempts
          .slice(0, -1)
          .map((a) => `${a.model}(${a.reason ?? "err"},${a.ms}ms)`)
          .join(" -> ");
        safeLogWarn(
          "gemini_model_fallback",
          `[${mode}] Rescued by ${model} (${attemptMs}ms) after: ${failedSummary}`,
          [opts.apiKey],
        );
      }

      return { json, modelUsed: model, attempts };
    } catch (parseErr) {
      const parseReason = `JSON parse error (${res.finishReason ?? "unknown"}): ${redactSecrets(parseErr, [opts.apiKey]).slice(0, 90)}`;
      attempts.push({
        model,
        ok: false,
        ms: attemptMs,
        firstChunkMs: res.firstChunkMs,
        reason: parseReason,
      });
    }
  }

  const trace = attempts
    .map((a) => `${a.model}: ${a.reason ?? "failed"} (${a.ms}ms)`)
    .join(" | ");
  throw new Error(
    redactSecrets(
      `All ${attempts.length}/${models.length} Argon/Barium/Gemini models failed [${mode}]: ${trace}`,
      [opts.apiKey],
    ),
  );
}
