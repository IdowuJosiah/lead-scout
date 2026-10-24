import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Small GET client for robots.txt. Unlike fetch it tolerates invalid TLS
 * certificates (reading a public file over a broken cert is harmless, and the
 * cert problem is recorded separately by the page load), follows up to 5
 * redirects, and caps the body size.
 */
export function httpGet(
    url: string,
    opts: { headers?: Record<string, string>; timeoutMs: number; maxBytes?: number; redirects?: number },
): Promise<{ status: number; body: string; finalUrl: string }> {
    const maxBytes = opts.maxBytes ?? 512_000;
    const redirectsLeft = opts.redirects ?? 5;
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const request = u.protocol === "https:" ? httpsRequest : httpRequest;
        const req = request(u, { method: "GET", headers: opts.headers, timeout: opts.timeoutMs, rejectUnauthorized: false }, (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;
            if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
                res.resume();
                resolve(httpGet(new URL(location, u).href, { ...opts, redirects: redirectsLeft - 1 }));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => {
                size += c.length;
                if (size <= maxBytes) chunks.push(c);
                else res.destroy();
            });
            const done = () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), finalUrl: u.href });
            res.on("end", done);
            res.on("close", done);
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(Object.assign(new Error(`timeout after ${opts.timeoutMs}ms`), { code: "ETIMEDOUT" })));
        req.on("error", reject);
        req.end();
    });
}
