// `@mediapipe/face_mesh` is a closure-compiled classic script that defines `FaceMesh` on the global
// object; imported as an ES module (as @tensorflow-models/face-landmarks-detection does) it exports
// nothing. Vite aliases the package to this shim; EyeTracker loads the real script (same version as
// the solution files) with a <script> tag before importing WebGazer, so the global exists here.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;
export const FaceMesh = g.FaceMesh;
export const VERSION = g.VERSION;
export const FACEMESH_TESSELATION = g.FACEMESH_TESSELATION;
export const FACEMESH_LEFT_EYE = g.FACEMESH_LEFT_EYE;
export const FACEMESH_RIGHT_EYE = g.FACEMESH_RIGHT_EYE;
export const FACEMESH_LIPS = g.FACEMESH_LIPS;
export const FACEMESH_FACE_OVAL = g.FACEMESH_FACE_OVAL;
export default { FaceMesh };
