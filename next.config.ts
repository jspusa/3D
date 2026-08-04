import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";

const nextConfig: NextConfig = {
  ...(isGitHubPages
    ? {
        output: "export",
        basePath: "/3D",
        assetPrefix: "/3D",
        trailingSlash: true,
        images: { unoptimized: true },
        // The Cloudflare-only database helper imports `cloudflare:workers`.
        // It is not part of this client-only Pages build and is validated by
        // the regular Vinext build instead.
        typescript: { ignoreBuildErrors: true },
      }
    : {}),
};

export default nextConfig;
