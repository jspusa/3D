"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { safeReleasePointerCapture, safeSetPointerCapture } from "./pointer-capture";

type PieceId = string;
type TowerView = "perspective" | "front" | "side" | "top";
type CanvasStyle = "graphite" | "eclipse" | "white" | "classic" | "neutral";
type BuyingCanvas = Extract<CanvasStyle, "graphite" | "eclipse">;
type CanvasScheme = "all-eclipse" | "all-graphite" | "signature-mix";
type Point3 = [number, number, number];
type Position = { x: number; y: number; z: number };
type Positions = Record<string, Position>;
type Camera = { yaw: number; pitch: number; zoom: number };

type TowerPiece = {
  id: PieceId;
  name: string;
  model: string;
  dimensions: { x: number; y: number; z: number };
  canvas: CanvasStyle;
};

type ProjectSnapshot = {
  name: string;
  clientName: string;
  notes: string;
  pieces: TowerPiece[];
  positions: Positions;
  view: TowerView;
  snapEnabled: boolean;
};

type SavedVersion = {
  id: string;
  label: string;
  createdAt: number;
  snapshot: ProjectSnapshot;
};

type TowerProject = ProjectSnapshot & {
  id: string;
  createdAt: number;
  updatedAt: number;
  versions: SavedVersion[];
};

type TowerStore = {
  schemaVersion: 1;
  activeProjectId: string;
  projects: TowerProject[];
};

type LayerMetric = {
  piece: TowerPiece;
  support: TowerPiece | null;
  stacked: boolean;
  supported: boolean;
  coverage: number | null;
  margins: ReturnType<typeof supportMargins> | null;
};

const STORAGE_KEY = "spatial-fit-pro:tower-projects:v1";
const MAX_PIECES = 10;
const MAX_VERSIONS = 10;
const MAX_PROJECTS = 30;
const CANVAS_LABELS: Record<CanvasStyle, string> = {
  graphite: "Damier Graphite",
  eclipse: "Monogram Eclipse",
  white: "Optic White",
  classic: "Monogram Classic",
  neutral: "中性純色",
};

const BUYING_CANVASES: { value: BuyingCanvas; label: string; english: string }[] = [
  { value: "graphite", label: "深灰棋盤格", english: "Damier Graphite" },
  { value: "eclipse", label: "黑色老花", english: "Monogram Eclipse" },
];

const CANVAS_SCHEMES: { id: CanvasScheme; label: string; detail: string }[] = [
  { id: "all-eclipse", label: "全黑老花", detail: "整體最一致 · 建議先看" },
  { id: "all-graphite", label: "全棋盤格", detail: "俐落、建築感較強" },
  { id: "signature-mix", label: "原本混搭", detail: "下層棋盤格＋頂層老花" },
];

const DEFAULT_PIECES: TowerPiece[] = [
  {
    id: "alzer",
    name: "Alzer 65",
    model: "N21231",
    dimensions: { x: 670, y: 470, z: 225 },
    canvas: "graphite",
  },
  {
    id: "bisten",
    name: "Bisten 50",
    model: "N21366",
    dimensions: { x: 510, y: 400, z: 185 },
    canvas: "graphite",
  },
  {
    id: "watch",
    name: "LV 錶盒",
    model: "M10262",
    dimensions: { x: 350, y: 205, z: 135 },
    canvas: "eclipse",
  },
];

const PIECE_PRESETS = [
  DEFAULT_PIECES[0],
  DEFAULT_PIECES[1],
  { ...DEFAULT_PIECES[1], id: "bisten-white", model: "M30956", canvas: "white" as const },
  DEFAULT_PIECES[2],
];

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clonePieces(pieces: TowerPiece[]) {
  return pieces.map((piece) => ({
    ...piece,
    dimensions: { ...piece.dimensions },
  }));
}

function buildCenteredPositions(pieces: TowerPiece[]): Positions {
  const positions: Positions = {};
  let z = 0;
  pieces.forEach((piece) => {
    positions[piece.id] = { x: 0, y: 0, z };
    z += piece.dimensions.z;
  });
  return positions;
}

function buildFrontAlignedPositions(pieces: TowerPiece[]): Positions {
  if (!pieces.length) return {};
  const positions: Positions = {};
  const front = -pieces[0].dimensions.y / 2;
  let z = 0;
  pieces.forEach((piece) => {
    positions[piece.id] = { x: 0, y: front + piece.dimensions.y / 2, z };
    z += piece.dimensions.z;
  });
  return positions;
}

function snapshotOf(project: TowerProject): ProjectSnapshot {
  return {
    name: project.name,
    clientName: project.clientName,
    notes: project.notes,
    pieces: clonePieces(project.pieces),
    positions: Object.fromEntries(Object.entries(project.positions).map(([id, position]) => [id, { ...position }])),
    view: project.view,
    snapEnabled: project.snapEnabled,
  };
}

function createProject(name = "我的 LV 三層塔", pieces = DEFAULT_PIECES, id = "lv-tower-default"): TowerProject {
  const cloned = clonePieces(pieces);
  return {
    id,
    name,
    clientName: "",
    notes: "",
    pieces: cloned,
    positions: buildCenteredPositions(cloned),
    view: "perspective",
    snapEnabled: true,
    createdAt: 0,
    updatedAt: 0,
    versions: [],
  };
}

function createDefaultStore(): TowerStore {
  const project = createProject();
  return { schemaVersion: 1, activeProjectId: project.id, projects: [project] };
}

function tierLabel(index: number, total: number) {
  if (index === 0) return "底層";
  if (index === total - 1) return "頂層";
  return `第 ${index + 1} 層`;
}

function isCanvas(value: unknown): value is CanvasStyle {
  return typeof value === "string" && value in CANVAS_LABELS;
}

function isView(value: unknown): value is TowerView {
  return value === "perspective" || value === "front" || value === "side" || value === "top";
}

function sanitizePiece(value: unknown, fallbackId: string): TowerPiece | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const dimensions = raw.dimensions as Record<string, unknown> | undefined;
  const numbers = dimensions && [dimensions.x, dimensions.y, dimensions.z].map(Number);
  if (!numbers || numbers.some((number) => !Number.isFinite(number) || number < 1 || number > 10000)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 60) : "";
  if (!name || !isCanvas(raw.canvas)) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.slice(0, 100) : fallbackId;
  return {
    id,
    name,
    model: typeof raw.model === "string" ? raw.model.trim().slice(0, 40) : "",
    dimensions: { x: numbers[0], y: numbers[1], z: numbers[2] },
    canvas: raw.canvas,
  };
}

function sanitizeSnapshot(value: unknown): ProjectSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.pieces) || raw.pieces.length < 1 || raw.pieces.length > MAX_PIECES) return null;
  const pieces = raw.pieces.map((piece, index) => sanitizePiece(piece, `piece-${index}`));
  if (pieces.some((piece) => !piece)) return null;
  const safePieces = pieces as TowerPiece[];
  if (new Set(safePieces.map((piece) => piece.id)).size !== safePieces.length) return null;
  const rawPositions = raw.positions && typeof raw.positions === "object" ? raw.positions as Record<string, unknown> : {};
  const centered = buildCenteredPositions(safePieces);
  const positions: Positions = {};
  safePieces.forEach((piece) => {
    const candidate = rawPositions[piece.id] as Record<string, unknown> | undefined;
    const values = candidate ? [candidate.x, candidate.y, candidate.z].map(Number) : [];
    positions[piece.id] = values.length === 3 && values.every((number) => Number.isFinite(number) && Math.abs(number) <= 50000)
      ? { x: values[0], y: values[1], z: Math.max(0, values[2]) }
      : centered[piece.id];
  });
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : "未命名疊塔",
    clientName: typeof raw.clientName === "string" ? raw.clientName.trim().slice(0, 80) : "",
    notes: typeof raw.notes === "string" ? raw.notes.trim().slice(0, 500) : "",
    pieces: safePieces,
    positions,
    view: isView(raw.view) ? raw.view : "perspective",
    snapEnabled: raw.snapEnabled !== false,
  };
}

function sanitizeStore(value: unknown): TowerStore | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.projects) || !raw.projects.length) return null;
  const projects: TowerProject[] = [];
  raw.projects.slice(0, MAX_PROJECTS).forEach((candidate, projectIndex) => {
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    const snapshot = sanitizeSnapshot(record);
    if (!snapshot) return;
    const projectId = typeof record.id === "string" && record.id ? record.id.slice(0, 100) : `project-${projectIndex}`;
    const versions: SavedVersion[] = [];
    if (Array.isArray(record.versions)) {
      record.versions.slice(-MAX_VERSIONS).forEach((version, versionIndex) => {
        if (!version || typeof version !== "object") return;
        const versionRecord = version as Record<string, unknown>;
        const versionSnapshot = sanitizeSnapshot(versionRecord.snapshot);
        if (!versionSnapshot) return;
        versions.push({
          id: typeof versionRecord.id === "string" ? versionRecord.id : `${projectId}-v${versionIndex}`,
          label: typeof versionRecord.label === "string" && versionRecord.label.trim() ? versionRecord.label.trim().slice(0, 60) : `版本 ${versionIndex + 1}`,
          createdAt: Number.isFinite(Number(versionRecord.createdAt)) ? Number(versionRecord.createdAt) : 0,
          snapshot: versionSnapshot,
        });
      });
    }
    projects.push({
      ...snapshot,
      id: projectId,
      createdAt: Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : 0,
      updatedAt: Number.isFinite(Number(record.updatedAt)) ? Number(record.updatedAt) : 0,
      versions,
    });
  });
  if (!projects.length || new Set(projects.map((project) => project.id)).size !== projects.length) return null;
  const requestedActive = typeof raw.activeProjectId === "string" ? raw.activeProjectId : "";
  return {
    schemaVersion: 1,
    activeProjectId: projects.some((project) => project.id === requestedActive) ? requestedActive : projects[0].id,
    projects,
  };
}

const cameraPresets: Record<TowerView, Camera> = {
  perspective: { yaw: -35, pitch: 25, zoom: 1 },
  front: { yaw: 0, pitch: 2, zoom: 1 },
  side: { yaw: -90, pitch: 2, zoom: 1 },
  top: { yaw: -35, pitch: 88, zoom: 1 },
};

