import { createMeadowWorldEngine } from "./voxel/meadow_engine.js";

const urlParams = new URLSearchParams(location.search);
const isOgCapture = urlParams.get("og") === "1";
if (isOgCapture) {
  document.body.dataset.ogCapture = "1";
}

const worldCanvas = document.getElementById("world-canvas");

const addBtn = document.getElementById("add-btn");
const pickSpotPill = document.getElementById("pick-spot-pill");
const cancelPickBtn = document.getElementById("cancel-pick-btn");

const bottomBuilder = document.getElementById("bottom-builder");
const moveSpotBtn = document.getElementById("move-spot-btn");
const closeBuilderBtn = document.getElementById("close-builder-btn");

const dropZone = document.getElementById("drop-zone");
const imageInput = document.getElementById("image-input");
const dropEmpty = document.getElementById("drop-empty");
const dropPreviewWrap = document.getElementById("drop-preview-wrap");
const dropPreviewImg = document.getElementById("drop-preview-img");
const clearImageBtn = document.getElementById("clear-image-btn");
const promptInput = document.getElementById("prompt-input");
const sculptBtn = document.getElementById("sculpt-btn");
const formError = document.getElementById("form-error");

const buildingPill = document.getElementById("building-pill");
const buildingPillLabel = document.getElementById("building-pill-label");
const readyGotoBtn = document.getElementById("ready-goto-btn");
const readyGotoLabel = document.getElementById("ready-goto-label");
const locateMineBtn = document.getElementById("locate-mine-btn");
const locateMineLabel = document.getElementById("locate-mine-label");

const hoverCard = document.getElementById("hover-card");
const hoverName = document.getElementById("hover-name");
const hoverFeed = document.getElementById("hover-feed");
const hoverStatus = document.getElementById("hover-status");
const weaveToast = document.getElementById("weave-toast");

// UI states: "idle" | "picking" | "composing" | "building" | "ready" | "placed"
let uiState = "idle";
let myCreationId = null;
let readyCreation = null;
let worldData = null;
let selectedImageDataUrl = null;
let chosenSpot = null;
let toastTimer = null;

// Live multi-user build queue state
let activeJob = null;
let jobTickInterval = null;
let jobPollInterval = null;
let jobPollInFlight = false;

function showToast(text, durationMs = 4200) {
  if (!text || isOgCapture) return;
  weaveToast.textContent = text;
  weaveToast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    weaveToast.hidden = true;
  }, durationMs);
}

function formatEta(seconds) {
  const s = Math.max(2, Math.round(Number(seconds) || 15));
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `~${m}m ${rem}s` : `~${m}m`;
}

function renderActiveJobLabel() {
  if (!activeJob) {
    buildingPillLabel.textContent = "Queueing…";
    return;
  }
  const elapsedSec = Math.max(0, Math.floor((Date.now() - activeJob.syncedAtMs) / 1000));
  const remSec = Math.max(3, (activeJob.etaSeconds || 18) - elapsedSec);
  if (activeJob.status === "queued" && activeJob.position >= 1) {
    buildingPillLabel.textContent = `Queue #${activeJob.position} · ${formatEta(remSec)}`;
  } else {
    buildingPillLabel.textContent = `Sculpting · ${formatEta(remSec)}`;
  }
}

function stopJobTracking() {
  activeJob = null;
  if (jobTickInterval) {
    clearInterval(jobTickInterval);
    jobTickInterval = null;
  }
  if (jobPollInterval) {
    clearInterval(jobPollInterval);
    jobPollInterval = null;
  }
}

const engine = createMeadowWorldEngine(
  worldCanvas,
  {
    onHoverCreation(creation, clientX, clientY, reading) {
      if (!creation || uiState === "picking" || isOgCapture) {
        hoverCard.hidden = true;
        return;
      }
      hoverName.textContent = creation.name;
      if (reading?.summary) {
        hoverFeed.textContent = reading.summary;
        hoverFeed.hidden = false;
      } else {
        hoverFeed.hidden = true;
      }
      hoverStatus.textContent = creation.behavior?.statusLine || creation.description || "";
      hoverCard.style.left = `${clientX}px`;
      hoverCard.style.top = `${clientY}px`;
      hoverCard.hidden = false;
    },
    onSelectCreation(creation, reading) {
      if (!creation || isOgCapture) return;
      const detail = reading?.summary
        ? `${reading.summary} · ${creation.behavior?.statusLine || creation.description}`
        : creation.behavior?.statusLine || creation.description;
      showToast(`${creation.name} — ${detail}`);
    },
    onPickGroundSpot(x, z) {
      chosenSpot = { x, z };
      uiState = "composing";
      syncDockUI();
      if (window.innerWidth > 640) {
        promptInput.focus({ preventScroll: true });
      }
    },
    onAutoNudgeSpot(x, z) {
      if (chosenSpot) {
        chosenSpot = { x, z };
      }
    },
  },
  { ogMode: isOgCapture },
);

