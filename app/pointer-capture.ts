export function safeSetPointerCapture(element: Element | null, pointerId: number) {
  if (!element || typeof element.setPointerCapture !== "function") return false;
  try {
    element.setPointerCapture(pointerId);
    return true;
  } catch {
    return false;
  }
}

export function safeReleasePointerCapture(element: Element | null, pointerId: number) {
  if (!element || typeof element.releasePointerCapture !== "function") return;
  try {
    if (typeof element.hasPointerCapture === "function" && !element.hasPointerCapture(pointerId)) return;
    element.releasePointerCapture(pointerId);
  } catch {
    // Some iOS/WKWebView versions throw when an SVG pointer is already inactive.
  }
}