const cubeFaces = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 2, 6, 7],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
];

function format(value: number, digits = 1) {
  const safe = Math.abs(value) < 0.0005 ? 0 : value;
  return new Intl.NumberFormat("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(safe);
}

function vertices(piece: TowerPiece, position: Position): Point3[] {
  const x = piece.dimensions.x / 2;
  const y = piece.dimensions.y / 2;
  const z0 = position.z;
  const z1 = position.z + piece.dimensions.z;
  return [
    [position.x - x, position.y - y, z0],
    [position.x + x, position.y - y, z0],
    [position.x + x, position.y + y, z0],
    [position.x - x, position.y + y, z0],
    [position.x - x, position.y - y, z1],
    [position.x + x, position.y - y, z1],
    [position.x + x, position.y + y, z1],
    [position.x - x, position.y + y, z1],
  ];
}

function faceDimensions(faceIndex: number, dimensions: TowerPiece["dimensions"]) {
  if (faceIndex <= 1) return { u: dimensions.x, v: dimensions.y };
  if (faceIndex <= 3) return { u: dimensions.x, v: dimensions.z };
  return { u: dimensions.y, v: dimensions.z };
}

function canvasForScheme(scheme: CanvasScheme, index: number, total: number): BuyingCanvas {
  if (scheme === "all-eclipse") return "eclipse";
  if (scheme === "all-graphite") return "graphite";
  return index === total - 1 ? "eclipse" : "graphite";
}

function supportMargins(child: TowerPiece, childPosition: Position, support: TowerPiece, supportPosition: Position) {
  return {
    left: childPosition.x - child.dimensions.x / 2 - (supportPosition.x - support.dimensions.x / 2),
    right: supportPosition.x + support.dimensions.x / 2 - (childPosition.x + child.dimensions.x / 2),
    front: childPosition.y - child.dimensions.y / 2 - (supportPosition.y - support.dimensions.y / 2),
    back: supportPosition.y + support.dimensions.y / 2 - (childPosition.y + child.dimensions.y / 2),
  };
}

function supportCoverage(child: TowerPiece, childPosition: Position, support: TowerPiece, supportPosition: Position) {
  const childMinX = childPosition.x - child.dimensions.x / 2;
  const childMaxX = childPosition.x + child.dimensions.x / 2;
  const childMinY = childPosition.y - child.dimensions.y / 2;
  const childMaxY = childPosition.y + child.dimensions.y / 2;
  const supportMinX = supportPosition.x - support.dimensions.x / 2;
  const supportMaxX = supportPosition.x + support.dimensions.x / 2;
  const supportMinY = supportPosition.y - support.dimensions.y / 2;
  const supportMaxY = supportPosition.y + support.dimensions.y / 2;
  const overlapX = Math.max(0, Math.min(childMaxX, supportMaxX) - Math.max(childMinX, supportMinX));
  const overlapY = Math.max(0, Math.min(childMaxY, supportMaxY) - Math.max(childMinY, supportMinY));
  return (overlapX * overlapY) / (child.dimensions.x * child.dimensions.y);
}

function computeTowerMetrics(pieces: TowerPiece[], positions: Positions) {
  const layerMetrics: LayerMetric[] = pieces.map((piece, index) => {
    if (index === 0) return { piece, support: null, stacked: true, supported: true, coverage: null, margins: null };
    const support = pieces[index - 1];
    const piecePosition = positions[piece.id];
    const supportPosition = positions[support.id];
    const margins = supportMargins(piece, piecePosition, support, supportPosition);
    const stacked = Math.abs(piecePosition.z - (supportPosition.z + support.dimensions.z)) < 0.5;
    return {
      piece,
      support,
      stacked,
      supported: stacked && Math.min(...Object.values(margins)) >= -0.001,
      coverage: supportCoverage(piece, piecePosition, support, supportPosition),
      margins,
    };
  });
  const bounds = pieces.map((piece) => ({
    minX: positions[piece.id].x - piece.dimensions.x / 2,
    maxX: positions[piece.id].x + piece.dimensions.x / 2,
    minY: positions[piece.id].y - piece.dimensions.y / 2,
    maxY: positions[piece.id].y + piece.dimensions.y / 2,
    minZ: positions[piece.id].z,
    maxZ: positions[piece.id].z + piece.dimensions.z,
  }));
  const minX = Math.min(...bounds.map((bound) => bound.minX));
  const maxX = Math.max(...bounds.map((bound) => bound.maxX));
  const minY = Math.min(...bounds.map((bound) => bound.minY));
  const maxY = Math.max(...bounds.map((bound) => bound.maxY));
  const minZ = Math.min(0, ...bounds.map((bound) => bound.minZ));
  const maxZ = Math.max(...bounds.map((bound) => bound.maxZ));
  const margins = layerMetrics.flatMap((metric) => metric.margins ? Object.values(metric.margins) : []);
  return {
    layers: layerMetrics,
    fullySupported: layerMetrics.every((metric) => metric.supported),
    allStacked: layerMetrics.every((metric) => metric.stacked),
    minMargin: margins.length ? Math.min(...margins) : null,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    footprint: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
  };
}

function encodeBase64Url(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function sharePayload(project: TowerProject) {
  const views: TowerView[] = ["perspective", "front", "side", "top"];
  return {
    v: 1,
    n: project.name,
    s: project.snapEnabled ? 1 : 0,
    w: views.indexOf(project.view),
    i: project.pieces.map((piece) => {
      const position = project.positions[piece.id];
      return [piece.name, piece.model, piece.dimensions.x, piece.dimensions.y, piece.dimensions.z, piece.canvas, position.x, position.y, position.z];
    }),
  };
}

function projectFromShare(value: unknown): TowerProject | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !Array.isArray(raw.i) || raw.i.length < 1 || raw.i.length > MAX_PIECES) return null;
  const pieces: TowerPiece[] = [];
  const positions: Positions = {};
  for (let index = 0; index < raw.i.length; index += 1) {
    const item = raw.i[index];
    if (!Array.isArray(item) || item.length !== 9) return null;
    const id = makeId("shared-piece");
    const piece = sanitizePiece({
      id,
      name: item[0],
      model: item[1],
      dimensions: { x: item[2], y: item[3], z: item[4] },
      canvas: item[5],
    }, id);
    const positionValues = [Number(item[6]), Number(item[7]), Number(item[8])];
    if (!piece || positionValues.some((number) => !Number.isFinite(number) || Math.abs(number) > 50000)) return null;
    pieces.push(piece);
    positions[id] = { x: positionValues[0], y: positionValues[1], z: Math.max(0, positionValues[2]) };
  }
  const views: TowerView[] = ["perspective", "front", "side", "top"];
  const now = Date.now();
  return {
    id: makeId("project"),
    name: `${typeof raw.n === "string" && raw.n.trim() ? raw.n.trim().slice(0, 72) : "分享疊塔"}（分享副本）`,
    clientName: "",
    notes: "",
    pieces,
    positions,
    view: views[Number(raw.w)] ?? "perspective",
    snapEnabled: raw.s !== 0,
    createdAt: now,
    updatedAt: now,
    versions: [],
  };
}