function syncDockUI() {
  if (isOgCapture) return;

  addBtn.hidden = true;
  pickSpotPill.hidden = true;
  bottomBuilder.hidden = true;
  buildingPill.hidden = true;
  readyGotoBtn.hidden = true;
  locateMineBtn.hidden = true;

  if (myCreationId && uiState !== "ready") {
    uiState = "placed";
  }

  switch (uiState) {
    case "picking":
      pickSpotPill.hidden = false;
      engine.setSpotPickerState({
        mode: "picking",
        ...(chosenSpot ? { x: chosenSpot.x, z: chosenSpot.z } : {}),
      });
      break;
    case "composing":
      bottomBuilder.hidden = false;
      engine.setPreviewPrompt(promptInput.value);
      engine.setSpotPickerState({
        mode: "staked",
        x: chosenSpot?.x ?? 16,
        z: chosenSpot?.z ?? 10,
      });
      break;
    case "building":
      buildingPill.hidden = false;
      renderActiveJobLabel();
      engine.setSpotPickerState({
        mode: "building",
        x: chosenSpot?.x ?? 16,
        z: chosenSpot?.z ?? 10,
      });
      break;
    case "ready": {
      readyGotoBtn.hidden = false;
      const name = readyCreation?.name || "your creation";
      readyGotoLabel.textContent = `Ready · Go to ${name}`;
      engine.setSpotPickerState({ mode: "hidden" });
      break;
    }
    case "placed": {
      locateMineBtn.hidden = false;
      const mine = worldData?.creations?.find((c) => c.id === myCreationId);
      locateMineLabel.textContent = mine ? `Locate · ${mine.name}` : "Locate yours";
      engine.setSpotPickerState({ mode: "hidden" });
      break;
    }
    default:
      addBtn.hidden = false;
      engine.setSpotPickerState({ mode: "hidden" });
      break;
  }
}

