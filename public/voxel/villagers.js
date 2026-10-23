// Articulated Voxel Villagers (with real Bus-Stop Queueing, Boarding, Riding & Alighting)
// and Tactile World Props (Bus Stops, Ponds, Warm Lantern Posts, Benches, Flower Patches, Signposts).

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

  // Head + eyes + hat/cap
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 9 * s, 0);
  const headVox = new Vox(201 + index);
  headVox.box(-2, 0, -2, 2, 4, 2, skin);
  headVox.put(-1, 1.5, 2, "#181a20");
  headVox.put(1, 1.5, 2, "#181a20");
  // Hat with brim
  headVox.box(-2, 3.5, -2, 2, 5, 2, hat);
  headVox.box(-2, 3.5, 2, 2, 4.2, 3, hat);
  headPivot.add(buildVoxelMesh(headVox, { scale: s }));
  root.add(headPivot);

  // Left & Right Legs
  const makeLeg = (seedOff) => {
    const piv = new THREE.Group();
    const lv = new Vox(301 + index + seedOff);
    lv.box(-1, -4, -1, 1, 0, 1, pants);
    lv.box(-1, -4, 0, 1, -3, 2, "#24272e");
    piv.add(buildVoxelMesh(lv, { scale: s }));
    return piv;
  };
  const leftLeg = makeLeg(1);
  leftLeg.position.set(1.1 * s, 4 * s, 0);
  const rightLeg = makeLeg(2);
  rightLeg.position.set(-1.1 * s, 4 * s, 0);
  root.add(leftLeg, rightLeg);

  // Left & Right Arms
  const makeArm = (seedOff) => {
    const piv = new THREE.Group();
    const av = new Vox(401 + index + seedOff);
    av.box(-0.8, -3.5, -0.8, 0.8, 0, 0.8, shirt);
    av.box(-0.8, -4.2, -0.8, 0.8, -3.5, 0.8, skin);
    piv.add(buildVoxelMesh(av, { scale: s }));
    return piv;
  };
  const leftArm = makeArm(1);
  leftArm.position.set(2.6 * s, 8.5 * s, 0);
  const rightArm = makeArm(2);
  rightArm.position.set(-2.6 * s, 8.5 * s, 0);
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

    const qAngle = (index * 2.1) % (Math.PI * 2);
    this.queueOffsetX = Math.cos(qAngle) * 0.9;
    this.queueOffsetZ = Math.sin(qAngle) * 0.9;

    this.x = (data.homeX ?? 0) + this.queueOffsetX;
    this.z = (data.homeZ ?? 0) + this.queueOffsetZ;
    this.yaw = 0;
    this.scale = 1.0;

    this.stopIndex = 0;
    this.state = data.usesTransit ? "WALK_TO_STOP" : "STROLL";
    this.timer = (index * 1.7) % 4.0;
    this.ridingVehicleId = null;
    this.boardedStopId = null;
    this.phase = index * 1.37;

    this.group.position.set(this.x, 0, this.z);
  }

  updateFromServer(data) {
    this.data = data;
  }

  step(dt, t, activeVehicles) {
    const stops = this.data.stops && this.data.stops.length >= 2 ? this.data.stops : [[this.x, this.z], [0, -16]];
    let movingSpeed = 0;

    if (this.state === "RIDING") {
      const bus = activeVehicles.find((v) => v.id === this.ridingVehicleId);
      if (!bus) {
        // Vehicle disappeared or reset; step onto grass safely
        this.state = "STROLL";
        this.group.visible = true;
        this.scale = 1.0;
      } else {
        this.x = bus.doorX;
        this.z = bus.doorZ;
        // Alight as soon as the bus dwells at a DIFFERENT stop than where we boarded!
        if (bus.dwellingStop && bus.dwellingStop.id !== this.boardedStopId) {
          this.ridingVehicleId = null;
          this.group.visible = true;
          this.scale = 0.25;
          this.x = bus.doorX;
          this.z = bus.doorZ;
          this.yaw = bus.yaw + Math.PI / 2;
          // Pick a scenic spot or landmark stop to walk to after stepping off!
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.state = "ALIGHT_VISIT";
          this.timer = 6.5 + (this.index % 4);
        } else {
          this.group.visible = false;
          return;
        }
      }
    }

    // Smooth scale-in when stepping off bus
    if (this.scale < 1.0 && this.state !== "BOARDING") {
      this.scale = Math.min(1.0, this.scale + dt * 3.8);
    }

    if (this.state === "WALK_TO_STOP") {
      const target = stops[this.stopIndex % stops.length];
      const tx = target[0] + this.queueOffsetX;
      const tz = target[1] + this.queueOffsetZ;
      const arrived = this.walkToward(tx, tz, 2.35, dt);
      movingSpeed = arrived ? 0 : 1;
      if (arrived) {
        this.state = "WAIT_FOR_BUS";
        this.timer = 0;
      }
    } else if (this.state === "WAIT_FOR_BUS") {
      this.timer += dt;
      // Look gently down the road for an approaching bus
      this.rig.headPivot.rotation.y = Math.sin(t * 1.6 + this.phase) * 0.35;

      // Check if any transit vehicle is currently dwelling at a stop within 7.5 units
      const nearbyStoppedBus = activeVehicles.find(
        (v) => v.dwellingStop && Math.hypot(v.x - this.x, v.z - this.z) < 7.8,
      );
      if (nearbyStoppedBus) {
        this.ridingVehicleId = nearbyStoppedBus.id;
        this.boardedStopId = nearbyStoppedBus.dwellingStop.id;
        this.state = "BOARDING";
      } else if (this.timer > 24) {
        // If no bus serves this spot yet, take a pleasant stroll to the next waypoint
        this.stopIndex = (this.stopIndex + 1) % stops.length;
        this.state = "STROLL";
      }
    } else if (this.state === "BOARDING") {
      const bus = activeVehicles.find((v) => v.id === this.ridingVehicleId);
      if (!bus || !bus.dwellingStop) {
        // Missed the door before it pulled away — wait at curb
        this.state = "WAIT_FOR_BUS";
        this.scale = 1.0;
      } else {
        const arrivedDoor = this.walkToward(bus.doorX, bus.doorZ, 3.4, dt);
        movingSpeed = 1.25;
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
      const tx = visitSpot[0] + this.queueOffsetX * 1.3;
      const tz = visitSpot[1] + this.queueOffsetZ * 1.3;
      const arrived = this.walkToward(tx, tz, 2.25, dt);
      movingSpeed = arrived ? 0 : 1;
      if (arrived) {
        this.timer -= dt;
        this.rig.headPivot.rotation.y = Math.sin(t * 1.8 + this.phase) * 0.3;
        if (this.timer <= 0) {
          this.stopIndex = 0;
          this.state = this.data.usesTransit ? "WALK_TO_STOP" : "STROLL";
        }
      }
    } else {
      // STROLL mode for gardeners/strollers
      const target = stops[this.stopIndex % stops.length];
      const tx = target[0] + this.queueOffsetX;
      const tz = target[1] + this.queueOffsetZ;
      const arrived = this.walkToward(tx, tz, 1.95, dt);
      movingSpeed = arrived ? 0 : 0.85;
      if (arrived) {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.stopIndex = (this.stopIndex + 1) % stops.length;
          this.timer = 3.5 + (this.index % 3);
          if (this.data.usesTransit && this.stopIndex === 0) {
            this.state = "WALK_TO_STOP";
          }
        }
      }
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

  walkToward(tx, tz, speed, dt) {
    const dx = tx - this.x;
    const dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.35) return true;
    const stepLen = Math.min(dist, speed * dt);
    this.x += (dx / dist) * stepLen;
    this.z += (dz / dist) * stepLen;
    const targetYaw = Math.atan2(dx, dz);
    let diff = targetYaw - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * Math.min(1, dt * 10);
    return dist - stepLen <= 0.35;
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
    // Soft stone & grass bank rim + translucent crystal water + voxel lilypads
    const rimGeo = new THREE.CylinderGeometry(r + 0.55, r + 0.85, 0.26, 36);
    const rimMat = new THREE.MeshStandardMaterial({ color: "#cfc6b4", roughness: 0.88 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = 0.06;
    rim.receiveShadow = true;
    group.add(rim);

    const waterGeo = new THREE.CylinderGeometry(r, r, 0.28, 36);
    const waterMat = new THREE.MeshStandardMaterial({
      color: "#52b2e3",
      roughness: 0.16,
      metalness: 0.12,
      emissive: new THREE.Color("#1c5f82"),
      emissiveIntensity: 0.18,
    });
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.position.y = 0.08;
    water.receiveShadow = true;
    group.add(water);

    // Voxel lilypads & water lotus blossoms
    const padVox = new Vox(77);
    const pads = [
      [-r * 0.4, -r * 0.25, true],
      [r * 0.35, r * 0.3, false],
      [-r * 0.15, r * 0.45, true],
      [r * 0.42, -r * 0.2, false],
    ];
    for (const [lx, lz, hasFlower] of pads) {
      const gx = Math.round(lx / s);
      const gz = Math.round(lz / s);
      padVox.cylinderAxis("y", gx, gz, 1, 2, 2.2, "#5cb85c");
      if (hasFlower) {
        padVox.put(gx, 2, gz, "#f598b6", 0.35);
      }
    }
    const padMesh = buildVoxelMesh(padVox, { scale: s, castShadow: false });
    padMesh.position.y = 0.04;
    group.add(padMesh);
  } else if (prop.kind === "bus_stop") {
    const v = new Vox(51);
    // Stone curb pad
    v.box(-5, 0, -3, 5, 1, 3, "concrete");
    // Timber shelter posts + glass back + terracotta canopy
    v.box(-4, 1, -2, -3, 10, -1, "woodDark");
    v.box(3, 1, -2, 4, 10, -1, "woodDark");
    v.box(-3, 2, -2, 3, 9, -1, "glass");
    v.box(-5, 10, -3, 5, 11, 2, "terracotta");
    // Waiting bench inside shelter
    v.box(-3, 2, -1, 3, 3, 1, "wood");
    // Iconic yellow bus-stop sign pole on right
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
    // flower_patch or tree_cluster
    const v = new Vox(91);
    const blossoms = ["#f6d55c", "#ec8db0", "#fcfaf5", "#9370cf", "#ff9b42"];
    for (let i = 0; i < 11; i++) {
      const fx = Math.round(Math.cos(i * 1.9) * (1 + (i % 4) * 1.4));
      const fz = Math.round(Math.sin(i * 2.3) * (1 + (i % 3) * 1.5));
      v.put(fx, 0, fz, "leaf");
      v.put(fx, 1, fz, blossoms[i % blossoms.length]);
    }
    group.add(buildVoxelMesh(v, { scale: s, castShadow: false }));
  }

  group.position.set(prop.x, 0, prop.z);
  group.rotation.y = prop.yaw || 0;
  return group;
}
