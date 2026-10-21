import type { PluginFetch } from "@termix-ssh/plugin-sdk/backend";

export type InstanceState = "running" | "stopped" | "other";

export interface CloudInstance {
  id: string;
  name: string;
  publicIp: string | null;
  privateIp: string | null;
  region: string;
  state: InstanceState;
  // Plain labels or "key:value" pairs from the cloud.
  tags: string[];
  // Login name the cloud knows about, when it does.
  user?: string;
}

export interface CredentialField {
  key: string;
  type: "text" | "secret" | "textarea" | "select";
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export type Credentials = Record<string, string>;

export interface Provider {
  id: string;
  fields: CredentialField[];
  defaultUser: string;
  list: (creds: Credentials, fetch: PluginFetch) => Promise<CloudInstance[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
