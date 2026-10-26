import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";
import { BODY_LIMITS } from "./src/server/repository-sources/limits";

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders({ enforceCsp: true }) }];
  },
  // web-tree-sitter loads its own WASM runtime and grammar files from node_modules at runtime (Phase 2H structure
  // analysis), so it must stay a plain Node dependency instead of being bundled.
  serverExternalPackages: ["web-tree-sitter"],
  experimental: {
    // Request bodies the proxy buffers; must stay above the source-upload request limit (enforced by the upload
    // Route Handler) so an allowed upload is never truncated. Server Actions keep the default 1 MB body limit.
    proxyClientMaxBodySize: BODY_LIMITS.proxyBodyBufferBytes,
  },
};

export default nextConfig;
