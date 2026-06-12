// ---------------------------------------------------------------------------
// WebGL renderer (Three.js) for the game world. Gameplay stays flat 2D on the
// z=0 plane; this draws it with a perspective camera, emissive neon materials
// and an UnrealBloom post pass for glow. HUD/text is drawn separately on a 2D
// overlay canvas (see game.js).
//
// Simulation space: x in [0, W], y from 0 (top) to ground (increasing down).
// World space: x centered on 0, y up (ground at y=0), action on the z=0 plane.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CONFIG } from './config.js';

const R = CONFIG.render;
const COL = CONFIG.colors;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // Fixed simulation dimensions (game overwrites these each frame with the
    // same constants); clientW/H track the actual window in pixels.
    this.simW = CONFIG.world.width;
    this.simGroundY = CONFIG.world.height - CONFIG.groundHeight;
    this.clientW = window.innerWidth;
    this.clientH = window.innerHeight;
    this.built = false;
    this._colorCache = new Map();
    this._tmpColor = new THREE.Color();

    this.three = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.three.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = R.exposure;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(R.fov, this.clientW / this.clientH, 1, 9000);

    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // z = 0
    this._ndc = new THREE.Vector2();
    this._hit = new THREE.Vector3();

    this._buildEnvironment();
    this._buildDynamicBuffers();
    this._buildComposer();

    this.cityGroups = [];
    this.turretGroups = [];

    this.setSize(this.clientW, this.clientH);
    this._placeCamera(this.simGroundY); // sane camera before frame 1
  }

  _placeCamera(gy) {
    // Frame the fixed play field so it's fully visible at ANY window aspect:
    // pull back far enough to contain both the vertical extent (coverFrac*gy)
    // and the full width (simW). Whichever needs more distance wins, so the
    // world looks identical regardless of how the window is shaped — only the
    // surrounding sky/ground letterboxes. A small tilt adds depth. With a
    // bottom inset (the touch controller strip) the field is framed into the
    // viewport area ABOVE the inset.
    const effH = Math.max(1, this.clientH - this.bottomInset);
    const tan = Math.tan(THREE.MathUtils.degToRad(R.fov) / 2);
    const aspect = this.clientW / effH;
    const distForHeight = (gy * R.coverFrac) / tan;
    const distForWidth = (this.simW * 0.5 * R.widthMargin) / (tan * aspect);
    const dist = Math.max(distForHeight, distForWidth);
    let lookY = gy * 0.5;
    if (this.bottomInset > 0) {
      // Touch layout: pin the field's BOTTOM edge just above the controller
      // strip instead of centering. Portrait screens are width-constrained,
      // so centering would waste tall dead bands both above and below the
      // field — pinning pushes all the slack into the sky, where threats
      // enter anyway. (visibleWorldH is the world height the viewport spans.)
      const visibleWorldH = 2 * dist * tan;
      lookY = Math.max(lookY, visibleWorldH / 2 - gy * 0.03);
    }
    this.camera.position.set(0, lookY + gy * R.tiltFrac, dist);
    this.camera.lookAt(0, lookY, 0);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Reserve a strip at the bottom of the canvas (the touch controller). The
   * scene is framed as if the viewport ended above the strip — implemented
   * with a camera view offset, so worldToScreen/screenToWorld (which read the
   * projection matrix) stay consistent for free.
   */
  setBottomInset(px) {
    if (this.bottomInset === px) return;
    this.bottomInset = px;
    this._applyViewOffset();
  }

  _applyViewOffset() {
    const inset = this.bottomInset || 0;
    const effH = Math.max(1, this.clientH - inset);
    this.camera.aspect = this.clientW / effH;
    if (inset > 0) {
      // Notional full image = the framed field at clientW x effH; rendering
      // the (taller) sub-rect 0,0,clientW,clientH puts that image in the top
      // of the canvas and lets the world continue beneath it.
      this.camera.setViewOffset(this.clientW, effH, 0, 0, this.clientW, this.clientH);
    } else {
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  // -- coordinate helpers ---------------------------------------------------
  wx(x) {
    return x - this.simW / 2;
  }
  wy(y) {
    return this.simGroundY - y;
  }

  baseColor(str) {
    let c = this._colorCache.get(str);
    if (!c) {
      c = new THREE.Color(str);
      this._colorCache.set(str, c);
    }
    return c;
  }

  // -- static environment ---------------------------------------------------
  _buildEnvironment() {
    // Sky gradient as the scene background.
    this.scene.background = this._gradientTexture(COL.sky[0], COL.sky[1]);

    // Lights: cool ambient + a key directional for shading the extruded shapes.
    this.scene.add(new THREE.AmbientLight(0x35506e, 1.1));
    const key = new THREE.DirectionalLight(0xbcd8ff, 1.5);
    key.position.set(-0.5, 1.0, 0.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xff8866, 0.4);
    fill.position.set(0.6, 0.2, 0.5);
    this.scene.add(fill);

    // Ground slab (dark, non-glowing) + a glowing horizon line.
    const groundMat = new THREE.MeshStandardMaterial({
      color: COL.ground,
      roughness: 0.95,
      metalness: 0.0,
    });
    const ground = new THREE.Mesh(new THREE.BoxGeometry(40000, 2000, 2400), groundMat);
    ground.position.set(0, -1000, -900);
    this.scene.add(ground);

    const lineMat = new THREE.MeshBasicMaterial({ color: COL.groundLine });
    // Wide enough to span the view at any aspect (only the visible part shows).
    this.horizon = new THREE.Mesh(new THREE.BoxGeometry(8000, 2.5, 6), lineMat);
    this.horizon.position.set(0, 0, 2);
    this.scene.add(this.horizon);

    // Field boundaries: opaque dark wings just outside the play area (so
    // side-entering threats emerge from behind them instead of popping into
    // existence) plus a glowing vertical edge line marking each boundary.
    const wingMat = new THREE.MeshBasicMaterial({ color: 0x05070d });
    const edgeLineMat = new THREE.MeshBasicMaterial({ color: COL.groundLine });
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(2400, 7000), wingMat);
      wing.position.set(side * (this.simW / 2 + 1200), 1500, 60);
      this.scene.add(wing);
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, this.simGroundY, 6),
        edgeLineMat
      );
      edge.position.set((side * this.simW) / 2, this.simGroundY / 2, 61);
      this.scene.add(edge);
    }
    // Ceiling: the same treatment across the top of the play area, so
    // ballistic threats drop in from behind the boundary too.
    const topWing = new THREE.Mesh(new THREE.PlaneGeometry(8000, 3000), wingMat);
    topWing.position.set(0, this.simGroundY + 1500, 60);
    this.scene.add(topWing);
    const topEdge = new THREE.Mesh(new THREE.BoxGeometry(this.simW, 2.5, 6), edgeLineMat);
    topEdge.position.set(0, this.simGroundY, 61);
    this.scene.add(topEdge);

    // Soft horizon haze: an additive gradient band above the ground line that
    // reads as low atmosphere catching the city glow.
    const hazeMat = new THREE.MeshBasicMaterial({
      map: this._gradientAlphaTexture(),
      transparent: true,
      opacity: 0.16,
      color: COL.groundLine,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const haze = new THREE.Mesh(new THREE.PlaneGeometry(8000, 320), hazeMat);
    haze.position.set(0, 130, -60);
    this.scene.add(haze);

    // Starfield (two additive layers far back whose brightness drifts out of
    // phase, so the sky twinkles gently rather than sitting static).
    this.starMats = [];
    for (let layer = 0; layer < 2; layer++) {
      const starCount = 450;
      const sp = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        sp[i * 3] = (Math.random() - 0.5) * 6000;
        sp[i * 3 + 1] = Math.random() * 2600 - 200;
        sp[i * 3 + 2] = -700 - Math.random() * 600;
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xbcd6ff,
        size: 3,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.7,
        map: this._dotTexture(),
        depthWrite: false,
      });
      this.starMats.push(mat);
      const stars = new THREE.Points(starGeo, mat);
      stars.frustumCulled = false;
      this.scene.add(stars);
    }
  }

  /** Vertical white→transparent gradient (alpha in the texture). */
  _gradientAlphaTexture() {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(c);
  }

  _gradientTexture(top, bottom) {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _dotTexture() {
    if (this._dot) return this._dot;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.65)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this._dot = new THREE.CanvasTexture(c);
    return this._dot;
  }

  // -- dynamic GPU buffers (points & line segments) -------------------------
  _makeLines(maxSeg) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(maxSeg * 2 * 3);
    const col = new Float32Array(maxSeg * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    this.scene.add(lines);
    return {
      pos,
      col,
      maxSeg,
      geo,
      setCount(segs) {
        geo.setDrawRange(0, segs * 2);
        geo.attributes.position.needsUpdate = true;
        geo.attributes.color.needsUpdate = true;
      },
    };
  }

  /**
   * Point cloud with per-point size and alpha (a small shader on top of what
   * PointsMaterial offers), used for debris sparks, smoke and engine glows.
   */
  _makeCloud(max, blending, softTexture = false) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(max * 3);
    const col = new Float32Array(max * 3);
    const size = new Float32Array(max);
    const alpha = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('palpha', new THREE.BufferAttribute(alpha, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: softTexture ? this._softTexture() : this._dotTexture() },
        uScale: { value: this.three.getPixelRatio() },
      },
      vertexShader: `
        attribute vec3 pcolor;
        attribute float psize;
        attribute float palpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = pcolor;
          vAlpha = palpha;
          gl_PointSize = psize * uScale;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(vColor, vAlpha) * texture2D(map, gl_PointCoord);
        }`,
      transparent: true,
      blending,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);
    this._clouds = this._clouds || [];
    this._clouds.push(mat);
    return {
      pos,
      col,
      size,
      alpha,
      geo,
      max,
      setCount(n) {
        geo.setDrawRange(0, n);
        geo.attributes.position.needsUpdate = true;
        geo.attributes.pcolor.needsUpdate = true;
        geo.attributes.psize.needsUpdate = true;
        geo.attributes.palpha.needsUpdate = true;
      },
    };
  }

  /** Very soft radial falloff (for smoke; the dot texture is too hard-edged). */
  _softTexture() {
    if (this._soft) return this._soft;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this._soft = new THREE.CanvasTexture(c);
    return this._soft;
  }

  _buildDynamicBuffers() {
    this.sparkCloud = this._makeCloud(R.maxParticles, THREE.AdditiveBlending);
    this.smokeCloud = this._makeCloud(R.maxSmoke, THREE.NormalBlending, true);
    // One glow point per missile/interceptor head (hot exhaust / reentry plasma).
    this.glowCloud = this._makeCloud(
      R.maxMissiles + R.maxInterceptors,
      THREE.AdditiveBlending
    );
    this._buildExplosionPool();
    this.laserSys = this._makeLines(24); // a few segments per live laser beam
    this._buildMissileMeshes();
    this._buildSideEntrantMeshes();
    this.missileTrailSys = this._makeLines(R.maxMissiles * CONFIG.missile.trailMaxPoints * 3);
    // 2 segments per tracer: GL lines are stuck at 1px, so each round is
    // drawn as a parallel pair straddling its true path for a ~2px tracer.
    this.bulletSys = this._makeLines(R.maxBullets * 2);
    this._buildInterceptorMeshes();
    this.interceptorTrailSys = this._makeLines(
      R.maxInterceptors * CONFIG.interceptor.trailMaxPoints
    );
    this._buildAAMMeshes();
    this.aamTrailSys = this._makeLines(
      R.maxAAMs * CONFIG.airstrike.missile.trailMaxPoints
    );
    this._buildJetMeshes();
    this._buildShieldMeshes();
  }

  _buildAAMMeshes() {
    // Air-to-air missiles: the interceptor's little sibling — a slim mint
    // dart, nose along velocity.
    this._aamGeo = new THREE.ConeGeometry(2.2, 10, 8);
    this.aamMeshes = [];
    for (let i = 0; i < R.maxAAMs; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL.aam,
        emissive: COL.aam,
        emissiveIntensity: 1.4,
        roughness: 0.35,
        metalness: 0.4,
      });
      const mesh = new THREE.Mesh(this._aamGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.aamMeshes.push(mesh);
    }
  }

  /**
   * Friendly F-16s (nose along +X): slim fuselage, nose cone, bubble canopy,
   * swept mid-set wings and stabs — and the type's signature, a SINGLE tall
   * raked tail fin (the enemy strike fighter wears two).
   */
  _buildJetMeshes() {
    this.jetMeshes = [];
    for (let i = 0; i < R.maxJets; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL.jet,
        emissive: COL.jet,
        emissiveIntensity: 0.55,
        roughness: 0.45,
        metalness: 0.5,
      });
      const g = new THREE.Group();
      const fuselage = new THREE.Mesh(new THREE.BoxGeometry(22, 3, 3.4), mat);
      g.add(fuselage);
      const noseGeo = new THREE.ConeGeometry(1.4, 6.5, 8);
      noseGeo.rotateZ(-Math.PI / 2);
      const nose = new THREE.Mesh(noseGeo, mat);
      nose.position.x = 14;
      g.add(nose);
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(4.5, 1.7, 2.2), mat);
      canopy.position.set(6.5, 2, 0);
      g.add(canopy);
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.55, 9.5), mat);
        wing.position.set(-1.5, -0.4, side * 5.4);
        wing.rotation.y = side * 0.5; // cropped-delta sweep
        g.add(wing);
        const stab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 5), mat);
        stab.position.set(-10, -0.2, side * 3.2);
        stab.rotation.y = side * 0.45;
        g.add(stab);
      }
      const fin = new THREE.Mesh(new THREE.BoxGeometry(5, 6.5, 0.6), mat);
      fin.position.set(-8.5, 3.4, 0);
      fin.rotation.z = 0.42; // raked back
      g.add(fin);
      // Engine nozzle the afterburner glow hangs off.
      const nozzleGeo = new THREE.CylinderGeometry(1.5, 1.2, 3, 8);
      nozzleGeo.rotateZ(-Math.PI / 2);
      const nozzle = new THREE.Mesh(nozzleGeo, mat);
      nozzle.position.x = -12;
      g.add(nozzle);
      g.visible = false;
      g.userData.mat = mat;
      g.traverse((o) => (o.frustumCulled = false));
      this.scene.add(g);
      this.jetMeshes.push(g);
    }
  }

  /** Soft vertical streaks; scrolled around the dome to read as an energy shimmer. */
  _shimmerTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#101010'; // faint uniform base (additive)
    g.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 7; i++) {
      const x = Math.random() * 256;
      const w = 16 + Math.random() * 30;
      const a = 0.35 + Math.random() * 0.4;
      const grad = g.createLinearGradient(x - w, 0, x + w, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, `rgba(255,255,255,${a})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(x - w, 0, w * 2, 128);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  _buildShieldMeshes() {
    // Subtle shimmering half-dome over shielded structures: a top hemisphere
    // (open at the bottom) sitting on the ground.
    this._shieldGeo = new THREE.SphereGeometry(
      CONFIG.shield.radius, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2
    );
    this._shieldTex = this._shimmerTexture();
    this.shieldMeshes = [];
    const count = CONFIG.cityCount + CONFIG.turretCount;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: COL.shield,
        map: this._shieldTex,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this._shieldGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.shieldMeshes.push(mesh);
    }
  }

  /**
   * Pooled explosion visuals: each slot is a billboard fireball flash (sprite)
   * plus a shader-driven overpressure shockwave on the action plane. The game
   * pushes short-lived {x, y, age, dur, maxR, color} events; we animate them.
   */
  _buildExplosionPool() {
    // Unit quad: the ripple travels INSIDE it via the shader's uProg, so the
    // mesh itself never rescales mid-burst — the wavefront just races out,
    // thinning and softening like a real over-pressure wave.
    this._shockGeo = new THREE.PlaneGeometry(2, 2);
    const shockVert = `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`;
    const shockFrag = `
      uniform float uProg;  // wavefront position, 0..1 of the blast radius
      uniform float uFade;  // overall envelope, 1 -> 0 over the burst
      uniform vec3 uColor;  // kill-type tint (applied lightly)
      varying vec2 vP;
      void main() {
        float r = length(vP);
        // Compression front: a thin gaussian band that widens and softens as
        // it travels outward.
        float w = 0.06 + 0.13 * uProg;
        float d = (r - uProg) / w;
        float front = exp(-d * d);
        // Faint trailing ripple — the reflected/secondary pulse.
        float d2 = (r - uProg * 0.6) / (w * 2.2);
        float trail = exp(-d2 * d2) * 0.28;
        // Interior heat-haze that empties out behind the wave.
        float haze = smoothstep(uProg, uProg * 0.15, r) * 0.12 * (1.0 - uProg);
        float a = (front + trail + haze) * uFade * step(r, 1.0);
        // Clearly tinted by the kill color, with a white-hot leading edge so
        // it still reads as a pressure wave rather than flat pigment.
        vec3 col = mix(uColor, vec3(1.0), front * 0.45);
        gl_FragColor = vec4(col * a, a);
      }`;
    this.explosionPool = [];
    for (let i = 0; i < R.maxExplosions; i++) {
      const flashMat = new THREE.SpriteMaterial({
        map: this._dotTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const flash = new THREE.Sprite(flashMat);
      flash.visible = false;
      // Hot white core inside the colored flash, so the centre blows out.
      const coreMat = flashMat.clone();
      coreMat.color.set(0xffffff);
      const core = new THREE.Sprite(coreMat);
      core.visible = false;
      const shockMat = new THREE.ShaderMaterial({
        uniforms: {
          uProg: { value: 0 },
          uFade: { value: 0 },
          uColor: { value: new THREE.Color(1, 1, 1) },
        },
        vertexShader: shockVert,
        fragmentShader: shockFrag,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const shock = new THREE.Mesh(this._shockGeo, shockMat);
      shock.visible = false;
      shock.frustumCulled = false;
      this.scene.add(flash, core, shock);
      this.explosionPool.push({ flash, flashMat, core, coreMat, shock, shockMat });
    }
  }

  _updateExplosions(game) {
    const fireball = this.baseColor(COL.fireball);
    let i = 0;
    for (const e of game.explosions) {
      if (i >= this.explosionPool.length) break;
      const slot = this.explosionPool[i++];
      const k = Math.min(1, e.age / e.dur);
      const ease = 1 - Math.pow(1 - k, 3); // fast start, soft finish
      const x = this.wx(e.x);
      const y = this.wy(e.y);
      const c = this.baseColor(e.color);

      // Fireball: balloons quickly, tinted toward hot orange, fades as it grows.
      const flashR = e.maxR * (0.4 + 0.5 * ease);
      slot.flash.visible = true;
      slot.flash.position.set(x, y, 4);
      slot.flash.scale.set(flashR * 2, flashR * 2, 1);
      slot.flashMat.color.copy(c).lerp(fireball, 0.35);
      slot.flashMat.opacity = Math.pow(1 - k, 1.6);

      // White-hot core: smaller and dies much faster than the fireball.
      slot.core.visible = k < 0.3;
      if (slot.core.visible) {
        const coreR = flashR * 0.3;
        slot.core.position.set(x, y, 5);
        slot.core.scale.set(coreR * 2, coreR * 2, 1);
        slot.coreMat.opacity = Math.pow(1 - k / 0.3, 2) * 0.85;
      }

      // Overpressure wave: the quad spans the blast radius exactly; the
      // ripple's wavefront travels through it via uProg and peaks at maxR.
      slot.shock.visible = true;
      slot.shock.position.set(x, y, 3);
      slot.shock.scale.set(e.maxR, e.maxR, 1);
      slot.shockMat.uniforms.uProg.value = ease;
      slot.shockMat.uniforms.uFade.value = Math.pow(1 - k, 1.1) * 0.9;
      slot.shockMat.uniforms.uColor.value.copy(c);
    }
    for (; i < this.explosionPool.length; i++) {
      const slot = this.explosionPool[i];
      slot.flash.visible = slot.core.visible = slot.shock.visible = false;
    }
  }

  _buildInterceptorMeshes() {
    // Friendly homing missiles: a small bright-blue cone, nose along velocity.
    this._interceptorGeo = new THREE.ConeGeometry(4, 16, 10);
    this.interceptorMeshes = [];
    for (let i = 0; i < R.maxInterceptors; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL.interceptor,
        emissive: COL.interceptor,
        emissiveIntensity: 1.3,
        roughness: 0.35,
        metalness: 0.4,
      });
      const mesh = new THREE.Mesh(this._interceptorGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.interceptorMeshes.push(mesh);
    }
  }

  /**
   * Distinct airframes for the side-entrants (nose along +X; each slot keeps
   * one shared material so type colour / hit flashes are per-slot tints):
   *   drone  — small fixed-wing UAV: fuselage, broad main wing, tail fin.
   *   cruise — Tomahawk-style: tube body, nose cone, pop-out wings, tail.
   */
  _buildSideEntrantMeshes() {
    const makeMat = () =>
      new THREE.MeshStandardMaterial({
        color: COL.missileDrone,
        emissive: COL.missileDrone,
        emissiveIntensity: 0.9,
        roughness: 0.4,
        metalness: 0.4,
      });

    this.droneMeshes = [];
    for (let i = 0; i < 24; i++) {
      const mat = makeMat();
      const g = new THREE.Group();
      const fuselage = new THREE.Mesh(new THREE.BoxGeometry(9, 2.4, 2.4), mat);
      g.add(fuselage);
      const noseGeo = new THREE.ConeGeometry(1.2, 3, 6);
      noseGeo.rotateZ(-Math.PI / 2);
      const nose = new THREE.Mesh(noseGeo, mat);
      nose.position.x = 6;
      g.add(nose);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.5, 16), mat);
      wing.position.x = 0.5;
      g.add(wing);
      const tailWing = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 7), mat);
      tailWing.position.x = -4;
      g.add(tailWing);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.2, 0.5), mat);
      fin.position.set(-4, 1.8, 0);
      g.add(fin);
      g.visible = false;
      g.userData.mat = mat;
      g.traverse((o) => (o.frustumCulled = false));
      this.scene.add(g);
      this.droneMeshes.push(g);
    }

    // Bomber: an Su-27-style strike fighter — long slim fuselage, drooped
    // nose, canopy hump, swept wings, stabilators, twin engine nacelles and
    // twin canted tail fins.
    this.bomberMeshes = [];
    for (let i = 0; i < 6; i++) {
      const mat = makeMat();
      const g = new THREE.Group();
      const fuselage = new THREE.Mesh(new THREE.BoxGeometry(30, 3.6, 4.4), mat);
      g.add(fuselage);
      const noseGeo = new THREE.ConeGeometry(1.8, 9, 8);
      noseGeo.rotateZ(-Math.PI / 2);
      const nose = new THREE.Mesh(noseGeo, mat);
      nose.position.set(19, -0.5, 0); // characteristic drooped radome
      nose.rotation.z = -0.06;
      g.add(nose);
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(5, 1.8, 2.6), mat);
      canopy.position.set(9, 2.4, 0);
      g.add(canopy);
      // Swept main wings (two halves, raked back).
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.7, 14), mat);
        wing.position.set(-2, -0.6, side * 7.5);
        wing.rotation.y = side * 0.55; // sweep
        g.add(wing);
        const stab = new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, 7.5), mat);
        stab.position.set(-14, -0.4, side * 4.6);
        stab.rotation.y = side * 0.45;
        g.add(stab);
        // Twin tails, slightly canted outward like the real thing.
        const fin = new THREE.Mesh(new THREE.BoxGeometry(6, 7.5, 0.7), mat);
        fin.position.set(-12, 3.6, side * 2.8);
        fin.rotation.x = side * 0.18;
        fin.rotation.z = 0.35; // raked back
        g.add(fin);
        // Underslung engine nacelle.
        const nacGeo = new THREE.CylinderGeometry(1.7, 1.5, 9, 8);
        nacGeo.rotateZ(-Math.PI / 2);
        const nacelle = new THREE.Mesh(nacGeo, mat);
        nacelle.position.set(-11, -1.6, side * 2.4);
        g.add(nacelle);
      }
      g.visible = false;
      g.userData.mat = mat;
      g.traverse((o) => (o.frustumCulled = false));
      this.scene.add(g);
      this.bomberMeshes.push(g);
    }

    this.cruiseMeshes = [];
    for (let i = 0; i < 12; i++) {
      const mat = makeMat();
      const g = new THREE.Group();
      const bodyGeo = new THREE.CylinderGeometry(1.9, 1.9, 15, 10);
      bodyGeo.rotateZ(-Math.PI / 2);
      g.add(new THREE.Mesh(bodyGeo, mat));
      const noseGeo = new THREE.ConeGeometry(1.9, 5, 10);
      noseGeo.rotateZ(-Math.PI / 2);
      const nose = new THREE.Mesh(noseGeo, mat);
      nose.position.x = 10;
      g.add(nose);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.45, 12), mat);
      wing.position.x = 1.5;
      g.add(wing);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 6.5), mat);
      tail.position.x = -6;
      g.add(tail);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3, 0.45), mat);
      fin.position.set(-6, 1.5, 0);
      g.add(fin);
      g.visible = false;
      g.userData.mat = mat;
      g.traverse((o) => (o.frustumCulled = false));
      this.scene.add(g);
      this.cruiseMeshes.push(g);
    }
  }

  _buildMissileMeshes() {
    // Slender cone = reentry vehicle / warhead; the apex (+Y) is the nose, which
    // we point along the direction of travel each frame.
    this._coneGeo = new THREE.ConeGeometry(5.5, 24, 14);
    this.missileMeshes = [];
    for (let i = 0; i < R.maxMissiles; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL.missile,
        emissive: COL.missile,
        emissiveIntensity: 1.15,
        roughness: 0.4,
        metalness: 0.35,
      });
      const mesh = new THREE.Mesh(this._coneGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.missileMeshes.push(mesh);
    }
  }

  _buildComposer() {
    this.composer = new EffectComposer(this.three);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.clientW, this.clientH),
      R.bloom.strength,
      R.bloom.radius,
      R.bloom.threshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  // -- structures (built per game) -----------------------------------------
  _disposeGroup(group) {
    this.scene.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  syncStructures(game) {
    for (const g of this.cityGroups) this._disposeGroup(g);
    for (const g of this.turretGroups) this._disposeGroup(g);
    this.cityGroups = [];
    this.turretGroups = [];

    for (const city of game.cities) this.cityGroups.push(this._buildCity(city));
    for (const t of game.turrets) this.turretGroups.push(this._buildTurret(t));
    this.built = true;
  }

  /** Crisp grid of randomly lit windows, used as each tower's emissive map. */
  _windowTexture(seed) {
    this._windowTexCache = this._windowTexCache || [];
    if (this._windowTexCache[seed]) return this._windowTexCache[seed];
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 32, 64);
    for (let y = 3; y < 60; y += 6) {
      for (let x = 3; x < 29; x += 6) {
        if (Math.random() < 0.62) {
          g.fillStyle = `rgba(255,255,255,${0.45 + Math.random() * 0.55})`;
          g.fillRect(x, y, 3, 3);
        }
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    this._windowTexCache[seed] = tex;
    return tex;
  }

  _buildCity(city) {
    const group = new THREE.Group();
    const meshes = [];
    const body = new THREE.Color(COL.city).multiplyScalar(0.3);
    for (const b of city.buildings) {
      const mat = new THREE.MeshStandardMaterial({
        color: body,
        emissive: COL.city,
        emissiveMap: this._windowTexture(Math.floor(Math.random() * 5)),
        emissiveIntensity: 1.0,
        roughness: 0.55,
        metalness: 0.15,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, 9), mat);
      mesh.position.set(b.x, b.h / 2, b.z || 0);
      mesh.userData.h = b.h;
      // Rooftop details ride along as children so collapse squashes them too.
      if (b.spire) {
        const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 9, 5), mat);
        spire.position.y = b.h / 2 + 4.5;
        mesh.add(spire);
      } else if (b.roof) {
        const plant = new THREE.Mesh(new THREE.BoxGeometry(b.w * 0.45, 2.6, 4), mat);
        plant.position.y = b.h / 2 + 1.3;
        mesh.add(plant);
      }
      group.add(mesh);
      meshes.push(mesh);
    }
    group.userData.meshes = meshes;
    group.userData.body = body;
    this.scene.add(group);
    return group;
  }

  /**
   * Phalanx-style CIWS mount: stepped platform, ammo drum, boxy gun house
   * with a white search-radome on top, and an elevating six-barrel gatling
   * cluster that visibly spins up while firing.
   */
  _buildTurret(turret) {
    const t = CONFIG.turret;
    const group = new THREE.Group();
    const steel = (color, glow = 0.12, rough = 0.45, metal = 0.7) =>
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: glow,
        roughness: rough,
        metalness: metal,
      });

    // Stepped platform + pedestal drum.
    const baseMat = steel(COL.turret, 0.15);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(t.baseRadius * 2.7, 5, 30), baseMat);
    plinth.position.y = 2.5;
    group.add(plinth);
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(t.baseRadius * 0.62, t.baseRadius * 0.86, 11, 16),
      baseMat
    );
    pedestal.position.y = 10.5;
    group.add(pedestal);

    // Ammo drum slung on the side of the pedestal.
    const drumGeo = new THREE.CylinderGeometry(5, 5, 9, 12);
    drumGeo.rotateZ(Math.PI / 2);
    const drum = new THREE.Mesh(drumGeo, steel(COL.barrel, 0.1));
    drum.position.set(-t.baseRadius * 0.85, 9, 0);
    group.add(drum);

    // Gun house with the white radome on top (fixed; only the gun elevates).
    const housingMat = steel(COL.turret, 0.15);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(15, 12, 11), housingMat);
    housing.position.set(-3, t.pivotHeight, 0);
    group.add(housing);
    const radomeMat = steel('#dde6f2', 0.3, 0.25, 0.1);
    const radome = new THREE.Mesh(new THREE.SphereGeometry(6.5, 18, 14), radomeMat);
    radome.position.set(-3, t.pivotHeight + 9, 0);
    radome.scale.y = 1.15;
    group.add(radome);

    // Elevating pivot at the trunnion, holding the spinning barrel cluster.
    const pivot = new THREE.Object3D();
    pivot.position.y = t.pivotHeight;
    group.add(pivot);

    const clusterMat = steel(COL.barrel, 0.2, 0.35, 0.8);
    const makeCluster = () => {
      const cluster = new THREE.Group();
      const breech = new THREE.Mesh(new THREE.BoxGeometry(9, 8.5, 8.5), clusterMat);
      breech.position.x = 1.5;
      cluster.add(breech);
      const shaftGeo = new THREE.CylinderGeometry(2.1, 2.1, t.barrelLength, 8);
      shaftGeo.rotateZ(-Math.PI / 2);
      shaftGeo.translate(t.barrelLength / 2 + 4, 0, 0);
      cluster.add(new THREE.Mesh(shaftGeo, clusterMat));
      const barrelGeo = new THREE.CylinderGeometry(1.0, 1.2, t.barrelLength, 6);
      barrelGeo.rotateZ(-Math.PI / 2);
      barrelGeo.translate(t.barrelLength / 2 + 4, 0, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const b = new THREE.Mesh(barrelGeo, clusterMat);
        b.position.set(0, Math.cos(a) * 3.4, Math.sin(a) * 3.4);
        cluster.add(b);
      }
      // Muzzle clamp ring holding the barrel ends together.
      const ringGeo = new THREE.CylinderGeometry(4.6, 4.6, 2.4, 12);
      ringGeo.rotateZ(-Math.PI / 2);
      const ring = new THREE.Mesh(ringGeo, clusterMat);
      ring.position.x = t.barrelLength + 2;
      cluster.add(ring);
      return cluster;
    };
    const cluster = makeCluster();
    pivot.add(cluster);

    const flashMat = new THREE.MeshBasicMaterial({
      color: COL.bullet,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      map: this._dotTexture(),
    });
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), flashMat);
    flash.position.x = t.barrelLength + 6;
    flash.visible = false;
    pivot.add(flash);

    // Laser emplacement, left of the mount (hidden until bought): a squat
    // pedestal carrying a trainable emitter head — a barrel with a focusing
    // ring that physically slews onto targets, and a glowing capacitor orb
    // behind it that brightens as the charge builds.
    const L = CONFIG.laser;
    const laserGroup = new THREE.Group();
    laserGroup.position.x = L.offsetX;
    const lBase = new THREE.Mesh(new THREE.BoxGeometry(18, 7, 16), baseMat);
    lBase.position.y = 3.5;
    laserGroup.add(lBase);
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(2, 2.8, L.emitterHeight - 7, 8),
      steel(COL.barrel, 0.12)
    );
    mast.position.y = 7 + (L.emitterHeight - 7) / 2 - 2;
    laserGroup.add(mast);
    const laserPivot = new THREE.Object3D();
    laserPivot.position.y = L.emitterHeight;
    laserGroup.add(laserPivot);
    const orbMat = steel(COL.laser, 0.3, 0.3, 0.2);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(3.6, 14, 10), orbMat);
    orb.position.x = -2;
    laserPivot.add(orb);
    const lBarrelGeo = new THREE.CylinderGeometry(1.5, 2.1, L.barrelLength, 8);
    lBarrelGeo.rotateZ(-Math.PI / 2);
    lBarrelGeo.translate(L.barrelLength / 2, 0, 0);
    laserPivot.add(new THREE.Mesh(lBarrelGeo, steel(COL.barrel, 0.15)));
    const focusGeo = new THREE.CylinderGeometry(2.8, 2.8, 1.6, 10);
    focusGeo.rotateZ(-Math.PI / 2);
    const focusRing = new THREE.Mesh(focusGeo, orbMat);
    focusRing.position.x = L.barrelLength - 1;
    laserPivot.add(focusRing);
    laserGroup.visible = false;
    group.add(laserGroup);

    // Interceptor launcher, right of the mount: a THAAD-style truck — cab,
    // flatbed on wheels, and an erected launch pod pointing skyward with the
    // next missile's tip poking out whenever a launch is ready.
    const launcherGroup = new THREE.Group();
    launcherGroup.position.x = CONFIG.interceptor.launcherOffsetX;
    const truckMat = steel(COL.turret, 0.12);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(26, 3, 9), truckMat);
    bed.position.set(5, 6, 0);
    launcherGroup.add(bed);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(6.5, 6.5, 8.5), truckMat);
    cab.position.set(14.5, 10.5, 0);
    launcherGroup.add(cab);
    const wheelGeo = new THREE.CylinderGeometry(2.5, 2.5, 2, 10);
    wheelGeo.rotateX(Math.PI / 2);
    const wheelMat = steel('#3a4252', 0.05, 0.8, 0.3);
    for (const wx of [-4, 3, 13]) {
      for (const wz of [-3.4, 3.4]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(wx, 2.5, wz);
        launcherGroup.add(wheel);
      }
    }
    // Erected pod (very slightly canted, like an emplaced battery).
    const pod = new THREE.Mesh(new THREE.BoxGeometry(9, 24, 9), steel(COL.barrel, 0.12));
    pod.position.set(-2, 19.5, 0);
    pod.rotation.z = 0.05;
    launcherGroup.add(pod);
    const missileMat = steel(COL.interceptor, 0.9, 0.35, 0.4);
    const readyMissile = new THREE.Mesh(new THREE.ConeGeometry(2.4, 10, 10), missileMat);
    readyMissile.position.set(-3.2, 34, 0); // vertical: launches straight up
    launcherGroup.add(readyMissile);
    group.add(launcherGroup);

    group.userData = {
      baseMat,
      housingMat,
      radomeMat,
      clusterMat,
      pivot,
      cluster,
      flash,
      flashMat,
      laserGroup,
      laserPivot,
      orbMat,
      launcherGroup,
      readyMissile,
      spin: 0,
      spinVel: 0,
      lastT: 0,
    };
    this.scene.add(group);
    return group;
  }

  // -- per-frame structure updates -----------------------------------------
  _updateStructures(game) {
    for (let i = 0; i < this.cityGroups.length; i++) {
      const group = this.cityGroups[i];
      const city = game.cities[i];
      if (!group || !city) continue;
      group.position.set(this.wx(city.x), 0, 0);
      for (const mesh of group.userData.meshes) {
        if (city.alive) {
          mesh.material.emissive.set(COL.city);
          mesh.material.color.copy(group.userData.body);
          mesh.material.emissiveIntensity = 1.0;
          mesh.scale.y = 1;
          mesh.position.y = mesh.userData.h / 2;
        } else {
          mesh.material.emissive.set(0x000000);
          mesh.material.color.set(COL.cityDead);
          mesh.scale.y = 0.16;
          mesh.position.y = (mesh.userData.h * 0.16) / 2;
        }
      }
    }

    for (let i = 0; i < this.turretGroups.length; i++) {
      const group = this.turretGroups[i];
      const turret = game.turrets[i];
      if (!group || !turret) continue;
      const ud = group.userData;
      group.position.set(this.wx(turret.x), 0, 0);

      const active = turret === game.activeTurret;
      const dt = Math.max(0, Math.min(0.1, game.time - ud.lastT));
      ud.lastT = game.time;
      if (!turret.alive) {
        ud.baseMat.color.set(COL.cityDead);
        ud.baseMat.emissive.set(0x000000);
        ud.housingMat.color.set(COL.cityDead);
        ud.housingMat.emissive.set(0x000000);
        ud.pivot.visible = false;
        ud.laserGroup.visible = false;
        ud.launcherGroup.visible = false;
      } else {
        ud.pivot.visible = true;
        const accent = active ? COL.turretActive : COL.turret;
        ud.housingMat.color.set(accent);
        ud.housingMat.emissive.set(accent);
        ud.housingMat.emissiveIntensity = active ? 0.45 : 0.15;
        ud.radomeMat.emissiveIntensity = active ? 0.55 : 0.3;

        ud.clusterMat.color.set(active ? COL.turretActive : COL.barrel);
        ud.clusterMat.emissive.set(active ? COL.turretActive : COL.barrel);
        ud.clusterMat.emissiveIntensity = active ? 0.45 : 0.2;

        ud.pivot.rotation.z = -turret.angle;

        // Gatling spin: winds up while rounds are going out, coasts back down.
        const firing = turret.muzzleFlash > 0.2;
        const targetVel = firing ? 28 : 0;
        ud.spinVel += (targetVel - ud.spinVel) * Math.min(1, dt * 6);
        ud.spin += ud.spinVel * dt;

        ud.cluster.position.set(-turret.recoil, 0, 0); // recoil kicks the gun back
        ud.cluster.rotation.x = ud.spin;

        ud.flash.visible = turret.muzzleFlash > 0;
        if (turret.muzzleFlash > 0) {
          const s = 0.5 + turret.muzzleFlash;
          ud.flash.scale.set(s, s, s);
          ud.flashMat.opacity = Math.min(1, turret.muzzleFlash);
        }

        // Laser emplacement appears once bought; the head tracks the weapon's
        // live aim and the capacitor orb brightens with charge (hot while firing).
        ud.laserGroup.visible = !!(game.laser && game.laser.owned);
        if (ud.laserGroup.visible) {
          ud.laserPivot.rotation.z = -game.laser.angle;
          ud.orbMat.emissiveIntensity = game.laser.burning
            ? 2.2
            : 0.25 + game.laser.chargeFrac * 1.3;
        }
        // Launcher truck appears once bought; the ready missile's tip shows
        // whenever a launch is up.
        ud.launcherGroup.visible = !!(
          game.interceptorWeapon && game.interceptorWeapon.owned
        );
        ud.readyMissile.visible = !!(
          game.interceptorWeapon && game.interceptorWeapon.canLaunch
        );
      }
    }
  }

  // -- per-frame dynamic updates -------------------------------------------
  _updateParticles(game) {
    const sparks = this.sparkCloud;
    const smoke = this.smokeCloud;
    let si = 0;
    let mi = 0;
    for (const p of game.particles) {
      const lifeFrac = Math.max(0, p.life / p.maxLife);
      const c = this.baseColor(p.color);
      if (p.kind === 'smoke') {
        if (mi >= smoke.max) continue;
        const o = mi * 3;
        smoke.pos[o] = this.wx(p.x);
        smoke.pos[o + 1] = this.wy(p.y);
        smoke.pos[o + 2] = 6; // in front of trails so it occludes the glow
        smoke.col[o] = c.r;
        smoke.col[o + 1] = c.g;
        smoke.col[o + 2] = c.b;
        // Puffs swell as they thin out.
        smoke.size[mi] = p.size * (1 + (1 - lifeFrac) * 1.8);
        smoke.alpha[mi] = 0.4 * lifeFrac;
        mi++;
      } else {
        if (si >= sparks.max) continue;
        const o = si * 3;
        sparks.pos[o] = this.wx(p.x);
        sparks.pos[o + 1] = this.wy(p.y);
        sparks.pos[o + 2] = 0;
        // Embers cool from white-hot toward their base colour as they age.
        const heat = p.kind === 'ember' ? Math.pow(lifeFrac, 2) * 0.7 : 0.15 * lifeFrac;
        sparks.col[o] = c.r + (1 - c.r) * heat;
        sparks.col[o + 1] = c.g + (1 - c.g) * heat;
        sparks.col[o + 2] = c.b + (1 - c.b) * heat;
        sparks.size[si] = p.size;
        sparks.alpha[si] = lifeFrac;
        si++;
      }
    }
    sparks.setCount(si);
    smoke.setCount(mi);
  }

  /** Queue one glow point (hot exhaust / plasma) for this frame. */
  _pushGlow(x, y, color, size, alpha) {
    const g = this.glowCloud;
    const i = this._glowCount;
    if (i >= g.max) return;
    const o = i * 3;
    g.pos[o] = x;
    g.pos[o + 1] = y;
    g.pos[o + 2] = 1;
    g.col[o] = color.r;
    g.col[o + 1] = color.g;
    g.col[o + 2] = color.b;
    g.size[i] = size;
    g.alpha[i] = alpha;
    this._glowCount = i + 1;
  }

  _updateMissiles(game) {
    const trails = this.missileTrailSys;
    let coneI = 0;
    let droneI = 0;
    let cruiseI = 0;
    let bomberI = 0;
    let seg = 0;
    for (const m of game.missiles) {
      if (m.stealthed) continue; // cloaked: no mesh, no trail, no glow
      const sideEntrant =
        m.type === 'drone' ||
        m.type === 'cruise' ||
        m.type === 'stealth' ||
        m.type === 'bomber';
      // Air-breathers and unpowered glide bombs leave no reentry trail.
      const noTrail = sideEntrant || m.type === 'glidebomb';
      // Colour by variant; ballistic types also scale their shared RV cone.
      let colStr = COL.missile;
      let sx = 1;
      let sy = 1;
      let sz = 1;
      if (m.splitsRemaining > 0) {
        colStr = COL.missileMirv;
        sx = sy = sz = CONFIG.missile.mirvScale;
      } else if (m.type === 'evasive') {
        colStr = COL.missileEvasive;
      } else if (m.type === 'hypersonic') {
        colStr = COL.missileHypersonic;
        sx = sz = 0.6; // thin
        sy = 1.6; // long nose -> sleek dart
      } else if (m.type === 'cruise') {
        colStr = COL.missileCruise;
      } else if (m.type === 'stealth') {
        colStr = COL.missileStealth;
      } else if (m.type === 'drone') {
        colStr = COL.missileDrone;
      } else if (m.type === 'bomber') {
        colStr = COL.missileBomber;
      } else if (m.type === 'glidebomb') {
        colStr = COL.missileGlidebomb;
        sx = sz = 0.7;
        sy = 0.85; // stubby finned bomb
      } else if (m.type === 'nuke') {
        colStr = COL.missileNuke;
        // A warhead released by a MIRV nuke is the same shape, much smaller.
        const s = m.subnuke ? CONFIG.missile.mirvNuke.childScale : CONFIG.missile.nuke.scale;
        sx = sz = s;
        sy = s * 1.15; // a huge, unmistakable bus
      } else if (m.type === 'mirvnuke') {
        colStr = COL.missileMirvNuke;
        sx = sz = CONFIG.missile.mirvNuke.scale;
        sy = CONFIG.missile.mirvNuke.scale * 1.2; // long, fast and wrong-coloured
      }
      const c = this.baseColor(colStr);

      // Pick the airframe: UAV model, cruise airframe, or the shared RV cone.
      let mesh = null;
      let mat = null;
      if (m.type === 'drone') {
        if (droneI < this.droneMeshes.length) mesh = this.droneMeshes[droneI++];
        if (mesh) mat = mesh.userData.mat;
      } else if (m.type === 'bomber') {
        if (bomberI < this.bomberMeshes.length) mesh = this.bomberMeshes[bomberI++];
        if (mesh) mat = mesh.userData.mat;
      } else if (m.type === 'cruise' || m.type === 'stealth') {
        if (cruiseI < this.cruiseMeshes.length) mesh = this.cruiseMeshes[cruiseI++];
        if (mesh) mat = mesh.userData.mat;
      } else if (coneI < this.missileMeshes.length) {
        mesh = this.missileMeshes[coneI++];
        mat = mesh.material;
      }
      if (mesh) {
        mesh.visible = true;
        mesh.position.set(this.wx(m.x), this.wy(m.y), 0);
        mesh.scale.set(sx, sy, sz);
        // Point the nose along the instantaneous heading (world dir = hx, -hy)
        // — RV cones point +Y, the airframe models point +X. A left-flying
        // airframe would come out inverted from the z-rotation alone, so
        // mirror it vertically to keep canopies and fins skyward.
        const heading = Math.atan2(-m.hy, m.hx);
        mesh.rotation.z = sideEntrant ? heading : heading - Math.PI / 2;
        if (sideEntrant && m.hx < 0) mesh.scale.y = -sy;
        if (m.hitFlash > 0) {
          mat.color.set(0xffffff);
          mat.emissive.set(0xffffff);
          mat.emissiveIntensity = 2.8;
        } else {
          mat.color.copy(c);
          mat.emissive.copy(c);
          mat.emissiveIntensity = sideEntrant ? 0.8 : 1.15;
        }
        // Flickering reentry-plasma glow at the head; hypersonics burn hotter,
        // nukes throb with a slow, ominous pulse. Side-entrants get just a
        // small engine light.
        const nukeLike = m.type === 'nuke' || m.type === 'mirvnuke';
        const flick = nukeLike
          ? 0.75 + 0.25 * Math.sin(game.time * 4 + m.id)
          : 0.8 + 0.2 * Math.sin(game.time * 31 + m.id * 5.1);
        const glowBase =
          m.type === 'hypersonic'
            ? 30
            : nukeLike
            ? 26
            : m.type === 'bomber'
            ? 16 // twin afterburners on a big airframe
            : sideEntrant
            ? 10
            : 20;
        this._pushGlow(this.wx(m.x), this.wy(m.y), c, glowBase * sy * flick, 0.55 * flick);
      }
      // Trail: stored points, then one extra segment to the live head — drawn
      // as THREE layers (a white-hot core and two soft fringes offset
      // perpendicular to the path) so the plume reads as a volumetric column
      // that flares wider toward the tail, instead of a 1px line.
      if (noTrail) continue;
      const pts = m.trail;
      const n = pts.length; // points; head is the (n)th implicit point
      for (let k = 0; k < n && seg + 3 <= trails.maxSeg; k++) {
        const a = pts[k];
        const b = k + 1 < n ? pts[k + 1] : m; // last segment goes to head
        const fa = 0.12 + 0.88 * (k / n);
        const fb = 0.12 + 0.88 * ((k + 1) / n);
        const ha = Math.pow(k / n, 4) * 0.85; // heat: ~0 along the tail, hot at the head
        const hb = Math.pow((k + 1) / n, 4) * 0.85;
        const ax = this.wx(a.x);
        const ay = this.wy(a.y);
        const bx = this.wx(b.x);
        const by = this.wy(b.y);
        // Per-segment perpendicular; older segments spread wider (the plume
        // expands as it cools).
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const spread = 1 + (1 - k / n) * 2.2;
        const px = (-dy / len) * spread;
        const py = (dx / len) * spread;
        for (const [ox, oy, gain] of [
          [0, 0, 0.8],
          [px, py, 0.3],
          [-px, -py, 0.3],
        ]) {
          const v = seg * 6;
          trails.pos[v] = ax + ox;
          trails.pos[v + 1] = ay + oy;
          trails.pos[v + 2] = 0;
          trails.pos[v + 3] = bx + ox;
          trails.pos[v + 4] = by + oy;
          trails.pos[v + 5] = 0;
          trails.col[v] = (c.r + (1 - c.r) * ha) * fa * gain;
          trails.col[v + 1] = (c.g + (1 - c.g) * ha) * fa * gain;
          trails.col[v + 2] = (c.b + (1 - c.b) * ha) * fa * gain;
          trails.col[v + 3] = (c.r + (1 - c.r) * hb) * fb * gain;
          trails.col[v + 4] = (c.g + (1 - c.g) * hb) * fb * gain;
          trails.col[v + 5] = (c.b + (1 - c.b) * hb) * fb * gain;
          seg++;
        }
      }
    }
    for (let k = coneI; k < this.missileMeshes.length; k++) {
      this.missileMeshes[k].visible = false;
    }
    for (let k = droneI; k < this.droneMeshes.length; k++) {
      this.droneMeshes[k].visible = false;
    }
    for (let k = bomberI; k < this.bomberMeshes.length; k++) {
      this.bomberMeshes[k].visible = false;
    }
    for (let k = cruiseI; k < this.cruiseMeshes.length; k++) {
      this.cruiseMeshes[k].visible = false;
    }
    trails.setCount(seg);
  }

  _updateInterceptors(game) {
    const trails = this.interceptorTrailSys;
    const c = this.baseColor(COL.interceptor);
    let i = 0;
    let seg = 0;
    for (const it of game.interceptorList) {
      if (i < this.interceptorMeshes.length) {
        const mesh = this.interceptorMeshes[i];
        mesh.visible = true;
        mesh.position.set(this.wx(it.x), this.wy(it.y), 0);
        mesh.rotation.z = Math.atan2(-it.vy, it.vx) - Math.PI / 2;
        mesh.material.emissiveIntensity = it.boosting ? 2.6 : 1.0; // boost flame
        const flick = 0.75 + 0.25 * Math.sin(game.time * 47 + i * 3.7);
        if (it.boosting) {
          // Solid-motor burn: a white-hot point right at the nozzle and a
          // bigger orange flame licking out behind it (the game also streams
          // diffusing white smoke particles from the same spot).
          const sp = Math.hypot(it.vx, it.vy) || 1;
          const ux = it.vx / sp;
          const uy = it.vy / sp;
          const hot = this.baseColor('#fff6e0');
          const flame = this.baseColor('#ffae5c');
          this._pushGlow(
            this.wx(it.x - ux * 8),
            this.wy(it.y - uy * 8),
            hot,
            16 * flick,
            0.95 * flick
          );
          this._pushGlow(
            this.wx(it.x - ux * 16),
            this.wy(it.y - uy * 16),
            flame,
            30 * flick,
            0.7 * flick
          );
        } else {
          // Coasting: just a faint coal at the nozzle.
          this._pushGlow(this.wx(it.x), this.wy(it.y), c, 14 * flick, 0.35 * flick);
        }
        i++;
      }
      const pts = it.trail;
      const n = pts.length;
      for (let k = 0; k < n && seg < trails.maxSeg; k++) {
        const a = pts[k];
        const b = k + 1 < n ? pts[k + 1] : it;
        const fa = 0.12 + 0.88 * (k / n);
        const fb = 0.12 + 0.88 * ((k + 1) / n);
        const v = seg * 6;
        trails.pos[v] = this.wx(a.x);
        trails.pos[v + 1] = this.wy(a.y);
        trails.pos[v + 2] = 0;
        trails.pos[v + 3] = this.wx(b.x);
        trails.pos[v + 4] = this.wy(b.y);
        trails.pos[v + 5] = 0;
        trails.col[v] = c.r * fa;
        trails.col[v + 1] = c.g * fa;
        trails.col[v + 2] = c.b * fa;
        trails.col[v + 3] = c.r * fb;
        trails.col[v + 4] = c.g * fb;
        trails.col[v + 5] = c.b * fb;
        seg++;
      }
    }
    for (let k = i; k < this.interceptorMeshes.length; k++) {
      this.interceptorMeshes[k].visible = false;
    }
    trails.setCount(seg);
  }

  /** AAMs: the interceptor treatment at two-thirds scale in mint. */
  _updateAAMs(game) {
    const trails = this.aamTrailSys;
    const c = this.baseColor(COL.aam);
    let i = 0;
    let seg = 0;
    for (const it of game.aamList || []) {
      if (i < this.aamMeshes.length) {
        const mesh = this.aamMeshes[i];
        mesh.visible = true;
        mesh.position.set(this.wx(it.x), this.wy(it.y), 0);
        mesh.rotation.z = Math.atan2(-it.vy, it.vx) - Math.PI / 2;
        mesh.material.emissiveIntensity = it.boosting ? 2.4 : 1.0;
        const flick = 0.75 + 0.25 * Math.sin(game.time * 51 + i * 4.3);
        if (it.boosting) {
          // The interceptor's two-stage solid-motor burn at ~60% scale: a
          // white-hot point at the nozzle, an orange tongue behind it.
          const sp = Math.hypot(it.vx, it.vy) || 1;
          const ux = it.vx / sp;
          const uy = it.vy / sp;
          const hot = this.baseColor('#fff6e0');
          const flame = this.baseColor('#ffae5c');
          this._pushGlow(
            this.wx(it.x - ux * 6),
            this.wy(it.y - uy * 6),
            hot,
            10 * flick,
            0.9 * flick
          );
          this._pushGlow(
            this.wx(it.x - ux * 12),
            this.wy(it.y - uy * 12),
            flame,
            18 * flick,
            0.6 * flick
          );
        } else {
          this._pushGlow(this.wx(it.x), this.wy(it.y), c, 9 * flick, 0.3 * flick);
        }
        i++;
      }
      const pts = it.trail;
      const n = pts.length;
      for (let k = 0; k < n && seg < trails.maxSeg; k++) {
        const a = pts[k];
        const b = k + 1 < n ? pts[k + 1] : it;
        const fa = 0.12 + 0.88 * (k / n);
        const fb = 0.12 + 0.88 * ((k + 1) / n);
        const v = seg * 6;
        trails.pos[v] = this.wx(a.x);
        trails.pos[v + 1] = this.wy(a.y);
        trails.pos[v + 2] = 0;
        trails.pos[v + 3] = this.wx(b.x);
        trails.pos[v + 4] = this.wy(b.y);
        trails.pos[v + 5] = 0;
        trails.col[v] = c.r * fa;
        trails.col[v + 1] = c.g * fa;
        trails.col[v + 2] = c.b * fa;
        trails.col[v + 3] = c.r * fb;
        trails.col[v + 4] = c.g * fb;
        trails.col[v + 5] = c.b * fb;
        seg++;
      }
    }
    for (let k = i; k < this.aamMeshes.length; k++) {
      this.aamMeshes[k].visible = false;
    }
    trails.setCount(seg);
  }

  /** Friendly F-16s: a clean, fast pass — no plume; the missiles carry the fire. */
  _updateJets(game) {
    let i = 0;
    for (const j of game.jets || []) {
      if (i >= this.jetMeshes.length) break;
      const mesh = this.jetMeshes[i];
      mesh.visible = true;
      mesh.position.set(this.wx(j.x), this.wy(j.y), 0);
      // Nose along the velocity (the airframe pitches onto its target line);
      // left-flying airframes mirror vertically so the canopy and fin stay
      // skyward (same trick as the enemy side-entrants).
      mesh.rotation.z = Math.atan2(-j.vy, j.vx);
      mesh.scale.set(1, j.dir > 0 ? 1 : -1, 1);
      i++;
    }
    for (; i < this.jetMeshes.length; i++) this.jetMeshes[i].visible = false;
  }

  /**
   * Laser beams: each live beam is drawn as a white-hot core segment plus two
   * slightly offset colored fringes — with bloom it reads as one thick,
   * searing beam that fades as the shot dissipates. Glow points mark the
   * emitter and the burn point.
   */
  _updateLaserBeams(game) {
    const sys = this.laserSys;
    const c = this.baseColor(COL.laser);
    let seg = 0;
    // Fading after-beams plus (while a burn is in progress) the live beam at
    // full intensity with a slight flicker.
    const beams = [...game.laserBeams];
    if (game.laserBeamLive) {
      beams.push({
        ...game.laserBeamLive,
        life: 0.92 + 0.08 * Math.sin(game.time * 53),
        maxLife: 1,
      });
    }
    for (const b of beams) {
      if (seg + 3 > sys.maxSeg) break;
      const f = Math.max(0, b.life / b.maxLife);
      const x1 = this.wx(b.x1);
      const y1 = this.wy(b.y1);
      const x2 = this.wx(b.x2);
      const y2 = this.wy(b.y2);
      // Perpendicular offset for the fringe lines.
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const px = (-(y2 - y1) / len) * 1.6;
      const py = ((x2 - x1) / len) * 1.6;
      const layers = [
        { ox: 0, oy: 0, r: f, g: f, b: f }, // white-hot core
        { ox: px, oy: py, r: c.r * f * 0.7, g: c.g * f * 0.7, b: c.b * f * 0.7 },
        { ox: -px, oy: -py, r: c.r * f * 0.7, g: c.g * f * 0.7, b: c.b * f * 0.7 },
      ];
      for (const L of layers) {
        const v = seg * 6;
        sys.pos[v] = x1 + L.ox;
        sys.pos[v + 1] = y1 + L.oy;
        sys.pos[v + 2] = 2;
        sys.pos[v + 3] = x2 + L.ox;
        sys.pos[v + 4] = y2 + L.oy;
        sys.pos[v + 5] = 2;
        sys.col[v] = L.r;
        sys.col[v + 1] = L.g;
        sys.col[v + 2] = L.b;
        sys.col[v + 3] = L.r;
        sys.col[v + 4] = L.g;
        sys.col[v + 5] = L.b;
        seg++;
      }
      this._pushGlow(x1, y1, c, 26 * f, 0.9 * f); // emitter flare
      this._pushGlow(x2, y2, c, 40 * f, 0.9 * f); // burn point
    }
    sys.setCount(seg);
  }

  _updateBullets(game) {
    const sys = this.bulletSys;
    const c = this.baseColor(COL.bullet);
    const inv = CONFIG.bullet.tracerLength / CONFIG.bullet.speed;
    let seg = 0;
    for (const b of game.bullets) {
      if (seg + 2 > sys.maxSeg) break;
      // Two parallel 1px lines straddling the true path read as one ~2px
      // tracer (offset is perpendicular to the velocity, in sim units).
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const px = (-b.vy / sp) * 0.5;
      const py = (b.vx / sp) * 0.5;
      const tx = b.x - b.vx * inv;
      const ty = b.y - b.vy * inv;
      for (let side = -1; side <= 1; side += 2) {
        const v = seg * 6;
        sys.pos[v] = this.wx(b.x + px * side);
        sys.pos[v + 1] = this.wy(b.y + py * side);
        sys.pos[v + 2] = 0;
        sys.pos[v + 3] = this.wx(tx + px * side);
        sys.pos[v + 4] = this.wy(ty + py * side);
        sys.pos[v + 5] = 0;
        sys.col[v] = c.r;
        sys.col[v + 1] = c.g;
        sys.col[v + 2] = c.b;
        sys.col[v + 3] = c.r * 0.2;
        sys.col[v + 4] = c.g * 0.2;
        sys.col[v + 5] = c.b * 0.2;
        seg++;
      }
    }
    sys.setCount(seg);
  }

  // -- public API -----------------------------------------------------------
  setSize(w, h) {
    this.clientW = w;
    this.clientH = h;
    // updateStyle=true pins the canvas CSS size to the same innerWidth/Height
    // the projection math uses — relying on `100vh` stretches the scene on
    // mobile, where the large viewport is taller than the visible one.
    this.three.setSize(w, h, true);
    this.composer.setSize(w, h);
    if (this.bloom) this.bloom.setSize(w, h);
    this._applyViewOffset(); // sets aspect (inset-aware) + projection
  }

  _updateCamera(game) {
    this._placeCamera(game.groundY);
    // Impact shake: jitter the camera itself so the whole world kicks, not
    // just the HUD overlay. Magnitude tracks the game's shake state.
    if (game.shakeTime > 0) {
      const k = Math.min(1, game.shakeTime / 0.25) * game.shakeMag * 0.7;
      this.camera.position.x += (Math.random() - 0.5) * 2 * k;
      this.camera.position.y += (Math.random() - 0.5) * 2 * k;
    }
  }

  /** Convert a screen-pixel point to simulation coords via the z=0 plane. */
  screenToWorld(px, py) {
    this._ndc.set((px / this.clientW) * 2 - 1, -(py / this.clientH) * 2 + 1);
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.plane, this._hit);
    if (!hit) return { x: this.simW / 2, y: this.simGroundY * 0.5 };
    return { x: hit.x + this.simW / 2, y: this.simGroundY - hit.y };
  }

  /**
   * Convert simulation coords to screen pixels (for HUD anchoring). Reuses a
   * scratch vector — this runs a dozen+ times per frame, and per-call
   * allocations add up to GC pauses.
   */
  worldToScreen(simX, simY, simZ = 0) {
    const v = (this._w2s = this._w2s || new THREE.Vector3());
    v.set(this.wx(simX), this.wy(simY), simZ).project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this.clientW,
      y: (-v.y * 0.5 + 0.5) * this.clientH,
    };
  }

  /**
   * Drop render resolution. Called by the main loop's quality governor when
   * the machine can't hold the frame-rate target — full-screen bloom at
   * devicePixelRatio 2 is the dominant GPU cost, so stepping the ratio down
   * buys a large margin for a small sharpness loss.
   */
  setPixelRatio(ratio) {
    this.three.setPixelRatio(ratio);
    this.setSize(this.clientW, this.clientH);
    // The point-cloud shaders size their sprites in device pixels.
    for (const mat of this._clouds || []) {
      mat.uniforms.uScale.value = ratio;
    }
  }

  render(game) {
    this.simW = game.W;
    this.simGroundY = game.groundY;
    if (!this.built) this.syncStructures(game);

    this._updateCamera(game);

    // Gentle out-of-phase star twinkle.
    if (this.starMats) {
      this.starMats[0].opacity = 0.55 + 0.2 * Math.sin(game.time * 1.1);
      this.starMats[1].opacity = 0.55 + 0.2 * Math.sin(game.time * 1.7 + 2.1);
    }

    this._glowCount = 0; // missile/interceptor updates push glow points
    this._updateStructures(game);
    this._updateShieldDomes(game);
    this._updateParticles(game);
    this._updateMissiles(game);
    this._updateInterceptors(game);
    this._updateAAMs(game);
    this._updateJets(game);
    this._updateBullets(game);
    this._updateLaserBeams(game);
    this._updateExplosions(game);
    this.glowCloud.setCount(this._glowCount);

    this.composer.render();
  }

  _updateShieldDomes(game) {
    const structures = [...game.turrets, ...game.cities];
    const t = game.time;
    // Drift the shimmer streaks around the domes.
    if (this._shieldTex) this._shieldTex.offset.x = (t * 0.04) % 1;
    const pulse = 1 + Math.sin(t * 1.6) * 0.02;
    let i = 0;
    for (const s of structures) {
      const mesh = this.shieldMeshes[i];
      if (!mesh) break;
      if (s.alive && s.shields > 0) {
        mesh.visible = true;
        mesh.position.set(this.wx(s.x), 1, 0); // dome rim sits on the ground
        mesh.scale.setScalar(pulse);
        // Subtle, gently flickering out of phase per structure so it shimmers.
        const flicker = 0.78 + 0.22 * Math.sin(t * 3.3 + i * 1.7);
        mesh.material.opacity = 0.14 * flicker;
      } else if (s.shieldFlash > 0) {
        // Collapse: the dome flares bright and expands as it fails.
        const f = s.shieldFlash / CONFIG.shield.flashTime; // 1 -> 0
        mesh.visible = true;
        mesh.position.set(this.wx(s.x), 1, 0);
        mesh.scale.setScalar(1 + (1 - f) * 0.45);
        mesh.material.opacity = 0.6 * f;
      } else {
        mesh.visible = false;
      }
      i++;
    }
    for (; i < this.shieldMeshes.length; i++) this.shieldMeshes[i].visible = false;
  }
}