function StackScene({
  pieces,
  positions,
  view,
  selected,
  snapEnabled,
  onSelect,
  onMove,
  onDrop,
  onNudge,
}: {
  pieces: TowerPiece[];
  positions: Positions;
  view: TowerView;
  selected: PieceId;
  snapEnabled: boolean;
  onSelect: (id: PieceId) => void;
  onMove: (id: PieceId, position: Position) => void;
  onDrop: (id: PieceId, position: Position) => void;
  onNudge: (id: PieceId, dx: number, dy: number) => void;
}) {
  const [camera, setCamera] = useState<Camera>(cameraPresets[view]);
  const sceneWrap = useRef<HTMLDivElement>(null);
  const cameraDrag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const pieceDrag = useRef<{
    id: PieceId;
    x: number;
    y: number;
    start: Position;
    last: Position;
  } | null>(null);
  const radians = Math.PI / 180;

  const rawProject = (point: Point3) => {
    const yaw = camera.yaw * radians;
    const pitch = camera.pitch * radians;
    const rotatedX = point[0] * Math.cos(yaw) - point[1] * Math.sin(yaw);
    const rotatedY = point[0] * Math.sin(yaw) + point[1] * Math.cos(yaw);
    return {
      x: rotatedX,
      y: -(point[2] * Math.cos(pitch) + rotatedY * Math.sin(pitch)),
      depth: rotatedY * Math.cos(pitch) - point[2] * Math.sin(pitch),
    };
  };

  const sceneMetrics = computeTowerMetrics(pieces, positions);
  const framePadding = Math.max(120, Math.min(260, Math.max(sceneMetrics.footprint.x, sceneMetrics.footprint.y) * 0.22));
  const minFrameX = Math.min(sceneMetrics.bounds.minX - framePadding, -460);
  const maxFrameX = Math.max(sceneMetrics.bounds.maxX + framePadding, 460);
  const minFrameY = Math.min(sceneMetrics.bounds.minY - framePadding, -360);
  const maxFrameY = Math.max(sceneMetrics.bounds.maxY + framePadding, 360);
  const frameZ = Math.max(620, sceneMetrics.bounds.maxZ + 80);
  const framing: Point3[] = [
    [minFrameX, minFrameY, 0], [maxFrameX, minFrameY, 0], [maxFrameX, maxFrameY, 0], [minFrameX, maxFrameY, 0],
    [minFrameX, minFrameY, frameZ], [maxFrameX, minFrameY, frameZ], [maxFrameX, maxFrameY, frameZ], [minFrameX, maxFrameY, frameZ],
  ];
  const rawFrame = framing.map(rawProject);
  const minX = Math.min(...rawFrame.map((point) => point.x));
  const maxX = Math.max(...rawFrame.map((point) => point.x));
  const minY = Math.min(...rawFrame.map((point) => point.y));
  const maxY = Math.max(...rawFrame.map((point) => point.y));
  const scale = Math.min(770 / (maxX - minX), 505 / (maxY - minY)) * camera.zoom;
  const originX = 450 - ((minX + maxX) / 2) * scale;
  const originY = 320 - ((minY + maxY) / 2) * scale;
  const project = (point: Point3) => {
    const projected = rawProject(point);
    return { x: originX + projected.x * scale, y: originY + projected.y * scale, depth: projected.depth };
  };
  const pointString = (points: Point3[]) => points.map((point) => {
    const projected = project(point);
    return `${projected.x},${projected.y}`;
  }).join(" ");

  const pieceVertices = Object.fromEntries(pieces.map((piece) => [piece.id, vertices(piece, positions[piece.id])])) as Record<string, Point3[]>;
  const faces = pieces.flatMap((piece) => cubeFaces.map((indices, faceIndex) => {
    const points = indices.map((index) => pieceVertices[piece.id][index]);
    return {
      piece,
      faceIndex,
      points,
      depth: points.reduce((sum, point) => sum + rawProject(point).depth, 0) / points.length,
    };
  })).sort((a, b) => b.depth - a.depth);

  const onBackgroundDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) return;
    cameraDrag.current = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
    safeSetPointerCapture(sceneWrap.current, event.pointerId);
  };
  const onPieceDown = (event: ReactPointerEvent<SVGElement>, id: PieceId) => {
    event.stopPropagation();
    onSelect(id);
    if (id === pieces[0].id) return;
    pieceDrag.current = {
      id,
      x: event.clientX,
      y: event.clientY,
      start: positions[id],
      last: positions[id],
    };
    safeSetPointerCapture(sceneWrap.current, event.pointerId);
  };
  const onBackgroundMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pieceDrag.current) {
      const rect = event.currentTarget.getBoundingClientRect();
      const deltaScreenX = (event.clientX - pieceDrag.current.x) * (900 / rect.width);
      const deltaScreenY = (event.clientY - pieceDrag.current.y) * (650 / rect.height);
      const yaw = camera.yaw * radians;
      const pitch = camera.pitch * radians;
      const projectedX = deltaScreenX / scale;
      const projectedY = -deltaScreenY / (scale * Math.max(0.15, Math.sin(pitch)));
      const dx = Math.cos(yaw) * projectedX + Math.sin(yaw) * projectedY;
      const dy = -Math.sin(yaw) * projectedX + Math.cos(yaw) * projectedY;
      const id = pieceDrag.current.id;
      const index = pieces.findIndex((piece) => piece.id === id);
      const support = pieces[index - 1];
      if (!support) return;
      const supportPosition = positions[support.id];
      const targetX = supportPosition.x;
      const targetY = supportPosition.y;
      let x = pieceDrag.current.start.x + dx;
      let y = pieceDrag.current.start.y + dy;
      const snapDistance = Math.max(12, Math.min(35, 18 / Math.max(0.25, scale)));
      if (snapEnabled && Math.abs(x - targetX) < snapDistance) x = targetX;
      if (snapEnabled && Math.abs(y - targetY) < snapDistance) y = targetY;
      const next = { x, y, z: pieceDrag.current.start.z };
      pieceDrag.current.last = next;
      onMove(id, next);
      return;
    }
    if (!cameraDrag.current) return;
    setCamera((current) => ({
      ...current,
      yaw: cameraDrag.current!.yaw + (event.clientX - cameraDrag.current!.x) * 0.32,
      pitch: Math.max(8, Math.min(89, cameraDrag.current!.pitch - (event.clientY - cameraDrag.current!.y) * 0.25)),
    }));
  };
  const onBackgroundUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pieceDrag.current) {
      onDrop(pieceDrag.current.id, pieceDrag.current.last);
      pieceDrag.current = null;
    }
    cameraDrag.current = null;
    safeReleasePointerCapture(event.currentTarget, event.pointerId);
  };
  const onPointerCaptureLost = () => {
    if (pieceDrag.current) {
      const { id, last } = pieceDrag.current;
      pieceDrag.current = null;
      onDrop(id, last);
    }
    cameraDrag.current = null;
  };
  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setCamera((current) => ({ ...current, zoom: Math.max(0.78, Math.min(1.3, current.zoom - event.deltaY * 0.001)) }));
  };

  const base = pieces[0];
  const basePosition = positions[base.id];
  const floor = [
    [sceneMetrics.bounds.minX - 120, sceneMetrics.bounds.minY - 120, -2],
    [sceneMetrics.bounds.maxX + 120, sceneMetrics.bounds.minY - 120, -2],
    [sceneMetrics.bounds.maxX + 120, sceneMetrics.bounds.maxY + 120, -2],
    [sceneMetrics.bounds.minX - 120, sceneMetrics.bounds.maxY + 120, -2],
  ] as Point3[];

  return (
    <div
      ref={sceneWrap}
      className="stack-scene-wrap"
      onPointerMove={onBackgroundMove}
      onPointerUp={onBackgroundUp}
      onPointerCancel={onBackgroundUp}
      onLostPointerCapture={onPointerCaptureLost}
    >
      <svg
        className="stack-scene"
        viewBox="0 0 900 650"
        role="group"
        aria-label={`依照真實毫米比例繪製的 ${pieces.length} 層箱件疊塔`}
        onPointerDown={onBackgroundDown}
        onWheel={onWheel}
      >
        <defs>
          <filter id="stack-shadow" x="-30%" y="-30%" width="160%" height="190%">
            <feDropShadow dx="0" dy="10" stdDeviation="8" floodColor="#101113" floodOpacity=".22" />
          </filter>
          <filter id="selected-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#0071e3" floodOpacity=".72" />
          </filter>
          <linearGradient id="stack-canvas-sheen" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity=".12" />
            <stop offset=".32" stopColor="#fff" stopOpacity=".015" />
            <stop offset=".72" stopColor="#000" stopOpacity=".04" />
            <stop offset="1" stopColor="#000" stopOpacity=".12" />
          </linearGradient>
          <linearGradient id="stack-silver" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f1f3f4" />
            <stop offset=".28" stopColor="#9fa4a8" />
            <stop offset=".55" stopColor="#e1e4e6" />
            <stop offset="1" stopColor="#71767a" />
          </linearGradient>
          <linearGradient id="stack-ruthenium" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a8aaad" />
            <stop offset=".38" stopColor="#4f5255" />
            <stop offset=".66" stopColor="#85888b" />
            <stop offset="1" stopColor="#292b2e" />
          </linearGradient>

          <pattern id="stack-graphite" width="72" height="72" patternUnits="userSpaceOnUse">
            <rect width="72" height="72" fill="#303235" />
            <rect width="36" height="36" fill="#414347" />
            <rect x="36" y="36" width="36" height="36" fill="#414347" />
            <rect x="36" width="36" height="36" fill="#282a2d" />
            <rect y="36" width="36" height="36" fill="#282a2d" />
            <path d="M-18 0L72 90M0-18L90 72M18-18L90 54M-18 18L54 90" stroke="#fff" strokeOpacity=".035" strokeWidth="1.2" />
            <text x="18" y="19" fill="#a7aaad" fillOpacity=".52" fontFamily="Arial, sans-serif" fontSize="4.3" fontWeight="700" textAnchor="middle">LOUIS VUITTON</text>
            <text x="18" y="25" fill="#a7aaad" fillOpacity=".42" fontFamily="Arial, sans-serif" fontSize="3.2" textAnchor="middle">PARIS</text>
          </pattern>
          <pattern id="stack-white" width="72" height="72" patternUnits="userSpaceOnUse">
            <rect width="72" height="72" fill="#e7e2d9" />
            <rect width="36" height="36" fill="#f5f1ea" />
            <rect x="36" y="36" width="36" height="36" fill="#f5f1ea" />
            <rect x="36" width="36" height="36" fill="#d6d0c6" />
            <rect y="36" width="36" height="36" fill="#d6d0c6" />
            <path d="M-18 0L72 90M0-18L90 72M18-18L90 54M-18 18L54 90" stroke="#8d877f" strokeOpacity=".09" strokeWidth="1" />
          </pattern>
          <pattern id="stack-eclipse" width="72" height="72" patternUnits="userSpaceOnUse">
            <rect width="72" height="72" fill="#242526" />
            <path d="M-18 0L72 90M0-18L90 72M18-18L90 54M-18 18L54 90" stroke="#fff" strokeOpacity=".025" strokeWidth="1.1" />
            <g fill="#84878a" fillOpacity=".68">
              <text x="18" y="23" fontFamily="Georgia, serif" fontSize="13" fontWeight="700" textAnchor="middle">LV</text>
              <path transform="translate(54 18)" d="M0-8L4-4L0 0L-4-4ZM8 0L4 4L0 0L4-4ZM0 8L-4 4L0 0L4 4ZM-8 0L-4-4L0 0L-4 4Z" />
              <path transform="translate(18 54)" d="M0-7L7 0L0 7L-7 0ZM0-3L-3 0L0 3L3 0Z" fillRule="evenodd" />
              <path transform="translate(54 54)" d="M0-8L4-4L0 0L-4-4ZM8 0L4 4L0 0L4-4ZM0 8L-4 4L0 0L4 4ZM-8 0L-4-4L0 0L-4 4Z" />
            </g>
          </pattern>
          <pattern id="stack-classic" width="72" height="72" patternUnits="userSpaceOnUse">
            <rect width="72" height="72" fill="#65452f" />
            <path d="M-18 0L72 90M0-18L90 72M18-18L90 54M-18 18L54 90" stroke="#fff" strokeOpacity=".025" strokeWidth="1.1" />
            <g fill="#d0ad73" fillOpacity=".8">
              <text x="18" y="23" fontFamily="Georgia, serif" fontSize="13" fontWeight="700" textAnchor="middle">LV</text>
              <path transform="translate(54 18)" d="M0-8L4-4L0 0L-4-4ZM8 0L4 4L0 0L4-4ZM0 8L-4 4L0 0L4 4ZM-8 0L-4-4L0 0L-4 4Z" />
              <path transform="translate(18 54)" d="M0-7L7 0L0 7L-7 0ZM0-3L-3 0L0 3L3 0Z" fillRule="evenodd" />
              <path transform="translate(54 54)" d="M0-8L4-4L0 0L-4-4ZM8 0L4 4L0 0L4-4ZM0 8L-4 4L0 0L4 4ZM-8 0L-4-4L0 0L-4 4Z" />
            </g>
          </pattern>
          <pattern id="stack-neutral" width="24" height="24" patternUnits="userSpaceOnUse">
            <rect width="24" height="24" fill="#aab0b7" />
            <path d="M-8 0L24 32M0-8L32 24" stroke="#fff" strokeOpacity=".12" strokeWidth="1" />
          </pattern>
        </defs>

        <polygon className="stack-floor" points={pointString(floor)} />
        <g className="stack-center-guides">
          {(() => {
            const a = project([sceneMetrics.bounds.minX - 80, basePosition.y, 0]);
            const b = project([sceneMetrics.bounds.maxX + 80, basePosition.y, 0]);
            const c = project([basePosition.x, sceneMetrics.bounds.minY - 80, 0]);
            const d = project([basePosition.x, sceneMetrics.bounds.maxY + 80, 0]);
            return <><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} /><line x1={c.x} y1={c.y} x2={d.x} y2={d.y} /></>;
          })()}
        </g>

        {selected !== base.id && (() => {
          const selectedIndex = pieces.findIndex((piece) => piece.id === selected);
          const supportId = pieces[selectedIndex - 1]?.id;
          if (!supportId) return null;
          const supportTop = cubeFaces[1].map((index) => pieceVertices[supportId][index]);
          const center = project([
            positions[supportId].x,
            positions[supportId].y,
            positions[supportId].z + pieces.find((piece) => piece.id === supportId)!.dimensions.z + 1,
          ]);
          return <g className="stack-drop-target"><polygon points={pointString(supportTop)} /><circle cx={center.x} cy={center.y} r="9" /><line x1={center.x - 16} y1={center.y} x2={center.x + 16} y2={center.y} /><line x1={center.x} y1={center.y - 16} x2={center.x} y2={center.y + 16} /></g>;
        })()}

        <g filter="url(#stack-shadow)">
          {faces.map((face) => {
            const canvas = face.piece.canvas;
            const local = faceDimensions(face.faceIndex, face.piece.dimensions);
            const [q0, q1, , q3] = face.points.map(project);
            const matrix = [
              (q1.x - q0.x) / local.u,
              (q1.y - q0.y) / local.u,
              (q3.x - q0.x) / local.v,
              (q3.y - q0.y) / local.v,
              q0.x,
              q0.y,
            ].map((value) => value.toFixed(6)).join(" ");
            const isWatchBox = /M10262|錶盒|watch/i.test(`${face.piece.model} ${face.piece.name}`);
            const isHardCase = !isWatchBox;
            const trim = Math.min(isWatchBox ? 10 : 14, local.u * .08, local.v * .11);
            const hardwareY = local.v * .49;
            const lockWidth = Math.min(isWatchBox ? 48 : 54, local.u * .18);
            const lockHeight = Math.min(isWatchBox ? 30 : 34, local.v * .31);
            const latchWidth = Math.min(38, local.u * .1);
            const latchHeight = Math.min(23, local.v * .22);
            const corner = Math.min(34, local.u * .09, local.v * .25);
            const cornerBand = Math.min(8, corner * .3);
            const hardwareFinish = isWatchBox && canvas === "eclipse" ? "hardware-ruthenium" : "hardware-silver";
            return (
              <g
                key={`${face.piece.id}-${face.faceIndex}`}
                className={`stack-face stack-face-${canvas} ${selected === face.piece.id ? "is-selected" : ""}`}
                onPointerDown={(event) => onPieceDown(event, face.piece.id)}
                aria-hidden="true"
              >
                <g transform={`matrix(${matrix})`}>
                  <rect className="stack-face-base" width={local.u} height={local.v} style={{ fill: `url(#stack-${canvas})` }} />
                  <rect className={`stack-face-light stack-face-light-${face.faceIndex}`} width={local.u} height={local.v} />
                  <rect className="stack-canvas-sheen" width={local.u} height={local.v} fill="url(#stack-canvas-sheen)" />

                  <g className={`stack-leather-trim trim-${canvas}`}>
                    <rect className="stack-trim-strip" width={local.u} height={trim} />
                    <rect className="stack-trim-strip" y={local.v - trim} width={local.u} height={trim} />
                    <rect className="stack-trim-strip" width={trim} height={local.v} />
                    <rect className="stack-trim-strip" x={local.u - trim} width={trim} height={local.v} />
                    <rect className="stack-trim-highlight" x={trim} y={trim} width={Math.max(0, local.u - trim * 2)} height={Math.max(0, local.v - trim * 2)} />
                  </g>

                  {face.faceIndex === 2 && <g className={`stack-front-hardware ${hardwareFinish}`}>
                    {isHardCase && <>
                      <rect className="stack-front-rail" x={trim} y={hardwareY - 7} width={Math.max(0, local.u - trim * 2)} height="14" rx="3" />
                      {[
                        "",
                        `translate(${local.u} 0) scale(-1 1)`,
                        `translate(0 ${local.v}) scale(1 -1)`,
                        `translate(${local.u} ${local.v}) scale(-1 -1)`,
                      ].map((transform, index) => <path key={`corner-${index}`} className="stack-metal stack-corner-plate" transform={transform || undefined} d={`M0 0H${corner}V${cornerBand}H${cornerBand}V${corner}H0Z`} />)}
                      {[.31, .69].map((ratio) => <g className="stack-latch" key={ratio}>
                        <rect className="stack-metal" x={local.u * ratio - latchWidth / 2} y={hardwareY - latchHeight / 2} width={latchWidth} height={latchHeight} rx="3" />
                        <rect className="stack-latch-inset" x={local.u * ratio - latchWidth * .29} y={hardwareY - latchHeight * .28} width={latchWidth * .58} height={latchHeight * .56} rx="2" />
                        <circle className="stack-rivet" cx={local.u * ratio} cy={hardwareY} r={Math.min(2.7, latchHeight * .12)} />
                      </g>)}
                    </>}
                    <g className="stack-s-lock">
                      <rect className="stack-lock-shadow" x={local.u / 2 - lockWidth / 2 - 3} y={hardwareY - lockHeight / 2 - 3} width={lockWidth + 6} height={lockHeight + 6} rx="5" />
                      <rect className="stack-metal stack-lock-plate" x={local.u / 2 - lockWidth / 2} y={hardwareY - lockHeight / 2} width={lockWidth} height={lockHeight} rx="4" />
                      <rect className="stack-lock-inset" x={local.u / 2 - lockWidth * .27} y={hardwareY - lockHeight * .25} width={lockWidth * .54} height={lockHeight * .5} rx="3" />
                      <circle className="stack-keyhole" cx={local.u / 2} cy={hardwareY - 1} r={Math.min(3.2, lockHeight * .1)} />
                      <path className="stack-keyhole" d={`M${local.u / 2 - 1.8} ${hardwareY + 1}L${local.u / 2 - 3.2} ${hardwareY + 7}H${local.u / 2 + 3.2}L${local.u / 2 + 1.8} ${hardwareY + 1}Z`} />
                      <circle className="stack-rivet" cx={local.u / 2 - lockWidth * .36} cy={hardwareY} r="2" />
                      <circle className="stack-rivet" cx={local.u / 2 + lockWidth * .36} cy={hardwareY} r="2" />
                    </g>
                  </g>}

                  {face.faceIndex === 1 && isHardCase && (() => {
                    const handleWidth = Math.min(180, local.u * .33);
                    const handleY = Math.max(trim + 18, Math.min(local.v * .21, local.v - trim - 42));
                    const left = local.u / 2 - handleWidth / 2;
                    const right = local.u / 2 + handleWidth / 2;
                    return <g className={`stack-top-handle ${hardwareFinish}`}>
                      <rect className="stack-metal" x={left - 12} y={handleY - 9} width="24" height="18" rx="5" />
                      <rect className="stack-metal" x={right - 12} y={handleY - 9} width="24" height="18" rx="5" />
                      <path className="stack-handle-shadow" d={`M${left} ${handleY}C${left + handleWidth * .18} ${handleY + 43} ${right - handleWidth * .18} ${handleY + 43} ${right} ${handleY}`} />
                      <path className="stack-handle-body" d={`M${left} ${handleY}C${left + handleWidth * .18} ${handleY + 43} ${right - handleWidth * .18} ${handleY + 43} ${right} ${handleY}`} />
                      <path className="stack-handle-highlight" d={`M${left + 8} ${handleY + 3}C${left + handleWidth * .22} ${handleY + 32} ${right - handleWidth * .22} ${handleY + 32} ${right - 8} ${handleY + 3}`} />
                    </g>;
                  })()}

                  <rect className="stack-face-outline" width={local.u} height={local.v} />
                </g>
              </g>
            );
          })}
        </g>

        {pieces.map((piece) => {
          const topFace = cubeFaces[1].map((index) => pieceVertices[piece.id][index]);
          return (
            <polygon
              key={`hit-${piece.id}`}
              className={`stack-keyboard-hit ${piece.id === base.id ? "is-fixed" : ""}`}
              points={pointString(topFace)}
              tabIndex={0}
              role="button"
              aria-pressed={selected === piece.id}
              aria-label={`${piece.name} ${piece.model}${piece.id === base.id ? "，底層固定" : "，可用方向鍵移動"}`}
              onPointerDown={(event) => onPieceDown(event, piece.id)}
              onFocus={() => onSelect(piece.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(piece.id); return; }
                if (piece.id === base.id) return;
                const step = event.shiftKey ? 1 : 5;
                if (event.key === "ArrowLeft") { event.preventDefault(); onNudge(piece.id, -step, 0); }
                if (event.key === "ArrowRight") { event.preventDefault(); onNudge(piece.id, step, 0); }
                if (event.key === "ArrowUp") { event.preventDefault(); onNudge(piece.id, 0, -step); }
                if (event.key === "ArrowDown") { event.preventDefault(); onNudge(piece.id, 0, step); }
              }}
            />
          );
        })}

        <g className="stack-dimension-line" aria-hidden="true">
          {(() => {
            const lineX = sceneMetrics.bounds.maxX + 55;
            const lineY = sceneMetrics.bounds.minY;
            const bottom = project([lineX, lineY, 0]);
            const top = project([lineX, lineY, sceneMetrics.bounds.maxZ]);
            return <><line x1={bottom.x} y1={bottom.y} x2={top.x} y2={top.y} /><text x={top.x + 12} y={(top.y + bottom.y) / 2}>總高 {format(sceneMetrics.footprint.z, 0)} mm</text></>;
          })()}
        </g>
      </svg>
      <div className="stack-scene-labels">
        <span>真實尺寸比例 · 1 個共同座標系</span>
        <strong>{format(sceneMetrics.footprint.x, 0)} × {format(sceneMetrics.footprint.y, 0)} × {format(sceneMetrics.footprint.z, 0)} mm</strong>
      </div>
      <div className="stack-gesture-hint">拖箱面移動 · 拖空白處旋轉 · 最底層固定</div>
    </div>
  );
}

