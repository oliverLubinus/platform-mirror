/**
 * Typed API client speaking the platform error envelope (integration
 * contract s3): `{ error: { code, message, status, details? } }`.
 *
 * The fetch implementation is INJECTED: the app passes
 * `auth.authedFetch` (Bearer + one silent refresh + one retry on 401);
 * tests pass spies. The 401 that survives the SDK retry surfaces HERE as
 * ApiClientError — apps decide policy, and the template policy is
 * loop-safe: surface, never redirect (see auth/authClient.ts).
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

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function request<T>(fetchImpl: FetchLike, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(path, { headers: { accept: 'application/json' }, ...init });
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

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export function createApi(fetchImpl: FetchLike) {
  return {
    health: () => request<HealthStatus>(fetchImpl, '/api/health'),
    notes: () => request<{ notes: Note[] }>(fetchImpl, '/api/notes'),
  };
}
