import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { fakeFetch, json, status } from "./fake-fetch.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;

interface Droplet {
  id: number;
  name: string;
  status: string;
  ip?: string;
}

let droplets: Droplet[] = [];
let denied = false;

const cloud = fakeFetch((url) => {
  if (url.host !== "api.digitalocean.com") return undefined;
  if (denied) return status(401, "denied");
  return json({
    droplets: droplets.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      region: { slug: "nyc1" },
      networks: {
        v4: d.ip ? [{ ip_address: d.ip, type: "public" }] : [],
      },
    })),
  });
});

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;

// The fake hosts API has no ssh_data rows, so the foreign key needs them.
function mirrorHostRows() {
  const hosts = mock.ctx.hosts as any;
  const create = hosts.create.bind(hosts);
  hosts.create = async (input: unknown) => {
    const record = await create(input);
    db.sqlite.prepare("INSERT INTO ssh_data (id) VALUES (?)").run(record.id);
    return record;
  };
  const remove = hosts.delete.bind(hosts);
  hosts.delete = async (id: number) => {
    const ok = await remove(id);
    db.sqlite.prepare("DELETE FROM ssh_data WHERE id = ?").run(id);
    return ok;
  };
}

async function setup(permissions: string[]) {
  db = await createTestDb(pluginDir);
  for (const user of ["user-1", "user-2"]) {
    db.sqlite
      .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
      .run(user, user);
  }
  let router: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions,
    fetch: cloud as never,
  });
  mirrorHostRows();
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") ?? "user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  user = "user-1",
) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "x-test-user": user,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const ALL = ["cloud-providers.view", "cloud-providers.manage"];

const account = {
  provider: "digitalocean",
  name: "do",
  credentials: { token: "SECRET-TOKEN" },
  onRemoved: "keep",
};

async function addAccount(extra: Record<string, unknown> = {}) {
  const created = await request("POST", "/accounts", { ...account, ...extra });
  expect(created.status).toBe(201);
  return created.body.account.id as number;
}

function hostsOf() {
  return mock.ctx.asUser("user-1", () => mock.ctx.hosts.listOwned());
}

beforeEach(async () => {
  droplets = [
    { id: 1, name: "web", status: "active", ip: "1.1.1.1" },
    { id: 2, name: "db", status: "active", ip: "2.2.2.2" },
  ];
  denied = false;
  cloud.mockClear();
  cloud.calls.length = 0;
  await setup(ALL);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("accounts", () => {
  it("lists providers with their fields", async () => {
    const { body } = await request("GET", "/providers");
    const ids = body.providers.map((p: { id: string }) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["aws", "azure", "gcp", "digitalocean", "oracle"]),
    );
  });

  it("never returns or stores the keys in plain text", async () => {
    const id = await addAccount();
    const list = await request("GET", "/accounts");
    expect(JSON.stringify(list.body)).not.toContain("SECRET-TOKEN");
    expect(list.body.accounts[0]).toMatchObject({
      id,
      name: "do",
      syncMode: "manual",
    });
    const raw = db.sqlite
      .prepare("SELECT credentials FROM p_cloud_providers_accounts")
      .get() as { credentials: string };
    expect(raw.credentials).not.toContain("SECRET-TOKEN");
  });

  it("validates the provider, the keys and the name", async () => {
    expect(
      (await request("POST", "/accounts", { ...account, provider: "nope" }))
        .status,
    ).toBe(400);
    expect(
      (await request("POST", "/accounts", { ...account, credentials: {} }))
        .status,
    ).toBe(400);
    expect(
      (await request("POST", "/accounts", { ...account, name: " " })).status,
    ).toBe(400);
  });

  it("refuses a duplicate name and hides accounts from other users", async () => {
    await addAccount();
    expect((await request("POST", "/accounts", account)).status).toBe(409);
    const other = await request("GET", "/accounts", undefined, "user-2");
    expect(other.body.accounts).toEqual([]);
    const id = (await request("GET", "/accounts")).body.accounts[0].id;
    expect(
      (await request("POST", `/accounts/${id}/sync`, undefined, "user-2"))
        .status,
    ).toBe(404);
  });

  it("keeps the saved keys when an edit sends none", async () => {
    const id = await addAccount();
    const edit = await request("PUT", `/accounts/${id}`, {
      name: "renamed",
      syncMode: "auto",
      intervalMinutes: 15,
    });
    expect(edit.status).toBe(200);
    const list = await request("GET", "/accounts");
    expect(list.body.accounts[0]).toMatchObject({
      name: "renamed",
      syncMode: "auto",
      intervalMinutes: 15,
    });
    const test = await request("POST", `/accounts/${id}/test`);
    expect(test.body).toEqual({ ok: true, count: 2 });
    expect(cloud.calls.at(-1)!.init.headers.authorization).toBe(
      "Bearer SECRET-TOKEN",
    );
  });

  it("deletes an account but leaves its hosts", async () => {
    const id = await addAccount();
    await request("POST", `/accounts/${id}/sync`);
    const before = (await hostsOf()).length;
    expect((await request("DELETE", `/accounts/${id}`)).status).toBe(200);
    expect((await request("GET", "/accounts")).body.accounts).toEqual([]);
    expect((await hostsOf()).length).toBe(before);
  });

  it("needs the manage permission to change anything", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await setup(["cloud-providers.view"]);
    expect((await request("GET", "/accounts")).status).toBe(200);
    expect((await request("POST", "/accounts", account)).status).toBe(403);
  });
});

