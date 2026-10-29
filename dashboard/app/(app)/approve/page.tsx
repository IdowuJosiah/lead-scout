import { approveBatch } from "@/app/actions";
import { Flash, LoadError, NoData } from "@/components/flash";
import { SubmitButton } from "@/components/ui";
import { loadDashboard } from "@/lib/data";
import { STATUS_LABEL, statusTone, when } from "@/lib/format";
import type { OutreachItem } from "@/lib/types";

function EmailCard({ it }: { it: OutreachItem }) {
    return (
        <div className="card">
            <div className="spread">
                <label className="check">
                    <input type="checkbox" name={`approve_${it.id}`} defaultChecked aria-label={`Send to ${it.name}`} />
                    {it.name}
                </label>
                <span className="muted small">
                    score {it.score ?? "–"}
                    {it.reviews != null ? ` · ${it.reviews} Google reviews` : ""}
                </span>
            </div>
            <div className="row small" style={{ marginTop: 6 }}>
                <span>To: {it.recipient}</span>
                {it.verification_status ? <span className={`badge ${it.verification_status === "valid" ? "good" : "warn"}`}>{it.verification_status}</span> : null}
                {it.risk_flag ? <span className="badge warn">{it.risk_flag}</span> : null}
                {it.website ? (
                    <a href={it.website} target="_blank" rel="noreferrer noopener">
                        site
                    </a>
                ) : null}
            </div>
            {it.evidence ? (
                <details>
                    <summary>What the audit measured</summary>
                    <p className="small">{it.evidence}</p>
                </details>
            ) : null}
            <label className="field">
                <span>Subject</span>
                <input type="text" name={`subject_${it.id}`} defaultValue={it.subject ?? ""} maxLength={200} />
            </label>
            <label className="field">
                <span>Message (edit freely; the &quot;stop&quot; line is always kept)</span>
                <textarea name={`body_${it.id}`} defaultValue={it.body} maxLength={5000} />
            </label>
        </div>
    );
}

export default async function ApprovePage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
    const { msg } = await searchParams;
    const { snap, error } = await loadDashboard();
    if (!snap)
        return (
            <>
                <h1>Approve emails</h1>
                <Flash msg={msg} />
                <LoadError error={error} />
                {!error ? <NoData /> : null}
            </>
        );
    const tz = snap.region.timezone;
    const batch = snap.batches.find((b) => b.status === "awaiting_approval");
    const drafts = batch?.items.filter((i) => i.status === "draft") ?? [];
    const history = snap.batches.filter((b) => b.status !== "awaiting_approval");

    return (
        <>
            <h1>Approve emails</h1>
            <Flash msg={msg} />
            <LoadError error={error} />

            {!batch || !drafts.length ? (
                <div className="card muted">No emails are waiting for approval. New drafts are written on the weekly run.</div>
            ) : batch.pending ? (
                <div className="notice good">
                    Your approval for batch #{batch.id} was received. The agent applies it on its next run and sends inside the send window (
                    {snap.region.send_window.days} {snap.region.send_window.start}–{snap.region.send_window.end}), a few minutes apart.
                </div>
            ) : (
                <form action={approveBatch}>
                    <input type="hidden" name="batch_id" value={batch.id} />
                    <p className="muted">
                        Batch #{batch.id} · drafted {when(batch.created_at, tz)} · {drafts.length} email(s). Untick any you don&apos;t want to send;
                        unticked emails are skipped. At most {snap.limits.daily_email_limit} go out per day.
                    </p>
                    {drafts.map((it) => (
                        <EmailCard key={it.id} it={it} />
                    ))}
                    <div className="row action-bar">
                        <SubmitButton pendingText="Approving…">Approve ticked emails</SubmitButton>
                    </div>
                </form>
            )}

            {history.length ? (
                <>
                    <h2>Earlier batches</h2>
                    {history.map((b) => (
                        <details className="card" key={b.id}>
                            <summary>
                                Batch #{b.id} · {when(b.created_at, tz)} · {b.items.filter((i) => i.status === "sent").length}/{b.items.length} sent
                            </summary>
                            <div className="table-wrap">
                                <table>
                                    <tbody>
                                        {b.items.map((it) => (
                                            <tr key={it.id}>
                                                <td>{it.name}</td>
                                                <td className="small">{it.recipient}</td>
                                                <td>
                                                    <span className={`badge ${statusTone(it.status)}`}>{STATUS_LABEL[it.status] ?? it.status}</span>
                                                    {it.replied ? <span className="badge good">replied</span> : null}
                                                </td>
                                                <td className="muted small">{it.sent_at ? when(it.sent_at, tz) : (it.error ?? "")}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </details>
                    ))}
                </>
            ) : null}
        </>
    );
}
