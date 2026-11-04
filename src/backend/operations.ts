import { and, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { AccountRow, CloudSync, SyncStores } from "./sync.js";

function actor(ctx: PluginContext): string {
  const userId = ctx.currentActor();
  if (!userId) throw new Error("This needs a user");
  return userId;
}

/** Cloud accounts as actions, so a sync can run from a rule or the CLI. */
export function registerOperations(
  ctx: PluginContext,
  stores: SyncStores,
  sync: CloudSync,
): void {
  if (typeof ctx.operations?.register !== "function") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = () => ctx.db.client<any>();

  const list = async (): Promise<AccountRow[]> =>
    (await db())
      .select()
      .from(stores.accounts)
      .where(eq(stores.accounts.ownerId, actor(ctx)));

  const find = async (value: unknown): Promise<AccountRow> => {
    const id = Number(value);
    const [row] = Number.isInteger(id)
      ? await (
          await db()
        )
          .select()
          .from(stores.accounts)
          .where(
            and(
              eq(stores.accounts.id, id),
              eq(stores.accounts.ownerId, actor(ctx)),
            ),
          )
      : [];
    if (!row) throw new Error("Cloud account not found");
    return row as AccountRow;
  };

  ctx.operations.register("cloud-providers.list-accounts", {
    run: async () => {
      const rows = await list();
      const failing = rows.filter((row) => row.status === "error");
      const label = failing.length
        ? `${failing.length} failing`
        : `${rows.length} accounts`;
      return {
        summary: label,
        data: {
          rows: rows.map((row) => ({
            id: String(row.id),
            name: row.name,
            provider: row.provider,
            mode: row.syncMode,
            lastSync: row.lastSyncAt ?? "",
            error: row.lastError ?? "",
          })),
          options: rows.map((row) => ({
            value: String(row.id),
            label: row.name,
          })),
          value: failing.length,
          status: failing.length ? "warn" : "ok",
          label,
        },
      };
    },
  });

  ctx.operations.register("cloud-providers.sync-account", {
    describe: async (input) => {
      const row = await find(input.account);
      return `Would sync ${row.name}. Removed instances: ${row.onRemoved}`;
    },
    run: async (input) => {
      const row = await find(input.account);
      const report = await sync.run(row);
      return {
        summary: `${row.name}: ${report.created} created, ${report.updated} updated, ${report.removed} removed, ${report.failed} failed`,
        changed: report.created + report.updated + report.removed > 0,
        data: { ...report },
      };
    },
  });
}
