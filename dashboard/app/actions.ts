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
