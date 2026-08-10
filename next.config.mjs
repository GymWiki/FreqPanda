/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  // ssh2 (app/api/admin/run-once/fix-rrsync — a temporary route, see its
  // own doc comment) ships an optional native addon (sshcrypto.node) that
  // webpack's default bundling chokes on trying to parse as JS. This tells
  // Next.js to `require()` it directly at runtime in the serverless
  // function instead of bundling it. Safe to remove once that route is
  // deleted and nothing else depends on ssh2.
  experimental: {
    serverComponentsExternalPackages: ["ssh2"],
  },
};

export default nextConfig;
