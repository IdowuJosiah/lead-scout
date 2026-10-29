export function when(iso: string | null | undefined, timeZone = "Africa/Lagos"): string {
    if (!iso) return "never";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

export const CLASS_LABEL: Record<string, string> = {
    none: "No website",
    owned_site: "Own website",
    social: "Social page only",
    messaging: "Chat link only",
    link_in_bio: "Link-in-bio only",
    hosted_storefront: "Platform shop",
    dead_listing: "Dead website",
};

export const STATUS_LABEL: Record<string, string> = {
    draft: "Draft",
    approved: "Approved",
    sending: "Sending",
    sent: "Sent",
    skipped: "Skipped",
    failed: "Failed",
    bounced: "Bounced",
};

export function statusTone(s: string): "good" | "warn" | "bad" | "" {
    if (s === "sent" || s === "approved") return "good";
    if (s === "failed" || s === "bounced") return "bad";
    if (s === "draft" || s === "sending") return "warn";
    return "";
}

/** One-tap WhatsApp link with the message already typed. */
export function whatsappHref(recipient: string | null, body: string): string | null {
    if (!recipient) return null;
    const m = /^https:\/\/wa\.me\/(\d{8,15})$/.exec(recipient);
    return m ? `https://wa.me/${m[1]}?text=${encodeURIComponent(body)}` : recipient;
}

export function phoneDigits(recipient: string | null): string | null {
    if (!recipient) return null;
    const d = recipient.replace(/[^\d+]/g, "");
    return d.length >= 7 ? d : null;
}