describe("discover and import", () => {
  it("reports the addresses and what is already imported", async () => {
    const id = await addAccount();
    const found = await request("POST", `/accounts/${id}/discover`);
    expect(found.body.instances).toHaveLength(2);
    expect(found.body.instances[0]).toMatchObject({
      address: "1.1.1.1",
      imported: false,
    });

    const imported = await request("POST", `/accounts/${id}/import`, {
      ids: ["1"],
    });
    expect(imported.body.report).toMatchObject({ created: 1, failed: 0 });
    const again = await request("POST", `/accounts/${id}/discover`);
    expect(
      again.body.instances.map((i: { imported: boolean }) => i.imported),
    ).toEqual([true, false]);
  });

  it("makes ssh hosts with the account defaults", async () => {
    const id = await addAccount({ defaultUser: "deploy", folder: "Cloud" });
    await request("POST", `/accounts/${id}/import`, { ids: ["1"] });
    const [host] = await hostsOf();
    expect(host).toMatchObject({
      name: "web",
      ip: "1.1.1.1",
      port: 22,
      username: "deploy",
      folder: "Cloud",
      connectionType: "ssh",
    });
    expect(host.tags).toContain("cloud:digitalocean");
    expect(host.tags).toContain("cloud:nyc1");
  });

  it("uses the termix-user tag over the default user", async () => {
    droplets = [{ id: 1, name: "web", status: "active", ip: "1.1.1.1" }];
    const body = (droplets as any)[0];
    cloud.mockImplementationOnce(async () =>
      json({
        droplets: [
          {
            id: body.id,
            name: "web",
            status: "active",
            tags: ["termix-user:ubuntu"],
            networks: { v4: [{ ip_address: "1.1.1.1", type: "public" }] },
          },
        ],
      }),
    );
    const id = await addAccount();
    await request("POST", `/accounts/${id}/import`, { ids: ["1"] });
    expect((await hostsOf())[0].username).toBe("ubuntu");
  });

  it("asks for at least one instance", async () => {
    const id = await addAccount();
    expect(
      (await request("POST", `/accounts/${id}/import`, { ids: [] })).status,
    ).toBe(400);
  });

  it("answers 502 when the cloud refuses the keys", async () => {
    const id = await addAccount();
    denied = true;
    const res = await request("POST", `/accounts/${id}/discover`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/refused the keys/);
    const test = await request("POST", `/accounts/${id}/test`);
    expect(test.body.ok).toBe(false);
  });
});

