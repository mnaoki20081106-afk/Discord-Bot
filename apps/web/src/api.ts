const envBase = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "");
export const API_BASE =
  envBase || (location.hostname === "localhost" ? "http://localhost:8787" : "");

const SESSION_KEY = "dsm_session";

export function bootstrapSession(): string | null {
  const match = location.hash.match(/^#session=([^&]+)/);
  if (match?.[1]) {
    const token = decodeURIComponent(match[1]);
    sessionStorage.setItem(SESSION_KEY, token);
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  return sessionStorage.getItem(SESSION_KEY);
}

export function currentSession(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export function login(): void {
  if (!API_BASE) throw new Error("VITE_API_BASE_URL が未設定です");
  location.href = `${API_BASE}/auth/discord`;
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
