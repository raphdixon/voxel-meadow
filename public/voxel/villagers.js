// Articulated Voxel Villagers (with Personal-Space Steering, Right-Hand Passing, Bus-Stop Queueing,
// Boarding, Riding & Alighting) and Tactile World Props.

import * as THREE from "../vendor/three-bundle.js";
import { Vox, buildVoxelMesh } from "./vox.js";

const SKIN_TONES = ["#f5cfa8", "#e6b48a", "#c98e63", "#8d5838", "#f7dcc0"];
const PANTS_COLORS = ["#394a6d", "#4b4f59", "#6b4f3a", "#3d6b5e", "#54476e"];

export function buildVillagerRig(villager, index = 0) {
  const root = new THREE.Group();
  const s = 0.135; // Fine micro-voxel scale (~1.5m tall villager)
  const skin = SKIN_TONES[index % SKIN_TONES.length];
  const pants = PANTS_COLORS[index % PANTS_COLORS.length];
  const shirt = villager.shirtColor || "#4c82d4";
  const hat = villager.hatColor || "#f5b82e";

  // Torso + backpack
  const torsoVox = new Vox(101 + index);
  torsoVox.box(-2, 0, -1, 2, 5, 2, shirt);
  if (villager.role === "student" || villager.role === "explorer") {
    torsoVox.box(-1.5, 1, -2, 1.5, 4, -1, hat);
  }
  const torso = buildVoxelMesh(torsoVox, { scale: s });
  torso.position.y = 4 * s;
  root.add(torso);

  // Head + eyes + hat/cap (slight clearance above torso collar + depthLayer 1)
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 9.06 * s, 0);
  const headVox = new Vox(201 + index);
  headVox.box(-2, 0, -2, 2, 4, 2, skin);
  headVox.put(-1, 1.5, 2, "#181a20");
  headVox.put(1, 1.5, 2, "#181a20");
  // Hat with brim
  headVox.box(-2, 3.5, -2, 2, 5, 2, hat);
  headVox.box(-2, 3.5, 2, 2, 4.2, 3, hat);
  headPivot.add(buildVoxelMesh(headVox, { scale: s, depthLayer: 1 }));
  root.add(headPivot);

  // Left & Right Legs (clean hip gap + depthLayer 2)
  const makeLeg = (seedOff) => {
    const piv = new THREE.Group();
    const lv = new Vox(301 + index + seedOff);
    lv.box(-1, -4, -1, 1, 0, 1, pants);
    lv.box(-1, -4, 0, 1, -3, 2, "#24272e");
    piv.add(buildVoxelMesh(lv, { scale: s, depthLayer: 2 }));
    return piv;
  };
  const leftLeg = makeLeg(1);
  leftLeg.position.set(1.08 * s, 3.94 * s, 0);
  const rightLeg = makeLeg(2);
  rightLeg.position.set(-1.08 * s, 3.94 * s, 0);
  root.add(leftLeg, rightLeg);

  // Left & Right Arms (clean 1-voxel wide shoulder clearance outside [-2..2] torso + depthLayer 3)
  const makeArm = (seedOff, x0, x1) => {
    const piv = new THREE.Group();
    const av = new Vox(401 + index + seedOff);
    av.box(x0, -3, -1, x1, 0, 1, shirt);
    av.box(x0, -4, -1, x1, -3, 1, skin);
    piv.add(buildVoxelMesh(av, { scale: s, depthLayer: 3 }));
    return piv;
  };
  const leftArm = makeArm(1, 0, 1);
  leftArm.position.set(2.08 * s, 8.6 * s, 0);
  const rightArm = makeArm(2, -1, 0);
  rightArm.position.set(-2.08 * s, 8.6 * s, 0);
  root.add(leftArm, rightArm);

  root.userData.dispose = () => {
    root.traverse((o) => {
      if (o.isMesh && o.geometry) o.geometry.dispose();
    });
  };

  return {
    root,
    headPivot,
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
  };
}

