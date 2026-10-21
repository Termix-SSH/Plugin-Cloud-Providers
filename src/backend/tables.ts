import {
  defineTable,
  id,
  integer,
  refHost,
  refUser,
  text,
  timestamp,
  varchar,
} from "@termix-ssh/plugin-sdk/db";

// p_cloud_providers_accounts: one cloud login. The keys are sealed with the
// installation key and never leave the server.
export const accounts = defineTable(
  "accounts",
  {
    id: id(),
    ownerId: refUser(),
    provider: varchar(32).notNull(),
    name: varchar(100).notNull(),
    credentials: text().notNull(),
    // Folder the hosts go in. Empty means a folder named after the account.
    folder: varchar(255),
    defaultUser: varchar(64),
    defaultCredentialId: integer(),
    // public, private or public-first
    addressPreference: varchar(16).notNull(),
    // manual or auto
    syncMode: varchar(8).notNull(),
    intervalMinutes: integer().notNull(),
    // keep, mark or delete
    onRemoved: varchar(8).notNull(),
    status: varchar(16).notNull(),
    lastError: text(),
    lastSyncAt: timestamp(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  {
    uniques: [
      {
        name: "uq_p_cloud_providers_accounts_owner_name",
        columns: ["ownerId", "name"],
      },
    ],
  },
);

// p_cloud_providers_instances: which Termix host came from which cloud
// instance. It goes with the host if the host is deleted.
export const instances = defineTable(
  "instances",
  {
    id: id(),
    accountId: integer().notNull(),
    instanceId: varchar(255).notNull(),
    hostId: refHost(),
    // What was last written, so an unchanged host is not written again.
    signature: varchar(64),
    state: varchar(16),
  },
  {
    uniques: [
      {
        name: "uq_p_cloud_providers_instances_account_instance",
        columns: ["accountId", "instanceId"],
      },
    ],
    indexes: [
      {
        name: "idx_p_cloud_providers_instances_account",
        columns: ["accountId"],
      },
    ],
  },
);

// termix-plugin migrations reads this list.
export const tables = [accounts, instances];
