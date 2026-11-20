import { markInactive } from "@/app/actions";
import { SubmitButton } from "@/components/ui";

const SOCIAL = /instagram\.com|facebook\.com|fb\.com|tiktok\.com|x\.com|twitter\.com|linktr\.ee|beacons\.ai|wa\.me|whatsapp/i;

/** Is the business still active, and a link to check it yourself. */
export function ActivityLine({ activity, note, website, name }: { activity?: string | null; note?: string | null; website: string | null; name: string }) {
    const social = website && SOCIAL.test(website) ? website : null;
    const search = `https://www.google.com/search?q=${encodeURIComponent(`${name} instagram`)}`;
    return (
        <div className="row small" style={{ marginTop: 4 }}>
            {activity === "active" ? (
                <span className="badge good">active</span>
            ) : activity === "inactive" ? (
                <span className="badge bad">inactive</span>
            ) : (
                <span className="badge warn">activity not confirmed</span>
            )}
            {note ? <span className="muted">{note}</span> : null}
            <a href={social ?? search} target="_blank" rel="noreferrer noopener">
                {social ? "check their page" : "find their socials"}
            </a>
        </div>
    );
}

export function InactiveButton({ leadId, from }: { leadId: number; from: string }) {
    return (
        <form action={markInactive}>
            <input type="hidden" name="lead_id" value={leadId} />
            <input type="hidden" name="from" value={from} />
            <SubmitButton className="btn btn-quiet">Business is inactive, skip</SubmitButton>
        </form>
    );
}
