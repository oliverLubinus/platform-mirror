/**
 * Typed API client speaking the platform error envelope (integration
 * contract §3): `{ error: { code, message, status, details? } }`.
 * Auth-token injection lands with the auth-client wiring (T1.5b).
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  status: number;
  details?: unknown;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiClientError';
    this.code = body.code;
    this.status = body.status;
    this.details = body.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' }, ...init });
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
  throw new ApiClientError(
    body?.error ?? { code: 'UNKNOWN', message: res.statusText, status: res.status }
  );
}

export interface HealthStatus {
  ok: boolean;
  uptime: number;
}

export const api = {
  health: () => request<HealthStatus>('/api/health'),
  notes: () => request<{ notes: unknown[] }>('/api/notes'),
};