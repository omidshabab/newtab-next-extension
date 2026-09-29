import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The extension ships as a static, unpacked directory. No Next.js server
  // exists at runtime, so the app must be a fully pre-rendered static export.
  output: "export",
  // Chrome rejects an extension whose *top-level* names start with "_", and
  // Next emits a `_next/` tree. Prefixing assets with `/assets` lets the build
  // nest that tree under assets/, which passes the check. This must stay in
  // sync with ASSETS_DIR in scripts/build-extension.mjs.
  assetPrefix: "/assets",
  // next/image optimises through a server route that does not exist in a
  // static export. Serve the original file instead.
  images: { unoptimized: true },
  reactCompiler: true,
};

export default nextConfig;
