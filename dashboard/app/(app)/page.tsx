import Link from "next/link";
import { runNow } from "@/app/actions";
import { Flash, LoadError, NoData } from "@/components/flash";
import { SubmitButton } from "@/components/ui";
import { loadDashboard } from "@/lib/data";
import { when } from "@/lib/format";
import type { RunInfo } from "@/lib/types";

function Run({ title, run, tz }: { title: string; run: RunInfo | null; tz: string }) {
    return (
        <div className="card">
            <div className="spread">
                <strong>{title}</strong>
                <span className="muted small">{run ? when(run.finished_at, tz) : "not run yet"}</span>
            </div>
            {run ? (
                <ul className="steps small">
                    {run.steps.map((s) => (
                        <li key={s.step}>
                            <span className={`badge ${s.ok ? "good" : "bad"}`}>{s.ok ? "ok" : "failed"}</span>
                            <strong>{s.step}</strong> <span className="muted">{s.detail}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return (
        <div className="card stat">
            <div className="label">{label} this month</div>
            <div className="value">
                {used}
                <span className="muted small"> / {limit}</span>
            </div>
            <div className="meter" role="img" aria-label={`${used} of ${limit} used`}>
                <span style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

export default async function Overview({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
    const { msg } = await searchParams;
    const { snap, error } = await loadDashboard();
    if (!snap)
        return (
            <>
                <h1>Overview</h1>
                <Flash msg={msg} />
                <LoadError error={error} />
                {!error ? <NoData /> : null}
            </>
        );

    const tz = snap.region.timezone;
    const waiting = snap.batches.find((b) => b.status === "awaiting_approval" && !b.pending);
    const waitingCount = waiting?.items.filter((i) => i.status === "draft").length ?? 0;
    const chats = snap.chats.filter((c) => c.status === "draft" && !c.pending).length;
    const s = snap.stats;
    const tiles: [string, number | string][] = [
        ["Leads", s.leads ?? 0],
        ["No website", s.noWebsite ?? 0],
        ["Emails to approve", waitingCount],
        ["Emails sent", s.emails_sent ?? 0],
        ["WhatsApp to send", chats],
        ["Replies", s.replies ?? 0],
    ];

    return (
        <>
            <div className="spread">
                <h1>Overview</h1>
                <span className="muted small">
                    {snap.region.city}, {snap.region.country} · updated {when(snap.generated_at, tz)}
                </span>
            </div>
            <Flash msg={msg} />
            <LoadError error={error} />

            {!snap.sender.configured ? (
                <div className="notice warn">Add your name in config/outreach.json (sender.name) so the agent can write messages.</div>
            ) : null}
            {snap.region.allowed_to_email !== true ? (
                <div className="notice warn">Email is switched off for this region (allowed_to_email in config/region.json). Only WhatsApp messages will be drafted.</div>
            ) : null}
            {waitingCount ? (
                <div className="notice warn">
                    <strong>{waitingCount} email(s) are waiting for your approval.</strong> <Link href="/approve">Review them →</Link>
                </div>
            ) : null}
            {chats ? (
                <div className="notice">
                    {chats} WhatsApp message(s) ready to send. <Link href="/whatsapp">Open the list →</Link>
                </div>
            ) : null}

            <div className="grid">
                {tiles.map(([label, value]) => (
                    <div className="card stat" key={label}>
                        <div className="value">{value}</div>
                        <div className="label">{label}</div>
                    </div>
                ))}
            </div>

            <h2>API credits</h2>
            <div className="grid">
                <Meter label="Hunter" used={snap.usage.hunter.used} limit={snap.usage.hunter.limit} />
                <Meter label="ZeroBounce" used={snap.usage.zerobounce.used} limit={snap.usage.zerobounce.limit} />
            </div>

            <h2>Agent runs</h2>
            <p className="muted small">
                Weekly run: Mondays early morning. Sending: hourly, {snap.region.send_window.days} {snap.region.send_window.start}–{snap.region.send_window.end} ({tz}).
            </p>
            <Run title="Weekly run (find, audit, draft)" run={snap.runs.weekly} tz={tz} />
            <Run title="Latest send run" run={snap.runs.tick} tz={tz} />
            <div className="row">
                <form action={runNow}>
                    <input type="hidden" name="workflow" value="weekly" />
                    <SubmitButton className="btn btn-quiet" pendingText="Starting…">
                        Run weekly now
                    </SubmitButton>
                </form>
                <form action={runNow}>
                    <input type="hidden" name="workflow" value="send" />
                    <SubmitButton className="btn btn-quiet" pendingText="Starting…">
                        Send approved now
                    </SubmitButton>
                </form>
            </div>

            {snap.failures.length ? (
                <>
                    <h2>Recent problems</h2>
                    <div className="card table-wrap">
                        <table>
                            <tbody>
                                {snap.failures.slice(0, 10).map((f, i) => (
                                    <tr key={i}>
                                        <td className="muted small">{when(f.occurred_at, tz)}</td>
                                        <td>
                                            <span className="badge">{f.stage}</span>
                                        </td>
                                        <td className="small">
                                            {f.name ? <strong>{f.name}: </strong> : null}
                                            {f.message}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            ) : null}
        </>
    );
}
