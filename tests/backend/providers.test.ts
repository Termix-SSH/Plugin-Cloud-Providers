import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getProvider } from "../../src/backend/providers/index.js";
import { ProviderError } from "../../src/backend/providers/types.js";
import { fakeFetch, json, status, xml } from "./fake-fetch.js";

const list = (id: string, creds: Record<string, string>, fetch: any) =>
  getProvider(id)!.list(creds, fetch);

describe("digitalocean", () => {
  it("pages droplets and splits public and private addresses", async () => {
    const fetch = fakeFetch((url) => {
      if (url.searchParams.get("page") === "2") {
        return json({
          droplets: [
            {
              id: 2,
              name: "b",
              status: "off",
              region: { slug: "fra1" },
              networks: { v4: [] },
            },
          ],
        });
      }
      return json({
        droplets: [
          {
            id: 1,
            name: "a",
            status: "active",
            tags: ["web"],
            region: { slug: "nyc1" },
            networks: {
              v4: [
                { ip_address: "10.0.0.2", type: "private" },
                { ip_address: "1.2.3.4", type: "public" },
              ],
            },
          },
        ],
        links: {
          pages: { next: "https://api.digitalocean.com/v2/droplets?page=2" },
        },
      });
    });
    const result = await list("digitalocean", { token: "t" }, fetch);
    expect(result).toEqual([
      {
        id: "1",
        name: "a",
        publicIp: "1.2.3.4",
        privateIp: "10.0.0.2",
        region: "nyc1",
        state: "running",
        tags: ["web"],
      },
      expect.objectContaining({ id: "2", publicIp: null, state: "stopped" }),
    ]);
    expect(fetch.calls[0].init.headers.authorization).toBe("Bearer t");
  });

  it("explains a refused token", async () => {
    const fetch = fakeFetch(() => status(401, "nope"));
    await expect(list("digitalocean", { token: "bad" }, fetch)).rejects.toThrow(
      /refused the keys/,
    );
    await expect(
      list("digitalocean", { token: "bad" }, fetch),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("hetzner", () => {
  it("follows pagination and reads labels", async () => {
    const fetch = fakeFetch((url) => {
      const page = url.searchParams.get("page");
      return json({
        servers: [
          {
            id: Number(page),
            name: `s${page}`,
            status: "running",
            public_net: { ipv4: { ip: `5.5.5.${page}` } },
            private_net: [{ ip: "10.1.0.1" }],
            datacenter: { location: { name: "fsn1" } },
            labels: { env: "prod", flag: "" },
          },
        ],
        meta: { pagination: { next_page: page === "1" ? 2 : null } },
      });
    });
    const result = await list("hetzner", { token: "t" }, fetch);
    expect(result.map((r) => r.publicIp)).toEqual(["5.5.5.1", "5.5.5.2"]);
    expect(result[0].tags).toEqual(["env:prod", "flag"]);
    expect(result[0].region).toBe("fsn1");
  });
});

describe("linode", () => {
  it("separates private ipv4 from public", async () => {
    const fetch = fakeFetch(() =>
      json({
        data: [
          {
            id: 9,
            label: "l",
            status: "offline",
            region: "us-east",
            ipv4: ["192.168.1.5", "9.9.9.9"],
            tags: ["t"],
          },
        ],
        page: 1,
        pages: 1,
      }),
    );
    const [one] = await list("linode", { token: "t" }, fetch);
    expect(one).toMatchObject({
      publicIp: "9.9.9.9",
      privateIp: "192.168.1.5",
      state: "stopped",
    });
  });
});

describe("vultr", () => {
  it("treats 0.0.0.0 as no address and follows the cursor", async () => {
    const fetch = fakeFetch((url) => {
      if (url.searchParams.get("cursor") === "abc") {
        return json({
          instances: [{ id: "b", label: "two", main_ip: "7.7.7.7" }],
          meta: { links: { next: "" } },
        });
      }
      return json({
        instances: [
          {
            id: "a",
            label: "one",
            main_ip: "0.0.0.0",
            power_status: "stopped",
          },
        ],
        meta: { links: { next: "abc" } },
      });
    });
    const result = await list("vultr", { token: "t" }, fetch);
    expect(result.map((r) => r.publicIp)).toEqual([null, "7.7.7.7"]);
    expect(result[0].state).toBe("stopped");
  });
});

describe("scaleway", () => {
  it("lists each zone and stops on a short page", async () => {
    const fetch = fakeFetch((url) =>
      json({
        servers: url.pathname.includes("fr-par-1")
          ? [
              {
                id: "x",
                name: "n",
                state: "running",
                public_ips: [{ address: "2.2.2.2", family: "inet" }],
                private_ip: "10.2.0.1",
              },
            ]
          : [],
      }),
    );
    const result = await list(
      "scaleway",
      { secretKey: "k", zones: "fr-par-1, nl-ams-1" },
      fetch,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      publicIp: "2.2.2.2",
      region: "fr-par-1",
    });
    expect(fetch.calls[0].init.headers["x-auth-token"]).toBe("k");
    expect(fetch.calls).toHaveLength(2);
  });
});

describe("upcloud", () => {
  it("reads each server for its addresses", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname === "/1.3/server"
        ? json({
            servers: {
              server: [
                { uuid: "u1", title: "t", state: "started", zone: "de-fra1" },
              ],
            },
          })
        : json({
            server: {
              ip_addresses: {
                ip_address: [
                  { access: "utility", address: "10.0.0.1", family: "IPv4" },
                  { access: "public", address: "3.3.3.3", family: "IPv4" },
                  { access: "public", address: "::1", family: "IPv6" },
                ],
              },
            },
          }),
    );
    const [one] = await list(
      "upcloud",
      { username: "u", password: "p" },
      fetch,
    );
    expect(one).toMatchObject({ publicIp: "3.3.3.3", state: "running" });
    expect(fetch.calls[0].init.headers.authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`,
    );
  });
});

describe("aws", () => {
  const ec2 = (instances: string, next = "") =>
    xml(
      `<DescribeInstancesResponse><reservationSet><item><instancesSet>${instances}</instancesSet></item></reservationSet>${next}</DescribeInstancesResponse>`,
    );
  const instance = (id: string, state: string, extra = "") => `<item>
    <instanceId>${id}</instanceId>
    <instanceState><name>${state}</name></instanceState>
    <privateIpAddress>10.0.0.4</privateIpAddress>${extra}
    <tagSet>
      <item><key>Name</key><value>web-${id}</value></item>
      <item><key>aws:cloudformation:stack</key><value>x</value></item>
      <item><key>termix-user</key><value>ubuntu</value></item>
    </tagSet></item>`;

  it("signs requests, pages, and skips terminated instances", async () => {
    const fetch = fakeFetch((url, init) => {
      if (init.body?.includes("NextToken=tok")) {
        return ec2(instance("i-2", "terminated"));
      }
      return ec2(
        instance("i-1", "running", "<ipAddress>54.1.1.1</ipAddress>"),
        "<nextToken>tok</nextToken>",
      );
    });
    const result = await list(
      "aws",
      {
        accessKeyId: "AK",
        secretAccessKey: "SK",
        regions: "us-east-1",
        service: "ec2",
      },
      fetch,
    );
    expect(result).toEqual([
      {
        id: "us-east-1/i-1",
        name: "web-i-1",
        publicIp: "54.1.1.1",
        privateIp: "10.0.0.4",
        region: "us-east-1",
        state: "running",
        tags: ["termix-user:ubuntu"],
      },
    ]);
    const first = fetch.calls[0];
    expect(first.url).toBe("https://ec2.us-east-1.amazonaws.com/");
    expect(first.init.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/us-east-1\/ec2\/aws4_request/,
    );
    expect(first.init.body).toContain("Action=DescribeInstances");
  });

  it("asks for the enabled regions when none are chosen", async () => {
    const fetch = fakeFetch((url, init) => {
      if (init.body?.includes("DescribeRegions")) {
        return xml(
          "<R><regionInfo><item><regionName>eu-west-1</regionName></item></regionInfo></R>",
        );
      }
      return ec2(instance("i-9", "stopped"));
    });
    const result = await list(
      "aws",
      { accessKeyId: "AK", secretAccessKey: "SK", service: "ec2" },
      fetch,
    );
    expect(fetch.calls[1].url).toBe("https://ec2.eu-west-1.amazonaws.com/");
    expect(result[0]).toMatchObject({ region: "eu-west-1", state: "stopped" });
  });

  it("reads Lightsail instances and their username", async () => {
    const fetch = fakeFetch((url, init) => {
      expect(init.headers["x-amz-target"]).toBe(
        "Lightsail_20161128.GetInstances",
      );
      return json({
        instances: [
          {
            name: "ls",
            username: "admin",
            publicIpAddress: "18.1.1.1",
            privateIpAddress: "172.26.0.5",
            state: { name: "running" },
            tags: [{ key: "env", value: "dev" }],
          },
        ],
      });
    });
    const result = await list(
      "aws",
      {
        accessKeyId: "AK",
        secretAccessKey: "SK",
        regions: "eu-west-2",
        service: "lightsail",
      },
      fetch,
    );
    expect(result[0]).toMatchObject({
      id: "lightsail/eu-west-2/ls",
      publicIp: "18.1.1.1",
      user: "admin",
      tags: ["env:dev"],
    });
  });
});

describe("azure", () => {
  it("joins vms, nics, public ips and power state", async () => {
    const vmId =
      "/subscriptions/S/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1";
    const nicId =
      "/subscriptions/S/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic1";
    const ipId =
      "/subscriptions/S/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/ip1";
    const fetch = fakeFetch((url, init) => {
      if (url.host === "login.microsoftonline.com") {
        expect(init.body).toContain("grant_type=client_credentials");
        return json({ access_token: "tok" });
      }
      if (url.pathname.endsWith("/virtualMachines")) {
        if (url.searchParams.get("statusOnly")) {
          return json({
            value: [
              {
                id: vmId,
                properties: {
                  instanceView: {
                    statuses: [
                      { code: "ProvisioningState/succeeded" },
                      { code: "PowerState/running" },
                    ],
                  },
                },
              },
            ],
          });
        }
        return json({
          value: [
            {
              id: vmId,
              name: "vm1",
              location: "westeurope",
              tags: { env: "prod" },
              properties: {
                osProfile: { adminUsername: "azadmin" },
                networkProfile: { networkInterfaces: [{ id: nicId }] },
              },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/networkInterfaces")) {
        return json({
          value: [
            {
              id: nicId,
              properties: {
                ipConfigurations: [
                  {
                    properties: {
                      privateIPAddress: "10.5.0.4",
                      publicIPAddress: { id: ipId },
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.pathname.endsWith("/publicIPAddresses")) {
        return json({
          value: [{ id: ipId, properties: { ipAddress: "20.1.1.1" } }],
        });
      }
    });
    const result = await list(
      "azure",
      { tenantId: "T", clientId: "C", clientSecret: "S", subscriptionId: "S" },
      fetch,
    );
    expect(result).toEqual([
      {
        id: vmId.toLowerCase(),
        name: "vm1",
        publicIp: "20.1.1.1",
        privateIp: "10.5.0.4",
        region: "westeurope",
        state: "running",
        tags: ["env:prod"],
        user: "azadmin",
      },
    ]);
  });
});

describe("gcp", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = JSON.stringify({
    client_email: "svc@p.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    project_id: "proj",
  });

  it("exchanges a signed JWT and flattens the aggregated list", async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.host === "oauth2.googleapis.com") {
        expect(init.body).toContain("assertion=");
        return json({ access_token: "g" });
      }
      return json({
        items: {
          "zones/us-central1-a": {
            instances: [
              {
                id: "123",
                name: "vm",
                status: "TERMINATED",
                zone: "https://x/zones/us-central1-a",
                labels: { team: "a" },
                networkInterfaces: [
                  {
                    networkIP: "10.128.0.2",
                    accessConfigs: [{ natIP: "35.1.1.1" }],
                  },
                ],
              },
            ],
          },
          "zones/europe-west1-b": { warning: { code: "NO_RESULTS_ON_PAGE" } },
        },
      });
    });
    const result = await list("gcp", { serviceAccount: account }, fetch);
    expect(result).toEqual([
      {
        id: "123",
        name: "vm",
        publicIp: "35.1.1.1",
        privateIp: "10.128.0.2",
        region: "us-central1-a",
        state: "stopped",
        tags: ["team:a"],
      },
    ]);
    expect(fetch.calls[1].url).toContain("/projects/proj/aggregated/instances");
  });

  it("rejects a key that is not JSON", async () => {
    await expect(
      list("gcp", { serviceAccount: "nope" }, fakeFetch()),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("oracle", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const creds = {
    tenancyId: "ocid1.tenancy.x",
    userId: "ocid1.user.x",
    fingerprint: "aa:bb",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    regions: "us-ashburn-1",
  };

  it("joins instances with their primary vnic and skips terminated ones", async () => {
    const fetch = fakeFetch((url, init) => {
      expect(init.headers.authorization).toContain("Signature version=");
      if (url.pathname.endsWith("/instances")) {
        return json([
          {
            id: "ocid1.instance.a",
            displayName: "a",
            lifecycleState: "RUNNING",
          },
          {
            id: "ocid1.instance.b",
            displayName: "b",
            lifecycleState: "TERMINATED",
          },
        ]);
      }
      if (url.pathname.endsWith("/vnicAttachments")) {
        return json([
          {
            instanceId: "ocid1.instance.a",
            vnicId: "ocid1.vnic.a",
            lifecycleState: "ATTACHED",
          },
        ]);
      }
      if (url.pathname.includes("/vnics/")) {
        return json({ publicIp: "129.1.1.1", privateIp: "10.0.0.9" });
      }
    });
    const result = await list("oracle", creds, fetch);
    expect(result).toEqual([
      {
        id: "ocid1.instance.a",
        name: "a",
        publicIp: "129.1.1.1",
        privateIp: "10.0.0.9",
        region: "us-ashburn-1",
        state: "running",
        tags: [],
      },
    ]);
  });
});