async function pollActiveJob() {
  if (!activeJob || jobPollInFlight) return;
  jobPollInFlight = true;
  try {
    const res = await fetch(`/api/job?id=${encodeURIComponent(activeJob.jobId)}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.job) return;

    const job = data.job;
    if (job.status === "done") {
      stopJobTracking();
      sculptBtn.disabled = false;
      if (data.world) {
        worldData = data.world;
        engine.applyWorldSnapshot(worldData);
      }
      if (data.feeds) {
        engine.applyLiveFeeds(data.feeds);
      }
      myCreationId = job.creationId || data.world?.myCreationId || myCreationId;
      readyCreation =
        job.creation || worldData?.creations?.find((c) => c.id === myCreationId) || null;
      uiState = "ready";
      syncDockUI();
      return;
    }

    if (job.status === "failed") {
      stopJobTracking();
      sculptBtn.disabled = false;
      if (job.creationId) {
        myCreationId = job.creationId;
        uiState = "placed";
        syncDockUI();
        return;
      }
      uiState = "composing";
      syncDockUI();
      showFormError(job.error || "Could not build that right now — try again.");
      return;
    }

    activeJob = {
      ...job,
      syncedAtMs: Date.now(),
    };
    renderActiveJobLabel();
  } catch {
    // ignore transient poll hiccups; next tick or WS broadcast will recover
  } finally {
    jobPollInFlight = false;
  }
}

function startTrackingJob(jobInfo) {
  stopJobTracking();
  activeJob = {
    ...jobInfo,
    syncedAtMs: Date.now(),
  };
  uiState = "building";
  syncDockUI();

  jobTickInterval = setInterval(() => {
    if (uiState === "building" && activeJob) {
      renderActiveJobLabel();
    }
  }, 1000);

  jobPollInterval = setInterval(() => {
    if (uiState === "building" && activeJob) {
      pollActiveJob();
    }
  }, 3000);
}

// Dynamically resize the 3D staked plot on the island as the visitor describes tiny vs colossal subjects!
promptInput.addEventListener("input", () => {
  engine.setPreviewPrompt(promptInput.value);
});

// 1. Click "+ Add" -> pick where on the island it will go
addBtn.addEventListener("click", () => {
  if (myCreationId) {
    uiState = "placed";
    syncDockUI();
    return;
  }
  hoverCard.hidden = true;
  engine.setPreviewPrompt(promptInput.value);
  uiState = "picking";
  syncDockUI();
});

cancelPickBtn.addEventListener("click", () => {
  chosenSpot = null;
  uiState = "idle";
  syncDockUI();
});

moveSpotBtn.addEventListener("click", () => {
  uiState = "picking";
  syncDockUI();
});

closeBuilderBtn.addEventListener("click", () => {
  hideError();
  chosenSpot = null;
  uiState = "idle";
  syncDockUI();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (uiState === "picking" || uiState === "composing") {
      e.preventDefault();
      hideError();
      chosenSpot = null;
      uiState = "idle";
      syncDockUI();
    }
  }
});

worldCanvas.addEventListener("pointerleave", () => {
  hoverCard.hidden = true;
});

readyGotoBtn.addEventListener("click", () => {
  if (!myCreationId) return;
  hoverCard.hidden = true;
  uiState = "placed";
  syncDockUI();
  engine.focusCreationById(myCreationId);
  const mine = worldData?.creations?.find((c) => c.id === myCreationId) || readyCreation;
  if (mine) {
    showToast(`${mine.name} — ${mine.behavior?.statusLine || mine.description}`, 4600);
  }
});

locateMineBtn.addEventListener("click", () => {
  if (!myCreationId) return;
  hoverCard.hidden = true;
  engine.focusCreationById(myCreationId);
  const mine = worldData?.creations?.find((c) => c.id === myCreationId);
  if (mine) {
    showToast(`${mine.name} — ${mine.behavior?.statusLine || mine.description}`);
  }
});

async function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Unsupported image format"));
      img.onload = () => {
        const maxSide = 960;
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          if (width >= height) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
        }
        const c = document.createElement("canvas");
        c.width = Math.max(1, width);
        c.height = Math.max(1, height);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.86));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function hideError() {
  formError.hidden = true;
}

async function handleSelectedFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showFormError("Choose a PNG, JPG, or WebP image.");
    return;
  }
  hideError();
  try {
    selectedImageDataUrl = await resizeImageFile(file);
    dropPreviewImg.src = selectedImageDataUrl;
    dropEmpty.hidden = true;
    dropPreviewWrap.hidden = false;
  } catch (err) {
    showFormError(err.message || "Could not process that image.");
  }
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (file) handleSelectedFile(file);
});

clearImageBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  selectedImageDataUrl = null;
  imageInput.value = "";
  dropPreviewImg.removeAttribute("src");
  dropPreviewWrap.hidden = true;
  dropEmpty.hidden = false;
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleSelectedFile(file);
});

window.addEventListener("paste", (e) => {
  if (uiState !== "composing") return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) handleSelectedFile(f);
      break;
    }
  }
});

// Enqueue build into the multi-user workshop queue -> close builder immediately so visitor can explore while watching live Queue #N & ~ETA!
sculptBtn.addEventListener("click", async () => {
  if (uiState === "building") return;
  hideError();
  const prompt = promptInput.value.trim();
  if (!prompt && !selectedImageDataUrl) {
    showFormError("Add a photo or short description first.");
    return;
  }

  engine.setPreviewPrompt(prompt);
  const spotX = chosenSpot?.x ?? null;
  const spotZ = chosenSpot?.z ?? null;

  uiState = "building";
  sculptBtn.disabled = true;
  buildingPillLabel.textContent = "Joining queue…";
  syncDockUI();

  try {
    const res = await fetch("/api/build", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-meadow-client": "1",
      },
      body: JSON.stringify({
        prompt,
        imageDataUrl: selectedImageDataUrl || undefined,
        x: spotX,
        z: spotZ,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      sculptBtn.disabled = false;
      if (data.alreadyPlaced && data.myCreationId) {
        myCreationId = data.myCreationId;
        uiState = "placed";
        syncDockUI();
        return;
      }
      uiState = "composing";
      syncDockUI();
      showFormError(data.error || "Could not build that right now — try again.");
      return;
    }

    if (data.job) {
      startTrackingJob(data.job);
      return;
    }

    // Direct synchronous fallback if ever returned
    sculptBtn.disabled = false;
    worldData = data.world;
    myCreationId = data.creation.id;
    readyCreation = data.creation;
    if (data.feeds) engine.applyLiveFeeds(data.feeds);
    engine.applyWorldSnapshot(worldData);
    uiState = "ready";
    syncDockUI();
  } catch {
    sculptBtn.disabled = false;
    uiState = "composing";
    syncDockUI();
    showFormError("Network hiccup while building — try again.");
  }
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sculptBtn.click();
  }
});

async function refreshLiveFeeds() {
  try {
    const res = await fetch("/api/feeds");
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.feeds) {
      engine.applyLiveFeeds(data.feeds);
    }
  } catch {
    // ignore transient feed errors
  }
}

async function refreshDailyEligibility() {
  if (isOgCapture || uiState === "building" || uiState === "ready") return;
  try {
    const res = await fetch("/api/world");
    if (!res.ok) return;
    const latest = await res.json();
    worldData = latest;
    myCreationId = latest.myCreationId || null;
    engine.applyWorldSnapshot(worldData);
    if (latest.myActiveJob && !myCreationId) {
      startTrackingJob(latest.myActiveJob);
    } else if (!myCreationId && uiState === "placed") {
      uiState = "idle";
      syncDockUI();
    }
  } catch {
    // ignore transient network errors
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (uiState === "building" && activeJob) {
      pollActiveJob();
    } else {
      refreshDailyEligibility();
    }
  }
});

async function initWorld() {
  try {
    const res = await fetch("/api/world");
    if (res.ok) {
      worldData = await res.json();
      myCreationId = worldData.myCreationId || null;
      engine.applyWorldSnapshot(worldData);
      if (!isOgCapture) {
        if (myCreationId) {
          uiState = "placed";
          syncDockUI();
        } else if (worldData.myActiveJob) {
          startTrackingJob(worldData.myActiveJob);
        } else {
          uiState = "idle";
          syncDockUI();
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch initial world:", err);
  }

  refreshLiveFeeds();
  if (!isOgCapture) {
    setInterval(refreshLiveFeeds, 90_000);
    setInterval(refreshDailyEligibility, 10 * 60_000);
    connectLiveWebSocket();
  }
}

function connectLiveWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "queue_tick" && activeJob && uiState === "building") {
        const qIdx = Array.isArray(msg.queuedIds) ? msg.queuedIds.indexOf(activeJob.jobId) : -1;
        const isSculpting =
          Array.isArray(msg.sculpting) && msg.sculpting.some((s) => s.jobId === activeJob.jobId);
        if (qIdx >= 0) {
          activeJob.status = "queued";
          activeJob.position = qIdx + 1;
          renderActiveJobLabel();
        } else if (isSculpting) {
          activeJob.status = "sculpting";
          activeJob.position = 0;
          renderActiveJobLabel();
        }
        pollActiveJob();
        return;
      }

      if ((msg.type === "creation_placed" || msg.type === "world_updated") && msg.world) {
        worldData = {
          ...msg.world,
          myCreationId,
        };
        engine.applyWorldSnapshot(worldData);
        if (uiState === "building" && activeJob) {
          pollActiveJob();
        } else if (uiState === "placed" || uiState === "ready") {
          syncDockUI();
        }
        refreshLiveFeeds();

        if (msg.type === "world_updated" && msg.note) {
          showToast(msg.note, 4600);
        } else if (
          msg.type === "creation_placed" &&
          msg.creation &&
          msg.creation.id !== myCreationId &&
          uiState !== "building"
        ) {
          showToast(`Someone added "${msg.creation.name}" to GeminIsland!`, 4200);
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.addEventListener("close", () => {
    setTimeout(connectLiveWebSocket, 3500);
  });
}

initWorld();
