"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pendingText, className, disabled }: { children: React.ReactNode; pendingText?: string; className?: string; disabled?: boolean }) {
    const { pending } = useFormStatus();
    return (
        <button type="submit" className={className ?? "btn"} disabled={pending || disabled} aria-busy={pending}>
            {pending ? (pendingText ?? "Saving…") : children}
        </button>
    );
}

export function CopyButton({ text, label = "Copy message" }: { text: string; label?: string }) {
    const [done, setDone] = useState(false);
    return (
        <button
            type="button"
            className="btn btn-quiet"
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    setDone(true);
                    setTimeout(() => setDone(false), 1500);
                } catch {
                    /* clipboard blocked: user can still select the text */
                }
            }}
        >
            {done ? "Copied" : label}
        </button>
    );
}
