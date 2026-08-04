# 3D 裝箱與 LV 疊塔計算器

以真實毫米尺寸建立 3D 箱體，檢查物品是否能放入，並模擬 LV 硬箱與錶盒的堆疊比例、位置及材質。

## 直接使用

https://box-fit-3d.brave-prawn-0848.chatgpt.site/

## 主要功能

- 自訂容器與物品的長、寬、高
- 3D 拖曳、旋轉、縮放、置中與自動疊放
- 裝箱適配判斷與尺寸餘量提示
- LV Alzer、Bisten 與錶盒三疊示意
- 每層可切換深灰棋盤格或黑色老花
- 上傳圖片製作三封袋與八面封袋包裝示意
- 儲存版本、分享專案及列印報告

## 本機執行

需要 Node.js 22.13 或更新版本，以及 Linux 環境。

```bash
npm run install:ci
npm run dev
```

## 驗證

```bash
npm test
npm run lint
```

## 技術

Next.js、React、TypeScript、Vinext、Vite 與 Cloudflare Workers。

> 3D 圖案與尺寸為購買前的比例模擬；實物帆布裁片、五金位置與製造公差可能不同，購買前仍應以門市實測為準。
