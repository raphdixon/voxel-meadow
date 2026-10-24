const ALLOWED_PROD_ORIGINS = new Set(["https://geminisland.raph.plus"]);

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{16,}/g,
  /ya29\.[0-9A-Za-z._-]+/g,
  /(x-goog-api-key\s*[:=]\s*)([^\s"',;}\]]+)/gi,
  /([?&](?:key|api_key|token|secret)=)([^&\s"'#]+)/gi,
  /(Bearer\s+)([0-9A-Za-z._~+/=-]+)/gi,
];

let ephemeralDevHmacSecret: string | null = null;

function getDevHmacSecret(): string {
  if (!ephemeralDevHmacSecret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    ephemeralDevHmacSecret = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return ephemeralDevHmacSecret;
}

/**
 * Scrubs any API keys, HMAC secrets, Bearer tokens, or Google key patterns from strings/errors
 * before logging, throwing, or storing diagnostic notes.
 */
export function redactSecrets(
  input: unknown,
  extraSecrets: readonly (string | undefined | null)[] = [],
): string {
  let raw = "";
  if (input instanceof Error) {
    raw = `${input.name}: ${input.message}`;
  } else if (typeof input === "string") {
    raw = input;
  } else {
    try {
      raw = JSON.stringify(input) ?? String(input);
    } catch {
      raw = String(input);
    }
  }

  let out = raw;
  for (const s of extraSecrets) {
    if (typeof s === "string" && s.trim().length >= 8) {
      const trimmed = s.trim();
      out = out.split(trimmed).join("[REDACTED]");
      const encoded = encodeURIComponent(trimmed);
      if (encoded !== trimmed) {
        out = out.split(encoded).join("[REDACTED]");
      }
    }
  }

  out = out.replace(SECRET_PATTERNS[0], "[REDACTED_GCP_KEY]");
  out = out.replace(SECRET_PATTERNS[1], "[REDACTED_TOKEN]");
  out = out.replace(SECRET_PATTERNS[2], "$1[REDACTED]");
  out = out.replace(SECRET_PATTERNS[3], "$1[REDACTED]");
  out = out.replace(SECRET_PATTERNS[4], "$1[REDACTED]");

  return out.slice(0, 400);
}

export function safeLogError(
  context: string,
  err: unknown,
  extraSecrets: readonly (string | undefined | null)[] = [],
): void {
  console.error(
    JSON.stringify({
      level: "error",
      context,
      error: redactSecrets(err, extraSecrets),
      ts: Date.now(),
    }),
  );
}

/**
 * True ONLY when running locally in `wrangler dev` on loopback without Cloudflare edge metadata.
 */
export function isLocalDevRequest(request: Request): boolean {
  const reqWithCf = request as Request & { cf?: unknown };
  if (reqWithCf.cf) return false;
  const url = new URL(request.url);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function isAllowedOrigin(origin: string, isLocal: boolean): boolean {
  if (ALLOWED_PROD_ORIGINS.has(origin)) return true;
  if (isLocal) {
    return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }
  return false;
}

/**
 * Enforces strict same-origin + CSRF custom header + Fetch Metadata on state-mutating POST requests.
 */
export function verifyMutationSecurity(request: Request): string | null {
  const isLocal = isLocalDevRequest(request);
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return "Cross-site requests are not permitted.";
  }

  const origin = request.headers.get("Origin") || "";
  if (!origin || !isAllowedOrigin(origin, isLocal)) {
    return "Invalid request origin.";
  }

  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return "Expected application/json content-type.";
  }

  if (request.headers.get("X-Meadow-Client") !== "1") {
    return "Missing required client security header.";
  }

  return null;
}

/**
 * Protects `/ws` from Cross-Site WebSocket Hijacking (CSWSH).
 */
export function verifyWebSocketOrigin(request: Request): string | null {
  const isLocal = isLocalDevRequest(request);
  const origin = request.headers.get("Origin");
  if (!origin) {
    // Browsers always send Origin on WebSocket handshakes; allow empty only on local CLI tests
    return isLocal ? null : "Missing WebSocket Origin header.";
  }
  if (!isAllowedOrigin(origin, isLocal)) {
    return "Disallowed WebSocket Origin.";
  }
  return null;
}

/**
 * Normalizes IPv4 to exact address and IPv6 to its `/64` prefix (first 4 hextets)
 * so attackers cannot rotate $2^{64}$ addresses within a single residential IPv6 `/64` allocation.
 */
export function normalizeClientIp(rawIp: string): string {
  const trimmed = rawIp.trim().toLowerCase();
  if (!trimmed) return "0.0.0.0";

  // Strip IPv4-mapped IPv6 prefix if present
  if (trimmed.startsWith("::ffff:") && trimmed.includes(".")) {
    return trimmed.slice(7);
  }

  if (!trimmed.includes(":")) {
    return trimmed;
  }

  // Expand IPv6 `::` into full 8 hextets and take first 4 hextets (/64 subnet)
  const zoneStripped = trimmed.split("%")[0];
  const parts = zoneStripped.split("::");
  if (parts.length > 2) return zoneStripped;

  const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];
  const missing = Math.max(0, 8 - (left.length + right.length));
  const full = [...left, ...Array(missing).fill("0000"), ...right].slice(0, 8);
  const prefix64 = full
    .slice(0, 4)
    .map((h) => h.padStart(4, "0"))
    .join(":");
  return `${prefix64}::/64`;
}

async function hmacSha256Bytes(secret: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Constant-time string comparison via SHA-256 + `crypto.subtle.timingSafeEqual`.
 */
async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(digestA, digestB);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header || header.length > 4096) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k || k === "__proto__" || k === "constructor" || k === "prototype") continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const HOST_COOKIE_NAME = "__Host-meadow_cid";
const LEGACY_COOKIE_NAME = "meadow_cid";
const CID_RE = /^[0-9a-f]{24,40}$/;
const SIG_RE = /^[0-9a-f]{28,64}$/;

export async function resolveVisitorIdentity(
  request: Request,
  env: Env & { ENABLE_DEV_ENDPOINTS?: string },
): Promise<{ ipHash: string; cookieId: string; setCookieHeader?: string }> {
  const isLocal = isLocalDevRequest(request);
  const secret = env.CREATOR_HMAC_SECRET?.trim() || (isLocal ? getDevHmacSecret() : "");
  if (!secret) {
    throw new Error("Missing required CREATOR_HMAC_SECRET in production environment");
  }

  const allowTestHeader = isLocal && env.ENABLE_DEV_ENDPOINTS === "1";
  const rawIp =
    (!isLocal ? request.headers.get("CF-Connecting-IP") : null) ||
    (allowTestHeader ? request.headers.get("X-Test-Visitor") : null) ||
    request.headers.get("CF-Connecting-IP") ||
    "127.0.0.1";

  const normalizedIp = normalizeClientIp(rawIp);
  const ipHash = bytesToHex(await hmacSha256Bytes(secret, `ip:${normalizedIp}`)).slice(0, 32);

  const cookies = parseCookies(request.headers.get("Cookie"));
  const cookieNameToSet = isLocal ? LEGACY_COOKIE_NAME : HOST_COOKIE_NAME;
  const candidates = [cookies[HOST_COOKIE_NAME], cookies[LEGACY_COOKIE_NAME]].filter(
    (v): v is string => typeof v === "string" && v.includes("."),
  );

  for (const token of candidates) {
    const dotIdx = token.indexOf(".");
    const cid = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    if (!CID_RE.test(cid) || !SIG_RE.test(sig)) continue;
    const expectedFull = bytesToHex(await hmacSha256Bytes(secret, `cid:${cid}`));
    const expected = sig.length === 28 ? expectedFull.slice(0, 28) : expectedFull.slice(0, 32);
    if (await timingSafeStringEqual(sig, expected)) {
      // Upgrade legacy cookie to `__Host-` cookie seamlessly on HTTPS
      if (!isLocal && !cookies[HOST_COOKIE_NAME]) {
        const upgradedSig = expectedFull.slice(0, 32);
        return {
          ipHash,
          cookieId: cid,
          setCookieHeader: `${HOST_COOKIE_NAME}=${cid}.${upgradedSig}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`,
        };
      }
      return { ipHash, cookieId: cid };
    }
  }

  const freshCid = crypto.randomUUID().replace(/-/g, "");
  const freshSig = bytesToHex(await hmacSha256Bytes(secret, `cid:${freshCid}`)).slice(0, 32);
  const signedVal = `${freshCid}.${freshSig}`;
  const setCookieHeader = isLocal
    ? `${cookieNameToSet}=${signedVal}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`
    : `${HOST_COOKIE_NAME}=${signedVal}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`;

  return { ipHash, cookieId: freshCid, setCookieHeader };
}

/**
 * Reads JSON request body with strict byte cap on both `Content-Length` and streamed chunks
 * so chunked oversized requests can never exhaust the Worker's 128 MB isolate memory.
 */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes = 5_000_000,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, error: "Request payload is too large." };
  }
  if (!request.body) {
    return { ok: false, status: 400, error: "Empty request body." };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, status: 413, error: "Request payload exceeds size limit." };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, status: 400, error: "Could not read request stream." };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    merged.set(ch, offset);
    offset += ch.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: "Expected a JSON object." };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON request body." };
  }
}

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validates `data:image/(jpeg|png|webp);base64,...` strings, size limits, and binary magic bytes.
 */
