"use client";

import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  anglesToMatrix,
  evaluateFit,
  optimizeFit,
  rotateVector,
  type Angles,
  type Dimensions,
  type FitEvaluation,
  type Matrix3,
} from "./fit-math";
import TowerStudio from "./tower-studio";
import PackagingStudio from "./packaging-studio";
import { safeReleasePointerCapture, safeSetPointerCapture } from "./pointer-capture";

type Unit = "mm" | "cm";
type Mode = "auto" | "manual";
type View = "perspective" | "front" | "side" | "top";
type Axis = "x" | "y" | "z";
type WorkspaceMode = "fit" | "tower" | "packaging";

const DEFAULT_CAVITY: Dimensions = { x: 349, y: 306, z: 281 };
const DEFAULT_OBJECT: Dimensions = { x: 350, y: 205, z: 135 };
const ZERO_ANGLES: Angles = { yaw: 0, leftLift: 0, frontLift: 0 };
const AXES: Axis[] = ["x", "y", "z"];

const axisMeta = {
  x: { name: "左右 X", cavity: "內寬", object: "長 L" },
  y: { name: "前後 Y", cavity: "內深", object: "寬 W" },
  z: { name: "上下 Z", cavity: "內高", object: "高 H" },
};

function almostEqual(a: number, b: number) {
  return Math.abs(a - b) < 0.0001;
}

function format(value: number, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  const safe = Math.abs(value) < 0.0005 ? 0 : value;
  return new Intl.NumberFormat("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(safe);
}

function formatForInput(valueMm: number, unit: Unit) {
  const factor = unit === "cm" ? 10 : 1;
  return Number((valueMm / factor).toFixed(unit === "cm" ? 4 : 3));
}

function DimensionField({
  id,
  label,
  helper,
  value,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  helper: string;
  value: number;
  unit: Unit;
  onChange: (value: number) => void;
}) {
  const factor = unit === "cm" ? 10 : 1;
  const invalid = !Number.isFinite(value) || value <= 0;
  return (
    <label className={`dimension-field ${invalid ? "has-error" : ""}`} htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="field-helper">{helper}</span>
      <span className="number-shell">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min="0.001"
          step={unit === "mm" ? "1" : "0.1"}
          value={formatForInput(value, unit)}
          onChange={(event) => onChange(event.target.value === "" ? 0 : Number(event.target.value) * factor)}
        />
        <span>{unit}</span>
      </span>
      {invalid && <small>請輸入大於 0 的尺寸</small>}
    </label>
  );
}

function RangeControl({
  label,
  left,
  right,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  left: string;
  right: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span className="range-heading">
        <span>{label}</span>
        <span className="angle-input">
          <input
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step="0.1"
            value={Number(value.toFixed(1))}
            onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value))))}
          />
          °
        </span>
      </span>
      <input
        className="angle-range"
        type="range"
        min={min}
        max={max}
        step="0.1"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="range-ends"><span>{left}</span><span>{right}</span></span>
    </label>
  );
}

type Point3 = [number, number, number];
type Camera = { yaw: number; pitch: number; zoom: number };

const cameraPresets: Record<View, Camera> = {
  perspective: { yaw: -36, pitch: 25, zoom: 1 },
  front: { yaw: 0, pitch: 1, zoom: 1 },
  side: { yaw: -90, pitch: 1, zoom: 1 },
  top: { yaw: -35, pitch: 88, zoom: 1 },
};

const cubeFaces = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [3, 2, 6, 7],
  [0, 3, 7, 4],
  [1, 5, 6, 2],
];

const cubeEdges = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function cavityVertices(dimensions: Dimensions): Point3[] {
  const x = dimensions.x / 2;
  const y = dimensions.y / 2;
  return [
    [-x, -y, 0], [x, -y, 0], [x, y, 0], [-x, y, 0],
    [-x, -y, dimensions.z], [x, -y, dimensions.z], [x, y, dimensions.z], [-x, y, dimensions.z],
  ];
}

function transformedObjectVertices(dimensions: Dimensions, matrix: Matrix3): Point3[] {
  const x = dimensions.x / 2;
  const y = dimensions.y / 2;
  const z = dimensions.z / 2;
  const local: Point3[] = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const rotated = local.map((point) => rotateVector(matrix, point));
  const floorOffset = -Math.min(...rotated.map((point) => point[2]));
  return rotated.map((point) => [point[0], point[1], point[2] + floorOffset]);
}

