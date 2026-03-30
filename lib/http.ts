export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RequestOptions = {
  method?: HttpMethod
  headers?: Record<string, string>
  /**
   * Request body. If you pass an object and `json: true`, it will be JSON.stringified
   * and `content-type: application/json` will be set (unless overridden).
   */
  body?: unknown
  /** Treat `body` as JSON and parse response as JSON by default. */
  json?: boolean
  /** Abort after timeout (ms). Default 15000. */
  timeoutMs?: number
  /** Extra query params appended to URL. */
  query?: Record<string, string | number | boolean | null | undefined>
  /** Credentials mode for fetch (UI only). */
  credentials?: RequestCredentials
  /** Custom fetch (for tests / polyfills). */
  fetcher?: typeof fetch
}

export class HttpError extends Error {
  readonly name = 'HttpError'
  readonly status: number
  readonly url: string
  readonly responseText?: string

  constructor(opts: { status: number; url: string; message?: string; responseText?: string }) {
    super(opts.message ?? `HTTP ${opts.status}`)
    this.status = opts.status
    this.url = opts.url
    this.responseText = opts.responseText
  }
}

export class NetworkError extends Error {
  readonly name = 'NetworkError'
  readonly url: string

  constructor(url: string, message?: string) {
    super(message ?? 'Network error')
    this.url = url
  }
}

export class TimeoutError extends Error {
  readonly name = 'TimeoutError'
  readonly url: string
  readonly timeoutMs: number

  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`)
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

function buildUrl(url: string, query?: RequestOptions['query']): string {
  if (!query) return url
  const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    u.searchParams.set(k, String(v))
  }
  return u.toString()
}

function mergeHeaders(a?: Record<string, string>, b?: Record<string, string>): Record<string, string> {
  return { ...(a ?? {}), ...(b ?? {}) }
}

export async function request<T = unknown>(url: string, opts?: RequestOptions): Promise<T> {
  const fetcher = opts?.fetcher ?? fetch
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const method: HttpMethod = opts?.method ?? (opts?.body ? 'POST' : 'GET')
  const wantJson = opts?.json ?? false

  const finalUrl = buildUrl(url, opts?.query)

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

  let body: BodyInit | undefined
  let headers = mergeHeaders(undefined, opts?.headers)

  if (opts?.body !== undefined) {
    if (wantJson && typeof opts.body === 'object' && opts.body !== null && !(opts.body instanceof FormData)) {
      body = JSON.stringify(opts.body)
      headers = mergeHeaders({ 'content-type': 'application/json' }, headers)
    } else if (typeof opts.body === 'string' || opts.body instanceof Blob || opts.body instanceof ArrayBuffer) {
      body = opts.body as any
    } else if (opts.body instanceof FormData) {
      body = opts.body
    } else {
      // best-effort
      body = String(opts.body)
    }
  }

  try {
    const res = await fetcher(finalUrl, {
      method,
      headers,
      body,
      credentials: opts?.credentials,
      signal: controller?.signal,
    })

    const contentType = res.headers.get('content-type') ?? ''
    const isJson = wantJson || contentType.includes('application/json')

    if (!res.ok) {
      let txt: string | undefined
      try {
        txt = await res.text()
      } catch {
        // ignore
      }
      throw new HttpError({
        status: res.status,
        url: finalUrl,
        message: `HTTP ${res.status} ${res.statusText}`.trim(),
        responseText: txt,
      })
    }

    if (isJson) {
      return (await res.json()) as T
    }
    return (await res.text()) as any as T
  } catch (e: any) {
    if (controller?.signal.aborted) throw new TimeoutError(finalUrl, timeoutMs)
    if (e instanceof HttpError) throw e
    throw new NetworkError(finalUrl, String(e?.message ?? e))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function getJSON<T = unknown>(url: string, opts?: Omit<RequestOptions, 'method' | 'body' | 'json'>) {
  return request<T>(url, { ...(opts ?? {}), method: 'GET', json: true })
}

export function postJSON<T = unknown>(
  url: string,
  body?: unknown,
  opts?: Omit<RequestOptions, 'method' | 'body' | 'json'>
) {
  return request<T>(url, { ...(opts ?? {}), method: 'POST', body, json: true })
}

