import { createMeadowWorldEngine } from "./voxel/meadow_engine.js";

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

function showToast(text, durationMs = 4200) {
  if (!text) return;
  weaveToast.textContent = text;
  weaveToast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    weaveToast.hidden = true;
  }, durationMs);
}

const engine = createMeadowWorldEngine(worldCanvas, {
  onHoverCreation(creation, clientX, clientY, reading) {
    if (!creation || uiState === "picking") {
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
    if (!creation) return;
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
});

function syncDockUI() {
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
      engine.setSpotPickerState({
        mode: "staked",
        x: chosenSpot?.x ?? 16,
        z: chosenSpot?.z ?? 10,
      });
      break;
    case "building":
      buildingPill.hidden = false;
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

// 1. Click "+ Add" -> pick where on the grass it will go
addBtn.addEventListener("click", () => {
  if (myCreationId) {
    uiState = "placed";
    syncDockUI();
    return;
  }
  hoverCard.hidden = true;
  uiState = "picking";
  syncDockUI();
});

// Cancel spot selection -> back to "+ Add"
cancelPickBtn.addEventListener("click", () => {
  chosenSpot = null;
  uiState = "idle";
  syncDockUI();
});

// Move spot from inside bottom builder -> re-enter spot picking
moveSpotBtn.addEventListener("click", () => {
  uiState = "picking";
  syncDockUI();
});

// Close bottom builder -> clear plot stake and return to "+ Add"
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

// Click "Ready · Go to <Name>" -> smoothly fly camera to their finished creation!
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

// Image upload & client-side resize
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

// Build in background at chosen spot -> show "Ready · Go to <Name>" when complete
let buildProgressTimer = null;
sculptBtn.addEventListener("click", async () => {
  if (uiState === "building") return;
  hideError();
  const prompt = promptInput.value.trim();
  if (!prompt && !selectedImageDataUrl) {
    showFormError("Add a photo or short description first.");
    return;
  }

  const spotX = chosenSpot?.x ?? null;
  const spotZ = chosenSpot?.z ?? null;

  uiState = "building";
  sculptBtn.disabled = true;
  const phases = ["Building…", "Sculpting voxels…", "Placing in meadow…"];
  let pIdx = 0;
  buildingPillLabel.textContent = phases[0];
  buildProgressTimer = setInterval(() => {
    pIdx = Math.min(phases.length - 1, pIdx + 1);
    buildingPillLabel.textContent = phases[pIdx];
  }, 3200);

  syncDockUI();

  try {
    const res = await fetch("/api/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        imageDataUrl: selectedImageDataUrl || undefined,
        x: spotX,
        z: spotZ,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
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

    worldData = data.world;
    myCreationId = data.creation.id;
    readyCreation = data.creation;

    if (data.feeds) {
      engine.applyLiveFeeds(data.feeds);
    }
    engine.applyWorldSnapshot(worldData);

    // Do NOT yank the camera automatically — let them click "Ready · Go to <Name>"!
    uiState = "ready";
    syncDockUI();
  } catch {
    uiState = "composing";
    syncDockUI();
    showFormError("Network hiccup while building — try again.");
  } finally {
    if (buildProgressTimer) clearInterval(buildProgressTimer);
    buildProgressTimer = null;
    sculptBtn.disabled = false;
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

async function initWorld() {
  try {
    const res = await fetch("/api/world");
    if (res.ok) {
      worldData = await res.json();
      myCreationId = worldData.myCreationId || null;
      engine.applyWorldSnapshot(worldData);
      uiState = myCreationId ? "placed" : "idle";
      syncDockUI();
    }
  } catch (err) {
    console.error("Failed to fetch initial world:", err);
  }

  refreshLiveFeeds();
  setInterval(refreshLiveFeeds, 90_000);
  connectLiveWebSocket();
}

function connectLiveWebSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if ((msg.type === "creation_placed" || msg.type === "world_updated") && msg.world) {
        worldData = {
          ...msg.world,
          myCreationId,
        };
        engine.applyWorldSnapshot(worldData);
        if (uiState === "placed" || uiState === "ready") {
          syncDockUI();
        }
        refreshLiveFeeds();

        if (msg.type === "world_updated" && msg.note) {
          showToast(msg.note, 4600);
        } else if (
          msg.type === "creation_placed" &&
          msg.creation &&
          msg.creation.id !== myCreationId
        ) {
          showToast(`Someone added "${msg.creation.name}" to the meadow!`, 4200);
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
