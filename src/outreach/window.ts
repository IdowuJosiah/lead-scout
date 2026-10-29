import type { SendWindow } from "../config.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon-Fri", "Mon,Wed,Fri" or "Mon-Wed,Sat" -> set of day indexes (0 = Sunday). */
export function parseDays(spec: string): Set<number> {
    const out = new Set<number>();
    for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
        const [a, b] = part.split("-").map((d) => DAYS.findIndex((x) => x.toLowerCase() === d!.trim().slice(0, 3).toLowerCase()));
        if (a === undefined || a < 0 || (b !== undefined && b < 0)) throw new Error(`send_window.days: can't read "${part}" (use e.g. "Mon-Fri")`);
        if (b === undefined) out.add(a);
        else for (let d = a; ; d = (d + 1) % 7) {
            out.add(d);
            if (d === b) break;
        }
    }
    return out;
}

/** Wall-clock parts in the region's timezone. */
export function localParts(date: Date, timeZone: string): { day: number; minutes: number; dateKey: string } {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" })
            .formatToParts(date)
            .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    return {
        day: DAYS.indexOf(parts.weekday!),
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h! * 60 + m!;
};

export function inSendWindow(date: Date, window: SendWindow, timeZone: string): boolean {
    const { day, minutes } = localParts(date, timeZone);
    return parseDays(window.days).has(day) && minutes >= toMinutes(window.start) && minutes < toMinutes(window.end);
}
