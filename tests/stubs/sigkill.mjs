// Self-terminate with SIGKILL so spawnSync returns { status: null, signal: 'SIGKILL' } —
// the operational "no exit code" case a killed check must classify as 'error', not 'fail'.
process.kill(process.pid, 'SIGKILL');
