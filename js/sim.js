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
export const DT = 1 / 30;             // fixed timestep used for headless steps
export const MAX_STEPS = 450;         // 15 sim-seconds per match
export const NUM_OBSTACLES = 5;       // random static blocks scattered at start
export const NUM_LOOSE_BLOCKS = 4;    // pickup-able blocks

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(a, b) { return a + Math.random() * (b - a); }

// Axis-aligned box helper: {x,z,hx,hz} (y handled separately/simply)
function boxesOverlap(ax, az, ahx, ahz, bx, bz, bhx, bhz) {
  return Math.abs(ax - bx) < ahx + bhx && Math.abs(az - bz) < ahz + bhz;
}

export class Block {
  constructor(x, z, movable) {
    this.x = x; this.y = 0.5; this.z = z;
    this.hx = 0.5; this.hz = 0.5;
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
  constructor(taggerBrain, runnerBrain, seed) {
    this.tagger = new Agent('tagger', taggerBrain);
    this.runner = new Agent('runner', runnerBrain);
    this.blocks = [];
    this.step = 0;
    this.over = false;
    this.tagStep = -1;
    this._buildArena();
    this._placeAgents();
  }

  _buildArena() {
    // static obstacles
    for (let i = 0; i < NUM_OBSTACLES; i++) {
      const x = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
      const z = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
      this.blocks.push(new Block(x, z, false));
    }
    // loose pickup-able blocks
    for (let i = 0; i < NUM_LOOSE_BLOCKS; i++) {
      const x = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
      const z = rand(-ARENA_HALF + 4, ARENA_HALF - 4);
      this.blocks.push(new Block(x, z, true));
    }
  }

  _placeAgents() {
    this.tagger.x = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
    this.tagger.z = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
    // spawn runner far from tagger
    let rx, rz;
    do {
      rx = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
      rz = rand(-ARENA_HALF + 2, ARENA_HALF - 2);
    } while (Math.hypot(rx - this.tagger.x, rz - this.tagger.z) < 15);
    this.runner.x = rx; this.runner.z = rz;
  }

  // --- vision -------------------------------------------------------
  // Casts RAY_COUNT rays in a full circle from `self`, returns flattened
  // [dist0, type0, dist1, type1, ...] normalized to 0..1.
  // type: 0 = nothing (max range), 0.5 = wall/block, 1.0 = other agent
  _castRays(self, other) {
    const maxDist = 16;
    const out = new Float32Array(RAY_COUNT * 2);
    for (let i = 0; i < RAY_COUNT; i++) {
      const ang = (i / RAY_COUNT) * Math.PI * 2;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      let best = maxDist, type = 0;

      // arena walls
      const tX = dx > 0 ? (ARENA_HALF - self.x) / dx : dx < 0 ? (-ARENA_HALF - self.x) / dx : Infinity;
      const tZ = dz > 0 ? (ARENA_HALF - self.z) / dz : dz < 0 ? (-ARENA_HALF - self.z) / dz : Infinity;
      const tWall = Math.min(tX > 0 ? tX : Infinity, tZ > 0 ? tZ : Infinity);
      if (tWall < best) { best = tWall; type = 0.5; }

      // blocks (simple ray-vs-circle approx using block half-extent as radius)
      for (const b of this.blocks) {
        if (b.heldBy !== null) continue;
        const t = rayCircle(self.x, self.z, dx, dz, b.x, b.z, 0.75);
        if (t !== null && t < best) { best = t; type = 0.5; }
      }

      // other agent
      const tAgent = rayCircle(self.x, self.z, dx, dz, other.x, other.z, AGENT_HALF);
      if (tAgent !== null && tAgent < best) { best = tAgent; type = 1.0; }

      out[i * 2] = clamp(best / maxDist, 0, 1);
      out[i * 2 + 1] = type;
    }
    return out;
  }

  buildObservation(self, other, timeLeftNorm) {
    const rays = this._castRays(self, other);
    const dx = other.x - self.x, dz = other.z - self.z;
    const dist = Math.hypot(dx, dz);
    const obs = new Float32Array(41);
    obs.set(rays, 0); // 32
    obs[32] = clamp(self.vx / MAX_SPEED, -1, 1);
    obs[33] = clamp(self.vz / MAX_SPEED, -1, 1);
    obs[34] = self.grounded ? 1 : 0;
    obs[35] = self.carrying ? 1 : 0;
    obs[36] = self.role === 'tagger' ? 1 : 0;
    obs[37] = timeLeftNorm;
    obs[38] = clamp(dx / (ARENA_HALF * 2), -1, 1);
    obs[39] = clamp(dz / (ARENA_HALF * 2), -1, 1);
    obs[40] = clamp(dist / (ARENA_HALF * 2), 0, 1);
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
      if (boxesOverlap(agent.x, agent.z, AGENT_HALF, AGENT_HALF, b.x, b.z, b.hx, b.hz)) {
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

  tick() {
    if (this.over) return;
    const timeLeft = 1 - this.step / MAX_STEPS;
    const obsT = this.buildObservation(this.tagger, this.runner, timeLeft);
    const obsR = this.buildObservation(this.runner, this.tagger, timeLeft);
    this._lastTaggerRays = obsT.subarray(0, RAY_COUNT * 2); // for optional vision-ray rendering
    const actT = this.tagger.brain.forward(obsT);
    const actR = this.runner.brain.forward(obsR);
    this._applyAction(this.tagger, actT);
    this._applyAction(this.runner, actR);
    this._integrate(this.tagger);
    this._integrate(this.runner);

    const dist = Math.hypot(this.tagger.x - this.runner.x, this.tagger.z - this.runner.z);

    // reward shaping
    this.tagger.fitness += (1 - clamp(dist / (ARENA_HALF * 2), 0, 1)) * 0.02;
    this.runner.fitness += clamp(dist / (ARENA_HALF * 2), 0, 1) * 0.015 + 0.01; // survival + spacing

    if (dist < TAG_RADIUS) {
      this.runner.tagged = true;
      this.tagStep = this.step;
      const speedBonus = (MAX_STEPS - this.step) / MAX_STEPS; // faster tag = more bonus
      this.tagger.fitness += 40 * (1 + speedBonus);
      this.over = true;
    }

    this.step++;
    if (this.step >= MAX_STEPS) {
      this.runner.fitness += 25; // survived the whole match
      this.over = true;
    }
  }

  runToCompletion() {
    while (!this.over) this.tick();
    return { taggerFitness: this.tagger.fitness, runnerFitness: this.runner.fitness, tagged: this.runner.tagged, steps: this.step };
  }
}

// ray-vs-circle intersection, returns distance t or null
function rayCircle(ox, oz, dx, dz, cx, cz, r) {
  const ocx = ox - cx, ocz = oz - cz;
  const b = ocx * dx + ocz * dz;
  const c = ocx * ocx + ocz * ocz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
