#!/usr/bin/env node
// Automated Voxel Overlap & Z-Fighting World Auditor CLI.
// Usage:
//   node scripts/audit_world.mjs                        (checks live production)
//   node scripts/audit_world.mjs http://127.0.0.1:8788  (checks local dev server)

const target = (process.argv[2] || "https://voxel-meadow.quiet-king-8097.workers.dev").replace(/\/$/, "");

const res = await fetch(`${target}/api/audit`, {
  headers: { accept: "application/json" },
});
if (!res.ok) {
  console.error(`Audit endpoint HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const data = await res.json();
console.log(`Voxel Meadow Audit (${target}/api/audit):`);
console.log(`  Clean:               ${data.clean}`);
console.log(`  Creations Checked:   ${data.creationsChecked}`);
console.log(`  Blueprint Conflicts: ${data.blueprintConflicts}`);
console.log(`  Spatial Conflicts:   ${data.spatialConflicts}`);
console.log(`  Total Auto-Repairs:  ${data.totalAutoRepairs}`);
console.log(`  Last Orchestrator:   ${data.lastAuditNote}`);
for (const c of data.creations || []) {
  const badge = c.clean ? "OK" : "CONFLICT";
  console.log(
    `    [${badge}] ${c.name} (${c.id}) — parts=${c.partsCount}, overlaps=${c.overlapCells}, coplanar=${c.coplanarFaces}, groundClips=${c.groundClips}`,
  );
}

if (!data.clean) {
  process.exit(2);
}
