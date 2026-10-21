import { signJwt } from "./auth/rsa.js";
import { getJson, paged, send } from "./http.js";
import { ProviderError } from "./types.js";
import type { CloudInstance, Provider } from "./types.js";

interface ServiceAccount {
  client_email?: string;
  private_key?: string;
  project_id?: string;
  token_uri?: string;
}

interface GcpInstance {
  id: string;
  name: string;
  status?: string;
  zone?: string;
  labels?: Record<string, string>;
  networkInterfaces?: Array<{
    networkIP?: string;
    accessConfigs?: Array<{ natIP?: string }>;
  }>;
}

interface Page {
  items?: Record<string, { instances?: GcpInstance[] }>;
  nextPageToken?: string;
}

function parseAccount(raw: string): ServiceAccount {
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new ProviderError("The service account key is not valid JSON");
  }
}

export const gcp: Provider = {
  id: "gcp",
  defaultUser: "ubuntu",
  fields: [
    { key: "serviceAccount", type: "textarea", required: true },
    { key: "projectId", type: "text", required: false },
  ],
  async list(creds, fetch) {
    const account = parseAccount(creds.serviceAccount);
    if (!account.client_email || !account.private_key) {
      throw new ProviderError("The service account key is incomplete");
    }
    const project = creds.projectId || account.project_id;
    if (!project) throw new ProviderError("No project id");

    const tokenUri = account.token_uri || "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt(
      {
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/compute.readonly",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      },
      account.private_key,
    );
    const response = await send(fetch, tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const token = ((await response.json()) as { access_token?: string })
      .access_token;
    if (!token) throw new ProviderError("Google did not return a token");
    const headers = { authorization: `Bearer ${token}` };

    const base = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/aggregated/instances?maxResults=500`;
    const found = await paged<GcpInstance>(base, async (url) => {
      const { body } = await getJson<Page>(fetch, url, headers);
      const list = Object.values(body.items ?? {}).flatMap(
        (scope) => scope.instances ?? [],
      );
      return {
        items: list,
        next: body.nextPageToken
          ? `${base}&pageToken=${encodeURIComponent(body.nextPageToken)}`
          : null,
      };
    });

    return found.map((i): CloudInstance => {
      const nic = i.networkInterfaces?.[0];
      return {
        id: i.id,
        name: i.name,
        publicIp: nic?.accessConfigs?.find((a) => a.natIP)?.natIP ?? null,
        privateIp: nic?.networkIP ?? null,
        region: (i.zone ?? "").split("/").pop() ?? "",
        state:
          i.status === "RUNNING"
            ? "running"
            : i.status === "TERMINATED" || i.status === "STOPPED"
              ? "stopped"
              : "other",
        tags: Object.entries(i.labels ?? {}).map(([k, v]) =>
          v ? `${k}:${v}` : k,
        ),
      };
    });
  },
};
