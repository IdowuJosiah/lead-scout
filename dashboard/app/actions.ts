"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { loadSnapshot, runWorkflow, saveAction } from "@/lib/data";
import { endSession, passwordMatches, requireSession, startSession } from "@/lib/session";

const int = (v: FormDataEntryValue | null): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const back = (path: string, msg: string): never => redirect(`${path}?msg=${encodeURIComponent(msg)}`);

export async function login(_prev: string | null, form: FormData): Promise<string | null> {
    // Slow down guessing a little.
    await new Promise((r) => setTimeout(r, 400));
    if (!passwordMatches(String(form.get("password") ?? ""))) return "Wrong password.";
    await startSession();
    redirect("/");
}

export async function logout() {
    await endSession();
    redirect("/login");
}

export async function approveBatch(form: FormData) {
    await requireSession();
    const batchId = int(form.get("batch_id"));
    if (!batchId) back("/approve", "That batch is not valid.");
    const snap = await loadSnapshot();
    const batch = snap?.batches.find((b) => b.id === batchId);
    if (!batch || batch.status !== "awaiting_approval") back("/approve", "That batch is no longer waiting for approval.");

    const items = batch!.items
        .filter((it) => it.status === "draft")
        .map((it) => {
            const subject = String(form.get(`subject_${it.id}`) ?? it.subject ?? "").slice(0, 200);
            const body = String(form.get(`body_${it.id}`) ?? it.body).slice(0, 5000);
            return {
                id: it.id,
                approve: form.get(`approve_${it.id}`) === "on",
                // Only send edits, so the agent keeps the original text otherwise.
                ...(subject !== it.subject ? { subject } : {}),
                ...(body.replace(/\r\n/g, "\n") !== it.body ? { body } : {}),
            };
        });
    const approved = items.filter((i) => i.approve).length;
    await saveAction({ type: "approve_batch", batch_id: batchId!, items });
    let started = true;
    try {
        await runWorkflow("send.yml");
    } catch {
        started = false;
    }
    revalidatePath("/", "layout");
    back(
        "/approve",
        `Approved ${approved} of ${items.length} email(s). ${started ? "Sending starts now" : "Sending starts at the next hourly run"} (only inside the send window, a few minutes apart).`,
    );
}

export async function markChat(form: FormData) {
    await requireSession();
    const id = int(form.get("outreach_id"));
    const kind = form.get("kind");
    if (!id || (kind !== "whatsapp_done" && kind !== "skip")) back("/whatsapp", "That message is not valid.");
    await saveAction(kind === "skip" ? { type: "skip", outreach_id: id! } : { type: "whatsapp_done", outreach_id: id! });
    revalidatePath("/", "layout");
    back("/whatsapp", kind === "skip" ? "Skipped." : "Marked as sent.");
}

export async function doNotContact(form: FormData) {
    await requireSession();
    const id = int(form.get("lead_id"));
    const from = String(form.get("from") ?? "/leads");
    const path = ["/leads", "/whatsapp", "/approve", "/replies"].includes(from) ? from : "/leads";
    if (!id) back(path, "That lead is not valid.");
    await saveAction({ type: "do_not_contact", lead_id: id! });
    revalidatePath("/", "layout");
    back(path, "Added to do-not-contact. They won't be messaged again.");
}

export async function runNow(form: FormData) {
    await requireSession();
    const which = form.get("workflow") === "weekly" ? "weekly.yml" : "send.yml";
    try {
        await runWorkflow(which);
    } catch (err) {
        back("/", (err as Error).message);
    }
    back("/", which === "weekly.yml" ? "Weekly run started. It can take 30-90 minutes; refresh later." : "Send run started. Refresh in a few minutes.");
}

/** Letters (any script), digits, spaces and simple punctuation: enough for "Austin, Texas" or "Lekki Phase 1". */
const PLACE_RE = /^[\p{L}\p{M}\p{N} ,.'()&\/-]{2,80}$/u;

export async function scout(form: FormData) {
    await requireSession();
    const place = String(form.get("place") ?? "").replace(/\s+/g, " ").trim();
    const keywordsRaw = String(form.get("keywords") ?? "").replace(/\s+/g, " ").trim();
    if (!PLACE_RE.test(place)) back("/regions", "Type a place name, e.g. Dubai or Austin, Texas (2-80 letters, no symbols).");
    const keywords = keywordsRaw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
    if (keywords.length > 15 || keywords.some((k) => !PLACE_RE.test(k))) back("/regions", "Keywords: up to 15 short words or phrases, separated by commas.");
    try {
        await runWorkflow("scout.yml", { place, keywords: keywords.join(", ") });
    } catch (err) {
        back("/regions", (err as Error).message);
    }
    revalidatePath("/", "layout");
    back("/regions", `Scouting ${place}. Finding, auditing and drafting takes 30-90 minutes; new leads will show up here and in Leads.`);
}

export async function setRegionEmail(form: FormData) {
    await requireSession();
    const id = int(form.get("region_id"));
    const allowed = form.get("allowed") === "true";
    if (!id) back("/regions", "That region is not valid.");
    if (allowed && form.get("confirm") !== "on") back("/regions", "Tick the box to confirm you may email businesses there before turning email on.");
    await saveAction({ type: "set_region_email", region_id: id!, allowed });
    revalidatePath("/", "layout");
    back("/regions", allowed ? "Email turned on. The next run will look up emails and draft them for your approval." : "Email turned off. Only WhatsApp messages will be drafted there.");
}

export async function removeRegion(form: FormData) {
    await requireSession();
    const id = int(form.get("region_id"));
    if (!id) back("/regions", "That region is not valid.");
    await saveAction({ type: "set_region_active", region_id: id!, active: false });
    revalidatePath("/", "layout");
    back("/regions", "Removed from weekly scouting. Its leads and messages stay; scout it again any time to bring it back.");
}

export async function markInactive(form: FormData) {
    await requireSession();
    const id = int(form.get("lead_id"));
    const from = String(form.get("from") ?? "/whatsapp");
    const path = ["/leads", "/whatsapp", "/approve"].includes(from) ? from : "/whatsapp";
    if (!id) back(path, "That lead is not valid.");
    await saveAction({ type: "mark_inactive", lead_id: id! });
    revalidatePath("/", "layout");
    back(path, "Marked inactive. Its messages are removed and it won't be contacted.");
}
