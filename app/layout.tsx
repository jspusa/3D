import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spatial Fit Pro｜3D 疊塔、裝箱與包裝模擬器",
  description: "以真實毫米比例配置箱件疊塔、判斷裝箱可行性，並上傳圖稿預覽三封袋與八面封袋成品。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: `${process.env.GITHUB_PAGES === "true" ? "/3D" : ""}/favicon.svg`,
    shortcut: `${process.env.GITHUB_PAGES === "true" ? "/3D" : ""}/favicon.svg`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