describe("sync", () => {
  it("creates, skips unchanged and follows an ip change", async () => {
    const id = await addAccount();
    const first = await request("POST", `/accounts/${id}/sync`);
    expect(first.body.report).toMatchObject({
      created: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(await hostsOf()).toHaveLength(2);

    const second = await request("POST", `/accounts/${id}/sync`);
    expect(second.body.report).toMatchObject({ created: 0, unchanged: 2 });

    droplets[0].ip = "9.9.9.9";
    droplets[1].name = "db-renamed";
    const third = await request("POST", `/accounts/${id}/sync`);
    expect(third.body.report).toMatchObject({ updated: 2, created: 0 });
    const byName = Object.fromEntries(
      (await hostsOf()).map((h) => [h.name, h]),
    );
    expect(byName.web.ip).toBe("9.9.9.9");
    expect(byName["db-renamed"]).toBeTruthy();
  });

  it("keeps the user's own tags and login across updates", async () => {
    const id = await addAccount();
    await request("POST", `/accounts/${id}/sync`);
    const web = (await hostsOf()).find((h) => h.name === "web")!;
    await mock.ctx.asUser("user-1", () =>
      mock.ctx.hosts.update(web.id, {
        tags: `${web.tags},mine`,
        username: "me",
      }),
    );
    droplets[0].ip = "8.8.8.8";
    await request("POST", `/accounts/${id}/sync`);
    const after = (await hostsOf()).find((h) => h.id === web.id)!;
    expect(after.ip).toBe("8.8.8.8");
    expect(after.username).toBe("me");
    expect(after.tags).toContain("mine");
  });

  it("recreates a host that was deleted by hand", async () => {
    const id = await addAccount();
    await request("POST", `/accounts/${id}/sync`);
    const web = (await hostsOf()).find((h) => h.name === "web")!;
    await mock.ctx.asUser("user-1", () => mock.ctx.hosts.delete(web.id));
    const again = await request("POST", `/accounts/${id}/sync`);
    expect(again.body.report.created).toBe(1);
    expect(await hostsOf()).toHaveLength(2);
  });

  it("skips an instance with no address", async () => {
    droplets = [{ id: 5, name: "off", status: "off" }];
    const id = await addAccount();
    const res = await request("POST", `/accounts/${id}/sync`);
    expect(res.body.report).toMatchObject({ created: 0, skipped: 1 });
  });

  it("keeps hosts for gone instances by default", async () => {
    const id = await addAccount();
    await request("POST", `/accounts/${id}/sync`);
    droplets = droplets.slice(1);
    const res = await request("POST", `/accounts/${id}/sync`);
    expect(res.body.report.removed).toBe(0);
    expect(await hostsOf()).toHaveLength(2);
  });

  it("tags gone instances as missing and clears it when they return", async () => {
    const id = await addAccount({ onRemoved: "mark" });
    await request("POST", `/accounts/${id}/sync`);
    const all = droplets;
    droplets = all.slice(1);
    const gone = await request("POST", `/accounts/${id}/sync`);
    expect(gone.body.report.removed).toBe(1);
    expect((await hostsOf()).find((h) => h.name === "web")!.tags).toContain(
      "cloud:missing",
    );
    const quiet = await request("POST", `/accounts/${id}/sync`);
    expect(quiet.body.report.removed).toBe(0);

    droplets = all;
    await request("POST", `/accounts/${id}/sync`);
    expect((await hostsOf()).find((h) => h.name === "web")!.tags).not.toContain(
      "cloud:missing",
    );
  });

  it("deletes hosts for gone instances when asked", async () => {
    const id = await addAccount({ onRemoved: "delete" });
    await request("POST", `/accounts/${id}/sync`);
    droplets = droplets.slice(1);
    const res = await request("POST", `/accounts/${id}/sync`);
    expect(res.body.report.removed).toBe(1);
    expect((await hostsOf()).map((h) => h.name)).toEqual(["db"]);
  });

  it("does not remove anything on a partial import", async () => {
    const id = await addAccount({ onRemoved: "delete" });
    await request("POST", `/accounts/${id}/sync`);
    await request("POST", `/accounts/${id}/import`, { ids: ["2"] });
    expect(await hostsOf()).toHaveLength(2);
  });

  it("records a failure on the account", async () => {
    const id = await addAccount();
    denied = true;
    const res = await request("POST", `/accounts/${id}/sync`);
    expect(res.status).toBe(502);
    const list = await request("GET", "/accounts");
    expect(list.body.accounts[0].status).toBe("error");
    expect(list.body.accounts[0].lastError).toMatch(/refused the keys/);
  });
});

describe("auto sync", () => {
  it("runs only auto accounts that are due and tells the owner on failure", async () => {
    const auto = await addAccount({
      name: "auto",
      syncMode: "auto",
      intervalMinutes: 5,
    });
    await addAccount({ name: "manual", syncMode: "manual" });
    await mock.runScheduled();
    expect(await hostsOf()).toHaveLength(2);
    const afterFirst = cloud.calls.length;

    // Not due again yet.
    await mock.runScheduled();
    expect(cloud.calls.length).toBe(afterFirst);

    db.sqlite
      .prepare(
        "UPDATE p_cloud_providers_accounts SET last_sync_at = ? WHERE id = ?",
      )
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), auto);
    denied = true;
    await mock.runScheduled();
    expect(mock.notifications).toHaveLength(1);
    expect(mock.notifications[0].notification).toMatchObject({
      audience: { userId: "user-1" },
      dedupeKey: `cloud-providers:${auto}`,
    });
  });
});