export class VillagerAgent {
  constructor(data, index) {
    this.id = data.id;
    this.data = data;
    this.index = index;
    this.rig = buildVillagerRig(data, index);
    this.group = this.rig.root;

    // Golden-angle staggered personal queue offset so villagers never target the exact same point
    const qAngle = (index * 2.399963) % (Math.PI * 2);
    const qRadius = 1.55 + (index % 5) * 0.65;
    this.queueOffsetX = Math.cos(qAngle) * qRadius;
    this.queueOffsetZ = Math.sin(qAngle) * qRadius;

    this.x = (data.homeX ?? 0) + this.queueOffsetX;
    this.z = (data.homeZ ?? 0) + this.queueOffsetZ;
    this.yaw = qAngle;
    this.scale = 1.0;

    this.stopIndex = index % Math.max(1, (data.stops || []).length);
    this.state = data.usesTransit ? "WALK_TO_STOP" : "STROLL";
    this.timer = (index * 1.9) % 4.5;
    this.ridingVehicleId = null;
    this.boardedStopId = null;
    this.phase = index * 1.37;

    this.group.position.set(this.x, 0, this.z);
  }

  updateFromServer(data) {
    this.data = data;
  }

  step(dt, t, activeVehicles, ponds = [], allVillagers = [], obstacles = []) {
    this.ponds = ponds;
    this.allVillagers = allVillagers;
    this.obstacles = obstacles;

    const stops = this.data.stops && this.data.stops.length >= 2 ? this.data.stops : [[this.x, this.z], [0, -16]];
    let movingSpeed = 0;

    if (this.state === "RIDING") {
      const bus = activeVehicles.find((v) => v.id === this.ridingVehicleId);
      if (!bus) {
        this.state = "STROLL";
        this.group.visible = true;
        this.scale = 1.0;
      } else {
        this.x = bus.doorX;
        this.z = bus.doorZ;
        if (bus.dwellingStop && bus.dwellingStop.id !== this.boardedStopId) {
          this.ridingVehicleId = null;
          this.group.visible = true;
          this.scale = 0.25;
          // Step off with slight per-villager fan-out so alighting passengers don't stack
          this.x = bus.doorX + this.queueOffsetX * 0.35;
          this.z = bus.doorZ + this.queueOffsetZ * 0.35;
          this.yaw = bus.yaw + Math.PI / 2;
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.state = "ALIGHT_VISIT";
          this.timer = 6.5 + (this.index % 4);
        } else {
          this.group.visible = false;
          return;
        }
      }
    }

    if (this.scale < 1.0 && this.state !== "BOARDING") {
      this.scale = Math.min(1.0, this.scale + dt * 3.8);
    }

    if (this.state === "WALK_TO_STOP") {
      const target = stops[this.stopIndex % stops.length];
      const tx = target[0] + this.queueOffsetX;
      const tz = target[1] + this.queueOffsetZ;
      const arrived = this.walkToward(tx, tz, 2.25, dt, false);
      movingSpeed = arrived ? 0 : 1;
      if (arrived) {
        this.state = "WAIT_FOR_BUS";
        this.timer = 0;
      }
    } else if (this.state === "WAIT_FOR_BUS") {
      this.timer += dt;
      this.rig.headPivot.rotation.y = Math.sin(t * 1.6 + this.phase) * 0.35;

      const nearbyStoppedBus = activeVehicles.find(
        (v) => v.dwellingStop && Math.hypot(v.x - this.x, v.z - this.z) < 8.8,
      );
      if (nearbyStoppedBus) {
        this.ridingVehicleId = nearbyStoppedBus.id;
        this.boardedStopId = nearbyStoppedBus.dwellingStop.id;
        this.state = "BOARDING";
      } else if (this.timer > 20) {
        this.stopIndex = (this.stopIndex + 1) % stops.length;
        this.state = "STROLL";
        this.timer = 4.0 + (this.index % 3);
      }
    } else if (this.state === "BOARDING") {
      const bus = activeVehicles.find((v) => v.id === this.ridingVehicleId);
      if (!bus || !bus.dwellingStop) {
        this.state = "WAIT_FOR_BUS";
        this.scale = 1.0;
      } else {
        const arrivedDoor = this.walkToward(bus.doorX, bus.doorZ, 3.35, dt, true);
        movingSpeed = 1.2;
        if (arrivedDoor) {
          this.scale = Math.max(0.15, this.scale - dt * 4.5);
          if (this.scale <= 0.2) {
            this.state = "RIDING";
            this.group.visible = false;
            return;
          }
        }
      }
    } else if (this.state === "ALIGHT_VISIT") {
      const visitSpot = stops[this.stopIndex % stops.length];
      const tx = visitSpot[0] + this.queueOffsetX * 1.15;
      const tz = visitSpot[1] + this.queueOffsetZ * 1.15;
      const arrived = this.walkToward(tx, tz, 2.15, dt, false);
      movingSpeed = arrived ? 0 : 1;
      if (arrived) {
        this.timer -= dt;
        this.rig.headPivot.rotation.y = Math.sin(t * 1.8 + this.phase) * 0.3;
        if (this.timer <= 0) {
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.state = this.data.usesTransit ? "WALK_TO_STOP" : "STROLL";
        }
      }
    } else {
      const target = stops[this.stopIndex % stops.length];
      const tx = target[0] + this.queueOffsetX;
      const tz = target[1] + this.queueOffsetZ;
      const arrived = this.walkToward(tx, tz, 1.9, dt, false);
      movingSpeed = arrived ? 0 : 0.85;
      if (arrived) {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.timer = 3.8 + (this.index % 3);
          if (this.data.usesTransit && this.stopIndex === 0) {
            this.state = "WALK_TO_STOP";
          }
        }
      }
    }

