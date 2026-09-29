import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The extension ships as a static, unpacked directory. No Next.js server
  // exists at runtime, so the app must be a fully pre-rendered static export.
  output: "export",
  // next/image optimises through a server route that does not exist in a
  // static export. Serve the original file instead.
  images: { unoptimized: true },
  reactCompiler: true,
};

export default nextConfig;
