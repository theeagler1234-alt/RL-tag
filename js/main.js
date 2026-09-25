import { Coevolution } from './evolution.js';
import { Match } from './sim.js';
import { SceneRenderer } from './render.js';
import { exportCoevolution, importCoevolution } from './save.js';

const LOCAL_KEY = 'tagrl-save-v1';
const ARENA_KEY = 'tagrl-arena-v1';
const SERVER_MODE = new URLSearchParams(location.search).get('mode') === 'server';
const DT = 1 / 30;

const co = new Coevolution();
tryAutoRestore();
co.arenaLayout = loadArenaLayout();

const renderer = new SceneRenderer(document.getElementById('viewport'));
let playerMode = false;
let featured = newFeaturedMatch();

// ---- UI elements ----------------------------------------------------
const el = {
  toggle: document.getElementById('btn-toggle'),
  speed: document.getElementById('speed'),
  speedVal: document.getElementById('speed-val'),
  gen: document.getElementById('stat-gen'),
  tagrate: document.getElementById('stat-tagrate'),
  tagger: document.getElementById('stat-tagger'),
  runner: document.getElementById('stat-runner'),
  exportArea: document.getElementById('export-area'),
  importArea: document.getElementById('import-area'),
  btnExport: document.getElementById('btn-export'),
  btnDownload: document.getElementById('btn-download'),
  btnImport: document.getElementById('btn-import'),
  btnReset: document.getElementById('btn-reset'),
  status: document.getElementById('status'),
  editorToggle: document.getElementById('btn-editor'),
  editorControls: document.getElementById('editor-controls'),
  editorPlace: document.getElementById('editor-place'),
  editorErase: document.getElementById('editor-erase'),
  editorClear: document.getElementById('editor-clear'),
  wallWidth: document.getElementById('wall-width'),
  wallHeight: document.getElementById('wall-height'),
  wallDepth: document.getElementById('wall-depth'),
  wallKind: document.getElementById('wall-kind'),
  wallHeightLabel: document.getElementById('wall-height-label'),
  wallList: document.getElementById('wall-list'),
  editorStatus: document.getElementById('editor-status'),
  serverStatus: document.getElementById('server-status'),
  serverToggle: document.getElementById('btn-server-toggle'),
  serverImport: document.getElementById('btn-server-import'),
  serverPush: document.getElementById('btn-server-push'),
  serverToken: document.getElementById('server-token'),
  clientTraining: document.getElementById('client-training'),
  serverTraining: document.getElementById('server-training'),
  viewMode: document.getElementById('view-mode'),
  playerToggle: document.getElementById('btn-player'),
  playerControls: document.getElementById('player-controls'),
  rewardTagger: document.getElementById('reward-tagger'),
  punishTagger: document.getElementById('punish-tagger'),
  rewardRunner: document.getElementById('reward-runner'),
  punishRunner: document.getElementById('punish-runner'),
  feedbackStatus: document.getElementById('feedback-status'),
};

let training = false;
let editorMode = false;
let serverState = null;
const pressedKeys = new Set();
el.clientTraining.hidden = SERVER_MODE;
el.serverTraining.hidden = !SERVER_MODE;

el.toggle.addEventListener('click', () => {
  training = !training;
  el.toggle.textContent = training ? 'Pause training' : 'Start training';
  el.toggle.classList.toggle('paused', training);
  if (training) scheduleTrainingBatch();
});

el.serverToggle.addEventListener('click', async () => {
  if (!serverState) return;
  try {
    await serverRequest('/api/training', { method: 'POST', body: JSON.stringify({ running: !serverState.training }) });
    await refreshServerStatus();
  } catch (e) { showServerError(e); }
});

el.serverImport.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/export', {
      cache: 'no-store',
      headers: { 'X-Admin-Token': el.serverToken.value },
    });
    if (!response.ok) throw new Error('Server export failed.');
    importCoevolution(co, await response.text());
    if (serverState) co.arenaLayout = serverState.arenaLayout;
    featured = newFeaturedMatch();
    updateStats();
    setStatus(`Imported server brains at generation ${co.generation}.`, 'ok');
  } catch (e) { showServerError(e); }
});

el.serverPush.addEventListener('click', async () => {
  try {
    await serverRequest('/api/import', {
      method: 'POST',
      body: JSON.stringify({ save: exportCoevolution(co) }),
    });
    await serverRequest('/api/arena', {
      method: 'POST',
      body: JSON.stringify({ layout: co.arenaLayout }),
    });
    await refreshServerStatus();
    setStatus(`Sent brains and arena to server at generation ${co.generation}.`, 'ok');
  } catch (e) { showServerError(e); }
});

