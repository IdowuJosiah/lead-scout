/** Minimal stderr logger so stdout stays clean for piping. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info";

export function setLogLevel(level: Level) {
    threshold = level;
}

function write(level: Level, msg: string) {
    if (ORDER[level] < ORDER[threshold]) return;
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}\n`);
}

export const log = {
    debug: (m: string) => write("debug", m),
    info: (m: string) => write("info", m),
    warn: (m: string) => write("warn", m),
    error: (m: string) => write("error", m),
};

export type Logger = typeof log;

export const errMessage = (err: unknown): string => {
    if (err instanceof Error) {
        const code = (err.cause as { code?: string } | undefined)?.code ?? (err as NodeJS.ErrnoException).code;
        return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
    }
    return String(err);
};
