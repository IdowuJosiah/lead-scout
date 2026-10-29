"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Nav({ counts }: { counts: { approve: number; chats: number; replies: number } }) {
    const path = usePathname();
    const tabs = [
        { href: "/", label: "Overview" },
        { href: "/approve", label: "Approve emails", count: counts.approve },
        { href: "/whatsapp", label: "WhatsApp", count: counts.chats },
        { href: "/leads", label: "Leads" },
        { href: "/replies", label: "Replies", count: counts.replies },
    ];
    return (
        <nav className="tabs" aria-label="Sections">
            {tabs.map((t) => (
                <Link key={t.href} href={t.href} aria-current={path === t.href ? "page" : undefined}>
                    {t.label}
                    {t.count ? <span className="count">{t.count}</span> : null}
                </Link>
            ))}
        </nav>
    );
}
