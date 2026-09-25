// render.js — the only file that touches Three.js / the DOM. It draws
// exactly one "featured" Match (from sim.js) per frame; all the other
// matches played during training are headless and never touch this file.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARENA_HALF, CRAWLSPACE_ROOF_THICKNESS, RAY_COUNT, RAY_RANGE, TAGGER_EXTRA_RAYS, rayAngles } from './sim.js';

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
    this.viewMode = 'arena';
    this.viewYawOffset = 0;
    this.viewPitchOffset = 0;
    this.currentMatch = null;
    this.orbitPosition = this.camera.position.clone();
    this.orbitTarget = this.controls.target.clone();

    this._buildStaticScene();
    this._buildAgentMeshes();
    this.blockMeshes = [];
    this.rayGroup = new THREE.Group();
    this.scene.add(this.rayGroup);
    this.editorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.editorRaycaster = new THREE.Raycaster();
    this.editorGhost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.25, depthWrite: false })
    );
    this.editorGhost.visible = false;
    this.scene.add(this.editorGhost);
    this.editorMode = false;
    this.editorTool = 'place';
    this.editorPoint = null;
    this.editorCallbacks = {};
    this.getEditorDimensions = () => ({ width: 4, height: 1, depth: 1 });
    this.renderer.domElement.addEventListener('pointermove', event => this._updateEditorPointer(event));
    this.renderer.domElement.addEventListener('pointerdown', event => this._handleEditorPointerDown(event));

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
    const playerMat = new THREE.MeshStandardMaterial({ color: 0x3ddc84, roughness: .4, metalness: .1 });
    this.taggerMesh = new THREE.Mesh(geo, taggerMat);
    this.runnerMesh = new THREE.Mesh(geo, runnerMat);
    this.playerMesh = new THREE.Mesh(geo, playerMat);
    this.taggerMesh.add(new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 8), taggerMat)).children[0].position.set(0, 0.3, -0.6);
    this.runnerMesh.add(new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 8), runnerMat)).children[0].position.set(0, 0.3, -0.6);
    this.playerMesh.add(new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 8), playerMat)).children[0].position.set(0, 0.3, -0.6);
    this.playerMesh.visible = false;
    this.scene.add(this.taggerMesh, this.runnerMesh, this.playerMesh);
  }

  // Call once whenever a new Match becomes the featured one (its obstacle
  // layout is randomized per-match, so block meshes must be rebuilt).
  setMatch(match) {
    match.captureRays = true;
    for (const m of this.blockMeshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.blockMeshes = [];
    for (const b of match.blocks) {
      const width = b.hx * 2, height = b.hy * 2, depth = b.hz * 2;
      const mat = new THREE.MeshStandardMaterial({
        color: b.movable ? 0xe0a458 : b.kind === 'crawlspace' ? 0x49a8a0 : height <= 1 ? 0xb78c57 : 0x626b79,
        roughness: .7,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
      this.scene.add(mesh);
      this.blockMeshes.push(mesh);
      b._mesh = mesh;
    }
  }

  sync(match) {
    this.currentMatch = match;
    this.taggerMesh.position.set(match.tagger.x, match.tagger.y, match.tagger.z);
    this.taggerMesh.rotation.y = -match.tagger.facing - Math.PI / 2;
    this.runnerMesh.position.set(match.runner.x, match.runner.y, match.runner.z);
    this.runnerMesh.rotation.y = -match.runner.facing - Math.PI / 2;
    this.playerMesh.visible = Boolean(match.player);
    if (match.player) {
      this.playerMesh.position.set(match.player.x, match.player.y, match.player.z);
      this.playerMesh.rotation.y = -match.player.facing - Math.PI / 2;
    }
    for (const b of match.blocks) {
      if (b._mesh) b._mesh.position.set(b.x, b.y, b.z);
    }
    this._drawRays(match);
    this._updateViewCamera(match);
  }

  _drawRays(match) {
    for (const line of this.rayGroup.children) {
      line.geometry.dispose();
      line.material.dispose();
    }
    this.rayGroup.clear();
    const maxDist = RAY_RANGE;
    const drawAgentRays = (agent, rays, distances, extraRays, color) => {
      if (!rays) return;
      const pts = [];
      const rayCount = RAY_COUNT + extraRays;
      for (let i = 0; i < rayCount; i++) {
        const { azimuth, elevation } = rayAngles(i);
        const horizontal = Math.cos(elevation);
        const dist = distances?.[i] ?? rays[i * 2] * maxDist;
        pts.push(new THREE.Vector3(agent.x, agent.y, agent.z));
        pts.push(new THREE.Vector3(
          agent.x + Math.cos(azimuth) * horizontal * dist,
          agent.y + Math.sin(elevation) * dist,
          agent.z + Math.sin(azimuth) * horizontal * dist,
        ));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 });
      this.rayGroup.add(new THREE.LineSegments(geo, mat));
    }
    drawAgentRays(match.tagger, match._lastTaggerRays, match._lastTaggerRayDistances, TAGGER_EXTRA_RAYS, 0xff5d5d);
    drawAgentRays(match.runner, match._lastRunnerRays, match._lastRunnerRayDistances, 0, 0x4da3ff);
  }

  setEditorMode(enabled, callbacks = {}, getDimensions = this.getEditorDimensions) {
    this.editorMode = enabled;
    this.editorCallbacks = callbacks;
    this.getEditorDimensions = getDimensions;
    this.controls.enabled = !enabled && this.viewMode === 'arena';
    this.editorGhost.visible = enabled;
    if (!enabled) this.editorPoint = null;
  }

  setEditorTool(tool) {
    this.editorTool = tool;
  }

  setViewMode(mode) {
    if (this.viewMode === 'arena') {
      this.orbitPosition.copy(this.camera.position);
      this.orbitTarget.copy(this.controls.target);
    }
    this.viewMode = mode;
    this.rayGroup.visible = mode === 'arena';
    this.viewYawOffset = 0;
    this.viewPitchOffset = 0;
    this.controls.enabled = mode === 'arena' && !this.editorMode;
    this.camera.fov = mode === 'arena' ? 55 : 88;
    this.camera.updateProjectionMatrix();
    if (mode === 'arena') {
      this.camera.position.copy(this.orbitPosition);
      this.controls.target.copy(this.orbitTarget);
    }
  }

  panView(yawDelta, pitchDelta) {
    if (this.viewMode === 'arena') return;
    if (this.viewMode === 'player' && this.currentMatch?.player) {
      const player = this.currentMatch.player;
      player.viewYaw = (player.viewYaw || 0) + yawDelta;
      player.viewPitch = THREE.MathUtils.clamp((player.viewPitch || 0) + pitchDelta, -1.2, 1.2);
      return;
    }
    this.viewYawOffset += yawDelta;
    this.viewPitchOffset = THREE.MathUtils.clamp(this.viewPitchOffset + pitchDelta, -1.2, 1.2);
  }

  getPlayerYaw() {
    return this.currentMatch?.player?.viewYaw || 0;
  }

  _updateViewCamera(match) {
    if (this.viewMode === 'arena') return;
    const agent = this.viewMode === 'tagger' ? match.tagger
      : this.viewMode === 'runner' ? match.runner
        : match.player;
    if (!agent) return;
    const isPlayer = this.viewMode === 'player';
    const yaw = (isPlayer ? agent.viewYaw || 0 : agent.facing) + this.viewYawOffset;
    const pitch = (isPlayer ? agent.viewPitch || 0 : 0) + this.viewPitchOffset;
    const horizontal = Math.cos(pitch);
    const direction = new THREE.Vector3(Math.cos(yaw) * horizontal, Math.sin(pitch), Math.sin(yaw) * horizontal);
    const anchorYaw = isPlayer ? yaw : agent.facing;
    const position = new THREE.Vector3(
      agent.x + Math.cos(anchorYaw) * 0.56,
      agent.y + 0.12,
      agent.z + Math.sin(anchorYaw) * 0.56,
    );
    this.camera.position.copy(position);
    this.camera.lookAt(position.clone().add(direction));
  }

  _updateEditorPointer(event) {
    if (!this.editorMode) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.editorRaycaster.setFromCamera(pointer, this.camera);
    const point = this.editorRaycaster.ray.intersectPlane(this.editorPlane, new THREE.Vector3());
    if (!point) {
      this.editorPoint = null;
      this.editorGhost.visible = false;
      return;
    }
    const { width, height, depth } = this.getEditorDimensions();
    const x = THREE.MathUtils.clamp(Math.round(point.x), -ARENA_HALF + width / 2, ARENA_HALF - width / 2);
    const z = THREE.MathUtils.clamp(Math.round(point.z), -ARENA_HALF + depth / 2, ARENA_HALF - depth / 2);
    this.editorPoint = { x, z };
    this.refreshEditorGhost();
  }

  refreshEditorGhost() {
    if (!this.editorMode || !this.editorPoint) return;
    const { width, height, depth, kind } = this.getEditorDimensions();
    const x = THREE.MathUtils.clamp(this.editorPoint.x, -ARENA_HALF + width / 2, ARENA_HALF - width / 2);
    const z = THREE.MathUtils.clamp(this.editorPoint.z, -ARENA_HALF + depth / 2, ARENA_HALF - depth / 2);
    this.editorPoint = { x, z };
    const roof = kind === 'crawlspace';
    const meshHeight = roof ? CRAWLSPACE_ROOF_THICKNESS : height;
    this.editorGhost.scale.set(width, meshHeight, depth);
    this.editorGhost.position.set(x, roof ? height + meshHeight / 2 : height / 2, z);
    this.editorGhost.visible = true;
  }

  _handleEditorPointerDown(event) {
    if (!this.editorMode || event.button !== 0) return;
    this._updateEditorPointer(event);
    if (!this.editorPoint) return;
    event.preventDefault();
    if (this.editorTool === 'erase') this.editorCallbacks.erase?.(this.editorPoint);
    else this.editorCallbacks.place?.(this.editorPoint, this.getEditorDimensions());
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