el.speed.addEventListener('input', () => { el.speedVal.textContent = el.speed.value; });

el.playerToggle.addEventListener('click', () => setPlayerMode(!playerMode));
el.rewardTagger.addEventListener('click', () => applyManualFeedback('tagger', 10));
el.punishTagger.addEventListener('click', () => applyManualFeedback('tagger', -10));
el.rewardRunner.addEventListener('click', () => applyManualFeedback('runner', 10));
el.punishRunner.addEventListener('click', () => applyManualFeedback('runner', -10));
el.viewMode.addEventListener('change', () => {
  if (el.viewMode.value === 'player' && !playerMode) setPlayerMode(true);
  else renderer.setViewMode(el.viewMode.value);
});

window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, button')) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    if (renderer.viewMode === 'arena') return;
    event.preventDefault();
    pressedKeys.add(event.key);
    return;
  }
  if (!playerMode) return;
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'space'].includes(key)) {
    event.preventDefault();
    pressedKeys.add(key);
  }
});

window.addEventListener('keyup', event => {
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  pressedKeys.delete(key);
});
window.addEventListener('blur', () => pressedKeys.clear());

el.editorToggle.addEventListener('click', () => {
  editorMode = !editorMode;
  if (editorMode && co.arenaLayout === null) {
    co.arenaLayout = featured.blocks.filter(block => !block.movable).map(block => ({
      x: block.x,
      z: block.z,
      width: block.hx * 2,
      height: block.kind === 'crawlspace' ? block.clearance : block.hy * 2,
      depth: block.hz * 2,
      kind: block.kind || 'wall',
    }));
    commitArena();
  }
  el.editorControls.hidden = !editorMode;
  el.editorToggle.textContent = editorMode ? 'Close arena editor' : 'Edit arena';
  el.editorToggle.classList.toggle('active', editorMode);
  renderer.setEditorMode(editorMode, { place: placeWall, erase: eraseWall }, wallDimensions);
  updateWallList();
  el.editorStatus.textContent = editorMode ? 'Click the arena to edit walls.' : '';
});

el.editorPlace.addEventListener('click', () => setEditorTool('place'));
el.editorErase.addEventListener('click', () => setEditorTool('erase'));
for (const input of [el.wallWidth, el.wallHeight, el.wallDepth]) {
  input.addEventListener('input', () => renderer.refreshEditorGhost());
}
el.wallKind.addEventListener('change', () => {
  const crawlspace = el.wallKind.value === 'crawlspace';
  el.wallHeightLabel.textContent = crawlspace ? 'Clearance' : 'Height';
  el.wallHeight.min = crawlspace ? '1.05' : '0.5';
  el.wallHeight.max = crawlspace ? '2.6' : '8';
  if (crawlspace && Number(el.wallHeight.value) < 1.05) el.wallHeight.value = '1.2';
  renderer.refreshEditorGhost();
});
el.editorClear.addEventListener('click', () => {
  co.arenaLayout = [];
  commitArena();
});

el.btnExport.addEventListener('click', () => {
  el.exportArea.value = exportCoevolution(co);
  setStatus('Exported current brains below — copy them somewhere safe.', 'ok');
});

