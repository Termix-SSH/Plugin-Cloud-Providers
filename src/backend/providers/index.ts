import { aws } from "./aws.js";
import { azure } from "./azure.js";
import { digitalocean } from "./digitalocean.js";
import { gcp } from "./gcp.js";
import { hetzner } from "./hetzner.js";
import { linode } from "./linode.js";
import { oracle } from "./oracle.js";
import { scaleway } from "./scaleway.js";
import { upcloud } from "./upcloud.js";
import { vultr } from "./vultr.js";
import type { Provider } from "./types.js";

export const providers: Provider[] = [
  aws,
  azure,
  gcp,
  digitalocean,
  hetzner,
  linode,
  vultr,
  oracle,
  scaleway,
  upcloud,
];

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}

export type {
  CloudInstance,
  Credentials,
  CredentialField,
  Provider,
} from "./types.js";
export { ProviderError } from "./types.js";
