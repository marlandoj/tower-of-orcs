import * as THREE from 'three';

/**
 * Pre-allocated scratch objects for hot paths. Borrow, use immediately, never retain.
 * Convention: a function may use at most the vectors it names in a local comment.
 */
export const v0 = new THREE.Vector3();
export const v1 = new THREE.Vector3();
export const v2 = new THREE.Vector3();
export const v3 = new THREE.Vector3();
export const v4 = new THREE.Vector3();
export const v5 = new THREE.Vector3();

export const q0 = new THREE.Quaternion();
export const q1 = new THREE.Quaternion();

export const m0 = new THREE.Matrix4();
export const m1 = new THREE.Matrix4();

export const c0 = new THREE.Color();
export const c1 = new THREE.Color();

export const e0 = new THREE.Euler();
export const box0 = new THREE.Box3();
export const sph0 = new THREE.Sphere();
export const ray0 = new THREE.Ray();
export const plane0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export const UP = Object.freeze(new THREE.Vector3(0, 1, 0));
export const FORWARD = Object.freeze(new THREE.Vector3(0, 0, 1));
