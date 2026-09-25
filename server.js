import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Coevolution } from './js/evolution.js';
import { exportCoevolution, importCoevolution } from './js/save.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const BRAIN_FILE = path.resolve(process.env.BRAIN_FILE || path.join(DATA_DIR, 'brains.tagrl'));
const ARENA_FILE = path.join(DATA_DIR, 'arena.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY_SIZE = 2 * 1024 * 1024;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const co = new Coevolution();
let training = process.env.TRAINING_PAUSED !== '1';
let latest = null;
let trainingError = null;

if (process.env.NODE_ENV === 'production' && !ADMIN_TOKEN) {
  throw new Error('Set ADMIN_TOKEN before running this server in production.');
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function sanitizeArena(layout) {
  if (layout === null) return null;
  if (!Array.isArray(layout)) throw new Error('Arena layout must be an array or null.');
  return layout.slice(0, 256).map(wall => {
    if (!wall || !['x', 'z', 'width', 'height', 'depth'].every(key => Number.isFinite(wall[key]))) {
      throw new Error('Each wall needs finite x, z, width, height, and depth values.');
    }
    const kind = wall.kind === 'crawlspace' ? 'crawlspace' : 'wall';
    const width = clamp(wall.width, 0.5, 12), depth = clamp(wall.depth, 0.5, 12);
    return {
      x: clamp(wall.x, -20 + width / 2, 20 - width / 2),
      z: clamp(wall.z, -20 + depth / 2, 20 - depth / 2),
      width,
      height: kind === 'crawlspace' ? clamp(wall.height, 1.05, 2.6) : clamp(wall.height, 0.5, 8),
      depth,
      kind,
    };
  });
}

async function persistFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, filePath);
}

async function loadSavedState() {
  try {
    importCoevolution(co, await readFile(BRAIN_FILE, 'utf8'));
    console.log(`Restored brains at generation ${co.generation}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not load brain save: ${error.message}`);
  }
  try {
    co.arenaLayout = sanitizeArena(JSON.parse(await readFile(ARENA_FILE, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not load arena save: ${error.message}`);
  }
}

async function persistBrains() {
  await persistFile(BRAIN_FILE, exportCoevolution(co));
}

async function persistArena() {
  await persistFile(ARENA_FILE, JSON.stringify(co.arenaLayout));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response, statusCode, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(statusCode, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function hasValidAdminToken(request) {
  const supplied = Buffer.from(request.headers['x-admin-token'] || '');
  const expected = Buffer.from(ADMIN_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function handleApi(request, response, url) {
  const needsToken = url.pathname === '/api/export' || request.method === 'POST';
  if (ADMIN_TOKEN && needsToken && !hasValidAdminToken(request)) {
    send(response, 401, { error: 'A valid server access token is required.' });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    send(response, 200, {
      training,
      generation: co.generation,
      latest,
      arenaLayout: co.arenaLayout,
      uptimeSeconds: Math.floor(process.uptime()),
      error: trainingError,
    });
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/export') {
    send(response, 200, exportCoevolution(co), 'text/plain; charset=utf-8');
    return true;
  }
  if (request.method !== 'POST') return false;

  if (url.pathname === '/api/training') {
    const body = JSON.parse(await readBody(request));
    if (typeof body.running !== 'boolean') throw new Error('Expected a boolean running value.');
    training = body.running;
    trainingError = null;
    if (training) scheduleTraining();
    send(response, 200, { training, generation: co.generation });
    return true;
  }
  if (url.pathname === '/api/feedback') {
    const body = JSON.parse(await readBody(request));
    if (!['tagger', 'runner'].includes(body.role) || !Number.isFinite(body.amount) || body.amount === 0 || Math.abs(body.amount) > 50) {
      throw new Error('Feedback must target a tagger or runner and be between -50 and 50 points.');
    }
    const population = body.role === 'tagger' ? co.taggers : co.runners;
    population.fitness[0] += body.amount;
    send(response, 200, { role: body.role, amount: body.amount, generation: co.generation });
    return true;
  }
  if (url.pathname === '/api/import') {
    const rawBody = await readBody(request);
    const payload = request.headers['content-type']?.includes('application/json') ? JSON.parse(rawBody) : { save: rawBody };
    if (typeof payload.save !== 'string') throw new Error('Expected a base64 save string.');
    importCoevolution(co, payload.save);
    latest = null;
    await persistBrains();
    send(response, 200, { generation: co.generation });
    return true;
  }
  if (url.pathname === '/api/arena') {
    const body = JSON.parse(await readBody(request));
    co.arenaLayout = sanitizeArena(body.layout);
    await persistArena();
    send(response, 200, { wallCount: co.arenaLayout?.length ?? null });
    return true;
  }
  return false;
}

async function serveStatic(request, response, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { send(response, 400, { error: 'Invalid URL path.' }); return; }
  if (pathname === '/server' || pathname === '/server/') {
    response.writeHead(302, { Location: '/?mode=server', 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  const requestedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, requestedPath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || filePath.startsWith(`${DATA_DIR}${path.sep}`)) {
    send(response, 404, { error: 'Not found.' });
    return;
  }
  try {
    const contents = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    response.end(contents);
  } catch (error) {
    send(response, error.code === 'ENOENT' ? 404 : 500, { error: 'Not found.' });
  }
}

let generationRunning = false;
function scheduleTraining() {
  if (!training || generationRunning) return;
  setImmediate(async () => {
    if (!training || generationRunning) return;
    generationRunning = true;
    try {
      latest = co.runGeneration();
      await persistBrains();
      trainingError = null;
    } catch (error) {
      training = false;
      trainingError = error.message;
      console.error(`Training stopped: ${error.stack || error}`);
    } finally {
      generationRunning = false;
    }
    scheduleTraining();
  });
}

await loadSavedState();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!await handleApi(request, response, url)) send(response, 404, { error: 'Unknown API route.' });
    } else if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(request, response, url);
    } else {
      send(response, 405, { error: 'Method not allowed.' });
    }
  } catch (error) {
    send(response, error.statusCode || 400, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tag RL server listening on http://${HOST}:${PORT}`);
  console.log(`Background training ${training ? 'enabled' : 'paused'}; brain saves: ${BRAIN_FILE}`);
  scheduleTraining();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    training = false;
    try { await persistBrains(); await persistArena(); }
    catch (error) { console.error(`Shutdown save failed: ${error.message}`); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}