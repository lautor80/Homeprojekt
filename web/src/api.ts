export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

/** Ereignis: Sitzung und Berechtigungen neu vom Server holen (Seitenleiste, Seiten, Buttons) */
export const SITZUNG_PRUEFEN = 'portal:sitzung-pruefen';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-portal-request': '1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // Rechte geändert (Rolle entzogen) oder Sitzung abgelaufen: Oberfläche gleicht die Sitzung ab (App.tsx)
  if ((res.status === 403 && /^Keine Berechtigung/.test(data?.message ?? '')) || (res.status === 401 && !url.startsWith('/api/auth/'))) {
    window.dispatchEvent(new Event(SITZUNG_PRUEFEN));
  }
  if (!res.ok) throw new ApiError(data?.message ?? `Fehler ${res.status}`, res.status, data?.code);
  return data as T;
}

/** Zugriff auf die Server-API. Module nutzen api.get(`/api/m/<modul>/...`). */
export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string, body?: unknown) => request<T>('DELETE', url, body ?? {}),
};

/** Query-String aus einem Objekt, leere Werte werden weggelassen. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + new URLSearchParams(p.map(([k, v]) => [k, String(v)])).toString() : '';
}
