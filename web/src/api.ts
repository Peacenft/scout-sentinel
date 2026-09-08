export type ApiErrorBody = { error?: { code?: string; message?: string; requestId?: string } };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId?: string
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers }
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ApiError(
      body.error?.message ?? "The request could not be completed.",
      response.status,
      body.error?.code ?? "unknown_error",
      body.error?.requestId
    );
  }
  return body;
}
