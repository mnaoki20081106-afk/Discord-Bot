const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
export const API_BASE =
  envBase || (location.hostname === "localhost" ? "http://localhost:8787" : "");

const SESSION_KEY = "dsm_session";

export function bootstrapSession(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}

export function currentSession(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
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
  sessionStorage.setItem(SESSION_KEY, payload.token);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE) throw new Error("API URL が未設定です");
  const token = currentSession();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new Error(payload.message || `HTTP ${response.status}`);
  }
  return payload as T;
}