export function validateImageDataUrl(
  raw: unknown,
): { ok: true; mimeType?: string; base64?: string } | { ok: false; status: number; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true };
  }
  if (typeof raw !== "string" || !raw.startsWith("data:image/")) {
    return { ok: false, status: 400, error: "Unsupported image format — please upload a JPG, PNG, or WebP." };
  }

  const commaIdx = raw.indexOf(",");
  if (commaIdx === -1 || commaIdx > 64) {
    return { ok: false, status: 400, error: "Malformed image data URL." };
  }

  const meta = raw.slice(5, commaIdx).toLowerCase();
  const parts = meta.split(";").map((s) => s.trim());
  const mimeType = parts[0] || "";
  if (!ALLOWED_IMAGE_MIMES.has(mimeType) || !parts.includes("base64")) {
    return { ok: false, status: 415, error: "Only base64-encoded JPEG, PNG, or WebP images are supported." };
  }

  const b64 = raw.slice(commaIdx + 1).replace(/\s+/g, "");
  if (b64.length < 32) {
    return { ok: false, status: 400, error: "Image data is empty or truncated." };
  }
  if (b64.length > 4_500_000) {
    return { ok: false, status: 413, error: "Image is too large — please use an image under 3.3 MB." };
  }
  if (b64.length % 4 !== 0 || !BASE64_BODY_RE.test(b64)) {
    return { ok: false, status: 400, error: "Invalid base64 image encoding." };
  }

  // Decode first 16 bytes (24 base64 chars) to verify genuine image magic header
  let headerBytes: Uint8Array;
  try {
    const bin = atob(b64.slice(0, 24));
    headerBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) headerBytes[i] = bin.charCodeAt(i);
  } catch {
    return { ok: false, status: 400, error: "Corrupted image header." };
  }

  const isJpeg =
    mimeType === "image/jpeg" &&
    headerBytes[0] === 0xff &&
    headerBytes[1] === 0xd8 &&
    headerBytes[2] === 0xff;
  const isPng =
    mimeType === "image/png" &&
    headerBytes[0] === 0x89 &&
    headerBytes[1] === 0x50 &&
    headerBytes[2] === 0x4e &&
    headerBytes[3] === 0x47 &&
    headerBytes[4] === 0x0d &&
    headerBytes[5] === 0x0a &&
    headerBytes[6] === 0x1a &&
    headerBytes[7] === 0x0a;
  const isWebp =
    mimeType === "image/webp" &&
    headerBytes[0] === 0x52 && // R
    headerBytes[1] === 0x49 && // I
    headerBytes[2] === 0x46 && // F
    headerBytes[3] === 0x46 && // F
    headerBytes[8] === 0x57 && // W
    headerBytes[9] === 0x45 && // E
    headerBytes[10] === 0x42 && // B
    headerBytes[11] === 0x50; // P

  if (!isJpeg && !isPng && !isWebp) {
    return { ok: false, status: 415, error: "Image contents do not match JPEG, PNG, or WebP header." };
  }

  return { ok: true, mimeType, base64: b64 };
}

/**
 * Strips ASCII control chars, bidi overrides, HTML brackets, and URL spam from user/LLM display strings.
 */
export function sanitizePlainText(raw: unknown, maxLen: number, stripUrls = false): string {
  if (typeof raw !== "string") return "";
  let s = raw
    // Remove ASCII control characters & DEL, plus Unicode bidi/zero-width spoofing chars
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    // Strip HTML angle brackets as defense-in-depth alongside textContent + CSP
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (stripUrls) {
    s = s.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  }
  return s.slice(0, maxLen);
}

export const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss://geminisland.raph.plus ws://localhost:* ws://127.0.0.1:*",
  "font-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function buildSecurityHeaders(isHttps: boolean): Record<string, string> {
  return {
    "content-security-policy": CSP_HEADER,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    ...(isHttps
      ? { "strict-transport-security": "max-age=63072000; includeSubDomains; preload" }
      : {}),
  };
}
