import { Flash, LoadError, NoData } from "@/components/flash";
import { loadDashboard } from "@/lib/data";
import { when } from "@/lib/format";

const KIND: Record<string, { label: string; tone: string }> = {
    reply: { label: "Reply", tone: "good" },
    opt_out: { label: "Asked to stop", tone: "bad" },
    bounce: { label: "Bounced", tone: "bad" },
    auto_reply: { label: "Auto-reply", tone: "" },
};

export default async function RepliesPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
    const { msg } = await searchParams;
    const { snap, error } = await loadDashboard();
    if (!snap)
        return (
            <>
                <h1>Replies</h1>
                <Flash msg={msg} />
                <LoadError error={error} />
                {!error ? <NoData /> : null}
            </>
        );
    const tz = snap.region.timezone;
    const sent = snap.batches
        .flatMap((b) => b.items)
        .filter((i) => i.status === "sent" || i.status === "bounced")
        .sort((a, b) => (b.sent_at ?? "").localeCompare(a.sent_at ?? ""));

    return (
        <>
            <h1>Replies</h1>
            <Flash msg={msg} />
            <LoadError error={error} />
            <p className="muted">
                Read from your mailbox on every run. Anyone who replies, asks to stop, or bounces is never emailed again. Answer replies from your own mail app.
            </p>
            {snap.replies.length ? (
                snap.replies.map((r) => (
                    <div className="card" key={r.id}>
                        <div className="spread">
                            <span>
                                <span className={`badge ${KIND[r.kind]?.tone ?? ""}`}>{KIND[r.kind]?.label ?? r.kind}</span>
                                <strong>{r.name ?? r.from_addr}</strong>
                            </span>
                            <span className="muted small">{when(r.received_at, tz)}</span>
                        </div>
                        <div className="muted small">
                            {r.from_addr} · {r.subject}
                        </div>
                        {r.snippet ? <div className="message">{r.snippet}</div> : null}
                    </div>
                ))
            ) : (
                <div className="card muted">No replies yet.</div>
            )}

            <h2>Sent emails ({sent.length})</h2>
            <div className="card table-wrap">
                <table>
                    <tbody>
                        {sent.map((i) => (
                            <tr key={i.id}>
                                <td>
                                    <strong>{i.name}</strong>
                                    <div className="muted small">{i.subject}</div>
                                </td>
                                <td className="small">{i.recipient}</td>
                                <td>
                                    {i.status === "bounced" ? <span className="badge bad">bounced</span> : null}
                                    {i.replied ? <span className="badge good">replied</span> : null}
                                </td>
                                <td className="muted small">{when(i.sent_at, tz)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
