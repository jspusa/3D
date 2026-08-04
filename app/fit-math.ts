export type Dimensions = { x: number; y: number; z: number };
export type Angles = { yaw: number; leftLift: number; frontLift: number };
export type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

export type FitEvaluation = {
  envelope: Dimensions;
  clearance: Dimensions;
  fits: boolean;
  totalDeficit: number;
  maxDeficit: number;
};

export type FitSolution = FitEvaluation & {
  matrix: Matrix3;
  angles: Angles;
  checked: number;
};

export const IDENTITY: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const DEG = Math.PI / 180;

export function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ] as Matrix3;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row][col] =
        a[row][0] * b[0][col] +
        a[row][1] * b[1][col] +
        a[row][2] * b[2][col];
    }
  }
  return out;
}

export function rotateVector(matrix: Matrix3, point: [number, number, number]) {
  return [
    matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2] * point[2],
    matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2] * point[2],
    matrix[2][0] * point[0] + matrix[2][1] * point[1] + matrix[2][2] * point[2],
  ] as [number, number, number];
}

export function rotationX(degrees: number): Matrix3 {
  const angle = degrees * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}

export function rotationY(degrees: number): Matrix3 {
  const angle = degrees * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}

export function rotationZ(degrees: number): Matrix3 {
  const angle = degrees * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

export function anglesToMatrix(angles: Angles): Matrix3 {
  return multiply(
    rotationZ(angles.yaw),
    multiply(rotationY(angles.leftLift), rotationX(-angles.frontLift)),
  );
}

function normalizeAngle(value: number) {
  let angle = ((value + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(angle) < 1e-8) angle = 0;
  return angle;
}

export function matrixToAngles(matrix: Matrix3): Angles {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -matrix[2][0])));
  const cp = Math.cos(pitch);
  let yaw: number;
  let roll: number;
  if (Math.abs(cp) > 1e-7) {
    yaw = Math.atan2(matrix[1][0], matrix[0][0]);
    roll = Math.atan2(matrix[2][1], matrix[2][2]);
  } else {
    yaw = Math.atan2(-matrix[0][1], matrix[1][1]);
    roll = 0;
  }
  return {
    yaw: normalizeAngle(yaw / DEG),
    leftLift: normalizeAngle(pitch / DEG),
    frontLift: normalizeAngle(-roll / DEG),
  };
}

export function evaluateFit(
  object: Dimensions,
  available: Dimensions,
  matrix: Matrix3,
): FitEvaluation {
  const values = [object.x, object.y, object.z];
  const envelope = {
    x: Math.abs(matrix[0][0]) * values[0] + Math.abs(matrix[0][1]) * values[1] + Math.abs(matrix[0][2]) * values[2],
    y: Math.abs(matrix[1][0]) * values[0] + Math.abs(matrix[1][1]) * values[1] + Math.abs(matrix[1][2]) * values[2],
    z: Math.abs(matrix[2][0]) * values[0] + Math.abs(matrix[2][1]) * values[1] + Math.abs(matrix[2][2]) * values[2],
  };
  const clearance = {
    x: available.x - envelope.x,
    y: available.y - envelope.y,
    z: available.z - envelope.z,
  };
  const deficits = [clearance.x, clearance.y, clearance.z].map((value) => Math.max(0, -value));
  return {
    envelope,
    clearance,
    fits: deficits.every((value) => value <= 1e-7),
    totalDeficit: deficits[0] + deficits[1] + deficits[2],
    maxDeficit: Math.max(...deficits),
  };
}

const AXIS_PERMUTATIONS: Matrix3[] = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, 1], [0, 1, 0], [1, 0, 0]],
];

function quaternionMatrix(x: number, y: number, z: number, w: number): Matrix3 {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function rotationDistance(matrix: Matrix3) {
  const cosine = Math.max(-1, Math.min(1, (matrix[0][0] + matrix[1][1] + matrix[2][2] - 1) / 2));
  return Math.acos(cosine) / DEG;
}

type Candidate = FitEvaluation & { matrix: Matrix3 };

function compareCandidates(a: Candidate, b: Candidate) {
  if (a.fits !== b.fits) return a.fits ? -1 : 1;
  if (a.fits) {
    const aMin = Math.min(a.clearance.x, a.clearance.y, a.clearance.z);
    const bMin = Math.min(b.clearance.x, b.clearance.y, b.clearance.z);
    if (Math.abs(aMin - bMin) > 1e-8) return bMin - aMin;
  } else {
    if (Math.abs(a.totalDeficit - b.totalDeficit) > 1e-8) return a.totalDeficit - b.totalDeficit;
    if (Math.abs(a.maxDeficit - b.maxDeficit) > 1e-8) return a.maxDeficit - b.maxDeficit;
  }
  return rotationDistance(a.matrix) - rotationDistance(b.matrix);
}

function candidate(object: Dimensions, available: Dimensions, matrix: Matrix3): Candidate {
  return { matrix, ...evaluateFit(object, available, matrix) };
}

export function optimizeFit(object: Dimensions, available: Dimensions): FitSolution {
  if (
    [object.x, object.y, object.z, available.x, available.y, available.z].some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  ) {
    const fallback = evaluateFit(object, available, IDENTITY);
    return { matrix: IDENTITY, angles: { yaw: 0, leftLift: 0, frontLift: 0 }, checked: 1, ...fallback };
  }

  const seeds: Candidate[] = AXIS_PERMUTATIONS.map((matrix) => candidate(object, available, matrix));
  const sampleCount = 4096;
  const golden = 0.6180339887498948;
  const silver = 0.414213562373095;
  const fract = (value: number) => value - Math.floor(value);

  for (let index = 0; index < sampleCount; index += 1) {
    const u1 = (index + 0.5) / sampleCount;
    const u2 = fract(index * golden + 0.173);
    const u3 = fract(index * silver + 0.417);
    const rootA = Math.sqrt(1 - u1);
    const rootB = Math.sqrt(u1);
    const qx = rootA * Math.sin(2 * Math.PI * u2);
    const qy = rootA * Math.cos(2 * Math.PI * u2);
    const qz = rootB * Math.sin(2 * Math.PI * u3);
    const qw = rootB * Math.cos(2 * Math.PI * u3);
    seeds.push(candidate(object, available, quaternionMatrix(qx, qy, qz, qw)));
  }

  seeds.sort(compareCandidates);
  const finalists = seeds.slice(0, 10);
  const steps = [10, 5, 2, 0.8, 0.3, 0.12, 0.04, 0.012, 0.004, 0.001];
  let checked = AXIS_PERMUTATIONS.length + sampleCount;

  for (let seedIndex = 0; seedIndex < finalists.length; seedIndex += 1) {
    let best = finalists[seedIndex];
    for (const step of steps) {
      let improved = true;
      let passes = 0;
      while (improved && passes < 8) {
        improved = false;
        passes += 1;
        for (const adjustment of [rotationX(step), rotationX(-step), rotationY(step), rotationY(-step), rotationZ(step), rotationZ(-step)]) {
          for (const matrix of [multiply(adjustment, best.matrix), multiply(best.matrix, adjustment)]) {
            const next = candidate(object, available, matrix);
            checked += 1;
            if (compareCandidates(next, best) < 0) {
              best = next;
              improved = true;
            }
          }
        }
      }
    }
    finalists[seedIndex] = best;
  }

  finalists.sort(compareCandidates);
  const best = finalists[0];
  return { ...best, angles: matrixToAngles(best.matrix), checked };
}
