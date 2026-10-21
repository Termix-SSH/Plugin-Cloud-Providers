import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";
import { signV4 } from "./auth/sigv4.js";
import { send, splitList } from "./http.js";
import { child, childText, items, parseXml } from "./xml.js";
import type { CloudInstance, Credentials, Provider } from "./types.js";

const EC2_VERSION = "2016-11-15";
const LIGHTSAIL_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "ca-central-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
];

interface Keys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function keys(creds: Credentials): Keys {
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken || undefined,
  };
}

async function ec2Call(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
  params: Record<string, string>,
): Promise<ReturnType<typeof parseXml>> {
  const url = `https://ec2.${region}.amazonaws.com/`;
  const body = new URLSearchParams({
    ...params,
    Version: EC2_VERSION,
  }).toString();
  const headers = signV4({
    method: "POST",
    url,
    region,
    service: "ec2",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    ...keys(creds),
  });
  const response = await send(fetch, url, { method: "POST", headers, body });
  return parseXml(await response.text());
}

async function regionsFor(
  fetch: PluginFetch,
  creds: Credentials,
): Promise<string[]> {
  const chosen = splitList(creds.regions);
  if (chosen.length && !chosen.includes("all")) return chosen;
  const root = await ec2Call(fetch, creds, "us-east-1", {
    Action: "DescribeRegions",
  });
  const names = items(root, "regionInfo")
    .map((r) => childText(r, "regionName"))
    .filter((n): n is string => Boolean(n));
  return names.length ? names : ["us-east-1"];
}

async function listEc2(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
): Promise<CloudInstance[]> {
  const out: CloudInstance[] = [];
  let token: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const params: Record<string, string> = { Action: "DescribeInstances" };
    if (token) params.NextToken = token;
    const root = await ec2Call(fetch, creds, region, params);
    for (const reservation of items(root, "reservationSet")) {
      for (const node of items(reservation, "instancesSet")) {
        const state = childText(child(node, "instanceState"), "name");
        if (state === "terminated" || state === "shutting-down") continue;
        const tags = items(node, "tagSet").map((t) => ({
          key: childText(t, "key") ?? "",
          value: childText(t, "value") ?? "",
        }));
        const id = childText(node, "instanceId") ?? "";
        out.push({
          id: `${region}/${id}`,
          name: tags.find((t) => t.key === "Name")?.value || id,
          publicIp: childText(node, "ipAddress") ?? null,
          privateIp: childText(node, "privateIpAddress") ?? null,
          region,
          state:
            state === "running"
              ? "running"
              : state === "stopped"
                ? "stopped"
                : "other",
          tags: tags
            .filter((t) => t.key !== "Name" && !t.key.startsWith("aws:"))
            .map((t) => (t.value ? `${t.key}:${t.value}` : t.key)),
        });
      }
    }
    token = childText(root, "nextToken");
    if (!token) break;
  }
  return out;
}

interface LightsailInstance {
  name: string;
  username?: string;
  publicIpAddress?: string;
  privateIpAddress?: string;
  state?: { name?: string };
  location?: { regionName?: string };
  tags?: Array<{ key: string; value?: string }>;
}

async function listLightsail(
  fetch: PluginFetch,
  creds: Credentials,
  region: string,
): Promise<CloudInstance[]> {
  const out: CloudInstance[] = [];
  const url = `https://lightsail.${region}.amazonaws.com/`;
  let pageToken: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const body = JSON.stringify(pageToken ? { pageToken } : {});
    const headers = signV4({
      method: "POST",
      url,
      region,
      service: "lightsail",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "Lightsail_20161128.GetInstances",
      },
      body,
      ...keys(creds),
    });
    const response = await send(fetch, url, { method: "POST", headers, body });
    const json = (await response.json()) as {
      instances?: LightsailInstance[];
      nextPageToken?: string;
    };
    for (const i of json.instances ?? []) {
      out.push({
        id: `lightsail/${region}/${i.name}`,
        name: i.name,
        publicIp: i.publicIpAddress ?? null,
        privateIp: i.privateIpAddress ?? null,
        region,
        state:
          i.state?.name === "running"
            ? "running"
            : i.state?.name === "stopped"
              ? "stopped"
              : "other",
        tags: (i.tags ?? []).map((t) =>
          t.value ? `${t.key}:${t.value}` : t.key,
        ),
        user: i.username,
      });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export const aws: Provider = {
  id: "aws",
  defaultUser: "ec2-user",
  fields: [
    { key: "accessKeyId", type: "text", required: true },
    { key: "secretAccessKey", type: "secret", required: true },
    { key: "sessionToken", type: "secret", required: false },
    {
      key: "regions",
      type: "text",
      required: false,
      placeholder: "us-east-1, eu-west-1",
    },
    {
      key: "service",
      type: "select",
      required: true,
      options: ["ec2", "lightsail", "both"],
    },
  ],
  async list(creds, fetch) {
    const service = creds.service || "ec2";
    const out: CloudInstance[] = [];
    if (service === "ec2" || service === "both") {
      for (const region of await regionsFor(fetch, creds)) {
        out.push(...(await listEc2(fetch, creds, region)));
      }
    }
    if (service === "lightsail" || service === "both") {
      const chosen = splitList(creds.regions);
      const regions =
        chosen.length && !chosen.includes("all") ? chosen : LIGHTSAIL_REGIONS;
      for (const region of regions) {
        out.push(...(await listLightsail(fetch, creds, region)));
      }
    }
    return out;
  },
};
