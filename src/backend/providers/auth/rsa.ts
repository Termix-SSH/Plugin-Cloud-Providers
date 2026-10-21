import { createSign } from "node:crypto";

const b64url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

/** A signed RS256 JWT, the shape Google service accounts use. */
export function signJwt(
  claims: Record<string, unknown>,
  privateKeyPem: string,
): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256")
    .update(`${head}.${body}`)
    .sign(privateKeyPem);
  return `${head}.${body}.${b64url(signature)}`;
}

export interface OciSignInput {
  method: string;
  url: string;
  tenancyId: string;
  userId: string;
  fingerprint: string;
  privateKeyPem: string;
  date?: Date;
}

/** Oracle Cloud request signing (GET without a body). */
export function signOci(input: OciSignInput): Record<string, string> {
  const url = new URL(input.url);
  const date = (input.date ?? new Date()).toUTCString();
  const target = `${input.method.toLowerCase()} ${url.pathname}${url.search}`;
  const signingString = [
    `(request-target): ${target}`,
    `host: ${url.host}`,
    `date: ${date}`,
  ].join("\n");
  const signature = createSign("RSA-SHA256")
    .update(signingString)
    .sign(input.privateKeyPem, "base64");
  const keyId = `${input.tenancyId}/${input.userId}/${input.fingerprint}`;
  return {
    date,
    host: url.host,
    authorization: `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
  };
}
