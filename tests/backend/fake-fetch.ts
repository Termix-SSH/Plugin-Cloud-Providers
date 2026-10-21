import { vi } from "vitest";

export type Handler = (
  url: URL,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Response | undefined;

export function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function xml(body: string) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/xml" },
  });
}

export function status(code: number, body = "") {
  return new Response(body, { status: code });
}

/** A fetch that answers from handlers, first match wins, and records calls. */
export function fakeFetch(...handlers: Handler[]) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init });
    for (const handler of handlers) {
      const response = handler(new URL(url), init);
      if (response) return response;
    }
    return new Response(`no fake for ${url}`, { status: 404 });
  });
  return Object.assign(fn, { calls });
}
