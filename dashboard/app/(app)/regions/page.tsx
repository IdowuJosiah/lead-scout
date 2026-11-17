import Link from "next/link";
import { removeRegion, scout, setRegionEmail } from "@/app/actions";
import { Flash, LoadError, NoData } from "@/components/flash";
import { SubmitButton } from "@/components/ui";
import { loadDashboard } from "@/lib/data";
import { when } from "@/lib/format";
import type { Region } from "@/lib/types";

function RegionCard({ r, tz, only }: { r: Region; tz: string; only: boolean }) {
    return (
        <div className="card">
            <div className="spread">
                <strong>{r.label}</strong>
                <span className="muted small">
                    {r.leads} lead(s) · {r.last_scouted_at ? `scouted ${when(r.last_scouted_at, tz)}` : "not scouted yet"}
                </span>
            </div>
            <div className="row small" style={{ marginTop: 4 }}>
                <span className="badge">{r.country_code}</span>
                <span className="muted">
                    {r.radius_km} km around {r.city} · {r.timezone}
                    {r.currency ? ` · ${r.currency}` : ""} · sends {r.send_window.days} {r.send_window.start}–{r.send_window.end}
                </span>
            </div>
            {r.keywords?.length ? <p className="muted small">Looking for: {r.keywords.join(", ")}</p> : null}
            <div className="row" style={{ marginTop: 8 }}>
                {r.pending ? <span className="badge warn">{r.pending}</span> : null}
                {r.allowed_to_email ? (
                    <>
                        <span className="badge good">email on</span>
                        <form action={setRegionEmail}>
                            <input type="hidden" name="region_id" value={r.id} />
                            <input type="hidden" name="allowed" value="false" />
                            <SubmitButton className="btn btn-quiet">Turn email off</SubmitButton>
                        </form>
                    </>
                ) : (
                    <>
                        <span className="badge">email off · WhatsApp only</span>
                        <form action={setRegionEmail} className="row">
                            <input type="hidden" name="region_id" value={r.id} />
                            <input type="hidden" name="allowed" value="true" />
                            <label className="small" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                <input type="checkbox" name="confirm" required /> I&apos;ve checked I may cold-email businesses in {r.country}
                            </label>
                            <SubmitButton className="btn btn-quiet">Turn email on</SubmitButton>
                        </form>
                    </>
                )}
                <Link className="btn btn-quiet" href={`/leads?r=${r.id}`}>
                    See leads
                </Link>
                {!only ? (
                    <form action={removeRegion}>
                        <input type="hidden" name="region_id" value={r.id} />
                        <SubmitButton className="btn btn-danger">Stop scouting</SubmitButton>
                    </form>
                ) : null}
            </div>
        </div>
    );
}

export default async function RegionsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
    const { msg } = await searchParams;
    const { snap, error } = await loadDashboard();
    const regions = snap?.regions ?? [];
    const tz = snap?.region.timezone ?? "UTC";
    const scoutRun = snap?.runs.scout ?? null;

    return (
        <>
            <h1>Scout a place</h1>
            <Flash msg={msg} />
            <LoadError error={error} />
            <div className="card">
                <form action={scout}>
                    <label className="field">
                        <span>Place: a city, area or country (e.g. Dubai, Lekki, Austin Texas, Nairobi)</span>
                        <input type="text" name="place" required minLength={2} maxLength={80} placeholder="Dubai" autoComplete="off" />
                    </label>
                    <label className="field">
                        <span>What kind of businesses (optional, comma-separated; leave empty for the usual list)</span>
                        <input type="text" name="keywords" maxLength={400} placeholder="fashion boutique, skincare, bakery" autoComplete="off" />
                    </label>
                    <SubmitButton pendingText="Starting…">Scout</SubmitButton>
                </form>
                <p className="muted small">
                    The agent works out the area, country, timezone, currency and local payment providers by itself, then finds businesses, audits their sites and
                    drafts messages. Nothing is sent without you. The place is then included in every weekly run.
                </p>
                <p className="muted small">
                    <strong>Email starts off in a new country.</strong> Cold-email rules differ by country (some need prior consent), so you turn it on per place once
                    you&apos;ve checked. Until then, those leads get WhatsApp drafts only, and no Hunter credits are spent on them.
                </p>
            </div>

            {scoutRun ? (
                <div className="card">
                    <div className="spread">
                        <strong>Last scout{scoutRun.place ? `: ${scoutRun.place}` : ""}</strong>
                        <span className="muted small">{when(scoutRun.finished_at, tz)}</span>
                    </div>
                    <ul className="steps small">
                        {scoutRun.steps.map((s) => (
                            <li key={s.step}>
                                <span className={`badge ${s.ok ? "good" : "bad"}`}>{s.ok ? "ok" : "failed"}</span>
                                <strong>{s.step}</strong> <span className="muted">{s.detail}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            <h2>Places ({regions.length})</h2>
            {!snap && !error ? <NoData /> : null}
            {snap && !regions.length ? <p className="muted">No places yet. The first run adds your home city from config/region.json.</p> : null}
            {regions.map((r) => (
                <RegionCard key={r.id} r={r} tz={r.timezone} only={regions.length === 1} />
            ))}
        </>
    );
}
