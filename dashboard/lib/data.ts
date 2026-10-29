import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cache } from "react";
import type { DashboardAction, DistributiveOmit, Snapshot } from "./types";

/**
 * Where the agent's state lives. In production: the "agent-data" branch of
 * your repo, through the GitHub API. For local testing: LOCAL_STATE_DIR.
 * The dashboard only ever reads dashboard.json and adds files to actions/.
 */

const localDir = () => process.env.LOCAL_STATE_DIR || null;
const repo = () => {
    const r = process.env.GITHUB_REPO;
    if (!r || !/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error("GITHUB_REPO must be set, e.g. IdowuJosiah/lead-scout");
    return r;
};
const stateBranch = () => process.env.STATE_BRANCH || "agent-data";
const codeBranch = () => process.env.CODE_BRANCH || "main";

async function gh(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<Response> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN must be set");
    return fetch(`https://api.github.com/repos/${repo()}${path}`, {
        ...init,
        cache: "no-store",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: init.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init.headers ?? {}),
        },
    });
}

export async function loadSnapshot(): Promise<Snapshot | null> {
    const dir = localDir();
    if (dir) {
        try {
            return JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8")) as Snapshot;
        } catch {
            return null;
        }
    }
    const res = await gh(`/contents/dashboard.json?ref=${encodeURIComponent(stateBranch())}`, { raw: true });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub: could not read dashboard.json (HTTP ${res.status})`);
    return (await res.json()) as Snapshot;
}

/** Clicks the agent hasn't applied yet. */
export async function pendingActions(): Promise<DashboardAction[]> {
    const dir = localDir();
    const parse = (text: string) => {
        try {
            return JSON.parse(text) as DashboardAction;
        } catch {
            return null;
        }
    };
    let actions: (DashboardAction | null)[] = [];
    if (dir) {
        const names = await readdir(join(dir, "actions")).catch(() => [] as string[]);
        actions = await Promise.all(names.filter((n) => n.endsWith(".json")).map(async (n) => parse(await readFile(join(dir, "actions", n), "utf8"))));
    } else {
        const res = await gh(`/contents/actions?ref=${encodeURIComponent(stateBranch())}`);
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`GitHub: could not list actions (HTTP ${res.status})`);
        const files = ((await res.json()) as { name: string; path: string; type: string }[]).filter((f) => f.type === "file" && f.name.endsWith(".json"));
        actions = await Promise.all(
            files.map(async (f) => {
                const r = await gh(`/contents/${f.path}?ref=${encodeURIComponent(stateBranch())}`, { raw: true });
                return r.ok ? parse(await r.text()) : null;
            }),
        );
    }
    return actions.filter((a): a is DashboardAction => !!a && typeof a === "object" && typeof a.id === "string");
}

export async function saveAction(action: DistributiveOmit<DashboardAction, "id" | "at">): Promise<DashboardAction> {
    const full = { ...action, id: randomUUID(), at: new Date().toISOString() } as DashboardAction;
    const name = `${Date.now()}-${full.id}.json`;
    const content = JSON.stringify(full, null, 1);
    const dir = localDir();
    if (dir) {
        await mkdir(join(dir, "actions"), { recursive: true });
        await writeFile(join(dir, "actions", name), content);
        return full;
    }
    const res = await gh(`/contents/actions/${name}`, {
        method: "PUT",
        body: JSON.stringify({ message: `dashboard: ${full.type}`, content: Buffer.from(content).toString("base64"), branch: stateBranch() }),
    });
    if (!res.ok) throw new Error(`GitHub: could not save your action (HTTP ${res.status}). Check the token has Contents: write.`);
    return full;
}

/** Start a workflow run now (send.yml or weekly.yml). */
export async function runWorkflow(file: "send.yml" | "weekly.yml"): Promise<void> {
    if (localDir()) {
        console.log(`[local] would start ${file}`);
        return;
    }
    const res = await gh(`/actions/workflows/${file}/dispatches`, { method: "POST", body: JSON.stringify({ ref: codeBranch() }) });
    if (!res.ok) throw new Error(`GitHub: could not start ${file} (HTTP ${res.status}). Check the token has Actions: write.`);
}

/** Snapshot with your not-yet-applied clicks laid on top, so the page reflects them immediately. */
export function withPending(snap: Snapshot, actions: DashboardAction[]): Snapshot {
    const s: Snapshot = structuredClone(snap);
    const items = [...s.batches.flatMap((b) => b.items), ...s.chats];
    for (const a of [...actions].sort((x, y) => x.at.localeCompare(y.at))) {
        if (a.type === "approve_batch") {
            const batch = s.batches.find((b) => b.id === a.batch_id);
            if (!batch || batch.status !== "awaiting_approval") continue;
            batch.pending = true;
            for (const it of batch.items) {
                const choice = a.items.find((x) => x.id === it.id);
                if (it.status !== "draft") continue;
                it.pending = choice?.approve ? "approved" : "not approved";
                if (choice?.subject) it.subject = choice.subject;
                if (choice?.body) it.body = choice.body;
            }
        } else if (a.type === "whatsapp_done" || a.type === "skip") {
            const it = items.find((x) => x.id === a.outreach_id);
            if (it && it.status === "draft") it.pending = a.type === "whatsapp_done" ? "sent" : "skipped";
        } else if (a.type === "do_not_contact") {
            const lead = s.leads.find((l) => l.id === a.lead_id);
            if (lead) lead.pending = "do not contact";
            for (const it of items) if (it.lead_id === a.lead_id && it.status === "draft") it.pending = "do not contact";
        }
    }
    return s;
}

/** Loaded once per request (layout and page share it). */
export const loadDashboard = cache(async function loadDashboard(): Promise<{ snap: Snapshot | null; error: string | null }> {
    try {
        const [snap, actions] = await Promise.all([loadSnapshot(), pendingActions()]);
        return { snap: snap ? withPending(snap, actions) : null, error: null };
    } catch (err) {
        return { snap: null, error: (err as Error).message };
    }
});