function ReportElevation({ pieces, positions }: { pieces: TowerPiece[]; positions: Positions }) {
  const metrics = computeTowerMetrics(pieces, positions);
  const frontScale = Math.min(330 / Math.max(1, metrics.footprint.x), 255 / Math.max(1, metrics.footprint.z));
  const topScale = Math.min(330 / Math.max(1, metrics.footprint.x), 255 / Math.max(1, metrics.footprint.y));
  return (
    <svg className="report-elevation" viewBox="0 0 800 380" role="img" aria-label="疊塔真實比例正視圖與俯視佔地圖">
      <defs>
        <pattern id="report-graphite" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#303234" /><rect width="10" height="10" fill="#4a4c4f" /><rect x="10" y="10" width="10" height="10" fill="#4a4c4f" /></pattern>
        <pattern id="report-white" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#f3f0e8" /><rect width="10" height="10" fill="#ddd9cf" /><rect x="10" y="10" width="10" height="10" fill="#ddd9cf" /></pattern>
        <pattern id="report-eclipse" width="42" height="28" patternUnits="userSpaceOnUse"><rect width="42" height="28" fill="#2c2927" /><text x="8" y="19" style={{ fill: "#8a8179" }} fontSize="11" fontWeight="700">LV</text></pattern>
        <pattern id="report-classic" width="42" height="28" patternUnits="userSpaceOnUse"><rect width="42" height="28" fill="#65452f" /><text x="8" y="19" style={{ fill: "#d0ad73" }} fontSize="11" fontWeight="700">LV</text></pattern>
        <pattern id="report-neutral" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#aeb4bc" /><path d="M0 20L20 0" stroke="#cbd0d6" strokeWidth="1" /></pattern>
      </defs>
      <text className="report-view-title" x="30" y="28">正視圖 · X / Z</text>
      <text className="report-view-title" x="430" y="28">俯視佔地 · X / Y</text>
      <line x1="30" y1="330" x2="370" y2="330" className="report-baseline" />
      <rect x="420" y="38" width="350" height="292" rx="8" className="report-top-frame" />
      {pieces.map((piece, index) => {
        const position = positions[piece.id];
        const frontX = 30 + (position.x - piece.dimensions.x / 2 - metrics.bounds.minX) * frontScale;
        const frontY = 330 - (position.z + piece.dimensions.z) * frontScale;
        const frontWidth = piece.dimensions.x * frontScale;
        const frontHeight = piece.dimensions.z * frontScale;
        const topX = 430 + (position.x - piece.dimensions.x / 2 - metrics.bounds.minX) * topScale;
        const topY = 48 + (position.y - piece.dimensions.y / 2 - metrics.bounds.minY) * topScale;
        const topWidth = piece.dimensions.x * topScale;
        const topHeight = piece.dimensions.y * topScale;
        return <g key={piece.id}><rect x={frontX} y={frontY} width={frontWidth} height={frontHeight} rx="3" fill={`url(#report-${piece.canvas})`} /><text x={frontX + frontWidth / 2} y={Math.max(42, frontY - 6)} textAnchor="middle">{index + 1}. {piece.name}</text><rect x={topX} y={topY} width={topWidth} height={topHeight} rx="3" fill={`url(#report-${piece.canvas})`} /><text className="report-top-label" x={topX + topWidth / 2} y={topY + topHeight / 2} textAnchor="middle">{index + 1}</text></g>;
      })}
    </svg>
  );
}

