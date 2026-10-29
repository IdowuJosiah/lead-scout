import { doNotContact } from "@/app/actions";
import { Flash, LoadError, NoData } from "@/components/flash";
import { SubmitButton } from "@/components/ui";
import { loadDashboard } from "@/lib/data";
import { CLASS_LABEL } from "@/lib/format";

const PAGE = 100;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ msg?: string; q?: string; cls?: string; page?: string }> }) {
    const { msg, q = "", cls = "", page = "1" } = await searchParams;
    const { snap, error } = await loadDashboard();
    if (!snap)
        return (
            <>
                <h1>Leads</h1>
                <Flash msg={msg} />
                <LoadError error={error} />
                {!error ? <NoData /> : null}
            </>
        );
    const needle = q.trim().toLowerCase();
    const filtered = snap.leads.filter(
        (l) =>
            (!cls || l.website_class === cls) &&
            (!needle || [l.name, l.category, l.website, l.phone].some((v) => v?.toLowerCase().includes(needle))),
    );
    const p = Math.max(1, Number(page) || 1);
    const rows = filtered.slice((p - 1) * PAGE, p * PAGE);
    const pages = Math.ceil(filtered.length / PAGE);
    const qs = (n: number) => `?${new URLSearchParams({ ...(q ? { q } : {}), ...(cls ? { cls } : {}), page: String(n) })}`;

    return (
        <>
            <h1>Leads</h1>
            <Flash msg={msg} />
            <LoadError error={error} />
            <form className="row" method="get">
                <input type="search" name="q" defaultValue={q} placeholder="Search name, category, website, phone" style={{ flex: "1 1 220px" }} />
                <select name="cls" defaultValue={cls} style={{ flex: "0 1 200px" }}>
                    <option value="">All website types</option>
                    {Object.entries(CLASS_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>
                            {v}
                        </option>
                    ))}
                </select>
                <button className="btn btn-quiet" type="submit">
                    Filter
                </button>
            </form>
            <p className="muted small">
                {filtered.length} lead(s), ranked by score, then Google review count.
            </p>
            <div className="card table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Score</th>
                            <th>Business</th>
                            <th>Website</th>
                            <th>Reviews</th>
                            <th>Outreach</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((l) => (
                            <tr key={l.id}>
                                <td className="num">{l.score ?? "–"}</td>
                                <td>
                                    <strong>{l.name}</strong>
                                    <div className="muted small">
                                        {l.category}
                                        {l.phone ? ` · ${l.phone}` : ""}
                                    </div>
                                    {l.evidence ? (
                                        <details>
                                            <summary>Evidence</summary>
                                            <p className="small">{l.evidence}</p>
                                        </details>
                                    ) : null}
                                </td>
                                <td className="small">
                                    <span className="badge">{CLASS_LABEL[l.website_class ?? "none"] ?? l.website_class}</span>
                                    {l.website ? (
                                        <div>
                                            <a href={l.website} target="_blank" rel="noreferrer noopener">
                                                {l.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
                                            </a>
                                        </div>
                                    ) : null}
                                </td>
                                <td className="num">{l.reviews ?? "–"}</td>
                                <td className="small">
                                    {l.pending ? <span className="badge warn">{l.pending}</span> : null}
                                    {l.replied ? <span className="badge good">replied</span> : null}
                                    {l.outreach.map((o, i) => (
                                        <span key={i} className="badge">
                                            {o.channel} {o.status}
                                        </span>
                                    ))}
                                </td>
                                <td>
                                    {!l.pending ? (
                                        <form action={doNotContact}>
                                            <input type="hidden" name="lead_id" value={l.id} />
                                            <input type="hidden" name="from" value="/leads" />
                                            <SubmitButton className="btn btn-danger">Never contact</SubmitButton>
                                        </form>
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {pages > 1 ? (
                <div className="row">
                    {p > 1 ? (
                        <a className="btn btn-quiet" href={qs(p - 1)}>
                            ← Previous
                        </a>
                    ) : null}
                    <span className="muted small">
                        Page {p} of {pages}
                    </span>
                    {p < pages ? (
                        <a className="btn btn-quiet" href={qs(p + 1)}>
                            Next →
                        </a>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}
