import { getJson, paged } from "./http.js";
import type { CloudInstance, Provider } from "./types.js";

interface Vultr {
  id: string;
  label?: string;
  hostname?: string;
  main_ip?: string;
  internal_ip?: string;
  power_status?: string;
  region?: string;
  tags?: string[];
}

interface Page {
  instances: Vultr[];
  meta?: { links?: { next?: string } };
}

const emptyIp = (ip?: string) => (!ip || ip === "0.0.0.0" ? null : ip);

export const vultr: Provider = {
  id: "vultr",
  defaultUser: "root",
  fields: [{ key: "token", type: "secret", required: true }],
  async list(creds, fetch) {
    const headers = { authorization: `Bearer ${creds.token}` };
    const base = "https://api.vultr.com/v2/instances?per_page=500";
    const items = await paged<Vultr>(base, async (url) => {
      const { body } = await getJson<Page>(fetch, url, headers);
      const cursor = body.meta?.links?.next;
      return {
        items: body.instances ?? [],
        next: cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : null,
      };
    });
    return items.map((v): CloudInstance => ({
      id: v.id,
      name: v.label || v.hostname || v.id,
      publicIp: emptyIp(v.main_ip),
      privateIp: emptyIp(v.internal_ip),
      region: v.region ?? "",
      state:
        v.power_status === "running"
          ? "running"
          : v.power_status === "stopped"
            ? "stopped"
            : "other",
      tags: v.tags ?? [],
    }));
  },
};
