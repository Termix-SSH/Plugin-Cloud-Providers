import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cloud,
  DownloadCloud,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  usePluginApi,
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListRow,
  ListRowAction,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import {
  createApi,
  errorMessage,
  type Account,
  type AccountInput,
  type ProviderInfo,
  type SavedCredential,
} from "./api";
import { AccountForm } from "./AccountForm";
import { DiscoverView } from "./DiscoverView";

const TAB_ID = "cloud-providers";

type View =
  | { kind: "list" }
  | { kind: "form"; account: Account | null }
  | { kind: "discover"; account: Account };

function CloudTab({ isVisible }: TabProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const pluginApi = usePluginApi();
  const api = useMemo(() => createApi(pluginApi), [pluginApi]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [view, setView] = useState<View>({ kind: "list" });
  const [busy, setBusy] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [list, known, saved] = await Promise.all([
        api.accounts(),
        api.providers(),
        api.credentials(),
      ]);
      setAccounts(list);
      setProviders(known);
      setCredentials(saved);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    if (isVisible) void reload();
  }, [isVisible, reload]);

  async function save(account: Account | null, input: AccountInput) {
    try {
      if (account) await api.update(account.id, input);
      else await api.create(input);
      toast.success(t("saved"));
      setView({ kind: "list" });
      await reload();
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    }
  }

  async function test(account: Account) {
    setBusy(account.id);
    try {
      const result = await api.test(account.id);
      if (result.ok) toast.success(t("testOk", { count: result.count ?? 0 }));
      else toast.error(result.error ?? t("testFailed"));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

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
      if (report.failed > 0)
        toast.error(t("syncFailed", { count: report.failed }));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      await reload();
    }
  }

  async function remove(account: Account) {
    const ok = await confirm({
      title: t("deleteConfirm", { name: account.name }),
      confirmLabel: t("delete"),
    });
    if (!ok) return;
    try {
      await api.remove(account.id);
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (view.kind === "form") {
    return (
      <AccountForm
        account={view.account}
        providers={providers}
        credentials={credentials}
        onBack={() => setView({ kind: "list" })}
        onSave={(input) => save(view.account, input)}
      />
    );
  }
  if (view.kind === "discover") {
    return (
      <DiscoverView
        account={view.account}
        api={api}
        onBack={() => setView({ kind: "list" })}
        onDone={() => {
          setView({ kind: "list" });
          void reload();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("tab.title")}</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-accent-brand/40 text-accent-brand"
          onClick={() => setView({ kind: "form", account: null })}
        >
          <Plus className="mr-1 size-3" /> {t("add")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {loaded && accounts.length === 0 && (
        <p className="py-4 text-xs text-muted-foreground">{t("empty")}</p>
      )}
      {accounts.map((account, index) => (
        <ListRow
          key={account.id}
          stripe={index}
          icon={<Cloud />}
          title={account.name}
          meta={
            <span>
              {t(`providers.${account.provider}`)} |{" "}
              {t(`options.${account.syncMode}`)}
              {" | "}
              {account.status === "error"
                ? (account.lastError ?? t("status.error"))
                : account.lastSyncAt
                  ? t("lastSync", {
                      date: new Date(account.lastSyncAt).toLocaleString(),
                    })
                  : t("status.never")}
            </span>
          }
          actions={
            <>
              <ListRowAction
                label={t("test")}
                disabled={busy === account.id}
                onClick={() => void test(account)}
              >
                <Plug />
              </ListRowAction>
              <ListRowAction
                label={t("discover.title")}
                onClick={() => setView({ kind: "discover", account })}
              >
                <DownloadCloud />
              </ListRowAction>
              <ListRowAction
                label={t("syncNow")}
                disabled={busy === account.id}
                onClick={() => void syncNow(account)}
              >
                <RefreshCw />
              </ListRowAction>
              <ListRowAction
                label={t("edit")}
                onClick={() => setView({ kind: "form", account })}
              >
                <Pencil />
              </ListRowAction>
              <ListRowAction
                label={t("delete")}
                tone="destructive"
                onClick={() => void remove(account)}
              >
                <Trash2 />
              </ListRowAction>
            </>
          }
        />
      ))}
    </div>
  );
}

export function activate(app: TermixApp): void {
  app.registerRailItem({
    id: TAB_ID,
    icon: Cloud,
    titleKey: "tab.title",
    kind: "tab",
    permission: "view",
  });
  app.registerTab(TAB_ID, CloudTab, {
    icon: Cloud,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
  });
}