el.btnDownload.addEventListener('click', () => {
  const b64 = el.exportArea.value || exportCoevolution(co);
  el.exportArea.value = b64;
  const blob = new Blob([b64], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tag-rl-gen${co.generation}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

el.btnImport.addEventListener('click', () => {
  const b64 = el.importArea.value.trim();
  if (!b64) { setStatus('Paste a base64 save first.', 'err'); return; }
  try {
    importCoevolution(co, b64);
    featured = newFeaturedMatch();
    updateStats();
    setStatus(`Imported! Resuming from generation ${co.generation}.`, 'ok');
  } catch (e) {
    setStatus('Import failed: ' + e.message, 'err');
  }
});

el.btnReset.addEventListener('click', () => {
  if (!confirm('This discards current progress (unless you exported it). Continue?')) return;
  Object.assign(co, new Coevolution());
  featured = newFeaturedMatch();
  localStorage.removeItem(LOCAL_KEY);
  updateStats();
  setStatus('Started fresh with random brains.', 'ok');
});

function setStatus(msg, cls) {
  el.status.textContent = msg;
  el.status.className = cls || '';
}

function updateStats() {
  el.gen.textContent = co.generation;
  const last = co.history[co.history.length - 1];
  if (last) {
    el.tagrate.textContent = Math.round(last.tagRate * 100) + '%';
    el.tagger.textContent = last.bestTagger.toFixed(1);
    el.runner.textContent = last.bestRunner.toFixed(1);
  }
}

function setPlayerMode(enabled) {
  playerMode = enabled;
  pressedKeys.clear();
  el.playerToggle.textContent = enabled ? 'Remove player cube' : 'Add player cube';
  el.playerControls.hidden = !enabled;
  if (enabled) {
    el.viewMode.value = 'player';
    featured = newFeaturedMatch(true);
    renderer.setViewMode('player');
  } else {
    if (renderer.viewMode === 'player') {
      el.viewMode.value = 'arena';
      renderer.setViewMode('arena');
    }
    featured = newFeaturedMatch(false);
  }
}

async function serverRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': el.serverToken.value,
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error((await response.text()) || `Server request failed (${response.status}).`);
  return response.json();
}

async function applyManualFeedback(role, amount) {
  try {
    if (SERVER_MODE) {
      await serverRequest('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({ role, amount }),
      });
    } else {
      const population = role === 'tagger' ? co.taggers : co.runners;
      population.fitness[0] += amount;
    }
    el.feedbackStatus.textContent = `${amount > 0 ? '+' : ''}${amount} selection points for the current ${role} champion.`;
  } catch (error) {
    el.feedbackStatus.textContent = error.message;
  }
}

async function refreshServerStatus() {
  try {
    serverState = await serverRequest('/api/status');
    el.serverStatus.textContent = `Online · ${serverState.training ? 'training' : 'paused'} · generation ${serverState.generation}`;
    if (serverState.latest) el.serverStatus.textContent += ` · tag rate ${Math.round(serverState.latest.tagRate * 100)}%`;
    if (serverState.error) el.serverStatus.textContent += ` · ${serverState.error}`;
    el.serverToggle.textContent = serverState.training ? 'Pause server' : 'Resume server';
    for (const button of [el.serverToggle, el.serverImport, el.serverPush]) button.disabled = false;
    if (co.arenaLayout === null && serverState.arenaLayout !== null) {
      co.arenaLayout = serverState.arenaLayout;
      featured = newFeaturedMatch();
    }
  } catch (error) {
    serverState = null;
    el.serverStatus.textContent = 'Offline · run npm start to train on this server.';
    el.serverToggle.textContent = 'Pause server';
    for (const button of [el.serverToggle, el.serverImport, el.serverPush]) button.disabled = true;
  }
}

function showServerError(error) {
  el.serverStatus.textContent = error.message;
}

function newFeaturedMatch(includePlayer = playerMode) {
  const { taggerBrain, runnerBrain } = co.featuredBrains();
  const m = new Match(taggerBrain, runnerBrain, co.arenaLayout, includePlayer);
  renderer && renderer.setMatch(m);
  return m;
}

function wallDimensions() {
  const kind = el.wallKind.value;
  const minHeight = kind === 'crawlspace' ? 1.05 : 0.5;
  const maxHeight = kind === 'crawlspace' ? 2.6 : 8;
  const height = Math.max(minHeight, Math.min(maxHeight, Number(el.wallHeight.value) || (kind === 'crawlspace' ? 1.2 : 1)));
  const width = Math.max(0.5, Math.min(12, Number(el.wallWidth.value) || 4));
  const depth = Math.max(0.5, Math.min(12, Number(el.wallDepth.value) || 1));
  return {
    width, height, depth, kind,
  };
}

function setEditorTool(tool) {
  renderer.setEditorTool(tool);
  el.editorPlace.classList.toggle('active', tool === 'place');
  el.editorErase.classList.toggle('active', tool === 'erase');
  el.editorPlace.setAttribute('aria-pressed', tool === 'place');
  el.editorErase.setAttribute('aria-pressed', tool === 'erase');
}

function placeWall(point, dimensions) {
  co.arenaLayout.push({ ...point, ...dimensions });
  commitArena();
}

function eraseWall(point) {
  let nearest = -1, nearestDistance = Infinity;
  for (let i = 0; i < co.arenaLayout.length; i++) {
    const wall = co.arenaLayout[i];
    if (Math.abs(point.x - wall.x) > wall.width / 2 || Math.abs(point.z - wall.z) > wall.depth / 2) continue;
    const distance = Math.hypot(point.x - wall.x, point.z - wall.z);
    if (distance < nearestDistance) { nearest = i; nearestDistance = distance; }
  }
  if (nearest >= 0) {
    co.arenaLayout.splice(nearest, 1);
    commitArena();
  }
}

function commitArena() {
  let saved = true;
  try {
    localStorage.setItem(ARENA_KEY, JSON.stringify(co.arenaLayout));
  } catch (e) {
    saved = false;
  }
  el.editorStatus.textContent = saved
    ? `${co.arenaLayout.length} fixed wall${co.arenaLayout.length === 1 ? '' : 's'}`
    : 'Arena changed, but could not be saved.';
  featured = newFeaturedMatch();
  updateWallList();
}

function updateWallList() {
  el.wallList.replaceChildren();
  co.arenaLayout.forEach((wall, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wall-item';
    const label = wall.kind === 'crawlspace' ? 'Crawlspace' : 'Wall';
    button.textContent = wall.kind === 'crawlspace'
      ? `${label} ${index + 1} · ${wall.width} wide · ${wall.height} clearance · ${wall.depth} deep`
      : `${label} ${index + 1} · ${wall.width} × ${wall.height} × ${wall.depth}`;
    button.setAttribute('aria-label', `Remove ${label.toLowerCase()} ${index + 1}`);
    button.addEventListener('click', () => {
      co.arenaLayout.splice(index, 1);
      commitArena();
    });
    el.wallList.appendChild(button);
  });
}

function loadArenaLayout() {
  try {
    const saved = localStorage.getItem(ARENA_KEY);
    if (saved === null) return null;
    const walls = JSON.parse(saved);
    if (!Array.isArray(walls)) return null;
    return walls.filter(wall => wall && ['x', 'z', 'width', 'height', 'depth'].every(key => Number.isFinite(wall[key])))
      .slice(0, 256)
      .map(wall => {
        const kind = wall.kind === 'crawlspace' ? 'crawlspace' : 'wall';
        const width = Math.max(0.5, Math.min(12, wall.width));
        const depth = Math.max(0.5, Math.min(12, wall.depth));
        return {
          x: Math.max(-20 + width / 2, Math.min(20 - width / 2, wall.x)),
          z: Math.max(-20 + depth / 2, Math.min(20 - depth / 2, wall.z)),
          width,
          height: kind === 'crawlspace'
            ? Math.max(1.05, Math.min(2.6, wall.height))
            : Math.max(0.5, Math.min(8, wall.height)),
          depth,
          kind,
        };
      });
  } catch (e) {
    return null;
  }
}

function tryAutoRestore() {
  try {
    const b64 = localStorage.getItem(LOCAL_KEY);
    if (b64) importCoevolution(co, b64);
  } catch (e) { /* ignore corrupt/missing autosave */ }
}

function autoSave() {
  try { localStorage.setItem(LOCAL_KEY, exportCoevolution(co)); } catch (e) { /* storage full/unavailable */ }
}

// ---- training scheduler ----------------------------------------------
// Runs generations off the render loop via setTimeout(0) so the page stays
// responsive; "speed" controls how many generations run back-to-back
// before we pause to update the UI and yield a frame.
function scheduleTrainingBatch() {
  if (!training) return;
  const batch = parseInt(el.speed.value, 10);
  setTimeout(() => {
    if (!training) return;
    for (let i = 0; i < batch; i++) co.runGeneration();
    updateStats();
    autoSave();
    featured = newFeaturedMatch(); // show off the newest champions
    scheduleTrainingBatch();
  }, 0);
}

// ---- render loop (always running, independent of training) -----------
let acc = 0, prev = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let delta = (now - prev) / 1000; prev = now;
  delta = Math.min(delta, 0.1);
  acc += delta;
  while (acc >= DT) {
    if (!editorMode) {
      if (renderer.viewMode !== 'arena') {
        const yaw = (Number(pressedKeys.has('ArrowLeft')) - Number(pressedKeys.has('ArrowRight'))) * 1.5 * DT;
        const pitch = (Number(pressedKeys.has('ArrowUp')) - Number(pressedKeys.has('ArrowDown'))) * 1.2 * DT;
        renderer.panView(yaw, pitch);
      }
      if (!featured.over) {
        const playerAction = playerMode ? getPlayerAction() : null;
        featured.tick(playerAction);
        if (featured.player) featured.player.facing = featured.player.viewYaw || 0;
      }
      else featured = newFeaturedMatch();
    }
    acc -= DT;
  }
  renderer.sync(featured);
  renderer.render();
}

function getPlayerAction() {
  const yaw = renderer.getPlayerYaw();
  const forward = Number(pressedKeys.has('w')) - Number(pressedKeys.has('s'));
  const strafe = Number(pressedKeys.has('d')) - Number(pressedKeys.has('a'));
  const mx = Math.cos(yaw) * forward + Math.cos(yaw + Math.PI / 2) * strafe;
  const mz = Math.sin(yaw) * forward + Math.sin(yaw + Math.PI / 2) * strafe;
  return [mx, mz, Number(pressedKeys.has('space')), 0];
}
requestAnimationFrame(frame);
updateStats();
if (SERVER_MODE) {
  refreshServerStatus();
  setInterval(refreshServerStatus, 10000);
}
