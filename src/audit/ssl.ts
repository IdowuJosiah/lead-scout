import { request } from "node:https";

export type SslResult = { ssl: "valid" | "invalid" | "none" | "unknown"; detail: string };

const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|DEPTH_ZERO|UNABLE_TO_GET_ISSUER/i;
const NO_HTTPS = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPROTO"]);

/** Classify a Chromium navigation error such as net::ERR_CERT_DATE_INVALID. */
export function chromiumCertError(message: string): string | null {
    const m = /net::(ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+|ERR_BAD_SSL_CLIENT_AUTH_CERT)/.exec(message);
    return m?.[1] ?? null;
}

/**
 * Probe https://host:443 with full certificate verification. Used when the
 * page itself was served over plain HTTP, to tell "no HTTPS" from "bad cert".
 */
export function probeHttps(host: string, timeoutMs = 10_000): Promise<SslResult> {
    return new Promise((resolve) => {
        const req = request({ host, port: 443, method: "HEAD", path: "/", timeout: timeoutMs, rejectUnauthorized: true }, (res) => {
            res.resume();
            resolve({ ssl: "valid", detail: `HTTPS probe answered HTTP ${res.statusCode} with a valid certificate` });
        });
        req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
        req.on("error", (err: NodeJS.ErrnoException) => {
            const code = err.code ?? err.message;
            if (CERT_ERRORS.test(code)) resolve({ ssl: "invalid", detail: `HTTPS certificate rejected: ${code}` });
            else if (NO_HTTPS.has(code)) resolve({ ssl: "none", detail: `HTTPS probe failed: ${code}` });
            else resolve({ ssl: "unknown", detail: `HTTPS probe error: ${code}` });
        });
        req.end();
    });
}