    // Enforce hard personal-space separation even while standing/waiting
    if (this.state !== "BOARDING") {
      this.resolveCollisions(dt);
    }

    // Animate gait (swinging limbs + cheerful walk bounce)
    const stride = movingSpeed > 0.05 ? Math.sin(t * 8.5 + this.phase) * 0.62 * movingSpeed : 0;
    const bounce = movingSpeed > 0.05 ? Math.abs(Math.sin(t * 8.5 + this.phase)) * 0.09 : 0;
    this.rig.leftLeg.rotation.x = stride;
    this.rig.rightLeg.rotation.x = -stride;
    this.rig.leftArm.rotation.x = -stride * 0.8;
    this.rig.rightArm.rotation.x = stride * 0.8;
    if (movingSpeed > 0.05) {
      this.rig.headPivot.rotation.y *= 0.85;
    }

    this.group.position.set(this.x, bounce, this.z);
    this.group.rotation.y = this.yaw;
    this.group.scale.setScalar(this.scale);
  }

  walkToward(tx, tz, speed, dt, isBoarding = false) {
    const dx = tx - this.x;
    const dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    const arriveTol = isBoarding ? 0.45 : 0.55;
    if (dist < arriveTol) return true;

    let steerX = dx / dist;
    let steerZ = dz / dist;

    // Social-force personal-space repulsion + right-hand passing rule
    if (!isBoarding && this.allVillagers) {
      for (const other of this.allVillagers) {
        if (other === this || !other.group.visible || other.state === "RIDING") continue;
        const vx = this.x - other.x;
        const vz = this.z - other.z;
        const d = Math.hypot(vx, vz);
        if (d < 3.2 && d > 0.0001) {
          const ux = vx / d;
          const uz = vz / d;
          const prox = (3.2 - d) / 3.2;
          // Push away + curve to right shoulder so oncoming villagers glide past each other
          const repel = prox * prox * 1.65;
          const rightPass = prox * 0.95;
          steerX += ux * repel - uz * rightPass;
          steerZ += uz * repel + ux * rightPass;
        }
      }
    }

    // Smoothly skirt around stationary buildings & town signboard
    if (!isBoarding && this.obstacles) {
      for (const obs of this.obstacles) {
        const vx = this.x - obs.x;
        const vz = this.z - obs.z;
        const d = Math.hypot(vx, vz);
        const avoidR = obs.r + 1.2;
        if (d < avoidR && d > 0.001) {
          const ux = vx / d;
          const uz = vz / d;
          const prox = (avoidR - d) / avoidR;
          // Pick tangent direction aligned with goal
          const t1x = -uz, t1z = ux;
          const dot = t1x * (dx / dist) + t1z * (dz / dist);
          const sign = dot >= 0 ? 1 : -1;
          steerX += ux * prox * 1.5 + t1x * sign * prox * 1.1;
          steerZ += uz * prox * 1.5 + t1z * sign * prox * 1.1;
        }
      }
    }

    const sLen = Math.hypot(steerX, steerZ) || 1;
    steerX /= sLen;
    steerZ /= sLen;

    const stepLen = Math.min(dist, speed * dt);
    this.x += steerX * stepLen;
    this.z += steerZ * stepLen;

    this.resolveCollisions(dt, isBoarding);

    const targetYaw = Math.atan2(steerX, steerZ);
    let diff = targetYaw - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, dt * 8.5);
    return Math.hypot(tx - this.x, tz - this.z) <= arriveTol;
  }

  resolveCollisions(dt, isBoarding = false) {
    // Keep dry outside ponds
    for (const pond of this.ponds || []) {
      const pr = (pond.radius || 6.4) + 0.9;
      const pdx = this.x - pond.x;
      const pdz = this.z - pond.z;
      const pd = Math.hypot(pdx, pdz);
      if (pd < pr && pd > 0.001) {
        this.x = pond.x + (pdx / pd) * pr;
        this.z = pond.z + (pdz / pd) * pr;
      }
    }

    // Keep outside stationary building footprints & city sign
    if (!isBoarding && this.obstacles) {
      for (const obs of this.obstacles) {
        const odx = this.x - obs.x;
        const odz = this.z - obs.z;
        const od = Math.hypot(odx, odz);
        if (od < obs.r && od > 0.001) {
          this.x = obs.x + (odx / od) * obs.r;
          this.z = obs.z + (odz / od) * obs.r;
        }
      }
    }

    // Non-overlapping personal space between villagers
    if (!isBoarding && this.allVillagers) {
      const minSep = 1.5;
      for (const other of this.allVillagers) {
        if (other === this || !other.group.visible || other.state === "RIDING") continue;
        let dx = this.x - other.x;
        let dz = this.z - other.z;
        let d = Math.hypot(dx, dz);
        if (d < minSep) {
          if (d < 0.001) {
            const ang = (this.index * 2.399) % (Math.PI * 2);
            dx = Math.cos(ang);
            dz = Math.sin(ang);
            d = 1;
          }
          const push = Math.min((minSep - d) * 0.55, dt * 4.5 + 0.08);
          this.x += (dx / d) * push;
          this.z += (dz / d) * push;
        }
      }
    }
  }

  dispose() {
    this.rig.root.userData.dispose?.();
  }
}

