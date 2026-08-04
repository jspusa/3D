import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  for (const expected of [
    "Spatial Fit Pro",
    "包裝預覽",
    "真實比例疊塔",
    "新增專案",
    "加入箱件",
    "列印／儲存 PDF",
    "Alzer 65",
    "Bisten 50",
    "LV 錶盒",
    "花色比較",
    "全黑老花",
    "深灰棋盤格",
    "黑色老花",
  ]) {
    assert.ok(html.includes(expected), `expected rendered HTML to contain ${expected}`);
  }
});

test("guards pointer capture calls for embedded mobile browsers", async () => {
  const interactiveSources = await Promise.all([
    "../app/page.tsx",
    "../app/tower-studio.tsx",
    "../app/packaging-studio.tsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

  for (const source of interactiveSources) {
    assert.doesNotMatch(source, /\.setPointerCapture\(/, "interactive views must use the guarded pointer helper");
    assert.doesNotMatch(source, /\.hasPointerCapture\(/, "interactive views must use the guarded pointer helper");
    assert.doesNotMatch(source, /\.releasePointerCapture\(/, "interactive views must use the guarded pointer helper");
    assert.match(source, /safeSetPointerCapture|safeReleasePointerCapture/);
  }

  const helper = await readFile(new URL("../app/pointer-capture.ts", import.meta.url), "utf8");
  assert.match(helper, /typeof element\.setPointerCapture !== "function"/);
  assert.match(helper, /try \{/);
  assert.match(helper, /catch \{/);
});
