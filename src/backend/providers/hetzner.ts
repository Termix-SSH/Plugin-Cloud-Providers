import { getJson, paged } from "./http.js";
import type { CloudInstance, Provider } from "./types.js";

interface Server {
  id: number;
  name: string;
  status: string;
  public_net?: { ipv4?: { ip?: string } | null };
  private_net?: Array<{ ip?: string }>;
  datacenter?: { location?: { name?: string } };
  labels?: Record<string, string>;
}

interface Page {
  servers: Server[];
  meta?: { pagination?: { next_page?: number | null } };
}

export const hetzner: Provider = {
  id: "hetzner",
  defaultUser: "root",
  fields: [{ key: "token", type: "secret", required: true }],
  async list(creds, fetch) {
    const headers = { authorization: `Bearer ${creds.token}` };
    const base = "https://api.hetzner.cloud/v1/servers?per_page=50&page=";
    const servers = await paged<Server>(`${base}1`, async (url) => {
      const { body } = await getJson<Page>(fetch, url, headers);
      const next = body.meta?.pagination?.next_page;
      return {
        items: body.servers ?? [],
        next: next ? `${base}${next}` : null,
      };
    });
    return servers.map((s): CloudInstance => ({
      id: String(s.id),
      name: s.name,
      publicIp: s.public_net?.ipv4?.ip ?? null,
      privateIp: s.private_net?.[0]?.ip ?? null,
      region: s.datacenter?.location?.name ?? "",
      state:
        s.status === "running"
          ? "running"
          : s.status === "off"
            ? "stopped"
            : "other",
      tags: Object.entries(s.labels ?? {}).map(([k, v]) =>
        v ? `${k}:${v}` : k,
      ),
    }));
  },
};
