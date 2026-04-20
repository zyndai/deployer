import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // SSE + long-lived streaming responses from route handlers
    // need to bypass the default body-size limits.
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
  // Uploads are limited to 50MB per file in the validator. Next's default
  // request parser in route handlers streams multipart bodies, so we
  // only bump the hard ceiling as a safety net.
  output: "standalone",
};

export default nextConfig;
