import { getJson, pool } from "./http.js";
import type { CloudInstance, Provider } from "./types.js";

interface Row {
  uuid: string;
  title?: string;
  hostname?: string;
  state?: string;
  zone?: string;
  tags?: { tag?: string[] };
}

interface Detail {
  server?: {
    ip_addresses?: {
      ip_address?: Array<{ access: string; address: string; family: string }>;
    };
  };
}

export const upcloud: Provider = {
  id: "upcloud",
  defaultUser: "root",
  fields: [
    { key: "username", type: "text", required: true },
    { key: "password", type: "secret", required: true },
  ],
  async list(creds, fetch) {
    const auth = Buffer.from(`${creds.username}:${creds.password}`).toString(
      "base64",
    );
    const headers = { authorization: `Basic ${auth}` };
    const { body } = await getJson<{ servers?: { server?: Row[] } }>(
      fetch,
      "https://api.upcloud.com/1.3/server",
      headers,
    );
    const rows = body.servers?.server ?? [];
    // The list has no addresses, so each server is read once.
    return pool(rows, 5, async (row): Promise<CloudInstance> => {
      const detail = await getJson<Detail>(
        fetch,
        `https://api.upcloud.com/1.3/server/${encodeURIComponent(row.uuid)}`,
        headers,
      );
      const ips = (detail.body.server?.ip_addresses?.ip_address ?? []).filter(
        (ip) => ip.family === "IPv4",
      );
      return {
        id: row.uuid,
        name: row.title || row.hostname || row.uuid,
        publicIp: ips.find((ip) => ip.access === "public")?.address ?? null,
        privateIp: ips.find((ip) => ip.access === "private")?.address ?? null,
        region: row.zone ?? "",
        state:
          row.state === "started"
            ? "running"
            : row.state === "stopped"
              ? "stopped"
              : "other",
        tags: row.tags?.tag ?? [],
      };
    });
  },
};
