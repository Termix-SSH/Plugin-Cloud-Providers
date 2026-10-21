import { getJson, splitList } from "./http.js";
import type { CloudInstance, Provider } from "./types.js";

interface Server {
  id: string;
  name: string;
  state: string;
  tags?: string[];
  public_ip?: { address?: string } | null;
  public_ips?: Array<{ address?: string; family?: string }>;
  private_ip?: string | null;
}

const PAGE = 100;
const ZONES = [
  "fr-par-1",
  "fr-par-2",
  "fr-par-3",
  "nl-ams-1",
  "nl-ams-2",
  "nl-ams-3",
  "pl-waw-1",
  "pl-waw-2",
  "pl-waw-3",
];

export const scaleway: Provider = {
  id: "scaleway",
  defaultUser: "root",
  fields: [
    { key: "secretKey", type: "secret", required: true },
    { key: "zones", type: "text", required: false, placeholder: "fr-par-1" },
  ],
  async list(creds, fetch) {
    const headers = { "x-auth-token": creds.secretKey };
    const out: CloudInstance[] = [];
    for (const zone of splitList(creds.zones, ZONES)) {
      for (let page = 1; page < 100; page += 1) {
        const url = `https://api.scaleway.com/instance/v1/zones/${encodeURIComponent(zone)}/servers?per_page=${PAGE}&page=${page}`;
        const { body } = await getJson<{ servers: Server[] }>(
          fetch,
          url,
          headers,
        );
        const servers = body.servers ?? [];
        for (const s of servers) {
          const v4 = s.public_ips?.find((ip) => ip.family !== "inet6");
          out.push({
            id: s.id,
            name: s.name,
            publicIp: s.public_ip?.address ?? v4?.address ?? null,
            privateIp: s.private_ip ?? null,
            region: zone,
            state:
              s.state === "running"
                ? "running"
                : s.state === "stopped"
                  ? "stopped"
                  : "other",
            tags: s.tags ?? [],
          });
        }
        if (servers.length < PAGE) break;
      }
    }
    return out;
  },
};
