import { createMeadowWorldEngine, createWhitePreviewStage } from "./voxel/meadow_engine.js";

const worldCanvas = document.getElementById("world-canvas");
const previewCanvas = document.getElementById("preview-canvas");
const modal = document.getElementById("create-modal");
const openCreateBtn = document.getElementById("open-create-btn");
const closeModalBtn = document.getElementById("close-modal-btn");
const locateMineBtn = document.getElementById("locate-mine-btn");
const locateMineLabel = document.getElementById("locate-mine-label");

const stepCompose = document.getElementById("step-compose");
const stepPreview = document.getElementById("step-preview");

const dropZone = document.getElementById("drop-zone");
const imageInput = document.getElementById("image-input");
const dropEmpty = document.getElementById("drop-empty");
const dropPreviewWrap = document.getElementById("drop-preview-wrap");
const dropPreviewImg = document.getElementById("drop-preview-img");
const clearImageBtn = document.getElementById("clear-image-btn");
const promptInput = document.getElementById("prompt-input");
const sculptBtn = document.getElementById("sculpt-btn");
const sculptBtnLabel = document.getElementById("sculpt-btn-label");
const formError = document.getElementById("form-error");

const previewTitle = document.getElementById("preview-title");
const previewDesc = document.getElementById("preview-desc");
const placeError = document.getElementById("place-error");
const backComposeBtn = document.getElementById("back-compose-btn");
const pickSpotBtn = document.getElementById("pick-spot-btn");
const placeNowBtn = document.getElementById("place-now-btn");

const hoverCard = document.getElementById("hover-card");
const hoverName = document.getElementById("hover-name");
const hoverStatus = document.getElementById("hover-status");

const placementBanner = document.getElementById("placement-banner");
const placementTargetName = document.getElementById("placement-target-name");
const cancelSpotBtn = document.getElementById("cancel-spot-btn");
const weaveToast = document.getElementById("weave-toast");

let myCreationId = null;
let worldData = null;
let selectedImageDataUrl = null;
let draftBlueprint = null;
let isPickingSpot = false;
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

// Initialize 3D Endless Meadow World + Pure White Modal Preview Stage
const previewStage = createWhitePreviewStage(previewCanvas);

const engine = createMeadowWorldEngine(worldCanvas, {
  onHoverCreation(creation, clientX, clientY) {
    if (!creation || modal.open || isPickingSpot) {
      hoverCard.hidden = true;
      return;
    }
    hoverName.textContent = creation.name;
    hoverStatus.textContent = creation.behavior?.statusLine || creation.description || "";
    hoverCard.style.left = `${clientX}px`;
    hoverCard.style.top = `${clientY}px`;
    hoverCard.hidden = false;
  },
  onSelectCreation(creation) {
    if (!creation) return;
    showToast(`${creation.name} — ${creation.behavior?.statusLine || creation.description}`);
  },
  async onConfirmGroundSpot(x, z, yaw) {
    if (!isPickingSpot || !draftBlueprint) return;
    await commitPlacement(x, z, yaw);
  },
});

// Dialog open/close & universal light-dismiss fallback
function openModal() {
  if (myCreationId) return;
  hoverCard.hidden = true;
  if (!modal.open) {
    modal.showModal();
    if (stepCompose && !stepCompose.hidden && window.innerWidth > 640) {
      promptInput.focus({ preventScroll: true });
    }
  }
  if (!stepPreview.hidden && draftBlueprint) {
    requestAnimationFrame(() => previewStage.syncSize());
  }
}

function closeModal() {
  if (modal.open) {
    modal.close();
  }
}

openCreateBtn.addEventListener("click", () => {
  if (!modal.open) openModal();
});
closeModalBtn.addEventListener("click", () => {
  closeModal();
});

// Fallback light-dismiss when clicking on <dialog> backdrop outside .modal-card
modal.addEventListener("click", (e) => {
  if (e.target === modal) {
    closeModal();
  }
});

function syncCreatorLockUI() {
  if (myCreationId) {
    openCreateBtn.hidden = true;
    locateMineBtn.hidden = false;
    const mine = worldData?.creations?.find((c) => c.id === myCreationId);
    locateMineLabel.textContent = mine ? `Locate · ${mine.name}` : "Locate yours";
    closeModal();
  } else {
    openCreateBtn.hidden = isPickingSpot;
    locateMineBtn.hidden = true;
  }
}

locateMineBtn.addEventListener("click", () => {
  if (!myCreationId) return;
  engine.focusCreationById(myCreationId);
  const mine = worldData?.creations?.find((c) => c.id === myCreationId);
  if (mine) {
    showToast(`${mine.name} — ${mine.behavior?.statusLine || mine.description}`);
  }
});

// Client-side image resizer (keeps uploads crisp & fast under 1024px)
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

async function handleSelectedFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showFormError("Please choose a PNG, JPG, or WebP image.");
    return;
  }
  hideErrors();
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
  if (!modal.open || !stepPreview.hidden) return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) handleSelectedFile(f);
      break;
    }
  }
});

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function hideErrors() {
  formError.hidden = true;
  placeError.hidden = true;
}

