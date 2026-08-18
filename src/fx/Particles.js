import * as THREE from 'three';

/**
 * One InstancedMesh, one draw call, N particles. Per-instance attributes carry
 * spawn time, velocity, size and colour, and the vertex shader integrates motion —
 * so a 6000-particle explosion costs the CPU nothing per frame.
 */
const VERT = /* glsl */`
  attribute vec3 iPos;
  attribute vec3 iVel;
  attribute vec4 iColor;
  attribute vec4 iParams;   // x: birth, y: life, z: size, w: mode(0 soft,1 spark,2 smoke)
  uniform float uTime;
  uniform float uGravity;
  varying vec4 vColor;
  varying vec2 vUv;
  varying float vMode;

  void main() {
    float age = uTime - iParams.x;
    float t = age / iParams.y;
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); vUv = uv; vMode = 0.0; return; }

    float drag = iParams.w > 1.5 ? 1.6 : 0.9;
    float damp = (1.0 - exp(-drag * age)) / drag;
    vec3 p = iPos + iVel * damp;
    p.y -= 0.5 * uGravity * age * age * (iParams.w > 1.5 ? 0.05 : 1.0);
    // Bounce off the floor once, softly.
    p.y = max(p.y, 0.02);

    float grow = iParams.w > 1.5 ? (1.0 + t * 2.2) : (1.0 - t * 0.35);
    float size = iParams.z * grow;

    // Fade: sparks stay bright then snap out; smoke eases; soft is a simple curve.
    float a = iParams.w > 0.5 && iParams.w < 1.5
      ? pow(1.0 - t, 0.6)
      : (iParams.w > 1.5 ? sin(t * 3.14159) * 0.75 : (1.0 - t) * (1.0 - t * 0.4));

    vColor = vec4(iColor.rgb, iColor.a * a);
    vUv = uv;
    vMode = iParams.w;

    // Camera-facing billboard.
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec2 corner = position.xy * size;
    if (iParams.w > 0.5 && iParams.w < 1.5) {
      // Sparks stretch along their velocity for a streak look.
      vec3 vv = normalize(iVel + vec3(0.0001));
      vec4 mvv = modelViewMatrix * vec4(vv, 0.0);
      vec2 dir = normalize(mvv.xy + vec2(0.0001));
      vec2 perp = vec2(-dir.y, dir.x);
      corner = dir * position.y * size * 3.0 + perp * position.x * size * 0.45;
    }
    mv.xy += corner;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  varying vec4 vColor;
  varying vec2 vUv;
  varying float vMode;
  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float alpha = vMode > 1.5
      ? smoothstep(1.0, 0.15, r) * 0.55
      : smoothstep(1.0, 0.0, r);
    if (vMode > 0.5 && vMode < 1.5) alpha = smoothstep(1.0, 0.2, r);
    gl_FragColor = vec4(vColor.rgb, vColor.a * alpha);
    if (gl_FragColor.a < 0.004) discard;
  }
`;

export class ParticleSystem {
  constructor(scene, { capacity = 8000, additive = true, gravity = 22, renderOrder = 10 } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.time = 0;

    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;

    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aPar = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    for (const a of [this.aPos, this.aVel, this.aCol, this.aPar]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iColor', this.aCol);
    geo.setAttribute('iParams', this.aPar);
    geo.instanceCount = capacity;
    // Particles are placed all over the level; skip frustum culling on the shared mesh.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uTime: { value: 0 }, uGravity: { value: gravity } },
      transparent: true, depthWrite: false, depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);
    this._dirty = false;
  }

  /** mode: 0 soft puff, 1 spark streak, 2 smoke */
  emit(x, y, z, vx, vy, vz, r, g, b, a, size, life, mode = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const p3 = i * 3, p4 = i * 4;
    this.aPos.array[p3] = x; this.aPos.array[p3 + 1] = y; this.aPos.array[p3 + 2] = z;
    this.aVel.array[p3] = vx; this.aVel.array[p3 + 1] = vy; this.aVel.array[p3 + 2] = vz;
    this.aCol.array[p4] = r; this.aCol.array[p4 + 1] = g; this.aCol.array[p4 + 2] = b; this.aCol.array[p4 + 3] = a;
    this.aPar.array[p4] = this.time; this.aPar.array[p4 + 1] = life;
    this.aPar.array[p4 + 2] = size; this.aPar.array[p4 + 3] = mode;
    this._dirty = true;
  }

  update(dt) {
    this.time += dt;
    this.material.uniforms.uTime.value = this.time;
    if (this._dirty) {
      this.aPos.needsUpdate = true; this.aVel.needsUpdate = true;
      this.aCol.needsUpdate = true; this.aPar.needsUpdate = true;
      this._dirty = false;
    }
  }

  clear() {
    this.aPar.array.fill(0);
    this.aCol.array.fill(0);
    this.aPar.needsUpdate = true; this.aCol.needsUpdate = true;
    this.cursor = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
