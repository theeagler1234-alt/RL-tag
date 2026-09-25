# Tag RL

Two cube agents — a **tagger** (red) and a **runner** (blue) — co-evolve in a
3D arena. Training can run in the browser or continuously in a Node server.

## Features

- **Simulation** (`js/sim.js`): 60-second matches, jumping, variable-height
  walls, crawlspace roofs, pickup/drop blocks, and 3D sensor rays angled above
  and below each agent. Horizontal rays continue to the nearest obstruction,
  including arena boundaries, instead of stopping at a fixed range.
- **Manual feedback**: reward or punish the current tagger/runner champion by
  10 fitness points before the next genetic selection. This changes selection
  pressure; it does not record player movement as training data.
- **Arena editor**: place and erase fixed walls or crawlspace roofs. A wall's
  height controls whether it can be jumped; a crawlspace's clearance leaves a
  walking gap but stops upward movement at the roof. Browser layouts persist
  locally and can be sent to the training server.
- **Brains and evolution** (`js/brain.js`, `js/evolution.js`): 24 taggers and
  24 runners, each with a 57-input, 32-hidden, 4-output network, trained with
  tournament selection, crossover, mutation, and elitism.
- **Exports** (`js/save.js`): population weights use the same compact binary
  format encoded as base64 in both browser and server. Existing browser saves
  remain importable.

## Fitness metrics

“Best tagger fitness” and “Best runner fitness” are fitness points for the
highest-scoring individual in the latest completed generation; they are not
neural-network weights or physical attributes. Taggers earn points for
closing distance and a large bonus for tagging, especially early. Runners
earn points for maintaining distance and surviving the match. The tag rate is
the fraction of matches ending in a tag. Compare each role's fitness over
time; the two roles use different reward formulas, so their scores are not
directly comparable.

## Run in a browser

For browser-only training, serve the folder over HTTP:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`. The root page is the client-only build: training
runs in that browser and stops when the page closes. It does not poll or depend
on the Node server API.

## Deploy the client version to GitHub Pages

Publish the repository root as a Pages site. Its `/` route is the browser-only
version, so Pages does not need Node, server routes, or persistent disk. Each
visitor trains their own population in their browser and can use the existing
base64 export/import controls to move brains between devices.

## Background server

Install Node.js 24 or newer, then run:

```bash
npm start
```

The Node server hosts the client app at `/` and a separate server-training
console at `/server`. It starts training automatically and saves the base64
brain export to `data/brains.tagrl` after each generation.
The custom arena is stored separately in `data/arena.json`. These files stay
on the server's persistent disk. Use `npm run start:paused` to start without
training. The `/server` console can pause/resume, import the server's base64
save, or send browser brains and an arena to the server. Its base64 format is
the same as the client's export/import format.

### Codespaces

Run `npm start` in the Codespace and open forwarded port `3000`; use `/server`
for the background-training console or `/` for browser training. Keep the port
private when possible. For production/public exposure, set `NODE_ENV=production`
and provide `ADMIN_TOKEN`; the page asks for that token before allowing model
export or server changes. Do not commit the token. A Codespace trains while it
is running, but stops training when Codespaces shuts down or hibernates it.
For uninterrupted training, use a host that keeps the process and its disk
running continuously.

The Node server is not supported by GitHub Pages; Pages can still host the
browser-only version, but background training needs a separate Node host.
