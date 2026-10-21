import { getJson, paged } from "./http.js";
import type { CloudInstance, Provider } from "./types.js";

interface Droplet {
  id: number;
  name: string;
  status: string;
  tags?: string[];
  region?: { slug?: string };
  networks?: { v4?: Array<{ ip_address: string; type: string }> };
}

interface Page {
  droplets: Droplet[];
  links?: { pages?: { next?: string } };
}

export const digitalocean: Provider = {
  id: "digitalocean",
  defaultUser: "root",
  fields: [{ key: "token", type: "secret", required: true }],
  async list(creds, fetch) {
    const headers = { authorization: `Bearer ${creds.token}` };
    const droplets = await paged<Droplet>(
      "https://api.digitalocean.com/v2/droplets?per_page=200",
      async (url) => {
        const { body } = await getJson<Page>(fetch, url, headers);
        return {
          items: body.droplets ?? [],
          next: body.links?.pages?.next ?? null,
        };
      },
    );
    return droplets.map((d): CloudInstance => {
      const v4 = d.networks?.v4 ?? [];
      return {
        id: String(d.id),
        name: d.name,
        publicIp: v4.find((n) => n.type === "public")?.ip_address ?? null,
        privateIp: v4.find((n) => n.type === "private")?.ip_address ?? null,
        region: d.region?.slug ?? "",
        state:
          d.status === "active"
            ? "running"
            : d.status === "off"
              ? "stopped"
              : "other",
        tags: d.tags ?? [],
      };
    });
  },
};
