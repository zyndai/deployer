import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // SSE + long-lived streaming responses from route handlers
    // need to bypass the default body-size limits.
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
  // dockerode pulls in ssh2 + cpu-features (native .node binding) which
  // webpack can't bundle for server routes. Keep them as runtime
  // require()s instead. Used by /api/images and any future Docker-backed
  // routes on the Next side.
  serverExternalPackages: ["dockerode", "ssh2", "cpu-features"],
  // Uploads are limited to 50MB per file in the validator. Next's default
  // request parser in route handlers streams multipart bodies, so we
  // only bump the hard ceiling as a safety net.
  output: "standalone",
};

export default nextConfig;
