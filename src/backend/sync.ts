import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  PluginContext,
  PluginHostCreateInput,
  PluginHostRecord,
} from "@termix-ssh/plugin-sdk/backend";
import {
  getProvider,
  type CloudInstance,
  type Credentials,
} from "./providers/index.js";

export type AddressPreference = "public" | "private" | "public-first";
export type RemovedPolicy = "keep" | "mark" | "delete";

export interface AccountRow {
  id: number;
  ownerId: string;
  provider: string;
  name: string;
  credentials: string;
  folder: string | null;
  defaultUser: string | null;
  defaultCredentialId: number | null;
  addressPreference: AddressPreference;
  syncMode: "manual" | "auto";
  intervalMinutes: number;
  onRemoved: RemovedPolicy;
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
}

export interface SyncStores {
  accounts: any;
  instances: any;
}

export interface SyncReport {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  removed: number;
  failed: number;
}

export interface DiscoveredInstance extends CloudInstance {
  address: string | null;
  imported: boolean;
}

export const MANAGED_PREFIX = "cloud:";
const FOLDER_ICON = "cloud";
const USER_TAG = /^termix-user[:=](.+)$/i;

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

const sha = (value: unknown) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 40);

export function pickAddress(
  instance: CloudInstance,
  preference: AddressPreference,
): string | null {
  if (preference === "private") return instance.privateIp;
  if (preference === "public") return instance.publicIp;
  return instance.publicIp ?? instance.privateIp;
}

export function managedTags(
  instance: CloudInstance,
  provider: string,
): string[] {
  const tags = [`${MANAGED_PREFIX}${provider}`];
  if (instance.region) tags.push(`${MANAGED_PREFIX}${instance.region}`);
  if (instance.state === "stopped") tags.push(`${MANAGED_PREFIX}stopped`);
  return tags;
}

