// render.js — the only file that touches Three.js / the DOM. It draws
// exactly one "featured" Match (from sim.js) per frame; all the other
// matches played during training are headless and never touch this file.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { ARENA_HALF, RAY_COUNT } from './sim.js';

export class SceneRenderer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f14);
    this.scene.fog = new THREE.Fog(0x0d0f14, 30, 70);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
    this.camera.position.set(0, 26, 30);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.enableDamping = true;

    this._buildStaticScene();
    this._buildAgentMeshes();
    this.blockMeshes = [];
    this.rayGroup = new THREE.Group();
    this.scene.add(this.rayGroup);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  _buildStaticScene() {
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x0a0a10, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(15, 25, 10);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2, 20, 20),
      new THREE.MeshStandardMaterial({ color: 0x1a1d29, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(ARENA_HALF * 2, 20, 0x2a2f42, 0x20233098);
    grid.position.y = 0.01;
    this.scene.add(grid);

    const wallMat = new THREE.LineBasicMaterial({ color: 0x3a4060 });
    const h = ARENA_HALF, y = 3;
    const pts = [
      [-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h], [-h, 0, -h],
      [-h, y, -h], [h, y, -h], [h, y, h], [-h, y, h], [-h, y, -h],
    ].map(p => new THREE.Vector3(...p));
    this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wallMat));
  }

  _buildAgentMeshes() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const taggerMat = new THREE.MeshStandardMaterial({ color: 0xff5d5d, roughness: .4, metalness: .1 });
    const runnerMat = new THREE.MeshStandardMaterial({ color: 0x4da3ff, roughness: .4, metalness: .1 });
    this.taggerMesh = new THREE.Mesh(geo, taggerMat);
    this.runnerMesh = new THREE.Mesh(geo, runnerMat);
    this.taggerMesh.add(new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 8), taggerMat)).children[0].position.set(0, 0.3, -0.6);
    this.runnerMesh.add(new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 8), runnerMat)).children[0].position.set(0, 0.3, -0.6);
    this.scene.add(this.taggerMesh, this.runnerMesh);
  }

  // Call once whenever a new Match becomes the featured one (its obstacle
  // layout is randomized per-match, so block meshes must be rebuilt).
  setMatch(match) {
    for (const m of this.blockMeshes) { this.scene.remove(m); }
    this.blockMeshes = [];
    for (const b of match.blocks) {
      const size = b.hx * 2;
      const mat = new THREE.MeshStandardMaterial({
        color: b.movable ? 0xe0a458 : 0x50566f,
        roughness: .7,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
      this.scene.add(mesh);
      this.blockMeshes.push(mesh);
      b._mesh = mesh;
    }
  }

  sync(match) {
    this.taggerMesh.position.set(match.tagger.x, match.tagger.y, match.tagger.z);
    this.taggerMesh.rotation.y = -match.tagger.facing + Math.PI / 2;
    this.runnerMesh.position.set(match.runner.x, match.runner.y, match.runner.z);
    this.runnerMesh.rotation.y = -match.runner.facing + Math.PI / 2;
    for (const b of match.blocks) {
      if (b._mesh) b._mesh.position.set(b.x, b.y, b.z);
    }
    this._drawRays(match);
  }

  _drawRays(match) {
    this.rayGroup.clear();
    const mat = new THREE.LineBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.15 });
    const a = match.tagger;
    const maxDist = 16;
    const obs = match._lastTaggerRays;
    if (!obs) return;
    const pts = [];
    for (let i = 0; i < RAY_COUNT; i++) {
      const ang = (i / RAY_COUNT) * Math.PI * 2;
      const dist = obs[i * 2] * maxDist;
      pts.push(new THREE.Vector3(a.x, a.y, a.z));
      pts.push(new THREE.Vector3(a.x + Math.cos(ang) * dist, a.y, a.z + Math.sin(ang) * dist));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.rayGroup.add(new THREE.LineSegments(geo, mat));
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
