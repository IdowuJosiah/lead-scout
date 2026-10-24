/**
 * Lighthouse mobile performance score, run against the Chromium instance
 * Playwright launched (over its remote-debugging port). Lighthouse's default
 * config is mobile: emulated mid-range phone + simulated slow 4G.
 */
export async function lighthouseMobileScore(
    url: string,
    port: number,
    opts: { locale: string; timeoutMs: number },
): Promise<{ score: number | null; error: string | null }> {
    const { default: lighthouse } = await import("lighthouse");
    let timer: NodeJS.Timeout | undefined;
    try {
        const run = lighthouse(url, {
            port,
            output: "json",
            logLevel: "error",
            onlyCategories: ["performance"],
            formFactor: "mobile",
            locale: opts.locale as never,
        });
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Lighthouse timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs);
        });
        const result = await Promise.race([run, timeout]);
        const lhr = result?.lhr;
        if (!lhr) return { score: null, error: "Lighthouse returned no result" };
        if (lhr.runtimeError) return { score: null, error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` };
        const score = lhr.categories.performance?.score;
        return typeof score === "number" ? { score: Math.round(score * 100), error: null } : { score: null, error: "no performance score" };
    } catch (err) {
        return { score: null, error: (err as Error).message };
    } finally {
        clearTimeout(timer);
    }
}
