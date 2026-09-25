// sim.js — headless physics + game rules for the tag environment.
// No rendering here on purpose: this needs to run hundreds of times per
// generation, as fast as possible. render.js reads a Match's public state
// each animation frame to draw the "featured" match with Three.js.

export const ARENA_HALF = 20;         // arena is 40x40
export const AGENT_HALF = 0.5;        // cube half-extent
export const GRAVITY = -22;
export const JUMP_SPEED = 8.5;
export const MOVE_ACCEL = 26;
export const FRICTION = 8;
export const MAX_SPEED = 7;
export const TAG_RADIUS = 1.1;
export const PICKUP_RADIUS = 1.8;
export const RAY_COUNT = 16;
export const TAGGER_EXTRA_RAYS = 8;
export const RAY_RANGE = 32;
export const DT = 1 / 30;             // fixed timestep used for headless steps
export const MAX_STEPS = 1800;        // 60 sim-seconds per match
export const NUM_OBSTACLES = 5;       // random static blocks scattered at start
export const NUM_LOOSE_BLOCKS = 4;    // pickup-able blocks
export const ARENA_WALL_HEIGHT = 3;
export const CRAWLSPACE_ROOF_THICKNESS = 0.3;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }
export function rayAngles(index) {
  if (index < RAY_COUNT) {
    const elevation = index % 4 === 1 ? Math.PI / 6 : index % 4 === 3 ? -Math.PI / 6 : 0;
    return { azimuth: (index / RAY_COUNT) * Math.PI * 2, elevation };
  }
  const extraIndex = index - RAY_COUNT;
  const rayIndex = (extraIndex * 4 + 1) / 2;
  return {
    azimuth: (rayIndex / RAY_COUNT) * Math.PI * 2,
    elevation: extraIndex % 2 === 0 ? Math.PI / 4 : -Math.PI / 4,
  };
}

// Axis-aligned box helper: {x,z,hx,hz} (y handled separately/simply)
function boxesOverlap(ax, az, ahx, ahz, bx, bz, bhx, bhz) {
  return Math.abs(ax - bx) < ahx + bhx && Math.abs(az - bz) < ahz + bhz;
}

function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let near = 0, far = Infinity;
  if (Math.abs(dx) < 1e-8) { if (ox < minX || ox > maxX) return null; }
  else {
    const t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
    near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
    if (far < near) return null;
  }
  if (Math.abs(dy) < 1e-8) { if (oy < minY || oy > maxY) return null; }
  else {
    const t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy;
    near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
    if (far < near) return null;
  }
  if (Math.abs(dz) < 1e-8) { if (oz < minZ || oz > maxZ) return null; }
  else {
    const t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz;
    near = Math.max(near, Math.min(t1, t2)); far = Math.min(far, Math.max(t1, t2));
    if (far < near) return null;
  }
  return near > 0 ? near : far > 0 ? far : null;
}

export class Block {
  constructor(x, z, movable, width = 1, height = 1, depth = 1, kind = 'wall') {
    this.kind = kind;
    this.clearance = kind === 'crawlspace' ? height : null;
    this.x = x;
    this.y = kind === 'crawlspace' ? height + CRAWLSPACE_ROOF_THICKNESS / 2 : height / 2;
    this.z = z;
    this.hx = width / 2;
    this.hy = kind === 'crawlspace' ? CRAWLSPACE_ROOF_THICKNESS / 2 : height / 2;
    this.hz = depth / 2;
    this.movable = movable;  // true = can be picked up
    this.heldBy = null;      // agent index or null
    this.static = !movable;  // static obstacles never move
  }
}

export class Agent {
  constructor(role, brain) {
    this.role = role; // 'tagger' | 'runner'
    this.brain = brain;
    this.reset();
  }
  reset() {
    this.x = 0; this.y = 0.5; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.grounded = true;
    this.carrying = null;   // Block ref
    this.facing = 0;        // yaw, radians
    this.fitness = 0;
    this.tagged = false;
    this.interactPrev = 0;  // for edge-detecting the interact button
  }
}

