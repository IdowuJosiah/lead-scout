import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSessionValue, isValidSession, MAX_AGE_SECONDS, SESSION_COOKIE } from "./sessionCore";

export { isValidSession, passwordMatches, SESSION_COOKIE } from "./sessionCore";

export async function startSession() {
    (await cookies()).set(SESSION_COOKIE, createSessionValue(), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: MAX_AGE_SECONDS,
    });
}

export async function endSession() {
    (await cookies()).delete(SESSION_COOKIE);
}

/** Call at the top of every server action and page: the proxy alone is not enough. */
export async function requireSession() {
    if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) redirect("/login");
}
