import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  usePermission,
  usePluginApi,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { ListRow, ListRowAction, PanelList } from "@termix-ssh/plugin-sdk/ui";
import { createApi, errorMessage, type Account } from "./api";

const POLL_MS = 60_000;

/** Dashboard card: each cloud account with when it last synced. */
export function CloudCard({ isVisible, shell }: DashboardCardProps) {
  const { t } = useTranslation();
  const canView = usePermission("view");
  const canManage = usePermission("manage");
  const pluginApi = usePluginApi();
  const api = useMemo(() => createApi(pluginApi), [pluginApi]);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.accounts());
    } catch {
      setAccounts([]);
    }
  }, [api]);

  useEffect(() => {
    if (!isVisible || !canView) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, canView, load]);

  async function syncNow(account: Account) {
    setBusy(account.id);
    try {
      const report = await api.sync(account.id);
      toast.success(
        t("syncDone", {
          created: report.created,
          updated: report.updated,
          removed: report.removed,
        }),
      );
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      await load();
    }
  }

  if (!canView) return null;
  if (!accounts) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("card.loading")}</p>
    );
  }

  return (
    <PanelList
      empty={
        <button
          type="button"
          onClick={() => shell.openSingletonTab("cloud-providers")}
          className="p-3 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {t("empty")}
        </button>
      }
    >
      {accounts.map((account, index) => (
        <ListRow
          key={account.id}
          stripe={index}
          tone={account.status === "error" ? "destructive" : "none"}
          icon={<Cloud className="size-3.5" />}
          title={account.name}
          meta={[
            t(`providers.${account.provider}`),
            account.status === "error"
              ? (account.lastError ?? t("status.error"))
              : account.lastSyncAt
                ? t("lastSync", {
                    date: new Date(account.lastSyncAt).toLocaleString(),
                  })
                : t("status.never"),
          ].join(" | ")}
          onClick={() => shell.openSingletonTab("cloud-providers")}
          actions={
            canManage ? (
              <ListRowAction
                label={t("syncNow")}
                tone="brand"
                disabled={busy === account.id}
                onClick={() => void syncNow(account)}
              >
                <RefreshCw />
              </ListRowAction>
            ) : undefined
          }
        />
      ))}
    </PanelList>
  );
}
