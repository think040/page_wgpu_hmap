import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  // .wgsl 셰이더 파일을 문자열로 import (Turbopack: 내장 raw 타입 / webpack: asset/source)
  turbopack: {
    rules: {
      "*.wgsl": { type: "raw" },
    },
  },
  webpack: (config) => {
    config.module.rules.push({ test: /\.wgsl$/, type: "asset/source" });
    return config;
  },
};

export default nextConfig;