export function splitTags(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Keeps the user's own tags and swaps the ones the plugin manages. */
export function mergeTags(
  existing: string | null,
  managed: string[],
): string[] {
  const own = splitTags(existing).filter((t) => !t.startsWith(MANAGED_PREFIX));
  return [...own, ...managed];
}

export function userFor(
  instance: CloudInstance,
  account: Pick<AccountRow, "defaultUser">,
  providerDefault: string,
): string {
  for (const tag of instance.tags) {
    const match = USER_TAG.exec(tag);
    if (match) return match[1].trim();
  }
  return instance.user || account.defaultUser || providerDefault;
}

export function createSync(
  ctx: PluginContext,
  stores: SyncStores,
  log: { warn: (message: string) => void } = ctx.log,
) {
  const db = () => ctx.db.client<any>();
  const running = new Set<number>();

  async function credentialsOf(row: AccountRow): Promise<Credentials> {
    const raw = await ctx.secrets.unseal(row.credentials);
    if (!raw) throw new SyncError("The saved keys can't be read");
    return JSON.parse(raw) as Credentials;
  }

  async function fetchInstances(row: AccountRow): Promise<CloudInstance[]> {
    const provider = getProvider(row.provider);
    if (!provider) throw new SyncError("Unknown provider", 400);
    return provider.list(await credentialsOf(row), ctx.fetch);
  }

  async function mappedRows(accountId: number): Promise<any[]> {
    return (await db())
      .select()
      .from(stores.instances)
      .where(eq(stores.instances.accountId, accountId));
  }

  async function discover(row: AccountRow): Promise<DiscoveredInstance[]> {
    const instances = await fetchInstances(row);
    const mapped = new Set((await mappedRows(row.id)).map((r) => r.instanceId));
    return instances.map((instance) => ({
      ...instance,
      address: pickAddress(instance, row.addressPreference),
      imported: mapped.has(instance.id),
    }));
  }

  function inputFor(
    row: AccountRow,
    instance: CloudInstance,
    address: string,
  ): PluginHostCreateInput {
    const provider = getProvider(row.provider)!;
    const credentialId = row.defaultCredentialId;
    return {
      name: instance.name,
      ip: address,
      port: 22,
      username: userFor(instance, row, provider.defaultUser),
      authType: credentialId ? "credential" : "none",
      credentialId: credentialId ?? undefined,
      connectionType: "ssh",
      enableSsh: true,
      statusCheckEnabled: true,
      folder: row.folder || row.name,
      tags: mergeTags(null, managedTags(instance, row.provider)),
      pluginSettings: {
        [ctx.pluginId]: { accountId: row.id, instanceId: instance.id },
      },
    };
  }

  /**
   * Writes hosts for the cloud's instances. With `only`, just those ids are
   * imported and nothing is removed. Without it this is a full sync.
   */
  async function run(
    row: AccountRow,
    options: { only?: string[] } = {},
  ): Promise<SyncReport> {
    if (running.has(row.id))
      throw new SyncError("A sync is already running", 409);
    running.add(row.id);
    const report: SyncReport = {
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      removed: 0,
      failed: 0,
    };
    try {
      const all = await fetchInstances(row);
      const wanted = options.only ? new Set(options.only) : null;
      const instances = wanted ? all.filter((i) => wanted.has(i.id)) : all;
      const client = await db();
      const mapped = await mappedRows(row.id);
      const byInstance = new Map<string, any>(
        mapped.map((m) => [m.instanceId, m]),
      );
      const seen = new Set(all.map((i) => i.id));

      await ctx.asUser(row.ownerId, async () => {
        await ctx.hosts.folders
          .ensure(row.folder || row.name, { icon: FOLDER_ICON })
          .catch(() => {});
        const owned = new Map<number, PluginHostRecord>(
          (await ctx.hosts.listOwned()).map((h) => [h.id, h]),
        );

        for (const instance of instances) {
          const existing = byInstance.get(instance.id);
          const current = existing ? owned.get(existing.hostId) : undefined;
          const address = pickAddress(instance, row.addressPreference);
          try {
            if (existing && !current) {
              // Deleted by hand, so it comes back as a new host.
              await client
                .delete(stores.instances)
                .where(eq(stores.instances.id, existing.id));
              byInstance.delete(instance.id);
            }
            if (existing && current) {
              const tags = managedTags(instance, row.provider);
              const ip = address ?? current.ip;
              const signature = sha([instance.name, ip, tags]);
              if (
                existing.signature === signature &&
                existing.state !== "gone"
              ) {
                report.unchanged += 1;
                continue;
              }
              await ctx.hosts.update(existing.hostId, {
                name: instance.name,
                ip,
                tags: mergeTags(current.tags, tags),
              });
              await client
                .update(stores.instances)
                .set({ signature, state: instance.state })
                .where(eq(stores.instances.id, existing.id));
              report.updated += 1;
              continue;
            }
            if (!address) {
              report.skipped += 1;
              continue;
            }
            const input = inputFor(row, instance, address);
            const created = await ctx.hosts.create(input);
            await client.insert(stores.instances).values({
              accountId: row.id,
              instanceId: instance.id,
              hostId: created.id,
              signature: sha([
                instance.name,
                address,
                managedTags(instance, row.provider),
              ]),
              state: instance.state,
            });
            report.created += 1;
          } catch (error) {
            report.failed += 1;
            log.warn(
              `Could not write ${instance.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (wanted) return;
        for (const entry of mapped) {
          if (seen.has(entry.instanceId)) continue;
          const current = owned.get(entry.hostId);
          try {
            if (!current) {
              await client
                .delete(stores.instances)
                .where(eq(stores.instances.id, entry.id));
            } else if (row.onRemoved === "delete") {
              await ctx.hosts.delete(entry.hostId);
              await client
                .delete(stores.instances)
                .where(eq(stores.instances.id, entry.id));
              report.removed += 1;
            } else if (row.onRemoved === "mark" && entry.state !== "gone") {
              const kept = splitTags(current.tags).filter(
                (t) => t !== `${MANAGED_PREFIX}missing`,
              );
              await ctx.hosts.update(entry.hostId, {
                tags: [...kept, `${MANAGED_PREFIX}missing`],
              });
              await client
                .update(stores.instances)
                .set({ state: "gone" })
                .where(eq(stores.instances.id, entry.id));
              report.removed += 1;
            }
          } catch (error) {
            report.failed += 1;
            log.warn(
              `Could not remove a host: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      });

      await client
        .update(stores.accounts)
        .set({
          status: report.failed > 0 ? "error" : "ok",
          lastError:
            report.failed > 0
              ? `${report.failed} hosts could not be written`
              : null,
          lastSyncAt: new Date().toISOString(),
        })
        .where(eq(stores.accounts.id, row.id));
      await ctx.db.persist();
      return report;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await (
          await db()
        )
          .update(stores.accounts)
          .set({ status: "error", lastError: message.slice(0, 500) })
          .where(eq(stores.accounts.id, row.id));
        await ctx.db.persist();
      } catch {
        // the original error is the one to report
      }
      throw error;
    } finally {
      running.delete(row.id);
    }
  }

  /** Auto accounts that are due, run one at a time. */
  async function runDue(now = Date.now()): Promise<void> {
    const rows: AccountRow[] = await (
      await db()
    )
      .select()
      .from(stores.accounts)
      .where(eq(stores.accounts.syncMode, "auto"));
    for (const row of rows) {
      const last = row.lastSyncAt ? new Date(row.lastSyncAt).getTime() : 0;
      if (now - last < row.intervalMinutes * 60_000) continue;
      try {
        await run(row);
      } catch (error) {
        if (error instanceof SyncError && error.status === 409) continue;
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Sync of ${row.name} failed: ${message}`);
        await ctx.notify
          .send({
            title: `Cloud sync failed: ${row.name}`,
            body: message,
            severity: "warning",
            audience: { userId: row.ownerId },
            dedupeKey: `cloud-providers:${row.id}`,
            link: { tab: "cloud-providers" },
          })
          .catch(() => {});
      }
    }
  }

  async function removeAccount(row: AccountRow): Promise<void> {
    const client = await db();
    await client
      .delete(stores.instances)
      .where(eq(stores.instances.accountId, row.id));
    await client.delete(stores.accounts).where(eq(stores.accounts.id, row.id));
    await ctx.db.persist();
  }

  return { discover, run, runDue, removeAccount, mappedRows };
}

export type CloudSync = ReturnType<typeof createSync>;
