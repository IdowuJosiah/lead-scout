import { AUDIT_VERSION, type LeadStore } from "../db.js";
import { rescoreAll } from "../export.js";
import { parseWebsite } from "../url.js";
import { websiteClass } from "../websiteClass.js";
import { isFreeProvider, isOwnDomain } from "./classify.js";
import { freeProviderFlag } from "./index.js";

export interface ReconcileReport {
    /** Stage 3 results removed because the lead's website is not an owned site, by class. */
    notOwnedSite: Record<string, { results: number; emails: number }>;
    /** Queued emails removed because they are at another business's domain. */
    domainMismatch: { leadId: number; name: string; email: string; siteHost: string }[];
    /** Stored (not queued) addresses at other domains, deleted. */
    otherDomainContactsDeleted: number;
    /** Queued free-provider emails that kept their place but gained a risk flag. */
    freeProviderFlagged: { leadId: number; name: string; email: string }[];
    /** Audits made before the current checks; refresh with `audit --upgrade`. */
    outdatedAudits: number;
}

/**
 * Bring stored stage 3 results in line with the current rules. Nothing is
 * fetched and no paid API is called: invalidated leads simply become eligible
 * again for the next `contacts` run, which reuses every cached lookup.
 */
export function reconcileContacts(store: LeadStore): ReconcileReport {
    rescoreAll(store);
    const report: ReconcileReport = { notOwnedSite: {}, domainMismatch: [], otherDomainContactsDeleted: 0, freeProviderFlagged: [], outdatedAudits: 0 };
    const db = store.db;
    const deleteResult = db.prepare("DELETE FROM contact_results WHERE lead_id = ?");
    const deleteContacts = db.prepare("DELETE FROM contacts WHERE lead_id = ?");
    const deleteContact = db.prepare("DELETE FROM contacts WHERE lead_id = ? AND email = ?");
    const contactsOf = db.prepare("SELECT email FROM contacts WHERE lead_id = ?");
    const setFlag = db.prepare("UPDATE contact_results SET risk_flag = ? WHERE lead_id = ?");

    db.exec("BEGIN");
    try {
        for (const { lead, result } of store.contactResults()) {
            const audit = store.getAudit(lead.id);
            const cls = websiteClass(lead.website_url, audit);
            if (cls !== "owned_site") {
                const r = (report.notOwnedSite[cls] ??= { results: 0, emails: 0 });
                r.results++;
                if (result.outcome === "email") r.emails++;
                deleteResult.run(lead.id);
                deleteContacts.run(lead.id);
                continue;
            }

            const siteHost = new URL(audit?.final_url ?? parseWebsite(lead.website_url)!.href).hostname;
            let chosenRemoved = false;
            for (const { email } of contactsOf.all(lead.id) as { email: string }[]) {
                const domain = email.split("@")[1]!;
                if (isOwnDomain(domain, siteHost) || isFreeProvider(domain)) continue;
                deleteContact.run(lead.id, email);
                if (result.outcome === "email" && result.email === email) {
                    chosenRemoved = true;
                    report.domainMismatch.push({ leadId: lead.id, name: lead.name, email, siteHost });
                } else {
                    report.otherDomainContactsDeleted++;
                }
            }
            if (chosenRemoved) {
                // The lead gets a fresh decision next run (other addresses, Hunter, or fallback).
                deleteResult.run(lead.id);
                continue;
            }

            if (result.outcome === "email" && result.email && isFreeProvider(result.email.split("@")[1]!)) {
                const flag = freeProviderFlag(result.email);
                if (!result.risk_flag?.includes(flag)) {
                    setFlag.run(result.risk_flag ? `${result.risk_flag}; ${flag}` : flag, lead.id);
                    report.freeProviderFlagged.push({ leadId: lead.id, name: lead.name, email: result.email });
                }
            }
        }
        db.exec("COMMIT");
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
    report.outdatedAudits = Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM audits WHERE COALESCE(audit_version, 1) < ${AUDIT_VERSION} AND status NOT IN ('social_profile','messaging_link','whatsapp_link')`).get() as { n: number }).n,
    );
    return report;
}

export function formatReconcileReport(r: ReconcileReport): string {
    const lines: string[] = [];
    const classEmails = Object.values(r.notOwnedSite).reduce((s, x) => s + x.emails, 0);
    const total = classEmails + r.domainMismatch.length;
    lines.push(`Emails invalidated: ${total}`);
    for (const [cls, x] of Object.entries(r.notOwnedSite)) {
        lines.push(`  - website is ${cls}, not an owned site: ${x.emails} queued email(s) (${x.results} stage-3 result(s) removed in total)`);
    }
    if (r.domainMismatch.length) {
        lines.push(`  - email domain does not match the lead's own site: ${r.domainMismatch.length}`);
        for (const m of r.domainMismatch) lines.push(`      #${m.leadId} ${m.name}: ${m.email} (site ${m.siteHost})`);
    }
    if (!total) lines.push("  (none)");
    if (r.otherDomainContactsDeleted) lines.push(`Other-domain addresses removed from stored contacts (were not queued): ${r.otherDomainContactsDeleted}`);
    lines.push(`Free-provider emails kept but flagged: ${r.freeProviderFlagged.length}`);
    for (const f of r.freeProviderFlagged) lines.push(`      #${f.leadId} ${f.name}: ${f.email}`);
    if (r.outdatedAudits) {
        lines.push(
            `Audits made before the multi-page cart, password and dead-site checks: ${r.outdatedAudits}. Refresh them (free) with: npm run cli -- audit --upgrade`,
        );
    }
    return lines.join("\n");
}
