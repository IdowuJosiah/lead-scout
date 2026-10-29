import Link from "next/link";
import { doNotContact, markChat } from "@/app/actions";
import { Flash, LoadError, NoData } from "@/components/flash";
import { CopyButton, SubmitButton } from "@/components/ui";
import { loadDashboard } from "@/lib/data";
import { CLASS_LABEL, phoneDigits, STATUS_LABEL, when, whatsappHref } from "@/lib/format";
import type { OutreachItem } from "@/lib/types";

function ChatCard({ it }: { it: OutreachItem }) {
    const wa = it.channel === "whatsapp" ? whatsappHref(it.recipient, it.body) : null;
    const tel = it.channel === "phone" ? phoneDigits(it.recipient) : null;
    return (
        <div className="card">
            <div className="spread">
                <strong>{it.name}</strong>
                <span className="muted small">
                    score {it.score ?? "–"}
                    {it.reviews != null ? ` · ${it.reviews} reviews` : ""}
                </span>
            </div>
            <div className="row small" style={{ marginTop: 4 }}>
                {it.website_class ? <span className="badge">{CLASS_LABEL[it.website_class] ?? it.website_class}</span> : null}
                {it.category ? <span className="badge">{it.category}</span> : null}
                <span className="muted">{it.channel === "whatsapp" ? "WhatsApp" : "Phone"}: {it.recipient}</span>
            </div>
            <div className="message">{it.body}</div>
            <div className="row">
                {wa ? (
                    <a className="btn" href={wa} target="_blank" rel="noreferrer noopener">
                        Open in WhatsApp
                    </a>
                ) : null}
                {tel ? (
                    <>
                        <a className="btn" href={`tel:${tel}`}>
                            Call
                        </a>
                        <a className="btn btn-quiet" href={`sms:${tel}?&body=${encodeURIComponent(it.body)}`}>
                            Text (SMS)
                        </a>
                    </>
                ) : null}
                <CopyButton text={it.body} />
            </div>
            <div className="row" style={{ marginTop: 8 }}>
                <form action={markChat}>
                    <input type="hidden" name="outreach_id" value={it.id} />
                    <input type="hidden" name="kind" value="whatsapp_done" />
                    <SubmitButton className="btn btn-quiet">I sent it ✓</SubmitButton>
                </form>
                <form action={markChat}>
                    <input type="hidden" name="outreach_id" value={it.id} />
                    <input type="hidden" name="kind" value="skip" />
                    <SubmitButton className="btn btn-quiet">Skip</SubmitButton>
                </form>
                <form action={doNotContact}>
                    <input type="hidden" name="lead_id" value={it.lead_id} />
                    <input type="hidden" name="from" value="/whatsapp" />
                    <SubmitButton className="btn btn-danger">Never contact</SubmitButton>
                </form>
            </div>
            {it.evidence ? (
                <details>
                    <summary>What the audit measured</summary>
                    <p className="small">{it.evidence}</p>
                </details>
            ) : null}
        </div>
    );
}

export default async function WhatsappPage({ searchParams }: { searchParams: Promise<{ msg?: string; show?: string }> }) {
    const { msg, show } = await searchParams;
    const { snap, error } = await loadDashboard();
    if (!snap)
        return (
            <>
                <h1>WhatsApp</h1>
                <Flash msg={msg} />
                <LoadError error={error} />
                {!error ? <NoData /> : null}
            </>
        );
    const tz = snap.region.timezone;
    const todo = snap.chats.filter((c) => c.status === "draft" && !c.pending);
    const done = snap.chats.filter((c) => c.status !== "draft" || c.pending);

    return (
        <>
            <h1>WhatsApp</h1>
            <Flash msg={msg} />
            <LoadError error={error} />
            <p className="muted">
                WhatsApp doesn&apos;t allow automated cold messages, so this is one tap each: <strong>Open in WhatsApp</strong> opens the chat with the message
                already typed. Press send there, then come back and tap <strong>I sent it</strong>. Best sent {snap.region.send_window.days}{" "}
                {snap.region.send_window.start}–{snap.region.send_window.end}.
            </p>
            <div className="row">
                <Link className={`btn ${show === "done" ? "btn-quiet" : ""}`} href="/whatsapp">
                    To send ({todo.length})
                </Link>
                <Link className={`btn ${show === "done" ? "" : "btn-quiet"}`} href="/whatsapp?show=done">
                    Done ({done.length})
                </Link>
            </div>

            {show === "done" ? (
                <div className="card table-wrap">
                    <table>
                        <tbody>
                            {done.map((c) => (
                                <tr key={c.id}>
                                    <td>{c.name}</td>
                                    <td>
                                        <span className="badge">{c.pending ?? STATUS_LABEL[c.status] ?? c.status}</span>
                                    </td>
                                    <td className="muted small">{c.sent_at ? when(c.sent_at, tz) : c.pending ? "syncing" : ""}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : todo.length ? (
                todo.map((c) => <ChatCard key={c.id} it={c} />)
            ) : (
                <div className="card muted">Nothing to send right now. New messages are drafted on the weekly run.</div>
            )}
        </>
    );
}
