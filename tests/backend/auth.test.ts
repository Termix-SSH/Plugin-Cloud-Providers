import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signV4 } from "../../src/backend/providers/auth/sigv4.js";
import { signJwt, signOci } from "../../src/backend/providers/auth/rsa.js";
import { parseXml, items, childText } from "../../src/backend/providers/xml.js";

describe("signV4", () => {
  it("matches the AWS get-vanilla test vector", () => {
    const headers = signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("signs the session token header when there is one", () => {
    const headers = signV4({
      method: "POST",
      url: "https://ec2.us-east-1.amazonaws.com/",
      region: "us-east-1",
      service: "ec2",
      body: "Action=DescribeInstances",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    expect(headers["x-amz-security-token"]).toBe("token");
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-date;x-amz-security-token",
    );
  });
});

describe("rsa signing", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("makes a JWT that verifies with the public key", () => {
    const jwt = signJwt({ iss: "me" }, pem);
    const [head, body, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({
      iss: "me",
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  it("signs an Oracle request over request-target, host and date", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const headers = signOci({
      method: "get",
      url: "https://iaas.us-ashburn-1.oraclecloud.com/20160918/instances?compartmentId=c&limit=100",
      tenancyId: "ten",
      userId: "usr",
      fingerprint: "aa:bb",
      privateKeyPem: pem,
      date,
    });
    expect(headers.authorization).toContain('keyId="ten/usr/aa:bb"');
    const signature = /signature="([^"]+)"/.exec(headers.authorization)![1];
    const text = [
      "(request-target): get /20160918/instances?compartmentId=c&limit=100",
      "host: iaas.us-ashburn-1.oraclecloud.com",
      `date: ${date.toUTCString()}`,
    ].join("\n");
    const ok = createVerify("RSA-SHA256")
      .update(text)
      .verify(publicKey, Buffer.from(signature, "base64"));
    expect(ok).toBe(true);
  });
});

describe("parseXml", () => {
  it("reads nested sets and unescapes text", () => {
    const root = parseXml(
      '<?xml version="1.0"?><R><set><item><k>a&amp;b</k></item><item><k>c</k></item></set><empty/></R>',
    );
    const list = items(root, "set");
    expect(list.map((i) => childText(i, "k"))).toEqual(["a&b", "c"]);
  });
});
