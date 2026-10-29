export function Flash({ msg }: { msg?: string | string[] }) {
    const text = Array.isArray(msg) ? msg[0] : msg;
    if (!text) return null;
    return (
        <div className="notice good" role="status">
            {text}
        </div>
    );
}

export function LoadError({ error }: { error: string | null }) {
    if (!error) return null;
    return (
        <div className="notice bad" role="alert">
            Couldn&apos;t load data: {error}
        </div>
    );
}

export function NoData() {
    return (
        <div className="card">
            <h2>No data yet</h2>
            <p className="muted">
                The agent hasn&apos;t finished its first run. In GitHub, open your lead-scout repo → Actions → &quot;Weekly lead run&quot; → Run
                workflow. When it finishes, refresh this page.
            </p>
        </div>
    );
}