export class Match {
  constructor(taggerBrain, runnerBrain, arenaLayout = null, includePlayer = false) {
    this.tagger = new Agent('tagger', taggerBrain);
    this.runner = new Agent('runner', runnerBrain);
    this.player = includePlayer ? new Agent('player', null) : null;
    this.blocks = [];
    this.step = 0;
    this.over = false;
    this.tagStep = -1;
    this.captureRays = false;
    this.arenaLayout = arenaLayout;
    this._buildArena();
    this._placeAgents();
  }

  _buildArena() {
    if (this.arenaLayout === null) {
      for (let i = 0; i < NUM_OBSTACLES; i++) {
        const x = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
        const z = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
        this.blocks.push(new Block(x, z, false));
      }
    } else {
      for (const wall of this.arenaLayout) {
        this.blocks.push(new Block(wall.x, wall.z, false, wall.width, wall.height, wall.depth, wall.kind));
      }
    }
    // loose pickup-able blocks
    for (let i = 0; i < NUM_LOOSE_BLOCKS; i++) {
      const x = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
      const z = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
      this.blocks.push(new Block(x, z, true));
    }
  }

  _placeAgents() {
    const taggerSpawn = this._findSpawn();
    this.tagger.x = taggerSpawn.x; this.tagger.z = taggerSpawn.z;
    const runnerSpawn = this._findSpawn(this.tagger);
    this.runner.x = runnerSpawn.x; this.runner.z = runnerSpawn.z;
    if (this.player) {
      const playerSpawn = this._findSpawn(this.runner);
      this.player.x = playerSpawn.x; this.player.z = playerSpawn.z;
    }
  }

