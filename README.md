# Tag RL

Two cube agents — a **tagger** (red) and a **runner** (blue) — co-evolve in a
3D arena entirely in your browser. No build step, no backend, no Python.

## How it works

- **Physics & rules** (`js/sim.js`): simple cube physics (gravity, jump,
  WASD-style acceleration, wall/block collision), 16-ray raycast "vision"
  per agent, and tag/pickup/drop logic. Runs headless (no rendering) so
  hundreds of matches can be simulated per generation quickly.
- **Brains** (`js/brain.js`): each agent is controlled by a small
  feedforward neural net (41 inputs → 32 hidden → 4 outputs: moveX, moveZ,
  jump, interact). Weights are a flat `Float32Array` — easy to mutate,
  crossover, and serialize.
- **Training** (`js/evolution.js`): two co-evolving populations (24 taggers,
  24 runners) trained with a genetic algorithm — tournament selection,
  uniform crossover, gaussian mutation, elitism. No gradients/backprop
  needed, which is why this works well fully client-side. Each generation,
  every tagger plays several random runners; fitness rewards closing
  distance and tagging quickly (taggers) or maintaining distance and
  surviving (runners).
- **Rendering** (`js/render.js`): Three.js draws only the single "featured"
  match (the current champions) live, with a visualization of the tagger's
  vision rays. Loaded from a CDN — no bundler needed.
- **Save/Load** (`js/save.js`): both populations' raw weights are packed
  into a compact binary buffer and base64-encoded (~350–400 KB of text for
  the default population sizes). Export it, paste it back in later, on any
  device — this is what survives a cookie/localStorage wipe. Progress also
  auto-saves to `localStorage` every generation as a convenience.

## Run it locally

Just serve the folder — ES modules need `http://`, not `file://`:

```bash
npx serve .
# or: python3 -m http.server
```

Then open the printed localhost URL.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo (keep `index.html` at the repo root,
   or in `/docs` if you configure Pages that way).
2. Repo Settings → Pages → set source to the branch/folder containing
   `index.html`.
3. Done — it's fully static.

## Tuning knobs

All in `js/sim.js` and `js/evolution.js`:

- `POP_SIZE`, `OPPONENTS_PER_GENOME` — bigger = better exploration, slower
  per generation.
- `HIDDEN_SIZE`, `RAY_COUNT` (in `brain.js`/`sim.js`) — bigger brains/vision,
  more compute per step, larger save files.
- Fitness shaping in `Match.tick()` — reshape what taggers/runners get
  rewarded for.
- Training speed slider in the UI controls how many generations run per
  batch before the page yields to update stats/render.

## Notes / things to extend

- Co-evolution can be unstable (it can cycle rather than monotonically
  improve) — that's normal for this kind of predator/prey setup. Watching
  `tagRate` over generations is more informative than either fitness alone.
- The pickup/drop mechanic currently lets either agent grab movable blocks
  and drop them as obstacles; there's no reward shaping specifically for
  *using* it well, so agents may take a while to discover it's useful.
  Adding a small shaping bonus for runners who drop a block between
  themselves and the tagger would likely accelerate that.
- Everything runs on the main thread. If you want training to run faster
  without touching the visuals at all, move `Coevolution.runGeneration()`
  into a Web Worker and postMessage the stats + featured brains back.
