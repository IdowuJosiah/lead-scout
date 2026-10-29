import { logout } from "@/app/actions";
import { Nav } from "@/components/nav";
import { loadDashboard } from "@/lib/data";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
    await requireSession();
    const { snap } = await loadDashboard();
    const counts = {
        approve: snap?.batches.find((b) => b.status === "awaiting_approval" && !b.pending)?.items.filter((i) => i.status === "draft").length ?? 0,
        chats: snap?.chats.filter((c) => c.status === "draft" && !c.pending).length ?? 0,
        replies: snap?.stats.replies ?? 0,
    };
    return (
        <>
            <header className="top">
                <div className="wrap">
                    <span className="brand">Lead Scout</span>
                    <Nav counts={counts} />
                    <form action={logout}>
                        <button className="btn btn-quiet" type="submit">
                            Sign out
                        </button>
                    </form>
                </div>
            </header>
            <main className="wrap">{children}</main>
        </>
    );
}