/**
 * Build charming micro-voxel WorldProps (bus stops, ponds, warm lamp posts, benches, flower patches, signposts).
 */
export function buildWorldPropMesh(prop) {
  const group = new THREE.Group();
  const s = 0.2;

  if (prop.kind === "pond") {
    const r = prop.radius || 6.4;
    const ps = 0.32;
    const gr = Math.round(r / ps);
    const pondVox = new Vox(77);
    const rimTones = ["limestone", "concrete", "concrete2", "grass2"];
    // Stepped voxel stone & mossy bank rim sitting flush on the meadow
    for (let x = -gr - 3; x <= gr + 3; x++) {
      for (let z = -gr - 3; z <= gr + 3; z++) {
        const d = Math.hypot(x, z);
        if (d >= gr - 0.8 && d <= gr + 2.4) {
          const h = Math.abs((x * 13 + z * 29) % 7);
          const col = d > gr + 1.3 && h < 3 ? "grass2" : rimTones[h % 3];
          pondVox.put(x, 0, z, col);
          if (d >= gr - 0.2 && d <= gr + 1.1 && h % 3 !== 0) {
            pondVox.put(x, 1, z, col);
          }
        }
      }
    }
    const rimMesh = buildVoxelMesh(pondVox, { scale: ps });
    group.add(rimMesh);

    const waterR = Math.max(1.2, (gr - 0.85) * ps);
    const waterGeo = new THREE.CylinderGeometry(waterR, waterR, 0.2, 32);
    const waterMat = new THREE.MeshStandardMaterial({
      color: "#4daee0",
      roughness: 0.18,
      metalness: 0.08,
      emissive: new THREE.Color("#1a5b7d"),
      emissiveIntensity: 0.16,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = 0.11;
    water.receiveShadow = true;
    group.add(water);

    // Chunky voxel lilypads & lotus blossoms
    const padVox = new Vox(79);
    const pads = [
      [-r * 0.38, -r * 0.24, true],
      [r * 0.34, r * 0.28, false],
      [-r * 0.14, r * 0.44, true],
      [r * 0.4, -r * 0.18, false],
    ];
    for (const [lx, lz, hasFlower] of pads) {
      const gx = Math.round(lx / s);
      const gz = Math.round(lz / s);
      padVox.cylinderAxis("y", gx, gz, 1, 2, 2.4, "leaf");
      if (hasFlower) {
        padVox.box(gx - 1, 2, gz, gx + 1, 3, gz + 1, "#f598b6");
        padVox.put(gx, 3, gz, "yellow");
      }
    }
    const padMesh = buildVoxelMesh(padVox, { scale: s, castShadow: false });
    padMesh.position.y = 0.05;
    group.add(padMesh);
  } else if (prop.kind === "bus_stop") {
    const v = new Vox(51);
    v.box(-5, 0, -3, 5, 1, 3, "concrete");
    v.box(-4, 1, -2, -3, 10, -1, "woodDark");
    v.box(3, 1, -2, 4, 10, -1, "woodDark");
    v.box(-3, 2, -2, 3, 9, -1, "glass");
    v.box(-5, 10, -3, 5, 11, 2, "terracotta");
    v.box(-3, 2, -1, 3, 3, 1, "wood");
    v.box(5, 0, 1, 6, 11, 2, "steelDark");
    v.box(4, 10, 1, 7, 13, 2, "busYellow", 0.55);
    v.put(5, 11, 2, "charcoal");
    group.add(buildVoxelMesh(v, { scale: s }));
  } else if (prop.kind === "lamp_post") {
    const v = new Vox(61);
    v.box(-1, 0, -1, 2, 2, 2, "iron");
    v.box(0, 2, 0, 1, 13, 1, "iron");
    v.box(0, 12, 0, 3, 13, 1, "iron");
    v.box(2, 10, -0.5, 4, 12, 1.5, "warmGlow", 1.5);
    group.add(buildVoxelMesh(v, { scale: s }));
  } else if (prop.kind === "bench") {
    const v = new Vox(71);
    v.box(-4, 0, -1, -3, 3, 2, "iron");
    v.box(3, 0, -1, 4, 3, 2, "iron");
    v.box(-4, 2, -1, 4, 3, 2, "wood");
    v.box(-4, 3, -1, 4, 5, 0, "woodLight");
    group.add(buildVoxelMesh(v, { scale: s }));
  } else if (prop.kind === "signpost") {
    const v = new Vox(81);
    v.box(0, 0, 0, 1, 10, 1, "woodDark");
    v.box(-3, 7, 0, 4, 9, 1, "cream");
    v.box(-1, 5, 0, 5, 6, 1, "wood");
    group.add(buildVoxelMesh(v, { scale: s }));
  } else {
    const seed = Math.abs(Math.round((prop.x || 1) * 13 + (prop.z || 1) * 29)) + 91;
    const v = new Vox(seed);
    const blossoms = ["#f6d55c", "#ec8db0", "#fcfaf5", "#ffb642"];
    const b1 = blossoms[seed % blossoms.length];
    const b2 = blossoms[(seed + 1) % blossoms.length];
    v.sphere(0, 1.1, 0, 2.6, 1.4, 2.3, "leaf");
    v.sphere(2.1, 0.9, 1.1, 1.9, 1.2, 1.8, "leafLight");
    v.sphere(-1.8, 0.8, 0.9, 1.6, 1.1, 1.6, "leafDark");
    v.clear(-6, -4, -6, 6, 0, 6);
    v.put(-1, 2, 0, b1);
    v.put(0, 2, 1, b1);
    v.put(2, 2, 1, b2);
    v.put(-2, 1, 1, b2);
    group.add(buildVoxelMesh(v, { scale: 0.22 }));
  }

  group.position.set(prop.x, 0, prop.z);
  group.rotation.y = prop.yaw || 0;
  return group;
}
