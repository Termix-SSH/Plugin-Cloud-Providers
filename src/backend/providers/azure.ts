import { getJson, paged, send } from "./http.js";
import type { CloudInstance, Provider } from "./types.js";

const ARM = "https://management.azure.com";

interface Vm {
  id: string;
  name: string;
  location?: string;
  tags?: Record<string, string>;
  properties?: {
    osProfile?: { adminUsername?: string };
    networkProfile?: { networkInterfaces?: Array<{ id: string }> };
  };
}

interface Nic {
  id: string;
  properties?: {
    ipConfigurations?: Array<{
      properties?: {
        privateIPAddress?: string;
        publicIPAddress?: { id?: string };
      };
    }>;
  };
}

interface PublicIp {
  id: string;
  properties?: { ipAddress?: string };
}

interface StatusRow {
  id: string;
  properties?: { instanceView?: { statuses?: Array<{ code?: string }> } };
}

const lower = (value: string) => value.toLowerCase();

async function listAll<T>(
  url: string,
  headers: Record<string, string>,
  fetch: Parameters<Provider["list"]>[1],
): Promise<T[]> {
  return paged<T>(url, async (next) => {
    const { body } = await getJson<{ value?: T[]; nextLink?: string }>(
      fetch,
      next,
      headers,
    );
    return { items: body.value ?? [], next: body.nextLink ?? null };
  });
}

export const azure: Provider = {
  id: "azure",
  defaultUser: "azureuser",
  fields: [
    { key: "tenantId", type: "text", required: true },
    { key: "clientId", type: "text", required: true },
    { key: "clientSecret", type: "secret", required: true },
    { key: "subscriptionId", type: "text", required: true },
  ],
  async list(creds, fetch) {
    const tokenResponse = await send(
      fetch,
      `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          scope: `${ARM}/.default`,
        }).toString(),
      },
    );
    const token = ((await tokenResponse.json()) as { access_token?: string })
      .access_token;
    if (!token) throw new Error("Azure did not return a token");
    const headers = { authorization: `Bearer ${token}` };
    const sub = `${ARM}/subscriptions/${encodeURIComponent(creds.subscriptionId)}/providers`;

    const [vms, nics, ips, statuses] = await Promise.all([
      listAll<Vm>(
        `${sub}/Microsoft.Compute/virtualMachines?api-version=2024-07-01`,
        headers,
        fetch,
      ),
      listAll<Nic>(
        `${sub}/Microsoft.Network/networkInterfaces?api-version=2024-05-01`,
        headers,
        fetch,
      ),
      listAll<PublicIp>(
        `${sub}/Microsoft.Network/publicIPAddresses?api-version=2024-05-01`,
        headers,
        fetch,
      ),
      listAll<StatusRow>(
        `${sub}/Microsoft.Compute/virtualMachines?api-version=2024-07-01&statusOnly=true`,
        headers,
        fetch,
      ),
    ]);

    const nicById = new Map(nics.map((n) => [lower(n.id), n]));
    const ipById = new Map(ips.map((p) => [lower(p.id), p]));
    const powerById = new Map(
      statuses.map((s) => [
        lower(s.id),
        (s.properties?.instanceView?.statuses ?? [])
          .map((x) => x.code ?? "")
          .find((code) => code.startsWith("PowerState/")),
      ]),
    );

    return vms.map((vm): CloudInstance => {
      let publicIp: string | null = null;
      let privateIp: string | null = null;
      for (const ref of vm.properties?.networkProfile?.networkInterfaces ??
        []) {
        const nic = nicById.get(lower(ref.id));
        for (const config of nic?.properties?.ipConfigurations ?? []) {
          privateIp ??= config.properties?.privateIPAddress ?? null;
          const ipId = config.properties?.publicIPAddress?.id;
          if (ipId) {
            publicIp ??= ipById.get(lower(ipId))?.properties?.ipAddress ?? null;
          }
        }
      }
      const power = powerById.get(lower(vm.id));
      return {
        id: lower(vm.id),
        name: vm.name,
        publicIp,
        privateIp,
        region: vm.location ?? "",
        state:
          power === "PowerState/running"
            ? "running"
            : power === "PowerState/deallocated" ||
                power === "PowerState/stopped"
              ? "stopped"
              : "other",
        tags: Object.entries(vm.tags ?? {}).map(([k, v]) =>
          v ? `${k}:${v}` : k,
        ),
        user: vm.properties?.osProfile?.adminUsername,
      };
    });
  },
};
