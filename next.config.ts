import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": [
      "./codex-generated/**/*", "./tests/**/*", "./.data/**/*", "./.music-test-data/**/*",
      "./.git/**/*", "./.wrangler/**/*", "./.vinext/**/*", "./dist/**/*", "./outputs/**/*", "./work/**/*",
    ],
  },
  async headers() {
    return [{ source: '/classroom/fonts/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=604800, stale-while-revalidate=2592000' }] }];
  },
};

export default nextConfig;