function SpecificationReport({ project, metrics, timestamp }: { project: TowerProject; metrics: ReturnType<typeof computeTowerMetrics>; timestamp: number }) {
  return (
    <section className="print-report">
      <header className="report-header">
        <div><span>SPATIAL FIT PRO</span><h1>{project.name}</h1><p>{project.clientName ? `客戶：${project.clientName}` : "客戶：—"}</p></div>
        <div className={metrics.fullySupported ? "report-status is-good" : "report-status is-warning"}><small>幾何判定</small><strong>{metrics.fullySupported ? "完整承托" : metrics.allStacked ? "有箱體超出" : "尚未完成疊放"}</strong><span>{timestamp ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(timestamp) : "尚未輸出"}</span></div>
      </header>
      <div className="report-summary"><div><span>整體佔地</span><strong>{format(metrics.footprint.x, 0)} × {format(metrics.footprint.y, 0)} mm</strong></div><div><span>最高點</span><strong>{format(metrics.footprint.z, 0)} mm</strong></div><div><span>層數</span><strong>{project.pieces.length}</strong></div><div><span>最小承托邊距</span><strong>{metrics.minMargin === null ? "—" : `${format(metrics.minMargin)} mm`}</strong></div></div>
      <ReportElevation pieces={project.pieces} positions={project.positions} />
      <table className="report-table">
        <thead><tr><th>層級</th><th>品項／型號</th><th>尺寸（mm）</th><th>表面</th><th>偏移 X / Y</th><th>支承結果</th></tr></thead>
        <tbody>{metrics.layers.map((metric, index) => {
          const position = project.positions[metric.piece.id];
          const margin = metric.margins ? Math.min(...Object.values(metric.margins)) : null;
          return <tr key={metric.piece.id}><td>{index + 1}</td><td><strong>{metric.piece.name}</strong><br />{metric.piece.model || "—"}</td><td>{format(metric.piece.dimensions.x, 0)} × {format(metric.piece.dimensions.y, 0)} × {format(metric.piece.dimensions.z, 0)}</td><td>{CANVAS_LABELS[metric.piece.canvas]}</td><td>{format(position.x)} / {format(position.y)} mm</td><td>{index === 0 ? "固定底層" : !metric.stacked ? "尚未疊上" : metric.supported ? `完整承托 · 最小 ${format(margin ?? 0)} mm` : `有超出 · ${format(margin ?? 0)} mm`}</td></tr>;
        })}</tbody>
      </table>
      {project.notes && <div className="report-notes"><strong>專案備註</strong><p>{project.notes}</p></div>}
      <footer className="report-disclaimer">獨立尺寸視覺化工具，非 Louis Vuitton 官方或授權服務；外箱毫米比例與承托面依輸入值計算，帆布裁片落位、皮邊、把手與五金為近似示意。結果不代表承重、結構強度或品牌認證，實物公差仍須現場確認。</footer>
    </section>
  );
}