  _findSpawn(other = null) {
    let fallback = null;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const x = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
      const z = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
      if (!this._spawnIsClear(x, z)) continue;
      if (!fallback) fallback = { x, z };
      if (!other || Math.hypot(x - other.x, z - other.z) >= 15) return { x, z };
    }
    return fallback || { x: -ARENA_HALF + 1, z: -ARENA_HALF + 1 };
  }

  _spawnIsClear(x, z) {
    return !this.blocks.some(b => !b.movable && boxesOverlap(x, z, AGENT_HALF, AGENT_HALF, b.x, b.z, b.hx, b.hz));
  }

  // --- vision -------------------------------------------------------
  // Casts RAY_COUNT rays in a full circle from `self`, returns flattened
  // [dist0, type0, dist1, type1, ...] normalized to 0..1.
  // type: 0 = nothing (max range), 0.5 = wall/block, 1.0 = other agent
  _castRays(self, other, extraRays = 0, rayDistances = null) {
    const out = new Float32Array((RAY_COUNT + extraRays) * 2);
    const rayCount = RAY_COUNT + extraRays;
    for (let i = 0; i < rayCount; i++) {
      const { azimuth, elevation } = rayAngles(i);
      const horizontal = Math.cos(elevation);
      const dx = Math.cos(azimuth) * horizontal;
      const dy = Math.sin(elevation);
      const dz = Math.sin(azimuth) * horizontal;
      let best = Math.abs(dy) < 1e-8 ? Infinity : RAY_RANGE;
      let type = 0;

      const checkWall = t => {
        if (!(t > 0 && t < best)) return;
        const hitX = self.x + dx * t, hitZ = self.z + dz * t, hitY = self.y + dy * t;
        if (t > 0 && t < best && Math.abs(hitX) <= ARENA_HALF && Math.abs(hitZ) <= ARENA_HALF && hitY >= 0 && hitY <= ARENA_WALL_HEIGHT) {
          best = t; type = 0.5;
        }
      };
      if (dx > 0) checkWall((ARENA_HALF - self.x) / dx);
      else if (dx < 0) checkWall((-ARENA_HALF - self.x) / dx);
      if (dz > 0) checkWall((ARENA_HALF - self.z) / dz);
      else if (dz < 0) checkWall((-ARENA_HALF - self.z) / dz);

      for (const b of this.blocks) {
        if (b.heldBy !== null) continue;
        const t = rayBox(self.x, self.y, self.z, dx, dy, dz,
          b.x - b.hx, b.y - b.hy, b.z - b.hz, b.x + b.hx, b.y + b.hy, b.z + b.hz);
        if (t !== null && t < best) { best = t; type = 0.5; }
      }

      // other agent
      const tAgent = rayBox(self.x, self.y, self.z, dx, dy, dz,
        other.x - AGENT_HALF, other.y - AGENT_HALF, other.z - AGENT_HALF,
        other.x + AGENT_HALF, other.y + AGENT_HALF, other.z + AGENT_HALF);
      if (tAgent !== null && tAgent < best) { best = tAgent; type = 1.0; }

      if (rayDistances) rayDistances[i] = Number.isFinite(best) ? best : RAY_RANGE;
      const distanceFeature = type === 0 ? 1 : best / (best + RAY_RANGE);
      out[i * 2] = clamp(distanceFeature, 0, 1);
      out[i * 2 + 1] = type;
    }
    return out;
  }

  buildObservation(self, other, timeLeftNorm, extraRays = 0, rayDistances = null) {
    const rays = this._castRays(self, other, extraRays, rayDistances);
    const dx = other.x - self.x, dz = other.z - self.z;
    const dist = Math.hypot(dx, dz);
    const obs = new Float32Array(41 + TAGGER_EXTRA_RAYS * 2);
    obs.set(rays.subarray(0, RAY_COUNT * 2), 0);
    obs[32] = clamp(self.vx / MAX_SPEED, -1, 1);
    obs[33] = clamp(self.vz / MAX_SPEED, -1, 1);
    obs[34] = self.grounded ? 1 : 0;
    obs[35] = self.carrying ? 1 : 0;
    obs[36] = self.role === 'tagger' ? 1 : 0;
    obs[37] = timeLeftNorm;
    obs[38] = clamp(dx / (ARENA_HALF * 2), -1, 1);
    obs[39] = clamp(dz / (ARENA_HALF * 2), -1, 1);
    obs[40] = clamp(dist / (ARENA_HALF * 2), 0, 1);
    if (extraRays) obs.set(rays.subarray(RAY_COUNT * 2), 41);
    return obs;
  }

  // --- physics --------------------------------------------------------
  _applyAction(agent, action) {
    const [mx, mz, jump, interact] = action;
    // WASD-style: NN outputs act like analog key strengths along world axes.
    agent.vx += mx * MOVE_ACCEL * DT;
    agent.vz += mz * MOVE_ACCEL * DT;

    if (jump && agent.grounded) {
      agent.vy = JUMP_SPEED;
      agent.grounded = false;
    }

    // interact: edge-triggered pick up / drop
    if (interact && !agent.interactPrev) {
      if (agent.carrying) {
        // drop in front of agent
        const b = agent.carrying;
        b.heldBy = null; b.static = true;
        b.x = clamp(agent.x + Math.cos(agent.facing) * 1.2, -ARENA_HALF + 0.5, ARENA_HALF - 0.5);
        b.z = clamp(agent.z + Math.sin(agent.facing) * 1.2, -ARENA_HALF + 0.5, ARENA_HALF - 0.5);
        b.y = b.hy;
        agent.carrying = null;
      } else {
        for (const b of this.blocks) {
          if (!b.movable || b.heldBy !== null) continue;
          if (Math.hypot(b.x - agent.x, b.z - agent.z) < PICKUP_RADIUS) {
            b.heldBy = agent === this.tagger ? 0 : 1;
            agent.carrying = b;
            break;
          }
        }
      }
    }
    agent.interactPrev = interact;
    if (mx !== 0 || mz !== 0) agent.facing = Math.atan2(mz, mx);
  }

  _integrate(agent) {
    // friction (ground drag)
    const speed = Math.hypot(agent.vx, agent.vz);
    if (speed > 0) {
      const drop = Math.min(speed, FRICTION * DT);
      const f = (speed - drop) / speed;
      agent.vx *= f; agent.vz *= f;
    }
    const sp = Math.hypot(agent.vx, agent.vz);
    if (sp > MAX_SPEED) { agent.vx = agent.vx / sp * MAX_SPEED; agent.vz = agent.vz / sp * MAX_SPEED; }

    agent.vy += GRAVITY * DT;
    agent.x += agent.vx * DT;
    agent.z += agent.vz * DT;
    agent.y += agent.vy * DT;

    if (agent.y <= 0.5) { agent.y = 0.5; agent.vy = 0; agent.grounded = true; }

    // arena bounds
    agent.x = clamp(agent.x, -ARENA_HALF + AGENT_HALF, ARENA_HALF - AGENT_HALF);
    agent.z = clamp(agent.z, -ARENA_HALF + AGENT_HALF, ARENA_HALF - AGENT_HALF);

    // static block collision (push-out)
    for (const b of this.blocks) {
      if (b.heldBy !== null) continue;
      if (!boxesOverlap(agent.x, agent.z, AGENT_HALF, AGENT_HALF, b.x, b.z, b.hx, b.hz)) continue;
      if (b.kind === 'crawlspace') {
        const roofBottom = b.y - b.hy;
        if (agent.vy > 0 && agent.y + AGENT_HALF > roofBottom && agent.y - AGENT_HALF < roofBottom) {
          agent.y = roofBottom - AGENT_HALF;
          agent.vy = 0;
        }
        continue;
      }
      if (Math.abs(agent.y - b.y) < AGENT_HALF + b.hy) {
        const dx = agent.x - b.x, dz = agent.z - b.z;
        const overlapX = AGENT_HALF + b.hx - Math.abs(dx);
        const overlapZ = AGENT_HALF + b.hz - Math.abs(dz);
        if (overlapX < overlapZ) agent.x += Math.sign(dx || 1) * overlapX;
        else agent.z += Math.sign(dz || 1) * overlapZ;
      }
    }

    // carried block follows
    if (agent.carrying) {
      agent.carrying.x = agent.x + Math.cos(agent.facing) * 1.0;
      agent.carrying.z = agent.z + Math.sin(agent.facing) * 1.0;
      agent.carrying.y = 1.2;
    }
  }

  tick(playerAction = null) {
    if (this.over) return;
    const timeLeft = 1 - this.step / MAX_STEPS;
    const taggerRayDistances = this.captureRays ? new Float32Array(RAY_COUNT + TAGGER_EXTRA_RAYS) : null;
    const runnerRayDistances = this.captureRays ? new Float32Array(RAY_COUNT) : null;
    const obsT = this.buildObservation(this.tagger, this.runner, timeLeft, TAGGER_EXTRA_RAYS, taggerRayDistances);
    const obsR = this.buildObservation(this.runner, this.tagger, timeLeft, 0, runnerRayDistances);
    this._lastTaggerRays = new Float32Array((RAY_COUNT + TAGGER_EXTRA_RAYS) * 2);
    this._lastTaggerRays.set(obsT.subarray(0, RAY_COUNT * 2));
    this._lastTaggerRays.set(obsT.subarray(41), RAY_COUNT * 2);
    this._lastRunnerRays = obsR.subarray(0, RAY_COUNT * 2);
    if (this.captureRays) {
      this._lastTaggerRayDistances = taggerRayDistances;
      this._lastRunnerRayDistances = runnerRayDistances;
    }
    const actT = this.tagger.brain.forward(obsT);
    const actR = this.runner.brain.forward(obsR);
    this._applyAction(this.tagger, actT);
    this._applyAction(this.runner, actR);
    if (this.player) this._applyAction(this.player, playerAction || [0, 0, 0, 0]);
    this._integrate(this.tagger);
    this._integrate(this.runner);
    if (this.player) this._integrate(this.player);

    const dist = Math.hypot(this.tagger.x - this.runner.x, this.tagger.z - this.runner.z);

    if (!this.player) {
      this.tagger.fitness += (1 - clamp(dist / (ARENA_HALF * 2), 0, 1)) * 0.02;
      this.runner.fitness += clamp(dist / (ARENA_HALF * 2), 0, 1) * 0.015 + 0.01;

      if (dist < TAG_RADIUS) {
        this.runner.tagged = true;
        this.tagStep = this.step;
        const speedBonus = (MAX_STEPS - this.step) / MAX_STEPS;
        this.tagger.fitness += 40 * (1 + speedBonus);
        this.over = true;
      }
    }

    this.step++;
    if (this.player && this.step >= MAX_STEPS) this.step = 0;
    else if (this.step >= MAX_STEPS) {
      this.runner.fitness += 25; // survived the whole match
      this.over = true;
    }
  }

  runToCompletion() {
    while (!this.over) this.tick();
    return { taggerFitness: this.tagger.fitness, runnerFitness: this.runner.fitness, tagged: this.runner.tagged, steps: this.step };
  }
}
