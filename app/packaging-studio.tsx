"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { safeReleasePointerCapture, safeSetPointerCapture } from "./pointer-capture";

type BagType = "three-seal" | "eight-seal";
type MockupView = "perspective" | "front" | "back" | "side" | "top";
type ArtworkFace = "front" | "back" | "side";
type ArtworkFit = "cover" | "contain";
type Finish = "matte" | "gloss";
type Point3 = [number, number, number];

type Artwork = {
  url: string;
  name: string;
  width: number;
  height: number;
};

type ArtworkTransform = {
  fit: ArtworkFit;
  zoom: number;
  x: number;
  y: number;
  rotation: number;
};

type Dimensions = {
  width: number;
  height: number;
  depth: number;
};

type SceneFace = {
  id: string;
  points: Point3[];
  fill: "front" | "side" | "seal" | "bottom";
  artworkFace?: ArtworkFace;
  artworkCorners?: [Point3, Point3, Point3];
  artworkSize?: { width: number; height: number };
  lines?: Array<[Point3, Point3]>;
};

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_WORK_EDGE = 4096;

const VIEW_CAMERAS: Record<MockupView, { yaw: number; pitch: number }> = {
  perspective: { yaw: -34, pitch: 20 },
  front: { yaw: 0, pitch: 1 },
  back: { yaw: 180, pitch: 1 },
  side: { yaw: -90, pitch: 2 },
  top: { yaw: -34, pitch: 88 },
};

const DEFAULT_TRANSFORM: ArtworkTransform = {
  fit: "cover",
  zoom: 1,
  x: 0,
  y: 0,
  rotation: 0,
};

function format(value: number, digits = 0) {
  return new Intl.NumberFormat("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mixHex(hex: string, target: string, amount: number) {
  const normalize = (value: string) => value.replace("#", "").padEnd(6, "0").slice(0, 6);
  const from = normalize(hex);
  const to = normalize(target);
  const channel = (start: number) => Math.round(parseInt(from.slice(start, start + 2), 16) * (1 - amount) + parseInt(to.slice(start, start + 2), 16) * amount).toString(16).padStart(2, "0");
  return `#${channel(0)}${channel(2)}${channel(4)}`;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = url;
  });
}

async function prepareArtwork(file: File): Promise<Artwork> {
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error("只接受 JPEG、PNG 或 WebP 圖片；不接受 SVG／HEIC。");
  if (file.size > MAX_FILE_BYTES) throw new Error("圖片請控制在 12 MB 以內。");
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    if (image.naturalWidth * image.naturalHeight > MAX_PIXELS) throw new Error("圖片像素過大，請使用 4,000 萬像素以下的檔案。");
    const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (longestEdge <= MAX_WORK_EDGE) {
      return { url: sourceUrl, name: file.name, width: image.naturalWidth, height: image.naturalHeight };
    }
    const scale = MAX_WORK_EDGE / longestEdge;
    const canvas = document.createElement("canvas");
    const processedWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const processedHeight = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.width = processedWidth;
    canvas.height = processedHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("這台裝置無法建立圖片工作區。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type === "image/png" ? "image/png" : "image/jpeg", 0.9));
    canvas.width = 1;
    canvas.height = 1;
    if (!blob) throw new Error("圖片壓縮失敗，請改用較小的 JPEG 或 PNG。");
    const processedUrl = URL.createObjectURL(blob);
    URL.revokeObjectURL(sourceUrl);
    return { url: processedUrl, name: file.name, width: processedWidth, height: processedHeight };
  } catch (error) {
    URL.revokeObjectURL(sourceUrl);
    throw error;
  }
}

function blobUrlToDataUrl(url: string) {
  return fetch(url)
    .then((response) => response.blob())
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("image read failed"));
      reader.readAsDataURL(blob);
    }));
}

