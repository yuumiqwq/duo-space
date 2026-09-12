// Match the public Host preserved by the HTTPS reverse proxy, not Next's
// internal container URL. Forwarded-Host cannot override this check.
export function isSamePushOrigin(request: { headers: Headers }): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.host === request.headers.get("host")
      && (parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)));
  } catch { return false; }
}
