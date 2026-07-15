// Load services/classroom/.env for local npm runs.
// Docker Compose injects env vars automatically — this file is a no-op there.
const fs   = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) return;

for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;

  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;

  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!(key in process.env)) process.env[key] = val;
}
