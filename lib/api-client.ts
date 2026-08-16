// The frontend half of lib/api-handler.ts's guarantee: every API route now
// always returns JSON, even on a 500 — but a fetch can still fail before a
// response body ever exists (network down, DNS failure, CORS), and in a
// misconfigured deployment a request could still hit something that isn't
// one of our routes at all (a platform error page, a proxy timeout page).
// This is the one place `.json()` gets called on a fetch response in this
// app, specifically so nothing else has to gamble on "Unexpected end of
// JSON input" or a raw HTML error page crashing a component.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function extractErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
    const details =
      "details" in data && typeof (data as { details: unknown }).details === "string"
        ? `: ${(data as { details: string }).details}`
        : "";
    return `${(data as { error: string }).error}${details}`;
  }
  return `Er ging iets mis (${status})`;
}

// Wraps fetch() so every call site gets the same guarantees: network
// failures become a friendly ApiError instead of an uncaught rejection,
// a non-JSON body (an HTML error page, an empty response) never reaches
// JSON.parse unguarded, and a non-2xx response always throws with the
// server's own { error, details } message rather than silently returning
// a "successful" parse of an error payload. Callers just `await` this and
// catch ApiError.
export async function apiFetch<T = unknown>(input: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    console.error(`[apiFetch] Network error calling ${input}:`, err);
    throw new ApiError("Netwerkfout — controleer je internetverbinding en probeer het opnieuw.", 0);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`[apiFetch] Non-JSON response from ${input} (status ${res.status}):`, text.slice(0, 500));
      throw new ApiError(
        res.ok ? "Onverwacht antwoord van de server." : `Serverfout (${res.status}). Probeer het opnieuw.`,
        res.status,
      );
    }
  }

  if (!res.ok) {
    throw new ApiError(extractErrorMessage(data, res.status), res.status);
  }

  return data as T;
}

// Small helper for the very common "I just want the error message for
// this state.error string" case, so call sites don't all repeat the same
// `err instanceof Error ? err.message : "..."` ternary.
//
// Tauri's own `invoke()` rejects a `Result<T, String>` command's Err case
// with a plain string, not an Error/ApiError — so without this check, every
// failure from src-tauri/src/main.rs's train_local_model (Docker not
// running, download-data failing against every data source, etc.) fell
// through both instanceof checks above and silently got replaced by the
// generic fallback text, hiding the actual, useful reason from the user.
export function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}
