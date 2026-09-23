const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
export const API_BASE =
  envBase || (location.hostname === "localhost" ? "http://localhost:8787" : "");

const SESSION_KEY = "dsm_session";

function readStoredSession(): string | null {
  let persistent: string | null = null;
  try {
    persistent = localStorage.getItem(SESSION_KEY);
  } catch {
    // Some privacy modes can deny persistent storage.
  }
  if (persistent) return persistent;

  // Migrate sessions created by older dashboard versions that used
  // sessionStorage, so an already logged-in browser becomes persistent
  // without asking for the password again.
  let legacy: string | null = null;
  try {
    legacy = sessionStorage.getItem(SESSION_KEY);
  } catch {
    // Ignore unavailable session storage.
  }
  if (!legacy) return null;

  try {
    localStorage.setItem(SESSION_KEY, legacy);
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Fall back to the current tab session when persistent storage is blocked.
  }
  return legacy;
}

function storeSession(token: string): void {
  try {
    localStorage.setItem(SESSION_KEY, token);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing to migrate.
    }
    return;
  } catch {
    // Fall back for strict/private browser modes.
  }

  sessionStorage.setItem(SESSION_KEY, token);
}

export function bootstrapSession(): string | null {
  return readStoredSession();
}

export function currentSession(): string | null {
  return readStoredSession();
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore unavailable persistent storage.
  }
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore unavailable session storage.
  }
}

export async function login(password: string): Promise<void> {
  if (!API_BASE) throw new Error("VITE_API_BASE_URL が未設定です");
  const response = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({password})
  });
  const payload = await response.json().catch(() => ({})) as {token?: string; message?: string};
  if (!response.ok || !payload.token) {
    throw new Error(payload.message || `HTTP ${response.status}`);
  }
  storeSession(payload.token);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE) throw new Error("API URL が未設定です");
  const token = currentSession();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const controller = new AbortController();
  const timeoutMs = 20_000;
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) clearSession();
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    return payload as T;
  } catch (reason) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new Error("APIの応答が20秒以内に返りませんでした。保存状態を確認して再試行してください");
    }
    throw reason;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
