import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";

export interface CredentialField {
  key: string;
  type: "text" | "secret" | "textarea" | "select";
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface ProviderInfo {
  id: string;
  defaultUser: string;
  fields: CredentialField[];
}

export interface Account {
  id: number;
  provider: string;
  name: string;
  folder: string | null;
  defaultUser: string | null;
  defaultCredentialId: number | null;
  addressPreference: "public" | "private" | "public-first";
  syncMode: "manual" | "auto";
  intervalMinutes: number;
  onRemoved: "keep" | "mark" | "delete";
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
}

export interface AccountInput {
  provider?: string;
  name: string;
  folder: string;
  defaultUser: string;
  defaultCredentialId: number | null;
  addressPreference: Account["addressPreference"];
  syncMode: Account["syncMode"];
  intervalMinutes: number;
  onRemoved: Account["onRemoved"];
  credentials?: Record<string, string>;
}

export interface Instance {
  id: string;
  name: string;
  region: string;
  state: "running" | "stopped" | "other";
  address: string | null;
  imported: boolean;
}

export interface Report {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  removed: number;
  failed: number;
}

export interface SavedCredential {
  id: number;
  name: string;
  username: string | null;
}

export function errorMessage(error: unknown): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  if (data?.error) return data.error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

/** The cloud-providers routes, through the plugin's own client. */
export function createApi(api: PluginApiClient) {
  const data = async <T>(request: Promise<{ data: T }>) => (await request).data;
  return {
    providers: () =>
      data(api.get<{ providers: ProviderInfo[] }>("/providers")).then(
        (r) => r.providers,
      ),
    credentials: () =>
      data(api.get<{ credentials: SavedCredential[] }>("/credentials")).then(
        (r) => r.credentials,
      ),
    accounts: () =>
      data(api.get<{ accounts: Account[] }>("/accounts")).then(
        (r) => r.accounts,
      ),
    create: (body: AccountInput) => data(api.post("/accounts", body)),
    update: (id: number, body: AccountInput) =>
      data(api.put(`/accounts/${id}`, body)),
    remove: (id: number) => data(api.delete(`/accounts/${id}`)),
    test: (id: number) =>
      data(
        api.post<{ ok: boolean; count?: number; error?: string }>(
          `/accounts/${id}/test`,
        ),
      ),
    discover: (id: number) =>
      data(
        api.post<{ instances: Instance[] }>(`/accounts/${id}/discover`),
      ).then((r) => r.instances),
    importIds: (id: number, ids: string[]) =>
      data(
        api.post<{ report: Report }>(`/accounts/${id}/import`, { ids }),
      ).then((r) => r.report),
    sync: (id: number) =>
      data(api.post<{ report: Report }>(`/accounts/${id}/sync`)).then(
        (r) => r.report,
      ),
  };
}

export type CloudApi = ReturnType<typeof createApi>;
