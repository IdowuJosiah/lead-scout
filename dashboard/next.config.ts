import { resolve } from "node:path";
import type { NextConfig } from "next";

// The dashboard is its own app inside the lead-scout repo.
const root = resolve(".");

const nextConfig: NextConfig = {
    poweredByHeader: false,
    outputFileTracingRoot: root,
    turbopack: { root },
    async headers() {
        return [
            {
                source: "/:path*",
                headers: [
                    { key: "X-Frame-Options", value: "DENY" },
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    { key: "Referrer-Policy", value: "no-referrer" },
                    { key: "X-Robots-Tag", value: "noindex, nofollow" },
                ],
            },
        ];
    },
};

export default nextConfig;
