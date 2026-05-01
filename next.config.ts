import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/v1/session/:path*",
        destination: "http://localhost:8001/api/v1/session/:path*",
      },
    ];
  },
};

export default nextConfig;
