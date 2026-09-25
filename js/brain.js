// brain.js — a tiny feedforward neural network used as an agent's "brain".
// Pure math, no DOM/Three.js dependency, so it can run headless (fast, for
// training many matches per frame) and inside the renderer.

export const INPUT_SIZE = 57;   // see sim.js buildObservation() for layout
export const HIDDEN_SIZE = 32;
export const OUTPUT_SIZE = 4;   // moveX, moveZ, jump, interact

const W1_LEN = (INPUT_SIZE + 1) * HIDDEN_SIZE;      // +1 bias row
const W2_LEN = (HIDDEN_SIZE + 1) * OUTPUT_SIZE;
export const GENOME_LEN = W1_LEN + W2_LEN;

function tanh(x) { return Math.tanh(x); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

export class Brain {
  constructor(weights) {
    this.w = weights || Brain.randomWeights();
  }

  static randomWeights() {
    const w = new Float32Array(GENOME_LEN);
    for (let i = 0; i < w.length; i++) w[i] = (Math.random() * 2 - 1) * 0.8;
    return w;
  }

  // Runs the network. `input` is a plain array/Float32Array of length INPUT_SIZE.
  // Returns [moveX, moveZ, jump(0/1), interact(0/1)]
  forward(input) {
    const w = this.w;
    const hidden = new Float32Array(HIDDEN_SIZE);
    let o = 0;
    for (let h = 0; h < HIDDEN_SIZE; h++) {
      let sum = w[o++]; // bias
      for (let i = 0; i < INPUT_SIZE; i++) sum += w[o++] * input[i];
      hidden[h] = tanh(sum);
    }
    const out = new Float32Array(OUTPUT_SIZE);
    for (let k = 0; k < OUTPUT_SIZE; k++) {
      let sum = w[o++]; // bias
      for (let h = 0; h < HIDDEN_SIZE; h++) sum += w[o++] * hidden[h];
      out[k] = sum;
    }
    return [
      tanh(out[0]),                 // moveX  -1..1
      tanh(out[1]),                 // moveZ  -1..1
      sigmoid(out[2]) > 0.5 ? 1 : 0, // jump
      sigmoid(out[3]) > 0.5 ? 1 : 0, // interact (pick up / drop)
    ];
  }

  clone() { return new Brain(this.w.slice()); }
}

export function mutate(weights, rate = 0.12, strength = 0.35) {
  const w = weights.slice();
  for (let i = 0; i < w.length; i++) {
    if (Math.random() < rate) {
      w[i] += (Math.random() * 2 - 1) * strength;
    }
    if (Math.random() < 0.01) {
      // occasional larger jump to escape local optima
      w[i] = (Math.random() * 2 - 1) * 1.2;
    }
  }
  return w;
}

export function crossover(a, b) {
  const w = new Float32Array(a.length);
  for (let i = 0; i < w.length; i++) w[i] = Math.random() < 0.5 ? a[i] : b[i];
  return w;
}
