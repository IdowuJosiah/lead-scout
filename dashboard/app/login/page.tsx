"use client";

import { useActionState } from "react";
import { login } from "@/app/actions";
import { SubmitButton } from "@/components/ui";

export default function LoginPage() {
    const [error, action] = useActionState(login, null);
    return (
        <main className="login">
            <h1>Lead Scout</h1>
            <p className="muted">Sign in to review leads and approve emails.</p>
            <form action={action} className="card">
                <label className="field">
                    <span>Password</span>
                    <input type="password" name="password" autoComplete="current-password" required autoFocus />
                </label>
                {error ? <p className="notice bad">{error}</p> : null}
                <SubmitButton pendingText="Signing in…">Sign in</SubmitButton>
            </form>
        </main>
    );
}
