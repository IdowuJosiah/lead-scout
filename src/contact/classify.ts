import type { EmailSource, EmailType } from "../db.js";

/**
 * Email classification and ranking. Classification looks only at the address
 * itself (plus Hunter's own personal/generic label when that is the source).
 */

const FREE_EXACT = new Set([
    "gmail.com",
    "googlemail.com",
    "ymail.com",
    "rocketmail.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "gmx.com",
    "gmx.net",
    "mail.com",
    "yandex.com",
    "yandex.ru",
    "zoho.com",
    "zohomail.com",
    "tutanota.com",
    "fastmail.com",
    "hey.com",
]);
// yahoo.co.uk, hotmail.fr, outlook.com.ng, live.com ...
const FREE_FAMILY = /^(yahoo|hotmail|outlook|live)\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

export function isFreeProvider(domain: string): boolean {
    const d = domain.toLowerCase();
    return FREE_EXACT.has(d) || FREE_FAMILY.test(d);
}

const ROLE_WORDS = new Set([
    "info", "hello", "hi", "hey", "contact", "contacts", "contactus", "sales", "support", "help", "admin",
    "administrator", "enquiries", "enquiry", "inquiries", "inquiry", "orders", "order", "shop", "store",
    "team", "office", "mail", "email", "care", "customercare", "customerservice", "customerservices",
    "service", "services", "marketing", "media", "press", "pr", "bookings", "booking", "reservations",
    "billing", "accounts", "account", "finance", "hr", "careers", "jobs", "webmaster", "feedback",
    "partnerships", "partners", "business", "wholesale", "studio", "general", "reception", "management",
    "online", "ecommerce", "shopping", "customer", "clients", "hq", "ask", "official", "brand",
]);

export function isRoleAddress(local: string): boolean {
    const l = local.toLowerCase().replace(/\+.*$/, "");
    if (ROLE_WORDS.has(l.replace(/[\d._-]/g, ""))) return true; // info, info1, customer.care
    const first = l.split(/[._-]/)[0] ?? "";
    return ROLE_WORDS.has(first.replace(/\d/g, "")); // sales.lagos, info-ng
}

/**
 * free_provider: the domain is a free mailbox service (whoever owns the mailbox).
 * role: a shared mailbox name (info@, hello@, sales@) or Hunter labels it generic.
 * personal: anything else at a business domain - i.e. not a known role mailbox.
 */
export function classifyEmail(email: string, hunterType?: string | null): EmailType {
    const [local = "", domain = ""] = email.split("@");
    if (isFreeProvider(domain)) return "free_provider";
    if (hunterType === "generic" || isRoleAddress(local)) return "role";
    return "personal";
}

const bareHost = (host: string) => host.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");

/** Same domain as the lead's site, or a parent/child of it (shop.brand.ng vs brand.ng). */
export function isOwnDomain(emailDomain: string, siteHost: string | null): boolean {
    if (!siteHost) return false;
    const e = bareHost(emailDomain);
    const s = bareHost(siteHost);
    return e === s || e.endsWith(`.${s}`) || s.endsWith(`.${e}`);
}

export interface RankInput {
    email: string;
    email_type: EmailType;
    own_domain: boolean;
    email_source: EmailSource;
    /** Provider verification status, when known. */
    status?: string | null;
}

const TYPE_RANK: Record<EmailType, number> = { personal: 0, role: 1, free_provider: 2 };
const SOURCE_RANK: Record<EmailSource, number> = { mailto: 0, page_text: 1, hunter: 2 };
const STATUS_RANK = (s: string | null | undefined) => (s === "valid" ? 0 : s === "catch-all" ? 1 : 2);

/**
 * Best first. An address at some other business's domain (e.g. the web
 * designer's, in the footer) ranks after every address that plausibly
 * belongs to the lead: its own domain or a free mailbox.
 */
export function rankEmails<T extends RankInput>(list: T[]): T[] {
    const affiliation = (c: T) => (c.own_domain || c.email_type === "free_provider" ? 0 : 1);
    return [...list].sort(
        (a, b) =>
            affiliation(a) - affiliation(b) ||
            TYPE_RANK[a.email_type] - TYPE_RANK[b.email_type] ||
            STATUS_RANK(a.status) - STATUS_RANK(b.status) ||
            Number(b.own_domain) - Number(a.own_domain) ||
            SOURCE_RANK[a.email_source] - SOURCE_RANK[b.email_source] ||
            a.email.localeCompare(b.email),
    );
}