function buildThreeSealFaces(dimensions: Dimensions, seal: number, zipper: boolean) {
  const { width, height } = dimensions;
  const depth = dimensions.depth;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const bodyBottom = seal;
  const bodyTop = height - seal * 1.35;
  const liveLeft = -halfWidth + seal;
  const liveRight = halfWidth - seal;
  const liveHeight = Math.max(1, bodyTop - bodyBottom);
  const frontY = -halfDepth;
  const backY = halfDepth;
  const zipperZ = bodyTop - Math.min(8, seal * 0.7);
  const zipperLines = zipper ? [
    [[liveLeft, frontY - 0.25, zipperZ], [liveRight, frontY - 0.25, zipperZ]],
  ] as Array<[Point3, Point3]> : [];
  const backZipperLines = zipper ? [
    [[liveRight, backY + 0.25, zipperZ], [liveLeft, backY + 0.25, zipperZ]],
  ] as Array<[Point3, Point3]> : [];
  const faces: SceneFace[] = [
    {
      id: "three-front",
      points: [[-halfWidth, frontY, bodyBottom], [halfWidth, frontY, bodyBottom], [halfWidth, frontY, bodyTop], [-halfWidth, frontY, bodyTop]],
      fill: "front",
      artworkFace: "front",
      artworkCorners: [[liveLeft, frontY - 0.15, bodyTop], [liveRight, frontY - 0.15, bodyTop], [liveLeft, frontY - 0.15, bodyBottom]],
      artworkSize: { width: Math.max(1, liveRight - liveLeft), height: liveHeight },
      lines: zipperLines,
    },
    {
      id: "three-back",
      points: [[halfWidth, backY, bodyBottom], [-halfWidth, backY, bodyBottom], [-halfWidth, backY, bodyTop], [halfWidth, backY, bodyTop]],
      fill: "front",
      artworkFace: "back",
      artworkCorners: [[liveRight, backY + 0.15, bodyTop], [liveLeft, backY + 0.15, bodyTop], [liveRight, backY + 0.15, bodyBottom]],
      artworkSize: { width: Math.max(1, liveRight - liveLeft), height: liveHeight },
      lines: backZipperLines,
    },
    { id: "three-left", points: [[-halfWidth, backY, bodyBottom], [-halfWidth, frontY, bodyBottom], [-halfWidth, frontY, bodyTop], [-halfWidth, backY, bodyTop]], fill: "seal" },
    { id: "three-right", points: [[halfWidth, frontY, bodyBottom], [halfWidth, backY, bodyBottom], [halfWidth, backY, bodyTop], [halfWidth, frontY, bodyTop]], fill: "seal" },
    { id: "three-top-front", points: [[-halfWidth, frontY, bodyTop], [halfWidth, frontY, bodyTop], [halfWidth, 0, height], [-halfWidth, 0, height]], fill: "seal" },
    { id: "three-top-back", points: [[halfWidth, backY, bodyTop], [-halfWidth, backY, bodyTop], [-halfWidth, 0, height], [halfWidth, 0, height]], fill: "seal" },
    { id: "three-bottom-front", points: [[-halfWidth, 0, 0], [halfWidth, 0, 0], [halfWidth, frontY, bodyBottom], [-halfWidth, frontY, bodyBottom]], fill: "seal" },
    { id: "three-bottom-back", points: [[halfWidth, 0, 0], [-halfWidth, 0, 0], [-halfWidth, backY, bodyBottom], [halfWidth, backY, bodyBottom]], fill: "seal" },
  ];
  return { faces, chamfer: 0, liveFrontWidth: Math.max(1, liveRight - liveLeft), liveSideWidth: 0, liveHeight };
}

function buildEightSealFaces(dimensions: Dimensions, seal: number, zipper: boolean) {
  const { width, height, depth } = dimensions;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const chamfer = clamp(Math.min(width, depth) * 0.1, 3, Math.min(width, depth) * 0.2);
  const bottomSeal = Math.min(12, Math.max(5, seal * 0.8));
  const bodyTop = height - seal * 1.4;
  const ring: Array<[number, number]> = [
    [-halfWidth + chamfer, -halfDepth],
    [halfWidth - chamfer, -halfDepth],
    [halfWidth, -halfDepth + chamfer],
    [halfWidth, halfDepth - chamfer],
    [halfWidth - chamfer, halfDepth],
    [-halfWidth + chamfer, halfDepth],
    [-halfWidth, halfDepth - chamfer],
    [-halfWidth, -halfDepth + chamfer],
  ];
  const topDepthFactor = Math.max(0.06, Math.min(0.18, 10 / Math.max(1, depth)));
  const topRing = ring.map(([x, y]) => [x, y * topDepthFactor] as [number, number]);
  const faces: SceneFace[] = [];
  const faceMeta: Array<{ artworkFace?: ArtworkFace; fill: SceneFace["fill"] }> = [
    { artworkFace: "front", fill: "front" },
    { fill: "seal" },
    { artworkFace: "side", fill: "side" },
    { fill: "seal" },
    { artworkFace: "back", fill: "front" },
    { fill: "seal" },
    { artworkFace: "side", fill: "side" },
    { fill: "seal" },
  ];
  ring.forEach(([x0, y0], index) => {
    const [x1, y1] = ring[(index + 1) % ring.length];
    const metadata = faceMeta[index];
    const localWidth = Math.hypot(x1 - x0, y1 - y0);
    const artworkTop = bodyTop - Math.min(5, seal * 0.35);
    const artworkBottom = bottomSeal;
    const zipperZ = bodyTop - Math.min(8, seal * 0.7);
    const isBack = index === 4;
    const artworkCorners: [Point3, Point3, Point3] | undefined = metadata.artworkFace
      ? isBack
        ? [[x0, y0, artworkTop], [x1, y1, artworkTop], [x0, y0, artworkBottom]]
        : [[x0, y0, artworkTop], [x1, y1, artworkTop], [x0, y0, artworkBottom]]
      : undefined;
    const lines: Array<[Point3, Point3]> = [];
    if (zipper && (index === 0 || index === 4)) lines.push([[x0, y0, zipperZ], [x1, y1, zipperZ]]);
    if (index === 2 || index === 6) lines.push([[(x0 + x1) / 2, (y0 + y1) / 2, bottomSeal], [(x0 + x1) / 2, (y0 + y1) / 2, bodyTop]]);
    faces.push({
      id: `eight-wall-${index}`,
      points: [[x0, y0, 0], [x1, y1, 0], [x1, y1, bodyTop], [x0, y0, bodyTop]],
      fill: metadata.fill,
      artworkFace: metadata.artworkFace,
      artworkCorners,
      artworkSize: metadata.artworkFace ? { width: Math.max(1, localWidth), height: Math.max(1, artworkTop - artworkBottom) } : undefined,
      lines,
    });
    const [tx0, ty0] = topRing[index];
    const [tx1, ty1] = topRing[(index + 1) % topRing.length];
    faces.push({ id: `eight-top-${index}`, points: [[x0, y0, bodyTop], [x1, y1, bodyTop], [tx1, ty1, height], [tx0, ty0, height]], fill: "seal" });
  });
  faces.push({ id: "eight-bottom", points: ring.map(([x, y]) => [x, y, 0] as Point3), fill: "bottom" });
  faces.push({ id: "eight-top-cap", points: topRing.map(([x, y]) => [x, y, height] as Point3), fill: "seal" });
  return {
    faces,
    chamfer,
    liveFrontWidth: Math.max(1, width - chamfer * 2),
    liveSideWidth: Math.max(1, depth - chamfer * 2),
    liveHeight: Math.max(1, bodyTop - bottomSeal),
  };
}

