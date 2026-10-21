import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { ProviderError } from "./types.js";

const MAX_PAGES = 200;

export function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "The cloud refused the keys";
  if (status === 429) return "The cloud is rate limiting requests";
  return `The cloud answered ${status}`;
}

export async function send(
  fetch: PluginFetch,
  url: string,
  init: Parameters<PluginFetch>[1] = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { timeoutMs: 30_000, ...init });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`Could not reach the cloud: ${message}`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // body already gone
    }
    throw new ProviderError(
      `${describeStatus(response.status)}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  return response;
}

export async function getJson<T = unknown>(
  fetch: PluginFetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ body: T; headers: Headers }> {
  const response = await send(fetch, url, {
    headers: { accept: "application/json", ...headers },
  });
  return { body: (await response.json()) as T, headers: response.headers };
}

/** Follows a next link until there is none, with a cap against loops. */
export async function paged<T>(
  first: string,
  step: (url: string) => Promise<{ items: T[]; next: string | null }>,
): Promise<T[]> {
  const all: T[] = [];
  let url: string | null = first;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const result = await step(url);
    all.push(...result.items);
    url = result.next;
  }
  return all;
}

export function splitList(value: string | undefined, fallback: string[] = []) {
  const items = (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

export function isPrivateIpv4(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(
    ip,
  );
}

/** Runs the tasks a few at a time. */
export async function pool<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, () =>
    (async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await run(items[current]);
      }
    })(),
  );
  await Promise.all(workers);
  return results;
}