function FitScene({
  cavity,
  object,
  matrix,
  evaluation,
  view,
}: {
  cavity: Dimensions;
  object: Dimensions;
  matrix: Matrix3;
  evaluation: FitEvaluation;
  view: View;
}) {
  const [camera, setCamera] = useState<Camera>(cameraPresets[view]);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const cavityPoints = cavityVertices(cavity);
  const objectPoints = transformedObjectVertices(object, matrix);
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

  const raw = [...cavityPoints, ...objectPoints].map(rawProject);
  const minX = Math.min(...raw.map((point) => point.x));
  const maxX = Math.max(...raw.map((point) => point.x));
  const minY = Math.min(...raw.map((point) => point.y));
  const maxY = Math.max(...raw.map((point) => point.y));
  const scale = Math.min(760 / Math.max(1, maxX - minX), 470 / Math.max(1, maxY - minY)) * camera.zoom;
  const centerX = 450 - ((minX + maxX) / 2) * scale;
  const centerY = 305 - ((minY + maxY) / 2) * scale;
  const project = (point: Point3) => {
    const result = rawProject(point);
    return { x: centerX + result.x * scale, y: centerY + result.y * scale, depth: result.depth };
  };
  const svgPoints = (indices: number[], points: Point3[]) =>
    indices.map((index) => {
      const point = project(points[index]);
      return `${point.x},${point.y}`;
    }).join(" ");

  const objectFaces = cubeFaces
    .map((indices, index) => ({
      indices,
      index,
      depth: indices.reduce((sum, vertex) => sum + project(objectPoints[vertex]).depth, 0) / indices.length,
    }))
    .sort((a, b) => b.depth - a.depth);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
    safeSetPointerCapture(event.currentTarget, event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    setCamera((current) => ({
      ...current,
      yaw: drag.current!.yaw + (event.clientX - drag.current!.x) * 0.35,
      pitch: Math.max(-8, Math.min(89, drag.current!.pitch - (event.clientY - drag.current!.y) * 0.28)),
    }));
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null;
    safeReleasePointerCapture(event.currentTarget, event.pointerId);
  };
  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setCamera((current) => ({ ...current, zoom: Math.max(0.72, Math.min(1.5, current.zoom - event.deltaY * 0.001)) }));
  };

  const statusText = evaluation.fits ? "目前姿勢：可放入" : `目前姿勢：超出 ${format(evaluation.maxDeficit)} mm`;
  const origin = project([0, 0, 0]);
  const axisLength = Math.min(cavity.x, cavity.y, cavity.z) * 0.28;
  const axisEnds = {
    x: project([axisLength, 0, 0]),
    y: project([0, axisLength, 0]),
    z: project([0, 0, axisLength]),
  };

  return (
    <div className={`scene-wrap ${evaluation.fits ? "scene-fit" : "scene-collision"}`}>
      <svg
        className="fit-scene"
        viewBox="0 0 900 600"
        role="img"
        aria-label={`依照真實比例的三維示意。${statusText}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="case-pattern" width="42" height="42" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
            <rect width="42" height="42" fill="#3a2a21" />
            <path d="M9 8l4 7-4 7-4-7 4-7Zm22 3 5 5-5 5-5-5 5-5Z" fill="none" stroke="#a88961" strokeWidth="1.1" opacity=".62" />
            <circle cx="20" cy="33" r="3.6" fill="none" stroke="#a88961" opacity=".48" />
          </pattern>
          <filter id="object-shadow" x="-30%" y="-30%" width="160%" height="180%">
            <feDropShadow dx="0" dy="9" stdDeviation="8" floodColor="#21170f" floodOpacity=".25" />
          </filter>
        </defs>

        <g className="cavity-faces">
          {cubeFaces.map((face, index) => <polygon key={index} points={svgPoints(face, cavityPoints)} />)}
        </g>

        <g className="axis-guides">
          {AXES.map((axis) => (
            <g key={axis}>
              <line x1={origin.x} y1={origin.y} x2={axisEnds[axis].x} y2={axisEnds[axis].y} className={`axis-${axis}`} />
              <text x={axisEnds[axis].x + 8} y={axisEnds[axis].y - 5} className={`axis-${axis}`}>{axis.toUpperCase()}</text>
            </g>
          ))}
        </g>

        <g className="object-solid" filter="url(#object-shadow)">
          {objectFaces.map((face) => (
            <polygon
              key={face.index}
              points={svgPoints(face.indices, objectPoints)}
              style={{ opacity: 0.68 + face.index * 0.035 }}
            />
          ))}
        </g>

        <g className="object-edges">
          {cubeEdges.map(([a, b], index) => {
            const start = project(objectPoints[a]);
            const end = project(objectPoints[b]);
            return <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
          })}
        </g>

        <g className="cavity-edges">
          {cubeEdges.map(([a, b], index) => {
            const start = project(cavityPoints[a]);
            const end = project(cavityPoints[b]);
            return <line key={index} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
          })}
        </g>
      </svg>
      <div className="scene-labels">
        <span className="scene-dimensions">容器 {format(cavity.x, 0)} × {format(cavity.y, 0)} × {format(cavity.z, 0)} mm</span>
        <span className={`current-pose ${evaluation.fits ? "is-fit" : "is-collision"}`}>{statusText}</span>
      </div>
      <div className="scene-key" aria-hidden="true">
        <span><i className="key-cavity" /> 容器淨空</span>
        <span><i className="key-object" /> 物件</span>
      </div>
    </div>
  );
}

export default function Home() {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("tower");
  const [unit, setUnit] = useState<Unit>("mm");
  const [cavity, setCavity] = useState<Dimensions>(DEFAULT_CAVITY);
  const [object, setObject] = useState<Dimensions>(DEFAULT_OBJECT);
  const [margin, setMargin] = useState(0);
  const [mode, setMode] = useState<Mode>("auto");
  const [view, setView] = useState<View>("perspective");
  const [manualAngles, setManualAngles] = useState<Angles>(ZERO_ANGLES);

  const available = useMemo(() => ({
    x: cavity.x - margin * 2,
    y: cavity.y - margin * 2,
    z: cavity.z - margin * 2,
  }), [cavity, margin]);
  const invalid = [...AXES.map((axis) => cavity[axis]), ...AXES.map((axis) => object[axis])].some(
    (value) => !Number.isFinite(value) || value <= 0,
  ) || margin < 0 || AXES.some((axis) => available[axis] <= 0);
  const best = useMemo(() => optimizeFit(object, available), [object, available]);
  const manualMatrix = useMemo(() => anglesToMatrix(manualAngles), [manualAngles]);
  const activeMatrix = mode === "auto" ? best.matrix : manualMatrix;
  const activeEvaluation = useMemo(
    () => evaluateFit(object, available, activeMatrix),
    [object, available, activeMatrix],
  );
  const minClearance = Math.min(best.clearance.x, best.clearance.y, best.clearance.z);
  const status = invalid
    ? "invalid"
    : best.fits && minClearance > 0.2
      ? "fit"
      : best.fits || best.maxDeficit <= 0.2
        ? "critical"
        : "fail";
  const isLvCase = margin === 0 && AXES.every((axis) =>
    almostEqual(cavity[axis], DEFAULT_CAVITY[axis]) && almostEqual(object[axis], DEFAULT_OBJECT[axis]),
  );
  const worstAxis = AXES.reduce((worst, axis) => best.clearance[axis] < best.clearance[worst] ? axis : worst, "x" as Axis);

  const verdict = status === "invalid"
    ? { title: "先完成尺寸", text: "每個尺寸都必須大於 0，安全間隙也不能吃掉全部淨空。" }
    : status === "fit"
      ? { title: "可以放入", text: `最佳姿勢符合設定；最緊方向置中後每側仍有 ${format(minClearance / 2)} mm。` }
      : status === "critical"
        ? { title: "臨界尺寸，請實測", text: "結果落在 ±0.2 mm 內，量測與製造公差都可能改變答案。" }
        : isLvCase
          ? { title: "放不下", text: "這組 LV 案例已確認：任意三軸旋轉都無法同時滿足 349 × 306 × 281 mm。" }
          : { title: "未找到可行姿勢", text: `最佳計算姿勢在${axisMeta[worstAxis].name}仍超出 ${format(best.maxDeficit)} mm。` };

  const setDimension = (
    setter: React.Dispatch<React.SetStateAction<Dimensions>>,
    axis: Axis,
    value: number,
  ) => setter((current) => ({ ...current, [axis]: value }));

  const loadLv = () => {
    setCavity(DEFAULT_CAVITY);
    setObject(DEFAULT_OBJECT);
    setMargin(0);
    setUnit("mm");
    setMode("auto");
    setManualAngles(ZERO_ANGLES);
    setView("perspective");
  };

  const startFromBest = () => {
    setManualAngles(best.angles);
    setMode("manual");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href={workspaceMode === "fit" ? "#top" : workspaceMode === "tower" ? "#tower-top" : "#packaging-top"} aria-label="Spatial Fit Pro 首頁">
          <span className="brand-mark"><i /><i /><i /></span>
          <span><b>Spatial Fit Pro</b><small>3D 空間比例工具</small></span>
        </a>
        <div className="header-actions">
          <div className="segmented workspace-switch" role="group" aria-label="工具模式">
            <button type="button" className={workspaceMode === "fit" ? "active" : ""} aria-pressed={workspaceMode === "fit"} onClick={() => setWorkspaceMode("fit")}><span className="mode-label-full">裝箱計算</span><span className="mode-label-short">裝箱</span></button>
            <button type="button" className={workspaceMode === "tower" ? "active" : ""} aria-pressed={workspaceMode === "tower"} onClick={() => setWorkspaceMode("tower")}><span className="mode-label-full">疊塔工作室</span><span className="mode-label-short">疊塔</span></button>
            <button type="button" className={workspaceMode === "packaging" ? "active" : ""} aria-pressed={workspaceMode === "packaging"} onClick={() => setWorkspaceMode("packaging")}><span className="mode-label-full">包裝預覽</span><span className="mode-label-short">包裝</span></button>
          </div>
          {workspaceMode === "fit" && <>
            <button className="preset-button" type="button" onClick={loadLv}>載入這次的 LV 案例</button>
            <div className="segmented compact" role="group" aria-label="尺寸單位">
              {(["mm", "cm"] as Unit[]).map((choice) => (
                <button key={choice} type="button" className={unit === choice ? "active" : ""} aria-pressed={unit === choice} onClick={() => setUnit(choice)}>{choice}</button>
              ))}
            </div>
          </>}
        </div>
      </header>

      {workspaceMode === "tower" ? <TowerStudio /> : workspaceMode === "packaging" ? <PackagingStudio /> : <>
      <section className="intro" id="top">
        <div>
          <p className="eyebrow">PHYSICAL CLEARANCE, VISUALIZED</p>
          <h1>先算清楚，<br />再決定要不要買。</h1>
          <p className="intro-copy">輸入最窄淨空和物件最外緣尺寸。計算器會搜尋三軸旋轉，並按真實比例畫出最佳角度。</p>
        </div>
        <div className={`verdict verdict-${status}`} aria-live="polite">
          <span className="verdict-label">全域最佳判定</span>
          <strong>{verdict.title}</strong>
          <p>{verdict.text}</p>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="input-column">
          <section className="panel input-panel">
            <div className="panel-heading">
              <span>01</span>
              <div><h2>容器內部最窄淨空</h2><p>輸入內尺寸，不是箱子的外尺寸。</p></div>
            </div>
            <div className="dimension-grid">
              {AXES.map((axis) => (
                <DimensionField
                  key={`cavity-${axis}`}
                  id={`cavity-${axis}`}
                  label={`${axisMeta[axis].cavity} ${axis.toUpperCase()}`}
                  helper={axisMeta[axis].name.split(" ")[0] + "方向"}
                  value={cavity[axis]}
                  unit={unit}
                  onChange={(value) => setDimension(setCavity, axis, value)}
                />
              ))}
            </div>
            <p className="panel-hint">門框、鉸鏈、內襯或突出物都要先扣除。</p>
          </section>

          <section className="panel input-panel">
            <div className="panel-heading">
              <span>02</span>
              <div><h2>要放入的物件</h2><p>量到把手、鎖扣及包角最突出處。</p></div>
            </div>
            <div className="object-preset-row">
              <span>LV M10262 預設</span>
              <button type="button" onClick={() => setObject(DEFAULT_OBJECT)}>350 × 205 × 135 mm</button>
            </div>
            <div className="dimension-grid">
              {AXES.map((axis) => (
                <DimensionField
                  key={`object-${axis}`}
                  id={`object-${axis}`}
                  label={axisMeta[axis].object}
                  helper={axis === "x" ? "最長邊" : axis === "y" ? "次長邊" : "箱體厚度"}
                  value={object[axis]}
                  unit={unit}
                  onChange={(value) => setDimension(setObject, axis, value)}
                />
              ))}
            </div>
            <p className="panel-hint">不必自行交換長寬高；計算器會旋轉物件。</p>
          </section>

          <section className="panel safety-panel">
            <div className="panel-heading">
              <span>03</span>
              <div><h2>每一側預留</h2><p>建議真實物品至少保留 1–2 mm。</p></div>
            </div>
            <div className="margin-buttons">
              {[0, 1, 2, 5].map((value) => (
                <button key={value} className={almostEqual(margin, value) ? "active" : ""} type="button" onClick={() => setMargin(value)}>{value} mm</button>
              ))}
            </div>
            <label className="custom-margin">
              <span>自訂每側</span>
              <span className="number-shell"><input type="number" min="0" step="0.1" value={formatForInput(margin, unit)} onChange={(event) => setMargin(Math.max(0, Number(event.target.value) * (unit === "cm" ? 10 : 1)))} /><span>{unit}</span></span>
            </label>
            <p className="panel-hint">每側 2 mm，代表每個軸向共扣除 4 mm。</p>
          </section>
        </aside>

        <section className="visual-column">
          <div className="panel visual-panel">
            <div className="visual-toolbar">
              <div className="segmented" role="group" aria-label="擺放模式">
                <button className={mode === "auto" ? "active" : ""} type="button" aria-pressed={mode === "auto"} onClick={() => setMode("auto")}>自動找最佳</button>
                <button className={mode === "manual" ? "active" : ""} type="button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>手動試角度</button>
              </div>
              <div className="view-buttons" role="group" aria-label="觀看角度">
                {([
                  ["perspective", "透視"], ["front", "正面"], ["side", "側面"], ["top", "俯視"],
                ] as [View, string][]).map(([choice, label]) => (
                  <button key={choice} className={view === choice ? "active" : ""} type="button" aria-pressed={view === choice} onClick={() => setView(choice)}>{label}</button>
                ))}
              </div>
            </div>

            <FitScene key={view} cavity={cavity} object={object} matrix={activeMatrix} evaluation={activeEvaluation} view={view} />
            <p className="scene-help"><span>拖曳畫面</span>只會旋轉觀看角度；物件姿勢請用下方控制。滾輪或雙指可縮放。</p>

            {mode === "manual" && (
              <div className="manual-controls">
                <div className="manual-heading">
                  <div><span className="section-kicker">MANUAL POSE</span><h3>親自試角度</h3></div>
                  <div className={`manual-status ${activeEvaluation.fits ? "is-fit" : "is-collision"}`}>
                    {activeEvaluation.fits ? "目前放得下" : `目前超出 ${format(activeEvaluation.maxDeficit)} mm`}
                  </div>
                </div>
                <div className="range-grid">
                  <RangeControl label="水平旋轉" left="逆時針" right="順時針" value={manualAngles.yaw} min={-90} max={90} onChange={(value) => setManualAngles((angles) => ({ ...angles, yaw: value }))} />
                  <RangeControl label="左右墊高" left="右側高" right="左側高" value={manualAngles.leftLift} min={-60} max={60} onChange={(value) => setManualAngles((angles) => ({ ...angles, leftLift: value }))} />
                  <RangeControl label="前後墊高" left="後側高" right="前側高" value={manualAngles.frontLift} min={-60} max={60} onChange={(value) => setManualAngles((angles) => ({ ...angles, frontLift: value }))} />
                </div>
                <div className="manual-actions">
                  <button type="button" onClick={startFromBest}>從最佳姿勢開始</button>
                  <button type="button" onClick={() => setManualAngles(ZERO_ANGLES)}>回到正放 0°</button>
                  {isLvCase && <button className="tilt-demo" type="button" onClick={() => setManualAngles({ yaw: 0, leftLift: 42.605, frontLift: 0 })}>示範左側墊高 42.6°</button>}
                </div>
              </div>
            )}
          </div>

          {isLvCase && (
            <aside className="lv-insight">
              <span className="insight-number">42.6°</span>
              <div><strong>左側墊高仍然不行</strong><p>傾到左右包絡剛好 349.0 mm 時，上下包絡會變成 336.3 mm，比內高多 55.3 mm。</p></div>
              <button type="button" onClick={() => { setMode("manual"); setManualAngles({ yaw: 0, leftLift: 42.605, frontLift: 0 }); }}>在 3D 中查看</button>
            </aside>
          )}

          <div className="results-grid">
            <section className="panel result-card">
              <span className="section-kicker">BEST ORIENTATION</span>
              <h2>最佳姿勢</h2>
              <div className="angle-list">
                <div><span>水平旋轉</span><strong>{format(best.angles.yaw)}°</strong></div>
                <div><span>左／右側抬高</span><strong>{format(best.angles.leftLift)}°</strong></div>
                <div><span>前／後側抬高</span><strong>{format(best.angles.frontLift)}°</strong></div>
              </div>
              <button className="text-button" type="button" onClick={startFromBest}>用滑桿微調這個姿勢 →</button>
            </section>

            <section className="panel result-card">
              <span className="section-kicker">BOUNDING ENVELOPE</span>
              <h2>物件實際佔用</h2>
              <div className="envelope-readout">
                <strong>{format(best.envelope.x)}</strong><i>×</i><strong>{format(best.envelope.y)}</strong><i>×</i><strong>{format(best.envelope.z)}</strong><small>mm</small>
              </div>
              <div className="clearance-list">
                {AXES.map((axis) => (
                  <div key={axis} className={best.clearance[axis] >= 0 ? "positive" : "negative"}>
                    <span>{axisMeta[axis].name}</span>
                    <strong>{best.clearance[axis] >= 0 ? "剩餘" : "超出"} {format(Math.abs(best.clearance[axis]))} mm</strong>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="panel detail-panel">
            <div className="detail-heading"><div><span className="section-kicker">MEASUREMENT AUDIT</span><h2>每一個方向怎麼算</h2></div><span>置中後每側 = 總餘裕 ÷ 2</span></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>方向</th><th>容器淨空</th><th>安全後可用</th><th>物件包絡</th><th>總餘裕</th><th>置中後每側</th></tr></thead>
                <tbody>
                  {AXES.map((axis) => (
                    <tr key={axis}>
                      <th>{axisMeta[axis].name}</th>
                      <td>{format(cavity[axis])} mm</td>
                      <td>{format(available[axis])} mm</td>
                      <td>{format(best.envelope[axis])} mm</td>
                      <td className={best.clearance[axis] >= 0 ? "cell-positive" : "cell-negative"}>{best.clearance[axis] >= 0 ? "+" : "−"}{format(Math.abs(best.clearance[axis]))} mm</td>
                      <td className={best.clearance[axis] >= 0 ? "cell-positive" : "cell-negative"}>{best.clearance[axis] >= 0 ? "+" : "−"}{format(Math.abs(best.clearance[axis] / 2))} mm</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="calculation-note">
            <span>計算假設</span>
            <p><strong>找到「可以」即為精確幾何解。</strong>「未找到」來自多方向取樣與局部細化；非常接近邊界時，請保留實測公差。結果只檢查放入後的矩形淨空；若入口、門框或鉸鏈更窄，請輸入整條路徑的最窄處。</p>
            <code>包絡 eᵢ = Σ |Rᵢⱼ| dⱼ</code>
          </aside>
        </section>
      </div>

      <div className={`mobile-verdict verdict-${status}`} aria-live="polite"><strong>{verdict.title}</strong><span>{status === "fail" ? `最少差 ${format(best.maxDeficit)} mm` : verdict.text}</span></div>
      </>}
      <footer><span>Spatial Fit Pro</span><p>尺寸是物理事實；購買前仍請以實物量測為準。</p></footer>
    </main>
  );
}