function ArtworkUpload({
  face,
  label,
  artwork,
  selected,
  onSelect,
  onUpload,
  onRemove,
}: {
  face: ArtworkFace;
  label: string;
  artwork: Artwork | null;
  selected: boolean;
  onSelect: () => void;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  return (
    <div className={`package-upload-row ${selected ? "is-selected" : ""}`}>
      <button type="button" className="package-upload-select" onClick={onSelect} aria-pressed={selected}>
        {artwork ? <span className="package-upload-thumb" style={{ backgroundImage: `url(${artwork.url})` }} aria-hidden="true" /> : <span>{face === "front" ? "F" : face === "back" ? "B" : "S"}</span>}
        <i><strong>{label}</strong><small>{artwork ? `${artwork.name} · ${artwork.width}×${artwork.height}px` : "尚未選擇圖片"}</small></i>
      </button>
      <label className="package-file-button">
        <span>{artwork ? "更換" : "上傳"}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.currentTarget.files?.[0];
          if (file) onUpload(file);
          event.currentTarget.value = "";
        }} />
      </label>
      {artwork && <button type="button" className="package-remove-art" onClick={onRemove} aria-label={`移除${label}圖片`}>×</button>}
    </div>
  );
}

export default function PackagingStudio() {
  const svgRef = useRef<SVGSVGElement>(null);
  const artworkUrls = useRef(new Set<string>());
  const dragRef = useRef<{ face: ArtworkFace; x: number; y: number; startX: number; startY: number } | null>(null);
  const rawId = useId();
  const svgId = rawId.replace(/:/g, "");
  const [bagType, setBagType] = useState<BagType>("eight-seal");
  const [dimensions, setDimensions] = useState<Dimensions>({ width: 180, height: 260, depth: 80 });
  const [fullness, setFullness] = useState(48);
  const [seal, setSeal] = useState(10);
  const [zipper, setZipper] = useState(true);
  const [finish, setFinish] = useState<Finish>("matte");
  const [baseColor, setBaseColor] = useState("#274c3f");
  const [view, setView] = useState<MockupView>("perspective");
  const [selectedFace, setSelectedFace] = useState<ArtworkFace>("front");
  const [showSafeZone, setShowSafeZone] = useState(false);
  const [artworks, setArtworks] = useState<Record<ArtworkFace, Artwork | null>>({ front: null, back: null, side: null });
  const [transforms, setTransforms] = useState<Record<ArtworkFace, ArtworkTransform>>({
    front: { ...DEFAULT_TRANSFORM },
    back: { ...DEFAULT_TRANSFORM },
    side: { ...DEFAULT_TRANSFORM },
  });
  const [message, setMessage] = useState("圖片只在這個瀏覽器記憶體內處理");
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);

  useEffect(() => () => {
    artworkUrls.current.forEach((url) => URL.revokeObjectURL(url));
    artworkUrls.current.clear();
  }, []);

  const previewDepth = bagType === "eight-seal"
    ? clamp(dimensions.depth, 1, Math.max(1, dimensions.width * 0.9))
    : clamp(dimensions.width * (0.025 + fullness / 100 * 0.14), 4, 36);
  const physicalDimensions = { ...dimensions, depth: previewDepth };
  const geometry = bagType === "eight-seal"
    ? buildEightSealFaces(physicalDimensions, seal, zipper)
    : buildThreeSealFaces(physicalDimensions, seal, zipper);

  const camera = VIEW_CAMERAS[view];
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
  const framePoints: Point3[] = [
    [-physicalDimensions.width / 2, -physicalDimensions.depth / 2, 0],
    [physicalDimensions.width / 2, -physicalDimensions.depth / 2, 0],
    [physicalDimensions.width / 2, physicalDimensions.depth / 2, 0],
    [-physicalDimensions.width / 2, physicalDimensions.depth / 2, 0],
    [-physicalDimensions.width / 2, -physicalDimensions.depth / 2, physicalDimensions.height],
    [physicalDimensions.width / 2, -physicalDimensions.depth / 2, physicalDimensions.height],
    [physicalDimensions.width / 2, physicalDimensions.depth / 2, physicalDimensions.height],
    [-physicalDimensions.width / 2, physicalDimensions.depth / 2, physicalDimensions.height],
  ];
  const rawFrame = framePoints.map(rawProject);
  const minX = Math.min(...rawFrame.map((point) => point.x));
  const maxX = Math.max(...rawFrame.map((point) => point.x));
  const minY = Math.min(...rawFrame.map((point) => point.y));
  const maxY = Math.max(...rawFrame.map((point) => point.y));
  const scale = Math.min(610 / Math.max(1, maxX - minX), 455 / Math.max(1, maxY - minY));
  const originX = 455 - ((minX + maxX) / 2) * scale;
  const originY = 325 - ((minY + maxY) / 2) * scale;
  const project = (point: Point3) => {
    const projected = rawProject(point);
    return { x: originX + projected.x * scale, y: originY + projected.y * scale, depth: projected.depth };
  };
  const polygonPoints = (points: Point3[]) => points.map((point) => {
    const mapped = project(point);
    return `${mapped.x},${mapped.y}`;
  }).join(" ");
  const renderedFaces = geometry.faces.map((face) => ({
    ...face,
    depth: face.points.reduce((sum, point) => sum + rawProject(point).depth, 0) / face.points.length,
  })).sort((a, b) => b.depth - a.depth);

  const updateDimension = (key: keyof Dimensions, value: number) => {
    setDimensions((current) => ({ ...current, [key]: clamp(Number.isFinite(value) ? value : 1, 1, 2000) }));
  };

  const selectType = (next: BagType) => {
    setBagType(next);
    setError("");
    if (next === "three-seal") {
      setDimensions((current) => ({ ...current, width: current.width === 180 ? 160 : current.width, height: current.height === 260 ? 240 : current.height }));
      if (selectedFace === "side") setSelectedFace("front");
    } else {
      setDimensions((current) => ({ ...current, width: current.width === 160 ? 180 : current.width, height: current.height === 240 ? 260 : current.height, depth: current.depth || 80 }));
    }
    setView("perspective");
    setMessage(next === "three-seal" ? "三封袋以平袋結構呈現；飽滿度只影響視覺，不列為成品深度。" : "八面封袋使用寬、高與側褶深度建立平底袋比例。");
  };

  const selectArtworkFace = (face: ArtworkFace) => {
    setSelectedFace(face);
    if (face === "back") setView("back");
    if (face === "side") setView("side");
    if (face === "front" && view === "back") setView("front");
  };

  const handleUpload = async (face: ArtworkFace, file: File) => {
    setError("");
    setMessage("正在解析圖片…");
    try {
      const artwork = await prepareArtwork(file);
      artworkUrls.current.add(artwork.url);
      setArtworks((current) => {
        const previous = current[face];
        if (previous) {
          URL.revokeObjectURL(previous.url);
          artworkUrls.current.delete(previous.url);
        }
        return { ...current, [face]: artwork };
      });
      selectArtworkFace(face);
      setTransforms((current) => ({ ...current, [face]: { ...DEFAULT_TRANSFORM } }));
      setMessage(`${file.name} 已套用到${face === "front" ? "正面" : face === "back" ? "背面" : "左右側面"}；重新整理後需重新上傳。`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "無法讀取這張圖片，請改用 JPEG、PNG 或 WebP。");
      setMessage("圖片未變更");
    }
  };

  const removeArtwork = (face: ArtworkFace) => {
    const previous = artworks[face];
    if (previous) {
      URL.revokeObjectURL(previous.url);
      artworkUrls.current.delete(previous.url);
    }
    setArtworks((current) => ({ ...current, [face]: null }));
    setMessage("圖片已從目前工作區移除");
  };

  const updateTransform = (patch: Partial<ArtworkTransform>, face = selectedFace) => {
    setTransforms((current) => ({ ...current, [face]: { ...current[face], ...patch } }));
  };

  const resetTransform = () => {
    updateTransform({ ...DEFAULT_TRANSFORM });
    setMessage("圖稿已置中並回復預設裁切");
  };

  const getArtworkDrawRect = (face: ArtworkFace, width: number, height: number) => {
    const artwork = artworks[face];
    const transform = transforms[face];
    if (!artwork) return null;
    const imageRatio = artwork.width / artwork.height;
    const faceRatio = width / height;
    let drawWidth: number;
    let drawHeight: number;
    if ((transform.fit === "cover" && imageRatio > faceRatio) || (transform.fit === "contain" && imageRatio < faceRatio)) {
      drawHeight = height;
      drawWidth = height * imageRatio;
    } else {
      drawWidth = width;
      drawHeight = width / imageRatio;
    }
    drawWidth *= transform.zoom;
    drawHeight *= transform.zoom;
    return {
      x: (width - drawWidth) / 2 + transform.x / 100 * width,
      y: (height - drawHeight) / 2 + transform.y / 100 * height,
      width: drawWidth,
      height: drawHeight,
    };
  };

  const renderArtwork = (face: SceneFace) => {
    if (!face.artworkFace || !face.artworkCorners || !face.artworkSize) return null;
    const artFace = face.artworkFace;
    const artwork = artworks[artFace];
    const transform = transforms[artFace];
    const [topLeft3, topRight3, bottomLeft3] = face.artworkCorners;
    const topLeft = project(topLeft3);
    const topRight = project(topRight3);
    const bottomLeft = project(bottomLeft3);
    const localWidth = face.artworkSize.width;
    const localHeight = face.artworkSize.height;
    const matrix = [
      (topRight.x - topLeft.x) / localWidth,
      (topRight.y - topLeft.y) / localWidth,
      (bottomLeft.x - topLeft.x) / localHeight,
      (bottomLeft.y - topLeft.y) / localHeight,
      topLeft.x,
      topLeft.y,
    ];
    const clipId = `${svgId}-${face.id}-clip`;
    const draw = getArtworkDrawRect(artFace, localWidth, localHeight);
    return (
      <g transform={`matrix(${matrix.join(" ")})`}>
        <defs><clipPath id={clipId}><rect width={localWidth} height={localHeight} /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
          <rect width={localWidth} height={localHeight} fill={mixHex(baseColor, "#ffffff", 0.08)} />
          {artwork && draw ? <g transform={`rotate(${transform.rotation} ${localWidth / 2} ${localHeight / 2})`}><image data-art-face={artFace} href={artwork.url} x={draw.x} y={draw.y} width={draw.width} height={draw.height} preserveAspectRatio="none" /></g> : artFace === "front" ? <g className="package-placeholder-art"><rect x={localWidth * 0.12} y={localHeight * 0.18} width={localWidth * 0.76} height={localHeight * 0.64} rx={Math.min(localWidth, localHeight) * 0.04} /><text x={localWidth / 2} y={localHeight * 0.48}>YOUR</text><text x={localWidth / 2} y={localHeight * 0.6}>ARTWORK</text></g> : null}
          {finish === "gloss" && <path d={`M${localWidth * 0.12} 0 L${localWidth * 0.42} 0 L${localWidth * 0.2} ${localHeight} L0 ${localHeight} Z`} fill="url(#package-gloss)" opacity=".33" />}
        </g>
        {showSafeZone && <rect className="package-safe-zone" x={localWidth * 0.055} y={localHeight * 0.045} width={localWidth * 0.89} height={localHeight * 0.91} rx={Math.min(localWidth, localHeight) * 0.02} />}
      </g>
    );
  };

  const activeSceneFace = renderedFaces.find((face) => face.artworkFace === selectedFace && (selectedFace !== "side" || face.id.includes("wall-2")))
    ?? renderedFaces.find((face) => face.artworkFace === selectedFace);
  const activeHitPoints = activeSceneFace?.artworkCorners ? [
    activeSceneFace.artworkCorners[0],
    activeSceneFace.artworkCorners[1],
    [
      activeSceneFace.artworkCorners[1][0] + activeSceneFace.artworkCorners[2][0] - activeSceneFace.artworkCorners[0][0],
      activeSceneFace.artworkCorners[1][1] + activeSceneFace.artworkCorners[2][1] - activeSceneFace.artworkCorners[0][1],
      activeSceneFace.artworkCorners[1][2] + activeSceneFace.artworkCorners[2][2] - activeSceneFace.artworkCorners[0][2],
    ] as Point3,
    activeSceneFace.artworkCorners[2],
  ] : null;

  const startArtworkDrag = (event: ReactPointerEvent<SVGPolygonElement>) => {
    event.stopPropagation();
    const transform = transforms[selectedFace];
    dragRef.current = { face: selectedFace, x: event.clientX, y: event.clientY, startX: transform.x, startY: transform.y };
    safeSetPointerCapture(svgRef.current, event.pointerId);
  };

  const moveArtwork = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const nextX = clamp(dragRef.current.startX + (event.clientX - dragRef.current.x) / rect.width * 150, -80, 80);
    const nextY = clamp(dragRef.current.startY + (event.clientY - dragRef.current.y) / rect.height * 150, -80, 80);
    updateTransform({ x: nextX, y: nextY }, dragRef.current.face);
  };

  const endArtworkDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    safeReleasePointerCapture(event.currentTarget, event.pointerId);
  };

  const exportPng = async () => {
    if (!svgRef.current || exporting) return;
    setExporting(true);
    setError("");
    setMessage("正在建立 3000px PNG…");
    try {
      const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", "1800");
      clone.setAttribute("height", "1240");
      const dataUrls = new Map<string, string>();
      await Promise.all((Object.entries(artworks) as Array<[ArtworkFace, Artwork | null]>).map(async ([face, artwork]) => {
        if (artwork) dataUrls.set(face, await blobUrlToDataUrl(artwork.url));
      }));
      clone.querySelectorAll<SVGImageElement>("[data-art-face]").forEach((image) => {
        const face = image.getAttribute("data-art-face");
        if (face && dataUrls.has(face)) image.setAttribute("href", dataUrls.get(face)!);
      });
      clone.querySelectorAll(".package-art-hit").forEach((node) => node.remove());
      const source = new XMLSerializer().serializeToString(clone);
      const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
      const svgUrl = URL.createObjectURL(svgBlob);
      try {
        const image = await loadImage(svgUrl);
        const canvas = document.createElement("canvas");
        canvas.width = 3000;
        canvas.height = Math.round(3000 * 620 / 900);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("PNG canvas unavailable");
        context.fillStyle = "#f5f5f7";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        canvas.width = 1;
        canvas.height = 1;
        if (!png) throw new Error("PNG encode failed");
        const pngUrl = URL.createObjectURL(png);
        const anchor = document.createElement("a");
        anchor.href = pngUrl;
        anchor.download = `${bagType === "three-seal" ? "three-side-seal" : "eight-side-seal"}-${format(dimensions.width)}x${format(dimensions.height)}.png`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(pngUrl), 1500);
      } finally {
        URL.revokeObjectURL(svgUrl);
      }
      setMessage("PNG 已完成；這是 sRGB 視覺示意圖，不是印刷完稿或刀模檔。");
    } catch {
      setError("這台裝置無法完成 PNG 輸出；請改用較小圖片或桌面瀏覽器再試一次。");
      setMessage("PNG 輸出未完成");
    } finally {
      setExporting(false);
    }
  };

  const selectedTransform = transforms[selectedFace];
  const artFaces: Array<{ id: ArtworkFace; label: string }> = bagType === "eight-seal"
    ? [{ id: "front", label: "正面稿" }, { id: "back", label: "背面稿" }, { id: "side", label: "左右側面稿" }]
    : [{ id: "front", label: "正面稿" }, { id: "back", label: "背面稿" }];
  const dimensionLabel = bagType === "eight-seal"
    ? `${format(dimensions.width)} × ${format(dimensions.height)} × ${format(dimensions.depth)} mm`
    : `${format(dimensions.width)} × ${format(dimensions.height)} mm`;

  return (
    <div className="packaging-screen">
      <section className="intro packaging-intro" id="packaging-top">
        <div>
          <p className="eyebrow">PACKAGING MOCKUP STUDIO</p>
          <h1>上傳平面稿，<br />直接看包裝成品。</h1>
          <p className="intro-copy">支援三封袋與八面封袋。每一面依毫米比例建立，圖稿可分面上傳、拖曳裁切，再輸出高解析 PNG 給客戶或內部討論。</p>
        </div>
        <div className="packaging-privacy-card">
          <span>LOCAL IMAGE PROCESSING</span>
          <strong>圖片不會上傳伺服器</strong>
          <p>所有圖稿只存在這個瀏覽器記憶體；重新整理或關閉頁面後，需要重新選擇圖片。</p>
        </div>
      </section>

      <div className="packaging-workspace">
        <aside className="packaging-sidebar">
          <section className="panel package-type-panel">
            <div className="panel-heading"><span>01</span><div><h2>選擇袋型</h2><p>使用不同的真實結構與尺寸欄位。</p></div></div>
            <div className="package-type-options" role="radiogroup" aria-label="包裝袋型">
              <button type="button" role="radio" aria-checked={bagType === "three-seal"} className={bagType === "three-seal" ? "active" : ""} onClick={() => selectType("three-seal")}><i className="bag-type-icon three" /><span><strong>三封袋</strong><small>平袋 · 三側熱封</small></span></button>
              <button type="button" role="radio" aria-checked={bagType === "eight-seal"} className={bagType === "eight-seal" ? "active" : ""} onClick={() => selectType("eight-seal")}><i className="bag-type-icon eight" /><span><strong>八面封袋</strong><small>側褶 · 八角平底</small></span></button>
            </div>
          </section>

          <section className="panel package-size-panel">
            <div className="panel-heading"><span>02</span><div><h2>成品尺寸</h2><p>單位皆為毫米（mm）。</p></div></div>
            <div className="package-size-grid">
              <label><span>袋寬 W</span><span className="number-shell"><input type="number" min="1" max="2000" value={dimensions.width} onChange={(event) => updateDimension("width", Number(event.target.value))} /><span>mm</span></span></label>
              <label><span>袋高 H</span><span className="number-shell"><input type="number" min="1" max="2000" value={dimensions.height} onChange={(event) => updateDimension("height", Number(event.target.value))} /><span>mm</span></span></label>
              {bagType === "eight-seal" && <label><span>側褶深度 D</span><span className="number-shell"><input type="number" min="1" max="2000" value={dimensions.depth} onChange={(event) => updateDimension("depth", Number(event.target.value))} /><span>mm</span></span></label>}
              <label><span>熱封寬度</span><span className="number-shell"><input type="number" min="4" max="20" value={seal} onChange={(event) => setSeal(clamp(Number(event.target.value), 4, 20))} /><span>mm</span></span></label>
            </div>
            {bagType === "three-seal" && <label className="package-range"><span><strong>視覺飽滿度</strong><small>{fullness}% · 不列為實體深度</small></span><input type="range" min="0" max="100" value={fullness} onChange={(event) => setFullness(Number(event.target.value))} /></label>}
            <div className="package-option-row"><label><span>袋身底色</span><input className="package-color" type="color" value={baseColor} onChange={(event) => setBaseColor(event.target.value)} /></label><button type="button" className={zipper ? "active" : ""} onClick={() => setZipper((current) => !current)} aria-pressed={zipper}>夾鏈 {zipper ? "開" : "關"}</button></div>
          </section>

          <section className="panel package-upload-panel">
            <div className="panel-heading"><span>03</span><div><h2>上傳各面圖稿</h2><p>JPEG、PNG、WebP；每張最多 12 MB。</p></div></div>
            <div className="package-upload-list">
              {artFaces.map(({ id, label }) => <ArtworkUpload key={id} face={id} label={label} artwork={artworks[id]} selected={selectedFace === id} onSelect={() => selectArtworkFace(id)} onUpload={(file) => handleUpload(id, file)} onRemove={() => removeArtwork(id)} />)}
            </div>
            {error && <p className="package-error" role="alert">{error}</p>}
          </section>

          <section className="panel package-adjust-panel">
            <div className="panel-heading"><span>04</span><div><h2>調整{selectedFace === "front" ? "正面" : selectedFace === "back" ? "背面" : "側面"}圖稿</h2><p>也可以直接在袋面上拖曳位置。</p></div></div>
            <div className="package-fit-switch" role="group" aria-label="圖稿顯示方式"><button type="button" className={selectedTransform.fit === "cover" ? "active" : ""} aria-pressed={selectedTransform.fit === "cover"} onClick={() => updateTransform({ fit: "cover" })}>填滿裁切</button><button type="button" className={selectedTransform.fit === "contain" ? "active" : ""} aria-pressed={selectedTransform.fit === "contain"} onClick={() => updateTransform({ fit: "contain" })}>完整顯示</button></div>
            <div className="package-slider-list">
              <label><span>縮放 <strong>{format(selectedTransform.zoom * 100)}%</strong></span><input type="range" min="0.5" max="2.5" step="0.01" value={selectedTransform.zoom} onChange={(event) => updateTransform({ zoom: Number(event.target.value) })} /></label>
              <label><span>左右位置 <strong>{format(selectedTransform.x)}%</strong></span><input type="range" min="-80" max="80" step="1" value={selectedTransform.x} onChange={(event) => updateTransform({ x: Number(event.target.value) })} /></label>
              <label><span>上下位置 <strong>{format(selectedTransform.y)}%</strong></span><input type="range" min="-80" max="80" step="1" value={selectedTransform.y} onChange={(event) => updateTransform({ y: Number(event.target.value) })} /></label>
              <label><span>旋轉 <strong>{format(selectedTransform.rotation)}°</strong></span><input type="range" min="-20" max="20" step="1" value={selectedTransform.rotation} onChange={(event) => updateTransform({ rotation: Number(event.target.value) })} /></label>
            </div>
            <button type="button" className="package-reset-art" onClick={resetTransform}>置中並重設裁切</button>
          </section>
        </aside>

        <section className="packaging-main">
          <div className="panel package-stage-panel">
            <div className="package-toolbar">
              <div><span className="section-kicker">TRUE-SCALE PACKAGING MOCKUP</span><strong>{bagType === "three-seal" ? "三封袋" : "八面封袋／平底袋"} · {dimensionLabel}</strong></div>
              <div className="package-toolbar-actions"><div className="view-buttons" role="group" aria-label="包裝觀看角度">{([["perspective", "透視"], ["front", "正面"], ["back", "背面"], ["side", "側面"], ["top", "俯視"]] as Array<[MockupView, string]>).map(([choice, label]) => <button key={choice} type="button" className={view === choice ? "active" : ""} aria-pressed={view === choice} onClick={() => setView(choice)}>{label}</button>)}</div><button type="button" className={`package-safe-toggle ${showSafeZone ? "active" : ""}`} onClick={() => setShowSafeZone((current) => !current)} aria-pressed={showSafeZone}>安全區</button></div>
            </div>
            <div className="package-stage">
              <svg ref={svgRef} className="package-svg" viewBox="0 0 900 620" role="img" aria-label={`${bagType === "three-seal" ? "三封袋" : "八面封袋"}包裝預覽，尺寸 ${dimensionLabel}`} onPointerMove={moveArtwork} onPointerUp={endArtworkDrag} onPointerCancel={endArtworkDrag}>
                <title>{bagType === "three-seal" ? "三封袋" : "八面封袋"}包裝成品模擬</title>
                <defs>
                  <linearGradient id="package-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#ececf0" /></linearGradient>
                  <linearGradient id="package-front" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={mixHex(baseColor, "#000000", 0.12)} /><stop offset=".22" stopColor={mixHex(baseColor, "#ffffff", 0.12)} /><stop offset=".72" stopColor={baseColor} /><stop offset="1" stopColor={mixHex(baseColor, "#000000", 0.18)} /></linearGradient>
                  <linearGradient id="package-side" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={mixHex(baseColor, "#000000", 0.28)} /><stop offset="1" stopColor={mixHex(baseColor, "#ffffff", 0.03)} /></linearGradient>
                  <linearGradient id="package-seal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={mixHex(baseColor, "#ffffff", 0.2)} /><stop offset="1" stopColor={mixHex(baseColor, "#000000", 0.24)} /></linearGradient>
                  <linearGradient id="package-gloss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#ffffff" stopOpacity="0" /><stop offset=".55" stopColor="#ffffff" stopOpacity=".9" /><stop offset="1" stopColor="#ffffff" stopOpacity="0" /></linearGradient>
                  <filter id="package-shadow" x="-40%" y="-40%" width="180%" height="200%"><feDropShadow dx="0" dy="13" stdDeviation="12" floodColor="#1d1d1f" floodOpacity=".23" /></filter>
                  <style>{`.package-placeholder-art rect{fill:rgba(255,255,255,.13);stroke:rgba(255,255,255,.58);stroke-width:1.2;stroke-dasharray:5 4}.package-placeholder-art text{fill:rgba(255,255,255,.86);font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-anchor:middle}.package-safe-zone{fill:none;stroke:#30d158;stroke-width:1.2;stroke-dasharray:5 4;vector-effect:non-scaling-stroke}.package-face{stroke:rgba(255,255,255,.33);stroke-width:1;vector-effect:non-scaling-stroke}.package-seam-line{stroke:rgba(255,255,255,.64);stroke-width:1.2;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}.package-art-hit{fill:transparent;stroke:#2997ff;stroke-width:2;stroke-dasharray:6 4;vector-effect:non-scaling-stroke;cursor:move}.package-art-hit:focus{outline:none;stroke:#0071e3;stroke-width:4}`}</style>
                </defs>
                <rect width="900" height="620" fill="url(#package-bg)" />
                <ellipse cx="450" cy="535" rx={Math.min(270, physicalDimensions.width * scale * 0.62)} ry="28" fill="rgba(29,29,31,.13)" filter="url(#package-shadow)" />
                <g filter="url(#package-shadow)">
                  {renderedFaces.map((face) => <g key={face.id}><polygon className="package-face" points={polygonPoints(face.points)} fill={`url(#package-${face.fill})`} />{renderArtwork(face)}{face.lines?.map(([start3, end3], index) => { const start = project(start3); const end = project(end3); return <line key={index} className="package-seam-line" x1={start.x} y1={start.y} x2={end.x} y2={end.y} />; })}</g>)}
                </g>
                {activeHitPoints && <polygon className="package-art-hit" points={polygonPoints(activeHitPoints)} tabIndex={0} role="button" aria-label={`拖曳調整${selectedFace === "front" ? "正面" : selectedFace === "back" ? "背面" : "側面"}圖稿位置`} onPointerDown={startArtworkDrag} onKeyDown={(event) => {
                  const step = event.shiftKey ? 5 : 1;
                  if (event.key === "ArrowLeft") { event.preventDefault(); updateTransform({ x: clamp(selectedTransform.x - step, -80, 80) }); }
                  if (event.key === "ArrowRight") { event.preventDefault(); updateTransform({ x: clamp(selectedTransform.x + step, -80, 80) }); }
                  if (event.key === "ArrowUp") { event.preventDefault(); updateTransform({ y: clamp(selectedTransform.y - step, -80, 80) }); }
                  if (event.key === "ArrowDown") { event.preventDefault(); updateTransform({ y: clamp(selectedTransform.y + step, -80, 80) }); }
                  if (event.key === "+" || event.key === "=") { event.preventDefault(); updateTransform({ zoom: clamp(selectedTransform.zoom + 0.05, 0.5, 2.5) }); }
                  if (event.key === "-") { event.preventDefault(); updateTransform({ zoom: clamp(selectedTransform.zoom - 0.05, 0.5, 2.5) }); }
                }} />}
              </svg>
              <div className="package-stage-labels"><span>{finish === "matte" ? "霧面膜" : "亮面膜"} · {zipper ? "含夾鏈" : "無夾鏈"}</span><strong>{dimensionLabel}</strong></div>
              <div className="package-stage-hint">拖曳藍框移動圖稿 · Shift＋方向鍵每次 5%</div>
            </div>
            <div className="package-stage-actions"><div className="package-finish-switch" role="group" aria-label="材質表面"><button type="button" className={finish === "matte" ? "active" : ""} aria-pressed={finish === "matte"} onClick={() => setFinish("matte")}>霧面</button><button type="button" className={finish === "gloss" ? "active" : ""} aria-pressed={finish === "gloss"} onClick={() => setFinish("gloss")}>亮面</button></div><button type="button" onClick={resetTransform}>置中目前圖稿</button><button type="button" className="command-primary" onClick={exportPng} disabled={exporting}>{exporting ? "正在輸出…" : "下載 3000px PNG"}</button><span role="status" aria-live="polite">{message}</span></div>
          </div>

          <div className="package-spec-strip">
            <div><span>袋型結構</span><strong>{bagType === "three-seal" ? "三側熱封平袋" : "八角平底＋側褶"}</strong></div>
            <div><span>正面可印面幅</span><strong>{format(geometry.liveFrontWidth)} × {format(geometry.liveHeight)} mm</strong></div>
            <div><span>{bagType === "eight-seal" ? "側面可印面幅" : "視覺填充厚度"}</span><strong>{bagType === "eight-seal" ? `${format(geometry.liveSideWidth)} × ${format(geometry.liveHeight)} mm` : `${format(previewDepth)} mm（模擬）`}</strong></div>
            <div><span>目前圖稿</span><strong>{artworks[selectedFace] ? `${artworks[selectedFace]!.width} × ${artworks[selectedFace]!.height}px` : "尚未上傳"}</strong></div>
          </div>
          <p className="commercial-note">此功能是包裝外觀與比例示意，不是印刷刀模、CMYK 打樣或製袋工程圖。正式生產仍須由包材廠確認出血、封邊、側褶、夾鏈、材料變形與公差。</p>
        </section>
      </div>
    </div>
  );
}
