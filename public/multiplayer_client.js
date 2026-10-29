// Real-time WebSocket multiplayer + shared world sync client for GeminIsland.

const PING_INTERVAL_MS = 25_000;
const POSE_TICK_MS = 95;
const POSE_KEEPALIVE_MS = 4_500;
const POS_DELTA_THRESHOLD = 0.015;
const ANGLE_DELTA_THRESHOLD = 0.025;
const RECONNECT_MIN_MS = 1_500;
const RECONNECT_MAX_MS = 12_000;
const RECONNECT_BACKOFF_FACTOR = 1.8;
const PROFILE_MIN_INTERVAL_MS = 210;
const EMOTE_MIN_INTERVAL_MS = 260;

const APPEARANCE_KEYS = [
  "skin",
  "hairStyle",
  "hairColor",
  "hatStyle",
  "hatColor",
  "eyeStyle",
  "accessory",
  "accessoryColor",
  "topStyle",
  "topColor",
  "bottomStyle",
  "bottomColor",
  "shoeColor",
];

const VALID_ANIMS = new Set(["idle", "walk", "run", "jump", "ride", "sit", "wave"]);
const VALID_EMOTES = new Set(["wave", "jump", "cheer"]);
const RIDE_ID_RE = /^[a-zA-Z0-9_#-]+$/;
const ROOM_ID_RE = /^[a-zA-Z0-9_-]+$/;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

function stripControlChars(str) {
  return typeof str === "string" ? str.replace(CONTROL_CHARS_RE, "") : "";
}

function clampRound(val, min, max, scale, fallback = 0) {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  const clamped = Math.max(min, Math.min(max, val));
  const rounded = Math.round(clamped * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

function wrapYaw(val, fallback = 0) {
  if (typeof val !== "number" || !Number.isFinite(val)) return fallback;
  const twoPi = Math.PI * 2;
  let wrapped = ((((val + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
  wrapped = Math.max(-twoPi, Math.min(twoPi, wrapped));
  const rounded = Math.round(wrapped * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

function shortestAngleDelta(a, b) {
  const twoPi = Math.PI * 2;
  let d = (a - b) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return d;
}

function sanitizeOptionalId(val, re) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val !== "string") return null;
  const cleaned = stripControlChars(val).trim().slice(0, 48);
  return cleaned && re.test(cleaned) ? cleaned : null;
}

function normalizeClientPose(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mode = src.mode === "aerial" ? "aerial" : "walk";
  const anim = typeof src.anim === "string" && VALID_ANIMS.has(src.anim) ? src.anim : "idle";
  const seat =
    typeof src.seat === "number" && Number.isFinite(src.seat)
      ? Math.max(0, Math.min(3, Math.trunc(src.seat)))
      : 0;

  return {
    mode,
    x: clampRound(src.x, -240, 240, 1000, 0),
    y: clampRound(src.y, -20, 600, 1000, 0),
    z: clampRound(src.z, -240, 240, 1000, 0),
    yaw: wrapYaw(src.yaw, 0),
    pitch: clampRound(src.pitch, -1.6, 1.6, 1000, 0),
    vx: clampRound(src.vx, -25, 25, 100, 0),
    vz: clampRound(src.vz, -25, 25, 100, 0),
    anim,
    ride: sanitizeOptionalId(src.ride, RIDE_ID_RE),
    seat,
    room: sanitizeOptionalId(src.room, ROOM_ID_RE),
  };
}

function normalizeClientProfile(raw) {
  if (!raw || typeof raw !== "object") {
    return { name: "", appearance: {} };
  }
  const srcAppearance =
    raw.appearance && typeof raw.appearance === "object" && !Array.isArray(raw.appearance)
      ? raw.appearance
      : raw;
  const rawName =
    typeof raw.name === "string"
      ? raw.name
      : typeof srcAppearance.name === "string"
        ? srcAppearance.name
        : "";
  const name = stripControlChars(rawName).replace(/\s+/g, " ").trim().slice(0, 16);

  const appearance = {};
  for (const key of APPEARANCE_KEYS) {
    if (typeof srcAppearance[key] === "string") {
      const cleaned = stripControlChars(srcAppearance[key]).trim().slice(0, 24);
      if (cleaned) appearance[key] = cleaned;
    }
  }
  return { name, appearance };
}

function shouldSendPoseUpdate(nextPose, prevPose, nowMs, lastSentMs) {
  if (!prevPose) return true;
  if (nowMs - lastSentMs >= POSE_KEEPALIVE_MS) return true;

  if (
    nextPose.mode !== prevPose.mode ||
    nextPose.anim !== prevPose.anim ||
    nextPose.ride !== prevPose.ride ||
    nextPose.seat !== prevPose.seat ||
    nextPose.room !== prevPose.room
  ) {
    return true;
  }

  const posDelta = Math.hypot(
    nextPose.x - prevPose.x,
    nextPose.y - prevPose.y,
    nextPose.z - prevPose.z,
  );
  if (posDelta > POS_DELTA_THRESHOLD) return true;

  const yawDelta = Math.abs(shortestAngleDelta(nextPose.yaw, prevPose.yaw));
  const pitchDelta = Math.abs(nextPose.pitch - prevPose.pitch);
  if (yawDelta > ANGLE_DELTA_THRESHOLD || pitchDelta > ANGLE_DELTA_THRESHOLD) {
    return true;
  }

  const prevSpeed = Math.hypot(prevPose.vx, prevPose.vz);
  const nextSpeed = Math.hypot(nextPose.vx, nextPose.vz);
  if (prevSpeed > 0.05 && nextSpeed <= 0.01) {
    return true;
  }

  return false;
}

export function createMultiplayerClient(options = {}) {
  const {
    multiplayerEnabled = true,
    getLocalPose,
    getLocalProfile,
    onWorldMessage,
    onWelcome,
    onPeerJoin,
    onPeerPose,
    onPeerProfile,
    onPeerEmote,
    onPeerLeave,
    onOnlineCountChange,
  } = options;

  let ws = null;
  let disposed = false;
  let selfId = null;
  let onlineCount = 0;

  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let pingInterval = null;
  let poseInterval = null;
  let profileFlushTimer = null;

  let lastSentPose = null;
  let lastPoseSentAt = 0;
  let lastProfileSentAt = 0;
  let lastEmoteSentAt = 0;
  let latestProfileCache = null;

  function setOnlineCount(nextCount) {
    const clean =
      typeof nextCount === "number" && Number.isFinite(nextCount) && nextCount >= 0
        ? Math.trunc(nextCount)
        : 0;
    if (clean !== onlineCount) {
      onlineCount = clean;
      onOnlineCountChange?.(onlineCount);
    }
  }

  function isConnected() {
    return Boolean(ws && typeof WebSocket !== "undefined" && ws.readyState === WebSocket.OPEN);
  }

  function safeSendJson(payload) {
    if (!isConnected()) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function resolveCurrentProfile() {
    const fromCallback = getLocalProfile?.();
    if (fromCallback && typeof fromCallback === "object") {
      return normalizeClientProfile(fromCallback);
    }
    if (latestProfileCache) {
      return latestProfileCache;
    }
    return { name: "", appearance: {} };
  }

  function resolveCurrentPose() {
    return normalizeClientPose(getLocalPose?.());
  }

  function sendHello() {
    if (!multiplayerEnabled || !isConnected()) return false;
    const profile = resolveCurrentProfile();
    const pose = resolveCurrentPose();
    const ok = safeSendJson({
      t: "hello",
      name: profile.name,
      appearance: profile.appearance,
      ...pose,
    });
    if (ok) {
      lastSentPose = pose;
      lastPoseSentAt = Date.now();
      lastProfileSentAt = lastPoseSentAt;
    }
    return ok;
  }

  function syncPoseTick(force = false) {
    if (!multiplayerEnabled || !isConnected()) return false;
    const rawPose = getLocalPose?.();
    if (!rawPose && !force) return false;

    const now = Date.now();
    const nextPose = normalizeClientPose(rawPose);
    if (!force && !shouldSendPoseUpdate(nextPose, lastSentPose, now, lastPoseSentAt)) {
      return false;
    }

    const ok = safeSendJson({
      t: "pose",
      ...nextPose,
    });
    if (ok) {
      lastSentPose = nextPose;
      lastPoseSentAt = now;
    }
    return ok;
  }

  function flushCachedProfile() {
    profileFlushTimer = null;
    if (!multiplayerEnabled || !isConnected() || !latestProfileCache) return false;
    const now = Date.now();
    const ok = safeSendJson({
      t: "profile",
      name: latestProfileCache.name,
      appearance: latestProfileCache.appearance,
    });
    if (ok) {
      lastProfileSentAt = now;
    }
    return ok;
  }

  function sendProfile(profile) {
    const normalized = normalizeClientProfile(profile ?? getLocalProfile?.());
    latestProfileCache = normalized;
    if (!multiplayerEnabled || !isConnected()) return false;

    const now = Date.now();
    const elapsed = now - lastProfileSentAt;
    if (elapsed >= PROFILE_MIN_INTERVAL_MS) {
      if (profileFlushTimer !== null) {
        clearTimeout(profileFlushTimer);
        profileFlushTimer = null;
      }
      return flushCachedProfile();
    }

    if (profileFlushTimer === null) {
      profileFlushTimer = setTimeout(flushCachedProfile, Math.max(16, PROFILE_MIN_INTERVAL_MS - elapsed));
    }
    return true;
  }

  function sendEmote(kind) {
    if (!multiplayerEnabled || !isConnected()) return false;
    if (typeof kind !== "string" || !VALID_EMOTES.has(kind)) return false;
    const now = Date.now();
    if (now - lastEmoteSentAt < EMOTE_MIN_INTERVAL_MS) return false;
    const ok = safeSendJson({ t: "emote", kind });
    if (ok) {
      lastEmoteSentAt = now;
    }
    return ok;
  }

  function forcePoseSync() {
    return syncPoseTick(true);
  }

  function clearSocketTimers() {
    if (pingInterval !== null) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    if (poseInterval !== null) {
      clearInterval(poseInterval);
      poseInterval = null;
    }
    if (profileFlushTimer !== null) {
      clearTimeout(profileFlushTimer);
      profileFlushTimer = null;
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      Math.round(RECONNECT_MIN_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, reconnectAttempts)),
    );
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleServerMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(String(rawData));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      return;
    }

    if (
      msg.type === "world_updated" ||
      msg.type === "creation_placed" ||
      msg.type === "queue_tick" ||
      msg.type === "pong" ||
      !msg.type.startsWith("mp_")
    ) {
      onWorldMessage?.(msg);
      return;
    }

    if (!multiplayerEnabled) {
      return;
    }

    switch (msg.type) {
      case "mp_welcome": {
        selfId = typeof msg.selfId === "string" ? msg.selfId : null;
        if (typeof msg.onlineCount === "number") {
          onlineCount = Math.max(1, Math.trunc(msg.onlineCount));
          onOnlineCountChange?.(onlineCount);
        }
        onWelcome?.(msg);
        break;
      }
      case "mp_join": {
        if (typeof msg.onlineCount === "number") {
          setOnlineCount(msg.onlineCount);
        }
        if (msg.player && msg.player.id && msg.player.id !== selfId) {
          onPeerJoin?.(msg.player, msg);
        }
        break;
      }
      case "mp_pose": {
        if (msg.id && msg.id !== selfId) {
          onPeerPose?.(msg);
        }
        break;
      }
      case "mp_profile": {
        if (msg.id && msg.id !== selfId) {
          onPeerProfile?.(msg);
        }
        break;
      }
      case "mp_emote": {
        if (msg.id && msg.id !== selfId) {
          onPeerEmote?.(msg);
        }
        break;
      }
      case "mp_leave": {
        if (typeof msg.onlineCount === "number") {
          setOnlineCount(msg.onlineCount);
        }
        if (msg.id && msg.id !== selfId) {
          onPeerLeave?.(msg.id, msg);
        }
        break;
      }
      default:
        break;
    }
  }

  function connect() {
    if (disposed || typeof WebSocket === "undefined" || typeof location === "undefined") {
      return;
    }
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener("open", () => {
      if (disposed || ws !== socket) {
        try {
          socket.close(1000, "Disposed");
        } catch {
          // ignore
        }
        return;
      }

      reconnectAttempts = 0;
      lastSentPose = null;
      lastPoseSentAt = 0;
      clearSocketTimers();

      pingInterval = setInterval(() => {
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          try {
            socket.send("ping");
          } catch {
            // close handler will reconnect
          }
        }
      }, PING_INTERVAL_MS);

      if (multiplayerEnabled) {
        sendHello();
        poseInterval = setInterval(() => {
          syncPoseTick(false);
        }, POSE_TICK_MS);
      }
    });

    socket.addEventListener("message", (ev) => {
      if (disposed || ws !== socket) return;
      handleServerMessage(ev.data);
    });

    socket.addEventListener("close", () => {
      if (ws !== socket) return;
      ws = null;
      selfId = null;
      lastSentPose = null;
      clearSocketTimers();
      if (multiplayerEnabled) {
        setOnlineCount(0);
      }
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // Browser fires "close" right after "error", which handles cleanup & backoff
    });
  }

  function handleVisibilityChange() {
    if (disposed || typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;

    if (isConnected()) {
      if (multiplayerEnabled) {
        forcePoseSync();
      }
    } else if (!ws || ws.readyState === WebSocket.CLOSED) {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      connect();
    }
  }

  function handleWindowOnline() {
    if (disposed) return;
    if (!ws || (typeof WebSocket !== "undefined" && ws.readyState === WebSocket.CLOSED)) {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempts = 0;
      connect();
    }
  }

  function handlePageUnload() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearSocketTimers();
    const activeSocket = ws;
    ws = null;
    selfId = null;
    lastSentPose = null;
    if (activeSocket) {
      try {
        activeSocket.close(1000, "unload");
      } catch {
        // ignore
      }
    }
  }

  function handlePageShow(ev) {
    if (disposed) return;
    if (ev && ev.persisted && !ws) {
      reconnectAttempts = 0;
      connect();
    }
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", handleWindowOnline);
    window.addEventListener("pagehide", handlePageUnload);
    window.addEventListener("beforeunload", handlePageUnload);
    window.addEventListener("pageshow", handlePageShow);
  }

  connect();

  function dispose() {
    if (disposed) return;
    disposed = true;

    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearSocketTimers();

    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("online", handleWindowOnline);
      window.removeEventListener("pagehide", handlePageUnload);
      window.removeEventListener("beforeunload", handlePageUnload);
      window.removeEventListener("pageshow", handlePageShow);
    }

    const activeSocket = ws;
    ws = null;
    selfId = null;
    onlineCount = 0;
    lastSentPose = null;

    if (activeSocket) {
      try {
        activeSocket.close(1000, "Client disposed");
      } catch {
        // ignore
      }
    }
  }

  return {
    sendProfile,
    sendEmote,
    forcePoseSync,
    getSelfId: () => selfId,
    getOnlineCount: () => onlineCount,
    isConnected,
    dispose,
  };
}