// Sculpt with Argon
let sculptProgressTimer = null;
sculptBtn.addEventListener("click", async () => {
  hideErrors();
  const prompt = promptInput.value.trim();
  if (!prompt && !selectedImageDataUrl) {
    showFormError("Drop an image or write a short description first.");
    return;
  }

  sculptBtn.disabled = true;
  const phases = [
    selectedImageDataUrl ? "Extracting subject with Argon..." : "Imagining structure with Argon...",
    "Sculpting high-detail micro-voxels...",
    "Articulating moving parts...",
  ];
  let pIdx = 0;
  sculptBtnLabel.textContent = phases[0];
  sculptProgressTimer = setInterval(() => {
    pIdx = Math.min(phases.length - 1, pIdx + 1);
    sculptBtnLabel.textContent = phases[pIdx];
  }, 2400);

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        imageDataUrl: selectedImageDataUrl || undefined,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (data.alreadyPlaced && data.myCreationId) {
        myCreationId = data.myCreationId;
        syncCreatorLockUI();
        return;
      }
      showFormError(data.error || "Could not sculpt that right now — please try again.");
      return;
    }

    draftBlueprint = data.blueprint;
    previewTitle.textContent = draftBlueprint.name;
    previewDesc.textContent = draftBlueprint.description;

    stepCompose.hidden = true;
    stepPreview.hidden = false;
    requestAnimationFrame(() => {
      previewStage.showBlueprint(draftBlueprint);
    });
  } catch {
    showFormError("Network hiccup while sculpting — please try once more.");
  } finally {
    if (sculptProgressTimer) clearInterval(sculptProgressTimer);
    sculptBtn.disabled = false;
    sculptBtnLabel.textContent = "Create voxel version";
  }
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sculptBtn.click();
  }
});

backComposeBtn.addEventListener("click", () => {
  hideErrors();
  stepPreview.hidden = true;
  stepCompose.hidden = false;
  previewStage.showBlueprint(null);
});

pickSpotBtn.addEventListener("click", () => {
  if (!draftBlueprint) return;
  isPickingSpot = true;
  placementTargetName.textContent = draftBlueprint.name;
  placementBanner.hidden = false;
  openCreateBtn.hidden = true;
  closeModal();
  engine.setPlacementBlueprint(draftBlueprint);
});

function cancelSpotPicking() {
  if (!isPickingSpot) return;
  isPickingSpot = false;
  placementBanner.hidden = true;
  engine.setPlacementBlueprint(null);
  syncCreatorLockUI();
  openModal();
}

cancelSpotBtn.addEventListener("click", cancelSpotPicking);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isPickingSpot) {
    e.preventDefault();
    cancelSpotPicking();
  }
});

placeNowBtn.addEventListener("click", async () => {
  if (!draftBlueprint) return;
  await commitPlacement(null, null, null);
});

async function commitPlacement(x, z, yaw) {
  if (!draftBlueprint) return;
  placeNowBtn.disabled = true;
  pickSpotBtn.disabled = true;
  backComposeBtn.disabled = true;
  placeNowBtn.textContent = "Placing...";
  placeError.hidden = true;

  try {
    const res = await fetch("/api/place", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blueprint: draftBlueprint,
        x,
        z,
        yaw,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (data.alreadyPlaced && data.myCreationId) {
        myCreationId = data.myCreationId;
        isPickingSpot = false;
        placementBanner.hidden = true;
        engine.setPlacementBlueprint(null);
        syncCreatorLockUI();
        engine.focusCreationById(myCreationId);
        return;
      }
      if (isPickingSpot) cancelSpotPicking();
      placeError.textContent = data.error || "Could not place creation.";
      placeError.hidden = false;
      return;
    }

    // Permanently placed! Lock creation UI, close modal, and glide camera to watch it come alive!
    isPickingSpot = false;
    placementBanner.hidden = true;
    engine.setPlacementBlueprint(null);
    previewStage.showBlueprint(null);
    draftBlueprint = null;

    worldData = data.world;
    myCreationId = data.creation.id;
    engine.applyWorldSnapshot(worldData);
    syncCreatorLockUI();

    engine.focusOn(data.creation.x, data.creation.z, 1.58);
    showToast(`${data.creation.name} joined the meadow — Argon is weaving it into the world...`, 5200);
  } catch {
    if (isPickingSpot) cancelSpotPicking();
    placeError.textContent = "Network error while placing — please try again.";
    placeError.hidden = false;
  } finally {
    placeNowBtn.disabled = false;
    pickSpotBtn.disabled = false;
    backComposeBtn.disabled = false;
    placeNowBtn.textContent = "Place in world";
  }
}

// Initial World Fetch + Live WebSocket Sync
async function initWorld() {
  try {
    const res = await fetch("/api/world");
    if (res.ok) {
      worldData = await res.json();
      myCreationId = worldData.myCreationId || null;
      engine.applyWorldSnapshot(worldData);
      syncCreatorLockUI();

      if (!myCreationId) {
        openModal();
      } else {
        engine.focusCreationById(myCreationId);
      }
    }
  } catch (err) {
    console.error("Failed to fetch initial world:", err);
  }

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
        syncCreatorLockUI();

        if (msg.type === "world_updated" && msg.note && !modal.open) {
          showToast(msg.note, 4800);
        } else if (
          msg.type === "creation_placed" &&
          msg.creation &&
          msg.creation.id !== myCreationId &&
          !modal.open
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
