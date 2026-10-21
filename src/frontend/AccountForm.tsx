import { useMemo, useState } from "react";
import { Cloud } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  FormFooter,
  InlineView,
  Input,
  PasswordInput,
  SectionCard,
  Select2,
  Textarea,
} from "@termix-ssh/plugin-sdk/ui";
import type {
  Account,
  AccountInput,
  ProviderInfo,
  SavedCredential,
} from "./api";

const labelClass =
  "text-[10px] font-bold uppercase tracking-widest text-muted-foreground";

export function AccountForm({
  account,
  providers,
  credentials,
  onBack,
  onSave,
}: {
  account: Account | null;
  providers: ProviderInfo[];
  credentials: SavedCredential[];
  onBack: () => void;
  onSave: (input: AccountInput) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [providerId, setProviderId] = useState(
    account?.provider ?? providers[0]?.id ?? "",
  );
  const provider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId],
  );
  const [name, setName] = useState(account?.name ?? "");
  const [folder, setFolder] = useState(account?.folder ?? "");
  const [defaultUser, setDefaultUser] = useState(account?.defaultUser ?? "");
  const [credentialId, setCredentialId] = useState<number | null>(
    account?.defaultCredentialId ?? null,
  );
  const [address, setAddress] = useState(
    account?.addressPreference ?? "public-first",
  );
  const [syncMode, setSyncMode] = useState(account?.syncMode ?? "manual");
  const [interval, setInterval] = useState(account?.intervalMinutes ?? 60);
  const [onRemoved, setOnRemoved] = useState(account?.onRemoved ?? "keep");
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const selectDefaults = Object.fromEntries(
    (provider?.fields ?? [])
      .filter((f) => f.type === "select" && f.options?.length)
      .map((f) => [f.key, f.options![0]]),
  );
  const missingKeys =
    !account &&
    !!provider?.fields.some(
      (f) => f.required && !(keys[f.key] ?? selectDefaults[f.key] ?? "").trim(),
    );
  const canSave = !!name.trim() && !!provider && !missingKeys && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const hasKeys = !!provider?.fields.some(
        (f) => f.type !== "select" && keys[f.key]?.trim(),
      );
      await onSave({
        provider: providerId,
        name: name.trim(),
        folder: folder.trim(),
        defaultUser: defaultUser.trim(),
        defaultCredentialId: credentialId,
        addressPreference: address,
        syncMode,
        intervalMinutes: interval,
        onRemoved,
        ...(hasKeys ? { credentials: { ...selectDefaults, ...keys } } : {}),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <InlineView
      open
      onOpenChange={(open) => !open && onBack()}
      icon={<Cloud className="size-4" />}
      title={t(account ? "form.editTitle" : "form.addTitle")}
      status={account?.name}
      footer={
        <FormFooter
          saving={saving}
          disabled={!canSave}
          onCancel={onBack}
          onSave={() => void save()}
          saveLabel={t(account ? "form.save" : "form.add")}
        />
      }
    >
      <SectionCard
        title={t("form.account")}
        icon={<Cloud className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.provider")}</label>
            <Select2
              value={providerId}
              disabled={!!account}
              onChange={(e) => {
                setProviderId(e.target.value);
                setKeys({});
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(`providers.${p.id}`)}
                </option>
              ))}
            </Select2>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.name")}</label>
            <Input
              value={name}
              placeholder={t("form.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {provider?.fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label className={labelClass}>
                {t(`fields.${field.key}`)}
                {field.required && !account && (
                  <span className="text-accent-brand"> *</span>
                )}
              </label>
              {field.type === "secret" ? (
                <PasswordInput
                  value={keys[field.key] ?? ""}
                  placeholder={account ? t("form.keepKeys") : field.placeholder}
                  onChange={(e) =>
                    setKeys((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                />
              ) : field.type === "textarea" ? (
                <Textarea
                  value={keys[field.key] ?? ""}
                  placeholder={account ? t("form.keepKeys") : field.placeholder}
                  className="min-h-24 resize-y font-mono text-xs"
                  onChange={(e) =>
                    setKeys((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                />
              ) : field.type === "select" ? (
                <Select2
                  value={keys[field.key] ?? field.options?.[0] ?? ""}
                  onChange={(e) =>
                    setKeys((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                >
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {t(`options.${option}`)}
                    </option>
                  ))}
                </Select2>
              ) : (
                <Input
                  value={keys[field.key] ?? ""}
                  placeholder={account ? t("form.keepKeys") : field.placeholder}
                  onChange={(e) =>
                    setKeys((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                />
              )}
            </div>
          ))}
          {account && (
            <p className="text-[11px] text-muted-foreground">
              {t("form.keysHint")}
            </p>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t("form.hosts")}
        icon={<Cloud className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.folder")}</label>
            <Input
              value={folder}
              placeholder={name || t("form.folderPlaceholder")}
              onChange={(e) => setFolder(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.defaultUser")}</label>
            <Input
              value={defaultUser}
              placeholder={provider?.defaultUser}
              onChange={(e) => setDefaultUser(e.target.value)}
            />
            <span className="text-[11px] text-muted-foreground">
              {t("form.defaultUserHint")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.credential")}</label>
            <Select2
              value={credentialId ?? ""}
              onChange={(e) =>
                setCredentialId(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">{t("form.noCredential")}</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select2>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.address")}</label>
            <Select2
              value={address}
              onChange={(e) => setAddress(e.target.value as typeof address)}
            >
              <option value="public-first">{t("options.public-first")}</option>
              <option value="public">{t("options.public")}</option>
              <option value="private">{t("options.private")}</option>
            </Select2>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("form.sync")} icon={<Cloud className="size-3.5" />}>
        <div className="flex flex-col gap-4 py-3">
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.syncMode")}</label>
            <Select2
              value={syncMode}
              onChange={(e) => setSyncMode(e.target.value as typeof syncMode)}
            >
              <option value="manual">{t("options.manual")}</option>
              <option value="auto">{t("options.auto")}</option>
            </Select2>
          </div>
          {syncMode === "auto" && (
            <div className="flex flex-col gap-1.5">
              <label className={labelClass}>{t("form.interval")}</label>
              <Input
                type="number"
                min={5}
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value) || 60)}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label className={labelClass}>{t("form.onRemoved")}</label>
            <Select2
              value={onRemoved}
              onChange={(e) => setOnRemoved(e.target.value as typeof onRemoved)}
            >
              <option value="keep">{t("options.keep")}</option>
              <option value="mark">{t("options.mark")}</option>
              <option value="delete">{t("options.delete")}</option>
            </Select2>
          </div>
        </div>
      </SectionCard>
    </InlineView>
  );
}
