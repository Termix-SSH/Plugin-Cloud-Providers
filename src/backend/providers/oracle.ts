import { signOci } from "./auth/rsa.js";
import { getJson, pool, splitList } from "./http.js";
import type { CloudInstance, Credentials, Provider } from "./types.js";

interface OciInstance {
  id: string;
  displayName?: string;
  lifecycleState?: string;
  region?: string;
  freeformTags?: Record<string, string>;
}

interface Attachment {
  instanceId: string;
  vnicId?: string;
  lifecycleState?: string;
}

interface Vnic {
  publicIp?: string;
  privateIp?: string;
  isPrimary?: boolean;
}

function signed(creds: Credentials, url: string) {
  return signOci({
    method: "get",
    url,
    tenancyId: creds.tenancyId,
    userId: creds.userId,
    fingerprint: creds.fingerprint,
    privateKeyPem: creds.privateKey,
  });
}

async function listPages<T>(
  creds: Credentials,
  fetch: Parameters<Provider["list"]>[1],
  base: string,
): Promise<T[]> {
  const out: T[] = [];
  let page: string | null = null;
  for (let n = 0; n < 200; n += 1) {
    const url = page ? `${base}&page=${encodeURIComponent(page)}` : base;
    const { body, headers } = await getJson<T[]>(
      fetch,
      url,
      signed(creds, url),
    );
    out.push(...body);
    page = headers.get("opc-next-page");
    if (!page) break;
  }
  return out;
}

export const oracle: Provider = {
  id: "oracle",
  defaultUser: "opc",
  fields: [
    { key: "tenancyId", type: "text", required: true },
    { key: "userId", type: "text", required: true },
    { key: "fingerprint", type: "text", required: true },
    { key: "privateKey", type: "textarea", required: true },
    {
      key: "regions",
      type: "text",
      required: true,
      placeholder: "us-ashburn-1",
    },
    {
      key: "compartments",
      type: "text",
      required: false,
      placeholder: "ocid1.compartment...",
    },
  ],
  async list(creds, fetch) {
    const compartments = splitList(creds.compartments, [creds.tenancyId]);
    const out: CloudInstance[] = [];
    for (const region of splitList(creds.regions)) {
      const host = `https://iaas.${region}.oraclecloud.com/20160918`;
      for (const compartment of compartments) {
        const query = `compartmentId=${encodeURIComponent(compartment)}&limit=100`;
        const instances = (
          await listPages<OciInstance>(
            creds,
            fetch,
            `${host}/instances?${query}`,
          )
        ).filter(
          (i) =>
            i.lifecycleState !== "TERMINATED" &&
            i.lifecycleState !== "TERMINATING",
        );
        if (!instances.length) continue;
        const attachments = await listPages<Attachment>(
          creds,
          fetch,
          `${host}/vnicAttachments?${query}`,
        );
        const byInstance = new Map<string, Attachment>();
        for (const a of attachments) {
          if (a.vnicId && a.lifecycleState === "ATTACHED") {
            byInstance.set(a.instanceId, byInstance.get(a.instanceId) ?? a);
          }
        }
        const vnics = await pool(instances, 5, async (instance) => {
          const attachment = byInstance.get(instance.id);
          if (!attachment?.vnicId) return null;
          const url = `${host}/vnics/${encodeURIComponent(attachment.vnicId)}`;
          const { body } = await getJson<Vnic>(fetch, url, signed(creds, url));
          return body;
        });
        instances.forEach((instance, index) => {
          const vnic = vnics[index];
          out.push({
            id: instance.id,
            name: instance.displayName || instance.id,
            publicIp: vnic?.publicIp ?? null,
            privateIp: vnic?.privateIp ?? null,
            region,
            state:
              instance.lifecycleState === "RUNNING"
                ? "running"
                : instance.lifecycleState === "STOPPED"
                  ? "stopped"
                  : "other",
            tags: Object.entries(instance.freeformTags ?? {}).map(([k, v]) =>
              v ? `${k}:${v}` : k,
            ),
          });
        });
      }
    }
    return out;
  },
};
