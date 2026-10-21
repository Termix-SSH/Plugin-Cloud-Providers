import { getJson, isPrivateIpv4, paged } from "./http.js";
import type { CloudInstance, Provider } from "./types.js";

interface Linode {
  id: number;
  label: string;
  status: string;
  region?: string;
  tags?: string[];
  ipv4?: string[];
}

interface Page {
  data: Linode[];
  page: number;
  pages: number;
}

export const linode: Provider = {
  id: "linode",
  defaultUser: "root",
  fields: [{ key: "token", type: "secret", required: true }],
  async list(creds, fetch) {
    const headers = { authorization: `Bearer ${creds.token}` };
    const base =
      "https://api.linode.com/v4/linode/instances?page_size=500&page=";
    const items = await paged<Linode>(`${base}1`, async (url) => {
      const { body } = await getJson<Page>(fetch, url, headers);
      return {
        items: body.data ?? [],
        next: body.page < body.pages ? `${base}${body.page + 1}` : null,
      };
    });
    return items.map((l): CloudInstance => {
      const addresses = l.ipv4 ?? [];
      return {
        id: String(l.id),
        name: l.label,
        publicIp: addresses.find((ip) => !isPrivateIpv4(ip)) ?? null,
        privateIp: addresses.find((ip) => isPrivateIpv4(ip)) ?? null,
        region: l.region ?? "",
        state:
          l.status === "running"
            ? "running"
            : l.status === "offline"
              ? "stopped"
              : "other",
        tags: l.tags ?? [],
      };
    });
  },
};
