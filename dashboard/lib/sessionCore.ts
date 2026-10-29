/** Pure session signing, safe to use from proxy.ts. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "ls_session";
export const MAX_AGE_SECONDS = 30 * 24 * 3600;

function secret(): string {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 16) throw new Error("SESSION_SECRET must be set (16+ characters)");
    return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** Cookie value: "<expiry-epoch-seconds>.<hmac>". */
export function createSessionValue(now = Date.now()): string {
    const exp = String(Math.floor(now / 1000) + MAX_AGE_SECONDS);
    return `${exp}.${sign(exp)}`;
}

export function isValidSession(value: string | undefined, now = Date.now()): boolean {
    if (!value) return false;
    const [exp, mac] = value.split(".");
    if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
    const expected = Buffer.from(sign(exp));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Constant-time password check (hashing first makes lengths equal). */
export function passwordMatches(given: string): boolean {
    const real = process.env.DASHBOARD_PASSWORD;
    if (!real) return false;
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(real).digest();
    return timingSafeEqual(a, b);
}

