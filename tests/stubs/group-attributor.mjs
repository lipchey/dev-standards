import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [scenario, value, third] = process.argv.slice(2);
const artifactPath = process.env.DS_GROUP_ARTIFACT;
const nonce = process.env.DS_GROUP_NONCE;

if (artifactPath === undefined || nonce === undefined) process.exit(64);

if (scenario === 'json-observe' && third !== undefined) {
  const count = fs.existsSync(third) ? JSON.parse(fs.readFileSync(third, 'utf8')).count : 0;
  fs.writeFileSync(third, JSON.stringify({ count: count + 1, artifactPath, nonce }));
} else if (scenario !== 'json-exit' && scenario !== 'json-sleep' && third !== undefined) {
  const count = fs.existsSync(third) ? Number(fs.readFileSync(third, 'utf8')) : 0;
  fs.writeFileSync(third, String(count + 1));
}

if (scenario === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, Number(value)));
} else if (scenario !== 'absent') {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  if (scenario === 'raw') {
    fs.writeFileSync(artifactPath, value ?? '');
  } else if (scenario === 'directory') {
    fs.mkdirSync(artifactPath);
  } else if (scenario === 'fifo') {
    const result = spawnSync('mkfifo', [artifactPath]);
    if (result.error !== undefined || result.status !== 0) process.exit(70);
  } else {
    const artifact = JSON.parse(value ?? '{}');
    if (artifact.nonce === '$NONCE') artifact.nonce = nonce;
    const content = JSON.stringify(artifact);
    if (scenario === 'symlink') {
      const realPath = `${artifactPath}.real`;
      fs.writeFileSync(realPath, content);
      fs.symlinkSync(realPath, artifactPath);
    } else {
      fs.writeFileSync(artifactPath, content);
    }
  }
}

if (scenario === 'json-exit') process.exit(Number(third));
if (scenario === 'json-sleep') await new Promise((resolve) => setTimeout(resolve, Number(third)));
