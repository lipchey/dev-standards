// Test stub: sleeps for the requested number of seconds, then exits 0.
// Seconds are read from argv[2]. The setTimeout keeps the event loop alive
// so the parent's spawnSync timeout can kill it. Run as `node sleep.mjs 5`.
const seconds = Number(process.argv[2]);
setTimeout(() => process.exit(0), seconds * 1000);
