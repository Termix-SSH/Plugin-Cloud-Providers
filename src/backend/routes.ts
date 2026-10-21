import type { Request, Response, Router } from "express";
import { and, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { getProvider, providers, ProviderError } from "./providers/index.js";
import type { Credentials } from "./providers/index.js";
import { SyncError, type AccountRow, type CloudSync } from "./sync.js";

const SYNC_MODES = ["manual", "auto"];
const ADDRESSES = ["public", "private", "public-first"];
const REMOVED = ["keep", "mark", "delete"];

function actor(ctx: PluginContext): string {
  return ctx.currentActor() as string;
}

function fail(res: Response, error: unknown) {
  if (error instanceof SyncError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof ProviderError) {
    return res.status(502).json({ error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return res.status(500).json({ error: message });
}

/** Never sends the keys back. */
function publicAccount(row: AccountRow & { createdAt?: string }) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    folder: row.folder,
    defaultUser: row.defaultUser,
    defaultCredentialId: row.defaultCredentialId,
    addressPreference: row.addressPreference,
    syncMode: row.syncMode,
    intervalMinutes: row.intervalMinutes,
    onRemoved: row.onRemoved,
    status: row.status,
    lastError: row.lastError,
    lastSyncAt: row.lastSyncAt,
  };
}

function cleanCredentials(
  providerId: string,
  input: unknown,
): Credentials | string {
  const provider = getProvider(providerId);
  if (!provider) return "Unknown provider";
  const source = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const out: Credentials = {};
  for (const field of provider.fields) {
    const value =
      typeof source[field.key] === "string"
        ? (source[field.key] as string).trim()
        : "";
    if (!value && field.required) return `${field.key} is required`;
    if (value) out[field.key] = value.slice(0, 8192);
  }
  return out;
}

function options(
  body: Record<string, unknown>,
  fallback: Partial<AccountRow> = {},
) {
  const text = (key: string, max: number) =>
    typeof body[key] === "string"
      ? (body[key] as string).trim().slice(0, max)
      : undefined;
  const pick = (key: string, allowed: string[]) =>
    typeof body[key] === "string" && allowed.includes(body[key] as string)
      ? (body[key] as string)
      : undefined;
  const minutes = Number(body.intervalMinutes);
  const credentialId = Number(body.defaultCredentialId);
  return {
    name: text("name", 100) ?? fallback.name,
    folder:
      body.folder === undefined
        ? (fallback.folder ?? null)
        : text("folder", 255) || null,
    defaultUser:
      body.defaultUser === undefined
        ? (fallback.defaultUser ?? null)
        : text("defaultUser", 64) || null,
    defaultCredentialId:
      body.defaultCredentialId === undefined
        ? (fallback.defaultCredentialId ?? null)
        : Number.isInteger(credentialId) && credentialId > 0
          ? credentialId
          : null,
    addressPreference:
      pick("addressPreference", ADDRESSES) ??
      fallback.addressPreference ??
      "public-first",
    syncMode: pick("syncMode", SYNC_MODES) ?? fallback.syncMode ?? "manual",
    intervalMinutes:
      Number.isFinite(minutes) && minutes >= 5 && minutes <= 10080
        ? Math.floor(minutes)
        : (fallback.intervalMinutes ?? 60),
    onRemoved: pick("onRemoved", REMOVED) ?? fallback.onRemoved ?? "keep",
  };
}

export function registerRoutes(
  router: Router,
  ctx: PluginContext,
  stores: { accounts: any; instances: any },
  sync: CloudSync,
): void {
  const view = ctx.rbac.require("view") as never;
  const manage = ctx.rbac.require("manage") as never;
  const db = () => ctx.db.client<any>();

  async function owned(
    req: Request,
    res: Response,
  ): Promise<AccountRow | null> {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Bad id" });
      return null;
    }
    const [row] = await (
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
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Account not found" });
      return null;
    }
    return row;
  }

  /**
   * @openapi
   * /plugin-api/cloud-providers/providers:
   *   get:
   *     summary: List the supported clouds and the keys each one needs
   *     tags:
   *       - Cloud Providers
   *     responses:
   *       200:
   *         description: The providers with their credential fields
   */
  router.get("/providers", view, (_req: Request, res: Response) => {
    res.json({
      providers: providers.map((p) => ({
        id: p.id,
        defaultUser: p.defaultUser,
        fields: p.fields,
      })),
    });
  });

  /**
   * @openapi
   * /plugin-api/cloud-providers/credentials:
   *   get:
   *     summary: List the signed-in user's saved logins, for choosing a default
   *     tags:
   *       - Cloud Providers
   *     responses:
   *       200:
   *         description: Credentials without any secret material
   */
  router.get("/credentials", manage, async (_req: Request, res: Response) => {
    try {
      const list = await ctx.credentials.list();
      res.json({
        credentials: list.map((c) => ({
          id: c.id,
          name: c.name,
          username: c.username,
        })),
      });
    } catch {
      res.json({ credentials: [] });
    }
  });

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts:
   *   get:
   *     summary: List the signed-in user's cloud accounts
   *     tags:
   *       - Cloud Providers
   *     responses:
   *       200:
   *         description: Accounts without their keys
   */
  router.get("/accounts", view, async (_req: Request, res: Response) => {
    const rows = await (
      await db()
    )
      .select()
      .from(stores.accounts)
      .where(eq(stores.accounts.ownerId, actor(ctx)));
    res.json({ accounts: rows.map(publicAccount) });
  });

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts:
   *   post:
   *     summary: Add a cloud account
   *     tags:
   *       - Cloud Providers
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               provider:
   *                 type: string
   *               name:
   *                 type: string
   *               credentials:
   *                 type: object
   *                 additionalProperties:
   *                   type: string
   *     responses:
   *       201:
   *         description: Account added
   *       400:
   *         description: Missing or invalid fields
   *       409:
   *         description: An account with that name exists
   */
  router.post("/accounts", manage, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = typeof body.provider === "string" ? body.provider : "";
      const creds = cleanCredentials(provider, body.credentials);
      if (typeof creds === "string")
        return res.status(400).json({ error: creds });
      const settings = options(body);
      if (!settings.name)
        return res.status(400).json({ error: "name is required" });

      const client = await db();
      const [dupe] = await client
        .select()
        .from(stores.accounts)
        .where(
          and(
            eq(stores.accounts.ownerId, actor(ctx)),
            eq(stores.accounts.name, settings.name),
          ),
        )
        .limit(1);
      if (dupe)
        return res.status(409).json({ error: "That name is already used" });

      await client.insert(stores.accounts).values({
        ownerId: actor(ctx),
        provider,
        credentials: await ctx.secrets.seal(JSON.stringify(creds)),
        status: "pending",
        ...settings,
      });
      await ctx.db.persist();
      const [row] = await client
        .select()
        .from(stores.accounts)
        .where(
          and(
            eq(stores.accounts.ownerId, actor(ctx)),
            eq(stores.accounts.name, settings.name),
          ),
        )
        .limit(1);
      res.status(201).json({ account: publicAccount(row) });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts/{id}:
   *   put:
   *     summary: Change a cloud account; keys are replaced only when sent
   *     tags:
   *       - Cloud Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Account saved
   *       404:
   *         description: Account not found
   */
  router.put("/accounts/:id", manage, async (req: Request, res: Response) => {
    try {
      const row = await owned(req, res);
      if (!row) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const changes: Record<string, unknown> = options(body, row);
      if (!changes.name)
        return res.status(400).json({ error: "name is required" });
      if (body.credentials && typeof body.credentials === "object") {
        const creds = cleanCredentials(row.provider, body.credentials);
        if (typeof creds === "string")
          return res.status(400).json({ error: creds });
        changes.credentials = await ctx.secrets.seal(JSON.stringify(creds));
      }
      await (
        await db()
      )
        .update(stores.accounts)
        .set(changes)
        .where(eq(stores.accounts.id, row.id));
      await ctx.db.persist();
      res.json({ success: true });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts/{id}:
   *   delete:
   *     summary: Delete a cloud account and forget its instances; hosts stay
   *     tags:
   *       - Cloud Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Account deleted
   *       404:
   *         description: Account not found
   */
  router.delete(
    "/accounts/:id",
    manage,
    async (req: Request, res: Response) => {
      try {
        const row = await owned(req, res);
        if (!row) return;
        await sync.removeAccount(row);
        res.json({ success: true });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts/{id}/test:
   *   post:
   *     summary: Check the saved keys by listing the cloud's instances
   *     tags:
   *       - Cloud Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: ok with an instance count, or the reason it failed
   */
  router.post(
    "/accounts/:id/test",
    manage,
    async (req: Request, res: Response) => {
      try {
        const row = await owned(req, res);
        if (!row) return;
        try {
          const found = await sync.discover(row);
          res.json({ ok: true, count: found.length });
        } catch (error) {
          res.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts/{id}/discover:
   *   post:
   *     summary: List the cloud's instances and which ones are already hosts
   *     tags:
   *       - Cloud Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Instances with their address and imported flag
   *       502:
   *         description: The cloud refused or could not be reached
   */
  router.post(
    "/accounts/:id/discover",
    manage,
    async (req: Request, res: Response) => {
      try {
        const row = await owned(req, res);
        if (!row) return;
        res.json({ instances: await sync.discover(row) });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts/{id}/import:
   *   post:
   *     summary: Make hosts from the chosen instances
   *     tags:
   *       - Cloud Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               ids:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Counts of created, updated and failed hosts
   *       400:
   *         description: No instances chosen
   */
  router.post(
    "/accounts/:id/import",
    manage,
    async (req: Request, res: Response) => {
      try {
        const row = await owned(req, res);
        if (!row) return;
        const ids = Array.isArray(req.body?.ids)
          ? (req.body.ids as unknown[]).filter(
              (id): id is string => typeof id === "string",
            )
          : [];
        if (ids.length === 0)
          return res
            .status(400)
            .json({ error: "Choose at least one instance" });
        res.json({ report: await sync.run(row, { only: ids }) });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/cloud-providers/accounts/{id}/sync:
   *   post:
   *     summary: Sync every instance now, applying the account's removal rule
   *     tags:
   *       - Cloud Providers
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Counts of created, updated, removed and failed hosts
   *       409:
   *         description: A sync is already running
   */
  router.post(
    "/accounts/:id/sync",
    manage,
    async (req: Request, res: Response) => {
      try {
        const row = await owned(req, res);
        if (!row) return;
        res.json({ report: await sync.run(row) });
      } catch (error) {
        fail(res, error);
      }
    },
  );
}
