import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next 16.4's Turbopack route runtime is not included by its default trace.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js"],
  },
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
