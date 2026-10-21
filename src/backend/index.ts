import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { accounts, instances } from "./tables.js";
import { registerRoutes } from "./routes.js";
import { createSync } from "./sync.js";

const TICK_MS = 60_000;
const FIRST_RUN_MS = 10_000;

export async function activate(ctx: PluginContext) {
  const stores = {
    accounts: await ctx.db.define(accounts),
    instances: await ctx.db.define(instances),
  };
  const sync = createSync(ctx, stores);

  registerRoutes(ctx.http.router<Router>(), ctx, stores, sync);

  // Auto accounts run when their interval has passed.
  ctx.schedule.after(FIRST_RUN_MS, () => sync.runDue());
  ctx.schedule.every(TICK_MS, () => sync.runDue(), { jitterMs: 5_000 });
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core.
}
