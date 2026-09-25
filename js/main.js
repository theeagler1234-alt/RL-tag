import { Coevolution } from './evolution.js';
import { Match } from './sim.js';
import { SceneRenderer } from './render.js';
import { exportCoevolution, importCoevolution } from './save.js';

const LOCAL_KEY = 'tagrl-save-v1';
const DT = 1 / 30;

const co = new Coevolution();
tryAutoRestore();

const renderer = new SceneRenderer(document.getElementById('viewport'));
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
};

let training = false;

el.toggle.addEventListener('click', () => {
  training = !training;
  el.toggle.textContent = training ? 'Pause training' : 'Start training';
  el.toggle.classList.toggle('paused', training);
  if (training) scheduleTrainingBatch();
});

el.speed.addEventListener('input', () => { el.speedVal.textContent = el.speed.value; });

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

function newFeaturedMatch() {
  const { taggerBrain, runnerBrain } = co.featuredBrains();
  const m = new Match(taggerBrain, runnerBrain);
  renderer && renderer.setMatch(m);
  return m;
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
    if (!featured.over) featured.tick();
    else featured = newFeaturedMatch();
    acc -= DT;
  }
  renderer.sync(featured);
  renderer.render();
}
requestAnimationFrame(frame);
updateStats();
