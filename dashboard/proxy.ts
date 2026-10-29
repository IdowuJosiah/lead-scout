import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "./lib/sessionCore";

/** Everything except the login page needs a valid session. Server actions check again themselves. */
export function proxy(request: NextRequest) {
    if (request.nextUrl.pathname === "/login") return NextResponse.next();
    let ok = false;
    try {
        ok = isValidSession(request.cookies.get(SESSION_COOKIE)?.value);
    } catch {
        ok = false; // SESSION_SECRET missing: nobody gets in
    }
    if (ok) return NextResponse.next();
    return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
