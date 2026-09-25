// evolution.js — competitive co-evolution between a Tagger population and a
// Runner population using a simple genetic algorithm (no gradients needed,
// which keeps everything easy to run and serialize entirely client-side).

import { Brain, GENOME_LEN, INPUT_SIZE, HIDDEN_SIZE, OUTPUT_SIZE, mutate, crossover } from './brain.js';
import { Match } from './sim.js';

export const POP_SIZE = 24;
export const OPPONENTS_PER_GENOME = 4; // matches each genome plays per generation
export const ELITE_COUNT = 2;
export const TOURNAMENT_SIZE = 3;

function randomGenome() { return Brain.randomWeights(); }

export class Population {
  constructor(role, size = POP_SIZE) {
    this.role = role;
    this.genomes = Array.from({ length: size }, randomGenome);
    this.fitness = new Float32Array(size);
  }
  best() {
    let bi = 0;
    for (let i = 1; i < this.fitness.length; i++) if (this.fitness[i] > this.fitness[bi]) bi = i;
    return { index: bi, genome: this.genomes[bi], fitness: this.fitness[bi] };
  }
  tournamentSelect() {
    let bi = Math.floor(Math.random() * this.genomes.length);
    for (let i = 1; i < TOURNAMENT_SIZE; i++) {
      const c = Math.floor(Math.random() * this.genomes.length);
      if (this.fitness[c] > this.fitness[bi]) bi = c;
    }
    return this.genomes[bi];
  }
  nextGeneration() {
    const ranked = [...this.genomes.keys()].sort((a, b) => this.fitness[b] - this.fitness[a]);
    const next = [];
    for (let i = 0; i < ELITE_COUNT; i++) next.push(this.genomes[ranked[i]].slice());
    while (next.length < this.genomes.length) {
      const a = this.tournamentSelect();
      const b = this.tournamentSelect();
      const child = mutate(crossover(a, b));
      next.push(child);
    }
    this.genomes = next;
    this.fitness = new Float32Array(this.genomes.length);
  }
}

export class Coevolution {
  constructor() {
    this.taggers = new Population('tagger');
    this.runners = new Population('runner');
    this.generation = 0;
    this.history = []; // {gen, bestTagger, bestRunner, tagRate}
    this._lastFeatured = null; // last Match played by the current-best pair, for rendering
    this.arenaLayout = null;
  }

  // Runs ONE full generation synchronously (all matches). Call this from a
  // web worker or in small time-boxed slices if it ever needs to stay under
  // a frame budget; see main.js for the slicing used in the browser.
  runGeneration() {
    const nT = this.taggers.genomes.length, nR = this.runners.genomes.length;
    let tags = 0, total = 0;

    for (let i = 0; i < nT; i++) {
      for (let k = 0; k < OPPONENTS_PER_GENOME; k++) {
        const j = Math.floor(Math.random() * nR);
        const tBrain = new Brain(this.taggers.genomes[i]);
        const rBrain = new Brain(this.runners.genomes[j]);
        const m = new Match(tBrain, rBrain, this.arenaLayout);
        const res = m.runToCompletion();
        this.taggers.fitness[i] += res.taggerFitness / OPPONENTS_PER_GENOME;
        this.runners.fitness[j] += res.runnerFitness / (OPPONENTS_PER_GENOME * (nT / nR));
        total++; if (res.tagged) tags++;
      }
    }

    const bestT = this.taggers.best();
    const bestR = this.runners.best();
    this.history.push({ gen: this.generation, bestTagger: bestT.fitness, bestRunner: bestR.fitness, tagRate: tags / total });

    // Keep a fresh match between the two current champions for the renderer.
    this._lastFeatured = { taggerGenome: bestT.genome.slice(), runnerGenome: bestR.genome.slice() };

    this.taggers.nextGeneration();
    this.runners.nextGeneration();
    this.generation++;
    return this.history[this.history.length - 1];
  }

  featuredBrains() {
    const f = this._lastFeatured;
    if (!f) return { taggerBrain: new Brain(this.taggers.genomes[0]), runnerBrain: new Brain(this.runners.genomes[0]) };
    return { taggerBrain: new Brain(f.taggerGenome), runnerBrain: new Brain(f.runnerGenome) };
  }

  // --- compact binary serialization ------------------------------------
  // Packs both populations' raw weights into one ArrayBuffer. Far smaller
  // than JSON (no per-number text/decimal overhead) — this is what gets
  // base64-encoded for export/import. History is UI-only and isn't saved.
  toBuffer() {
    const nT = this.taggers.genomes.length, nR = this.runners.genomes.length;
    const glen = GENOME_LEN;
    const header = new Uint32Array([0x31474154 /*'TAG1'*/, this.generation, nT, nR, glen]);
    const buf = new ArrayBuffer(header.byteLength + (nT + nR) * glen * 4);
    new Uint32Array(buf, 0, header.length).set(header);
    let offset = header.byteLength;
    for (const g of this.taggers.genomes) { new Float32Array(buf, offset, glen).set(g); offset += glen * 4; }
    for (const g of this.runners.genomes) { new Float32Array(buf, offset, glen).set(g); offset += glen * 4; }
    return buf;
  }
  loadBuffer(buf) {
    if (buf.byteLength < 5 * 4) throw new Error('Not a valid tag-rl save file');
    const header = new Uint32Array(buf, 0, 5);
    if (header[0] !== 0x31474154) throw new Error('Not a valid tag-rl save file');
    const [, generation, nT, nR, glen] = header;
    const legacyInputSize = 41;
    const legacyGenomeLen = (legacyInputSize + 1) * HIDDEN_SIZE + (HIDDEN_SIZE + 1) * OUTPUT_SIZE;
    if (glen !== GENOME_LEN && glen !== legacyGenomeLen) throw new Error('Save file is from an incompatible network shape');
    if (buf.byteLength !== 5 * 4 + (nT + nR) * glen * 4) throw new Error('Not a valid tag-rl save file');
    const migrateGenome = genome => {
      const migrated = new Float32Array(GENOME_LEN);
      const legacyW1Len = (legacyInputSize + 1) * HIDDEN_SIZE;
      const currentW1Len = (INPUT_SIZE + 1) * HIDDEN_SIZE;
      for (let h = 0; h < HIDDEN_SIZE; h++) {
        migrated.set(genome.subarray(h * (legacyInputSize + 1), (h + 1) * (legacyInputSize + 1)), h * (INPUT_SIZE + 1));
      }
      migrated.set(genome.subarray(legacyW1Len), currentW1Len);
      return migrated;
    };
    const readGenome = offset => {
      const genome = new Float32Array(buf, offset, glen).slice();
      return glen === GENOME_LEN ? genome : migrateGenome(genome);
    };
    let offset = 5 * 4;
    const taggers = [];
    for (let i = 0; i < nT; i++) { taggers.push(readGenome(offset)); offset += glen * 4; }
    const runners = [];
    for (let i = 0; i < nR; i++) { runners.push(readGenome(offset)); offset += glen * 4; }
    this.generation = generation;
    this.taggers.genomes = taggers;
    this.runners.genomes = runners;
    this.taggers.fitness = new Float32Array(nT);
    this.runners.fitness = new Float32Array(nR);
    this.history = [];
    this._lastFeatured = { taggerGenome: taggers[0], runnerGenome: runners[0] };
  }
}
