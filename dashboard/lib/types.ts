/** Shape of dashboard.json, written by the agent (src/agent/snapshot.ts). */

export interface OutreachItem {
    id: number;
    lead_id: number;
    channel: "email" | "whatsapp" | "phone";
    name: string;
    category: string | null;
    score: number | null;
    reviews: number | null;
    website: string | null;
    website_class: string | null;
    phone: string | null;
    recipient: string | null;
    subject: string | null;
    body: string;
    issues: string[];
    evidence: string | null;
    status: "draft" | "approved" | "sending" | "sent" | "skipped" | "failed" | "bounced";
    error: string | null;
    created_at: string;
    sent_at: string | null;
    verification_status: string | null;
    risk_flag: string | null;
    replied: boolean;
    /** Set by the dashboard when a click hasn't been applied by the agent yet. */
    pending?: string;
}

export interface Batch {
    id: number;
    created_at: string;
    status: "awaiting_approval" | "approved" | "done";
    approved_at: string | null;
    items: OutreachItem[];
    pending?: boolean;
}

export interface StepResult {
    step: string;
    ok: boolean;
    detail: string;
}

export interface RunInfo {
    started_at: string;
    finished_at: string;
    steps: StepResult[];
}

export interface Lead {
    id: number;
    name: string;
    category: string | null;
    score: number | null;
    priority: string;
    website: string | null;
    website_class: string | null;
    phone: string | null;
    rating: number | null;
    reviews: number | null;
    evidence: string | null;
    outreach: { channel: string; status: string; sent_at: string | null }[];
    replied: boolean;
    pending?: string;
}

export interface Reply {
    id: number;
    lead_id: number | null;
    outreach_id: number | null;
    kind: "reply" | "opt_out" | "bounce" | "auto_reply";
    from_addr: string | null;
    subject: string | null;
    snippet: string | null;
    received_at: string | null;
    name: string | null;
}

export interface Snapshot {
    version: number;
    generated_at: string;
    region: {
        city: string;
        country: string;
        country_code: string;
        timezone: string;
        send_window: { days: string; start: string; end: string };
        allowed_to_email: boolean | null;
    };
    sender: { name: string; configured: boolean };
    limits: Record<string, number>;
    stats: Record<string, number>;
    usage: { month: string; hunter: { used: number; limit: number }; zerobounce: { used: number; limit: number } };
    runs: { weekly: RunInfo | null; tick: RunInfo | null };
    batches: Batch[];
    chats: OutreachItem[];
    replies: Reply[];
    leads: Lead[];
    failures: { occurred_at: string; stage: string; lead_id: number | null; name: string | null; message: string }[];
}

/** Omit that applies to each member of a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DashboardAction =
    | { id: string; at: string; type: "approve_batch"; batch_id: number; items: { id: number; approve: boolean; subject?: string; body?: string }[] }
    | { id: string; at: string; type: "whatsapp_done"; outreach_id: number }
    | { id: string; at: string; type: "skip"; outreach_id: number }
    | { id: string; at: string; type: "do_not_contact"; lead_id: number };