export default function TowerStudio() {
  const [store, setStore] = useState<TowerStore>(createDefaultStore);
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<PieceId>("watch");
  const [announcement, setAnnouncement] = useState("三層已完全置中");
  const [saveStatus, setSaveStatus] = useState("準備自動儲存");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionName, setVersionName] = useState("");
  const [draftPiece, setDraftPiece] = useState<TowerPiece | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [reportTimestamp, setReportTimestamp] = useState(0);
  const storeRef = useRef(store);
  const activeModal = draftPiece ? "piece" : libraryOpen ? "library" : versionOpen ? "version" : shareOpen ? "share" : "";

  const project = store.projects.find((candidate) => candidate.id === store.activeProjectId) ?? store.projects[0];
  const pieces = project.pieces;
  const positions = project.positions;
  const view = project.view;
  const snapEnabled = project.snapEnabled;
  const safeSelected = pieces.some((piece) => piece.id === selected) ? selected : pieces[pieces.length - 1].id;
  const selectedPiece = pieces.find((piece) => piece.id === safeSelected) ?? pieces[0];
  const selectedIndex = pieces.findIndex((piece) => piece.id === safeSelected);
  const metrics = useMemo(() => computeTowerMetrics(pieces, positions), [pieces, positions]);
  const centered = metrics.allStacked && pieces.every((piece, index) => index === 0 || (Math.abs(positions[piece.id].x - positions[pieces[index - 1].id].x) < 0.01 && Math.abs(positions[piece.id].y - positions[pieces[index - 1].id].y) < 0.01));
  const baseFront = positions[pieces[0].id].y - pieces[0].dimensions.y / 2;
  const frontAligned = metrics.allStacked && pieces.every((piece) => Math.abs((positions[piece.id].y - piece.dimensions.y / 2) - baseFront) < 0.01);
  const activeCanvasScheme = CANVAS_SCHEMES.find(({ id }) => pieces.every((piece, index) => piece.canvas === canvasForScheme(id, index, pieces.length)))?.id;

  const updateActive = (updater: (current: TowerProject) => TowerProject) => {
    setSaveStatus("儲存中…");
    setStore((current) => ({
      ...current,
      projects: current.projects.map((candidate) => {
        if (candidate.id !== current.activeProjectId) return candidate;
        const updated = updater(candidate);
        return updated === candidate ? candidate : { ...updated, updatedAt: Date.now() };
      }),
    }));
  };

  const setPositions = (updater: Positions | ((current: Positions) => Positions)) => {
    updateActive((current) => ({ ...current, positions: typeof updater === "function" ? updater(current.positions) : updater }));
  };

  const setView = (next: TowerView) => updateActive((current) => ({ ...current, view: next }));

  const setPieceCanvas = (id: PieceId, canvas: BuyingCanvas) => {
    const target = pieces.find((piece) => piece.id === id);
    if (!target || target.canvas === canvas) return;
    updateActive((current) => ({
      ...current,
      pieces: current.pieces.map((piece) => piece.id === id ? { ...piece, canvas } : piece),
    }));
    setAnnouncement(`${target.name} 已切換為 ${BUYING_CANVASES.find((choice) => choice.value === canvas)?.label}`);
  };

  const applyCanvasScheme = (scheme: CanvasScheme) => {
    updateActive((current) => ({
      ...current,
      pieces: current.pieces.map((piece, index) => ({ ...piece, canvas: canvasForScheme(scheme, index, current.pieces.length) })),
    }));
    setAnnouncement(`已套用「${CANVAS_SCHEMES.find((choice) => choice.id === scheme)?.label}」花色方案；尺寸與位置維持不變`);
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      let nextStore = createDefaultStore();
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored) nextStore = sanitizeStore(JSON.parse(stored)) ?? nextStore;
      } catch {
        setSaveStatus("瀏覽器未允許讀取本機專案");
      }
      const hash = window.location.hash;
      if (hash.startsWith("#p=sf1.")) {
        try {
          if (hash.length > 8000) throw new Error("too long");
          const imported = projectFromShare(decodeBase64Url(hash.slice(7)));
          if (!imported) throw new Error("invalid");
          const retained = nextStore.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PROJECTS - 1);
          nextStore = { ...nextStore, activeProjectId: imported.id, projects: [...retained, imported] };
          setSelected(imported.pieces[imported.pieces.length - 1].id);
          setAnnouncement("分享連結已匯入為新的本機副本");
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        } catch {
          setAnnouncement("這個分享連結無效或版本不相容，已保留原本專案");
        }
      }
      const now = Date.now();
      nextStore = { ...nextStore, projects: nextStore.projects.map((candidate) => ({ ...candidate, createdAt: candidate.createdAt || now, updatedAt: candidate.updatedAt || now })) };
      setStore(nextStore);
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => {
    if (!hydrated) return;
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        setSaveStatus("已自動儲存於此裝置");
      } catch {
        setSaveStatus("無法儲存；仍可繼續操作與分享");
      }
    }, 450);
    return () => window.clearTimeout(timeout);
  }, [hydrated, store]);

  useEffect(() => {
    const flushStore = () => {
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storeRef.current)); } catch { /* Keep the current in-memory project usable. */ }
    };
    window.addEventListener("pagehide", flushStore);
    return () => {
      window.removeEventListener("pagehide", flushStore);
      flushStore();
    };
  }, []);

  useEffect(() => {
    if (!activeModal) return;
    const dialog = document.querySelector<HTMLElement>(".sheet-backdrop [role='dialog']");
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = [document.querySelector<HTMLElement>(".topbar"), document.querySelector<HTMLElement>(".tower-screen")].filter(Boolean) as HTMLElement[];
    background.forEach((element) => element.setAttribute("inert", ""));
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"));
    const animationFrame = window.requestAnimationFrame(() => (dialog.querySelector<HTMLElement>("[autofocus]") ?? getFocusable()[0] ?? dialog).focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (activeModal === "piece") setDraftPiece(null);
        if (activeModal === "library") setLibraryOpen(false);
        if (activeModal === "version") setVersionOpen(false);
        if (activeModal === "share") setShareOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      background.forEach((element) => element.removeAttribute("inert"));
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [activeModal]);

  const movePiece = (id: PieceId, next: Position) => {
    updateActive((current) => {
      const index = current.pieces.findIndex((piece) => piece.id === id);
      if (index <= 0) return current;
      const previous = current.positions[id];
      const delta = { x: next.x - previous.x, y: next.y - previous.y, z: next.z - previous.z };
      let chainEnd = index;
      for (let cursor = index + 1; cursor < current.pieces.length; cursor += 1) {
        const support = current.pieces[cursor - 1];
        const child = current.pieces[cursor];
        const touching = Math.abs(current.positions[child.id].z - (current.positions[support.id].z + support.dimensions.z)) < 0.5;
        const overlapping = supportCoverage(child, current.positions[child.id], support, current.positions[support.id]) >= 0.35;
        if (!touching || !overlapping) break;
        chainEnd = cursor;
      }
      const updated = { ...current.positions };
      updated[id] = next;
      for (let cursor = index + 1; cursor <= chainEnd; cursor += 1) {
        const piece = current.pieces[cursor];
        const position = current.positions[piece.id];
        updated[piece.id] = { x: position.x + delta.x, y: position.y + delta.y, z: position.z + delta.z };
      }
      return { ...current, positions: updated };
    });
  };

  const dropPiece = (id: PieceId, dropped: Position) => {
    const index = pieces.findIndex((piece) => piece.id === id);
    if (index <= 0) return;
    const piece = pieces[index];
    const support = pieces[index - 1];
    const supportPosition = positions[support.id];
    const closeToCenter = Math.abs(dropped.x - supportPosition.x) <= 45 && Math.abs(dropped.y - supportPosition.y) <= 45;
    const landedX = snapEnabled && closeToCenter ? supportPosition.x : dropped.x;
    const landedY = snapEnabled && closeToCenter ? supportPosition.y : dropped.y;
    const coverage = supportCoverage(piece, { ...dropped, x: landedX, y: landedY }, support, supportPosition);
    const landed = {
      x: landedX,
      y: landedY,
      z: coverage >= 0.35 ? supportPosition.z + support.dimensions.z : 0,
    };
    movePiece(id, landed);
    setAnnouncement(coverage >= 0.35 ? `${piece.name} 已落在 ${support.name}${closeToCenter && snapEnabled ? "並磁吸置中" : "上"}` : `${piece.name} 已離開支承面，回到地面`);
  };

  const nudgePiece = (id: PieceId, dx: number, dy: number) => {
    const current = positions[id];
    dropPiece(id, { ...current, x: current.x + dx, y: current.y + dy });
  };

  const applyCentered = () => {
    setPositions(buildCenteredPositions(pieces));
    setView("perspective");
    setAnnouncement(`${pieces.length} 層已完全置中`);
  };

  const applyFrontAligned = () => {
    setPositions(buildFrontAlignedPositions(pieces));
    setView("perspective");
    setAnnouncement(`${pieces.length} 層已左右置中並前緣齊平`);
  };

  const centerSelected = () => {
    if (selectedIndex <= 0) return;
    const support = pieces[selectedIndex - 1];
    const supportPosition = positions[support.id];
    dropPiece(safeSelected, { x: supportPosition.x, y: supportPosition.y, z: supportPosition.z + support.dimensions.z });
    setAnnouncement(`${selectedPiece.name} 已置中疊上`);
  };

  const scatterPieces = () => {
    const spread = Math.max(...pieces.map((piece) => piece.dimensions.x)) * 0.72;
    const scattered = Object.fromEntries(pieces.map((piece, index) => [piece.id, index === 0 ? { x: 0, y: 0, z: 0 } : { x: (index % 2 ? -1 : 1) * spread * Math.ceil(index / 2), y: (index % 3 - 1) * spread * 0.5, z: 0 }])) as Positions;
    setPositions(scattered);
    setSelected(pieces[Math.min(1, pieces.length - 1)].id);
    setView("perspective");
    setAnnouncement("箱件已拆開；請拖動它們疊回去");
  };

  const openNewPiece = () => {
    setDraftPiece({ id: makeId("piece"), name: "自訂箱件", model: "CUSTOM", dimensions: { x: 400, y: 300, z: 150 }, canvas: "neutral" });
    setDraftIsNew(true);
    setEditorError("");
  };

  const openEditPiece = (piece: TowerPiece) => {
    setDraftPiece({ ...piece, dimensions: { ...piece.dimensions } });
    setDraftIsNew(false);
    setEditorError("");
  };

  const savePiece = () => {
    if (!draftPiece) return;
    if (!draftPiece.name.trim() || Object.values(draftPiece.dimensions).some((value) => !Number.isFinite(value) || value < 1 || value > 10000)) {
      setEditorError("請輸入名稱，且每個尺寸須為 1–10,000 mm。");
      return;
    }
    if (draftIsNew && pieces.length >= MAX_PIECES) {
      setEditorError(`每個專案最多 ${MAX_PIECES} 件。`);
      return;
    }
    const clean = { ...draftPiece, name: draftPiece.name.trim().slice(0, 60), model: draftPiece.model.trim().slice(0, 40) };
    updateActive((current) => {
      const nextPieces = draftIsNew ? [...current.pieces, clean] : current.pieces.map((piece) => piece.id === clean.id ? clean : piece);
      return { ...current, pieces: nextPieces, positions: buildCenteredPositions(nextPieces) };
    });
    setSelected(clean.id);
    setDraftPiece(null);
    setAnnouncement(`${clean.name} 已${draftIsNew ? "加入" : "更新"}；層序已重新置中`);
  };

  const reorderPiece = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= pieces.length) return;
    const reordered = [...pieces];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    updateActive((current) => ({ ...current, pieces: reordered, positions: buildCenteredPositions(reordered) }));
    setSelected(reordered[target].id);
    setAnnouncement("層序已更新並重新置中");
  };

  const deletePiece = (piece: TowerPiece) => {
    if (pieces.length === 1) { setAnnouncement("專案至少要保留一件箱件"); return; }
    if (!window.confirm(`確定要刪除「${piece.name}」嗎？`)) return;
    const nextPieces = pieces.filter((candidate) => candidate.id !== piece.id);
    updateActive((current) => ({ ...current, pieces: nextPieces, positions: buildCenteredPositions(nextPieces) }));
    setSelected(nextPieces[nextPieces.length - 1].id);
    setAnnouncement(`${piece.name} 已刪除`);
  };

  const resetLvPreset = () => {
    if (!window.confirm("要以推薦的 Alzer 65／Bisten 50／M10262 取代目前箱件嗎？")) return;
    const nextPieces = clonePieces(DEFAULT_PIECES);
    updateActive((current) => ({ ...current, pieces: nextPieces, positions: buildCenteredPositions(nextPieces), view: "perspective", snapEnabled: true }));
    setSelected("watch");
    setAnnouncement("已回復推薦 LV 三層組合");
  };

  const createNewProject = () => {
    if (store.projects.length >= MAX_PROJECTS) {
      setAnnouncement(`此裝置最多保存 ${MAX_PROJECTS} 個專案；請先在專案庫刪除不需要的專案。`);
      setLibraryOpen(true);
      return;
    }
    const now = Date.now();
    const next = createProject(`新疊塔 ${store.projects.length + 1}`, DEFAULT_PIECES, makeId("project"));
    next.createdAt = now;
    next.updatedAt = now;
    setStore((current) => ({ ...current, activeProjectId: next.id, projects: [...current.projects, next] }));
    setSelected(next.pieces[next.pieces.length - 1].id);
    setLibraryOpen(false);
    setAnnouncement("已建立新的本機專案");
  };

  const openProject = (id: string) => {
    const target = store.projects.find((candidate) => candidate.id === id);
    if (!target) return;
    setStore((current) => ({ ...current, activeProjectId: id }));
    setSelected(target.pieces[target.pieces.length - 1].id);
    setLibraryOpen(false);
    setAnnouncement(`已開啟 ${target.name}`);
  };

  const deleteProject = (id: string) => {
    const target = store.projects.find((candidate) => candidate.id === id);
    if (!target || !window.confirm(`確定要刪除專案「${target.name}」嗎？`)) return;
    setStore((current) => {
      const remaining = current.projects.filter((candidate) => candidate.id !== id);
      if (remaining.length) return { ...current, activeProjectId: current.activeProjectId === id ? remaining[0].id : current.activeProjectId, projects: remaining };
      const replacement = createProject("我的 LV 三層塔", DEFAULT_PIECES, makeId("project"));
      replacement.createdAt = Date.now();
      replacement.updatedAt = replacement.createdAt;
      return { ...current, activeProjectId: replacement.id, projects: [replacement] };
    });
    setAnnouncement("專案已從此裝置刪除");
  };

  const saveNamedVersion = () => {
    const label = versionName.trim() || `版本 ${project.versions.length + 1}`;
    const version: SavedVersion = { id: makeId("version"), label: label.slice(0, 60), createdAt: Date.now(), snapshot: snapshotOf(project) };
    updateActive((current) => ({ ...current, versions: [...current.versions, version].slice(-MAX_VERSIONS) }));
    setVersionName("");
    setVersionOpen(false);
    setAnnouncement(`已儲存版本「${version.label}」`);
  };

  const restoreVersion = (projectId: string, version: SavedVersion) => {
    setStore((current) => ({
      ...current,
      activeProjectId: projectId,
      projects: current.projects.map((candidate) => candidate.id === projectId ? { ...candidate, ...version.snapshot, updatedAt: Date.now() } : candidate),
    }));
    setSelected(version.snapshot.pieces[version.snapshot.pieces.length - 1].id);
    setLibraryOpen(false);
    setAnnouncement(`已載入版本「${version.label}」`);
  };

  const deleteVersion = (projectId: string, versionId: string) => {
    setStore((current) => ({ ...current, projects: current.projects.map((candidate) => candidate.id === projectId ? { ...candidate, versions: candidate.versions.filter((version) => version.id !== versionId) } : candidate) }));
  };

  const handleShare = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}${window.location.search}#p=sf1.${encodeBase64Url(sharePayload(project))}`;
      if (url.length > 8000) throw new Error("too long");
      setShareUrl(url);
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title: project.name, text: "查看這個真實比例疊塔配置", url });
          setAnnouncement("分享面板已完成");
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        setAnnouncement("分享連結已複製；客戶名稱與備註不會寫入連結");
      } catch {
        setAnnouncement("請從視窗手動複製分享連結");
      }
      setShareOpen(true);
    } catch {
      setAnnouncement("目前內容太大，無法製作分享連結");
    }
  };

  const printReport = () => {
    setReportTimestamp(Date.now());
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()));
  };

  const formatProjectDate = (timestamp: number) => timestamp ? new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp) : "剛建立";

  return (
    <>
      <div className="tower-screen">
        <section className="project-command-bar" aria-label="專案工具列">
          <div className="project-identity">
            <span>專案</span>
            <input aria-label="專案名稱" value={project.name} maxLength={80} onChange={(event) => updateActive((current) => ({ ...current, name: event.target.value }))} />
            <small role="status" aria-live="polite"><i className="save-dot" />{saveStatus}</small>
          </div>
          <div className="project-actions">
            <button type="button" onClick={createNewProject}>新增專案</button>
            <button type="button" onClick={() => setLibraryOpen(true)}>專案庫 <span>{store.projects.length}</span></button>
            <button type="button" onClick={() => setVersionOpen(true)}>儲存版本</button>
            <button type="button" className="command-primary" onClick={handleShare}>分享</button>
            <button type="button" onClick={printReport}>列印／儲存 PDF</button>
          </div>
        </section>

        <section className="intro tower-intro" id="tower-top">
          <div>
            <p className="eyebrow">TRUE-SCALE STACK CONFIGURATOR</p>
            <h1>真實比例疊塔，<br />現在可以交付。</h1>
            <p className="intro-copy">保留你的 Alzer、Bisten 與 M10262，也能加入任何自訂箱件。尺寸、層序、花色與承托判定會同步進入分享連結和客戶報告。</p>
          </div>
          <div className={`verdict ${metrics.fullySupported ? "verdict-fit" : metrics.allStacked ? "verdict-critical" : "verdict-fail"}`} aria-live="polite">
            <span className="verdict-label">目前 {pieces.length} 層幾何判定</span>
            <strong>{metrics.fullySupported ? "完整承托，可以這樣疊" : !metrics.allStacked ? "尚未完成全部疊放" : "有箱體超出下層"}</strong>
            <p>{centered ? `目前每層完全置中；最小承托邊距 ${metrics.minMargin === null ? "—" : `${format(metrics.minMargin)} mm`}。` : frontAligned ? "目前為左右置中、所有前緣齊平。" : !metrics.allStacked ? "拖動箱體靠近下層；放手後會自動落下並可磁吸置中。" : `目前最小承托邊距為 ${format(metrics.minMargin ?? 0)} mm。`}</p>
          </div>
        </section>

        <div className="tower-workspace">
          <aside className="tower-sidebar">
            <section className="panel tower-inventory">
              <div className="panel-heading"><span>01</span><div><h2>箱件與層序</h2><p>底層固定；其餘可拖拉、編輯與排序。</p></div></div>
              <div className="tower-piece-list dynamic-list">
                {pieces.map((piece, index) => ({ piece, index })).reverse().map(({ piece, index }) => (
                  <div className={`piece-row ${safeSelected === piece.id ? "is-selected" : ""}`} key={piece.id}>
                    <button type="button" className="piece-select" onClick={() => setSelected(piece.id)} aria-pressed={safeSelected === piece.id}>
                      <span className={`canvas-swatch canvas-${piece.canvas}`} />
                      <span className="piece-copy"><small>{tierLabel(index, pieces.length)} · {piece.model || "無型號"}</small><strong>{piece.name}</strong><span>{format(piece.dimensions.x / 10)} × {format(piece.dimensions.y / 10)} × {format(piece.dimensions.z / 10)} cm</span></span>
                    </button>
                    <div className="piece-row-actions">
                      <button type="button" onClick={() => reorderPiece(index, 1)} disabled={index === pieces.length - 1} aria-label={`${piece.name} 往上移一層`}>↑</button>
                      <button type="button" onClick={() => reorderPiece(index, -1)} disabled={index === 0} aria-label={`${piece.name} 往下移一層`}>↓</button>
                      <button type="button" onClick={() => openEditPiece(piece)} aria-label={`編輯 ${piece.name}`}>編輯</button>
                      <button type="button" className="danger-text" onClick={() => deletePiece(piece)} aria-label={`刪除 ${piece.name}`}>刪除</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="inventory-actions"><button type="button" className="command-primary" onClick={openNewPiece} disabled={pieces.length >= MAX_PIECES}>＋ 加入箱件</button><button type="button" onClick={resetLvPreset}>回復 LV 三層範本</button></div>
            </section>

            <section className="panel tower-material-panel">
              <div className="panel-heading"><span>02</span><div><h2>花色比較</h2><p>整組快速切換，也能逐層自己選。</p></div></div>
              <div className="scheme-compare" role="group" aria-label="快速比較三種花色方案">
                {CANVAS_SCHEMES.map((scheme) => (
                  <button type="button" key={scheme.id} className={activeCanvasScheme === scheme.id ? "active" : ""} aria-pressed={activeCanvasScheme === scheme.id} onClick={() => applyCanvasScheme(scheme.id)}>
                    <span className="scheme-mini-stack" aria-hidden="true">
                      {[2, 1, 0].map((layer) => <i key={layer} className={`canvas-${canvasForScheme(scheme.id, layer, 3)}`} />)}
                    </span>
                    <span><strong>{scheme.label}</strong><small>{scheme.detail}</small></span>
                  </button>
                ))}
              </div>
              <div className="material-layer-list">
                {pieces.map((piece, index) => ({ piece, index })).reverse().map(({ piece, index }) => (
                  <div className="material-layer" key={`material-${piece.id}`}>
                    <div><span>{tierLabel(index, pieces.length)}</span><strong>{piece.name}</strong><small>{piece.model || "無型號"}</small></div>
                    <div className="material-segmented" role="group" aria-label={`${piece.name} 花色`}>
                      {BUYING_CANVASES.map((choice) => (
                        <button type="button" key={choice.value} className={piece.canvas === choice.value ? "active" : ""} aria-pressed={piece.canvas === choice.value} aria-label={`${piece.name} 選擇${choice.label}`} onClick={() => setPieceCanvas(piece.id, choice.value)}>
                          <i className={`canvas-swatch canvas-${choice.value}`} aria-hidden="true" />
                          <span><strong>{choice.label}</strong><small>{choice.english}</small></span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="material-buying-note">花色切換只改視覺方案，不改尺寸、位置、櫃姐報價或訂單型號。帆布裁片落位、皮邊與五金反光仍以實物為準。</p>
            </section>

            <section className="panel client-panel">
              <div className="panel-heading"><span>03</span><div><h2>客戶報告資料</h2><p>只保存在此裝置，不會加入分享連結。</p></div></div>
              <label><span>客戶名稱</span><input value={project.clientName} maxLength={80} placeholder="選填" onChange={(event) => updateActive((current) => ({ ...current, clientName: event.target.value }))} /></label>
              <label><span>專案備註</span><textarea value={project.notes} maxLength={500} rows={3} placeholder="入口、承重或現場公差提醒…" onChange={(event) => updateActive((current) => ({ ...current, notes: event.target.value }))} /></label>
            </section>

            <section className="panel tower-measure-panel">
              <span className="section-kicker">PHYSICAL RESULT</span><h2>目前實際佔地與高度</h2>
              <div className="tower-measures"><div><span>整體佔地</span><strong>{format(metrics.footprint.x / 10)} × {format(metrics.footprint.y / 10)} cm</strong></div><div><span>最高點</span><strong>{format(metrics.footprint.z / 10)} cm</strong></div><div><span>層數</span><strong>{pieces.length} 層</strong></div><div><span>最小承托</span><strong>{metrics.minMargin === null ? "—" : `${format(metrics.minMargin)} mm`}</strong></div></div>
            </section>

            <section className="panel tower-drag-panel">
              <div className="drag-panel-row"><div><span className="section-kicker">MAGNETIC SNAP</span><strong>自動吸附置中</strong></div><button type="button" className={`snap-toggle ${snapEnabled ? "active" : ""}`} onClick={() => updateActive((current) => ({ ...current, snapEnabled: !current.snapEnabled }))} aria-pressed={snapEnabled}>{snapEnabled ? "開啟" : "關閉"}</button></div>
              <p>拖動任一非底層箱件；它上方仍相連的層會一起移動，避免穿模。</p>
              <div className="selected-offsets"><span>選取：{selectedPiece.name}{selectedIndex === 0 ? "（固定）" : ""}</span><strong>X {format(positions[safeSelected].x)} · Y {format(positions[safeSelected].y)} mm</strong></div>
            </section>
          </aside>

          <section className="tower-main">
            <div className="panel stack-visual-panel">
              <div className="stack-toolbar">
                <div><span className="section-kicker">LIVE 3D COMPOSITION</span><strong>{selectedPiece.name} {selectedPiece.model} · {CANVAS_LABELS[selectedPiece.canvas]}</strong></div>
                <div className="view-buttons" role="group" aria-label="疊塔觀看角度">
                  {([["perspective", "透視"], ["front", "正面"], ["side", "側面"], ["top", "俯視"]] as [TowerView, string][]).map(([choice, label]) => <button key={choice} type="button" className={view === choice ? "active" : ""} aria-pressed={view === choice} onClick={() => setView(choice)}>{label}</button>)}
                </div>
              </div>
              <StackScene key={view} pieces={pieces} positions={positions} view={view} selected={safeSelected} snapEnabled={snapEnabled} onSelect={setSelected} onMove={movePiece} onDrop={dropPiece} onNudge={nudgePiece} />
              <div className="stack-actions"><button type="button" className={centered ? "primary active" : "primary"} onClick={applyCentered}>一鍵完全置中</button><button type="button" onClick={centerSelected} disabled={selectedIndex === 0}>選取層置中疊上</button><button type="button" className={frontAligned ? "active" : ""} onClick={applyFrontAligned}>所有前緣齊平</button><button type="button" onClick={scatterPieces} disabled={pieces.length < 2}>拆開後自己拖</button><span className="sr-only" aria-live="polite">{announcement}</span></div>
            </div>

            <div className="stack-result-grid dynamic-results">
              {metrics.layers.slice(1).map((metric, index) => {
                const minHorizontal = metric.margins ? Math.min(metric.margins.left, metric.margins.right) : 0;
                const minDepth = metric.margins ? Math.min(metric.margins.front, metric.margins.back) : 0;
                return <section className="panel stack-result-card" key={metric.piece.id}><span className="section-kicker">LAYER {String(index + 2).padStart(2, "0")} / {String(index + 1).padStart(2, "0")}</span><h2>{metric.piece.name} 疊在 {metric.support?.name}</h2><div className="support-diagram"><span>左右 {format(minHorizontal)} mm</span><strong className={metric.supported ? "is-good" : "is-warning"}>{!metric.stacked ? "尚未疊上" : metric.supported ? "完整承托" : "有超出"}</strong><span>前後 {format(minDepth)} mm</span></div></section>;
              })}
              {metrics.layers.length === 1 && <section className="panel stack-result-card empty-result"><span className="section-kicker">START HERE</span><h2>目前只有底層</h2><p>加入第二件箱件後，這裡會顯示完整承托邊距。</p></section>}
            </div>
            <p className="commercial-note">幾何結果不等於承重安全；正式展示前仍應確認箱體結構、五金、入口路徑與實物公差。</p>
          </section>
        </div>
      </div>

      <SpecificationReport project={project} metrics={metrics} timestamp={reportTimestamp} />

      {draftPiece && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraftPiece(null); }}><section className="editor-sheet" role="dialog" aria-modal="true" aria-labelledby="piece-editor-title"><header><div><span className="section-kicker">ITEM EDITOR</span><h2 id="piece-editor-title">{draftIsNew ? "加入箱件" : `編輯 ${draftPiece.name}`}</h2></div><button type="button" className="sheet-close" onClick={() => setDraftPiece(null)} aria-label="關閉">×</button></header><div className="preset-strip"><span>快速套用 LV 範本</span><div>{PIECE_PRESETS.map((preset) => <button key={`${preset.model}-${preset.canvas}`} type="button" onClick={() => setDraftPiece((current) => current ? { ...current, name: preset.name, model: preset.model, dimensions: { ...preset.dimensions }, canvas: preset.canvas } : current)}><i className={`canvas-swatch canvas-${preset.canvas}`} />{preset.name}<small>{preset.model}</small></button>)}</div></div><div className="editor-form"><label><span>名稱</span><input value={draftPiece.name} maxLength={60} onChange={(event) => setDraftPiece({ ...draftPiece, name: event.target.value })} /></label><label><span>型號</span><input value={draftPiece.model} maxLength={40} onChange={(event) => setDraftPiece({ ...draftPiece, model: event.target.value })} /></label><div className="editor-dimensions">{(["x", "y", "z"] as const).map((axis) => <label key={axis}><span>{axis === "x" ? "長 X" : axis === "y" ? "深 Y" : "高 Z"}（mm）</span><input type="number" min="1" max="10000" inputMode="decimal" value={draftPiece.dimensions[axis]} onChange={(event) => setDraftPiece({ ...draftPiece, dimensions: { ...draftPiece.dimensions, [axis]: Number(event.target.value) } })} /></label>)}</div><label><span>表面圖案</span><select value={draftPiece.canvas} onChange={(event) => setDraftPiece({ ...draftPiece, canvas: event.target.value as CanvasStyle })}>{Object.entries(CANVAS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>{editorError && <p className="form-error" role="alert">{editorError}</p>}<footer><button type="button" onClick={() => setDraftPiece(null)}>取消</button><button type="button" className="command-primary" onClick={savePiece}>{draftIsNew ? "加入並置中" : "儲存並重新置中"}</button></footer></section></div>}

      {libraryOpen && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLibraryOpen(false); }}><section className="library-sheet" role="dialog" aria-modal="true" aria-labelledby="library-title"><header><div><span className="section-kicker">ON THIS DEVICE</span><h2 id="library-title">專案庫</h2><p>專案與客戶資料只儲存在這個瀏覽器。</p></div><button type="button" className="sheet-close" onClick={() => setLibraryOpen(false)} aria-label="關閉">×</button></header><div className="project-library-list">{store.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt).map((candidate) => <article key={candidate.id} className={candidate.id === project.id ? "is-active" : ""}><div className="project-library-heading"><div><strong>{candidate.name || "未命名疊塔"}</strong><span>{candidate.pieces.length} 件 · {formatProjectDate(candidate.updatedAt)}</span></div><div><button type="button" className="command-primary" onClick={() => openProject(candidate.id)}>{candidate.id === project.id ? "目前開啟" : "開啟"}</button><button type="button" className="danger-text" onClick={() => deleteProject(candidate.id)}>刪除</button></div></div>{candidate.versions.length > 0 && <div className="version-list"><span>已命名版本</span>{candidate.versions.slice().reverse().map((version) => <div key={version.id}><span><strong>{version.label}</strong><small>{formatProjectDate(version.createdAt)}</small></span><button type="button" onClick={() => restoreVersion(candidate.id, version)}>載入</button><button type="button" className="danger-text" onClick={() => deleteVersion(candidate.id, version.id)}>刪除</button></div>)}</div>}</article>)}</div><footer><button type="button" className="command-primary" onClick={createNewProject}>＋ 新增專案</button></footer></section></div>}

      {versionOpen && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setVersionOpen(false); }}><section className="compact-sheet" role="dialog" aria-modal="true" aria-labelledby="version-title"><header><div><span className="section-kicker">VERSION</span><h2 id="version-title">儲存目前版本</h2></div><button type="button" className="sheet-close" onClick={() => setVersionOpen(false)} aria-label="關閉">×</button></header><label><span>版本名稱</span><input autoFocus value={versionName} maxLength={60} placeholder={`例如：客戶確認版 ${project.versions.length + 1}`} onChange={(event) => setVersionName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveNamedVersion(); }} /></label><p>每個專案保留最近 {MAX_VERSIONS} 個命名版本。</p><footer><button type="button" onClick={() => setVersionOpen(false)}>取消</button><button type="button" className="command-primary" onClick={saveNamedVersion}>儲存版本</button></footer></section></div>}

      {shareOpen && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShareOpen(false); }}><section className="compact-sheet share-sheet" role="dialog" aria-modal="true" aria-labelledby="share-title"><header><div><span className="section-kicker">SHAREABLE CONFIG</span><h2 id="share-title">分享連結已準備好</h2></div><button type="button" className="sheet-close" onClick={() => setShareOpen(false)} aria-label="關閉">×</button></header><p>連結包含箱件、尺寸、圖案與位置；不包含客戶名稱和備註。</p><label><span>分享連結</span><input readOnly value={shareUrl} onFocus={(event) => event.currentTarget.select()} /></label><footer><button type="button" onClick={() => setShareOpen(false)}>完成</button><button type="button" className="command-primary" onClick={async () => { try { await navigator.clipboard.writeText(shareUrl); setAnnouncement("分享連結已複製"); } catch { setAnnouncement("請選取欄位後手動複製"); } }}>複製連結</button></footer></section></div>}
    </>
  );
}
