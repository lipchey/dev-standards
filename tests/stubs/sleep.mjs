// Keep the event loop alive so spawnSync timeout can kill this child.
const seconds = Number(process.argv[2]);
setTimeout(() => process.exit(0), seconds * 1000);
