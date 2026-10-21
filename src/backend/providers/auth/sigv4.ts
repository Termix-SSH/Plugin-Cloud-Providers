import { createHash, createHmac } from "node:crypto";

export interface SigV4Input {
  method: string;
  url: string;
  region: string;
  service: string;
  headers?: Record<string, string>;
  body?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value, "utf8").digest();

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(search: URLSearchParams): string {
  return [...search.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) =>
      a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Signs a request with AWS Signature Version 4 and returns the headers to send. */
export function signV4(input: SigV4Input): Record<string, string> {
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": amzDate,
  };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;

  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(lower).sort();

  const canonical = [
    input.method.toUpperCase(),
    url.pathname || "/",
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    names.join(";"),
    sha256(input.body ?? ""),
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join(
    "\n",
  );
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region),
      input.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(toSign, "utf8")
    .digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}
