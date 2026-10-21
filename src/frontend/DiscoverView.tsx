import { useEffect, useMemo, useState } from "react";
import { Cloud } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Checkbox,
  FormFooter,
  InlineView,
  SectionCard,
} from "@termix-ssh/plugin-sdk/ui";
import {
  errorMessage,
  type Account,
  type CloudApi,
  type Instance,
} from "./api";

export function DiscoverView({
  account,
  api,
  onBack,
  onDone,
}: {
  account: Account;
  api: CloudApi;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .discover(account.id)
      .then((list) => {
        if (!live) return;
        setInstances(list);
        setPicked(
          new Set(
            list.filter((i) => !i.imported && i.address).map((i) => i.id),
          ),
        );
      })
      .catch((error) => live && setFailed(errorMessage(error)));
    return () => {
      live = false;
    };
  }, [api, account.id]);

  const selectable = useMemo(
    () => (instances ?? []).filter((i) => i.address),
    [instances],
  );

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const report = await api.importIds(account.id, [...picked]);
      toast.success(
        t("discover.done", {
          created: report.created,
          updated: report.updated,
        }),
      );
      if (report.failed > 0)
        toast.error(t("discover.failed", { count: report.failed }));
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <InlineView
      open
      onOpenChange={(open) => !open && onBack()}
      icon={<Cloud className="size-4" />}
      title={t("discover.title")}
      status={account.name}
      footer={
        <FormFooter
          saving={saving}
          disabled={picked.size === 0 || saving}
          onCancel={onBack}
          onSave={() => void save()}
          saveLabel={t("discover.import", { count: picked.size })}
        />
      }
    >
      <SectionCard
        title={t("discover.instances")}
        icon={<Cloud className="size-3.5" />}
      >
        <div className="flex flex-col py-2">
          {failed && <p className="py-2 text-xs text-destructive">{failed}</p>}
          {!failed && instances === null && (
            <p className="py-2 text-xs text-muted-foreground">
              {t("discover.loading")}
            </p>
          )}
          {instances?.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">
              {t("discover.empty")}
            </p>
          )}
          {instances && instances.length > 0 && (
            <div className="flex gap-2 pb-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPicked(new Set(selectable.map((i) => i.id)))}
              >
                {t("discover.all")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPicked(new Set())}
              >
                {t("discover.none")}
              </Button>
            </div>
          )}
          {instances?.map((instance) => (
            <label
              key={instance.id}
              className="flex items-center gap-3 border-b border-border py-2 text-xs"
            >
              <Checkbox
                checked={picked.has(instance.id)}
                disabled={!instance.address}
                onCheckedChange={() => toggle(instance.id)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate">{instance.name}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {instance.address ?? t("discover.noAddress")} |{" "}
                  {instance.region} | {t(`state.${instance.state}`)}
                </div>
              </div>
              {instance.imported && (
                <span className="text-[10px] uppercase text-muted-foreground">
                  {t("discover.imported")}
                </span>
              )}
            </label>
          ))}
        </div>
      </SectionCard>
    </InlineView>
  );
}
