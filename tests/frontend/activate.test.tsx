import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("registers the rail item and tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["cloud-providers"]);
    expect(rendered.registered.railItems()).toEqual([
      expect.objectContaining({
        id: "cloud-providers",
        permission: "cloud-providers.view",
      }),
    ]);
  });

  it("lists accounts with their provider", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/accounts") {
        return {
          data: {
            accounts: [
              {
                id: 1,
                provider: "hetzner",
                name: "Hetzner prod",
                folder: null,
                defaultUser: null,
                defaultCredentialId: null,
                addressPreference: "public-first",
                syncMode: "auto",
                intervalMinutes: 60,
                onRemoved: "keep",
                status: "ok",
                lastError: null,
                lastSyncAt: null,
              },
            ],
          },
        };
      }
      if (path === "/providers") return { data: { providers: [] } };
      return { data: { credentials: [] } };
    });
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { get } as never,
    });
    rendered.renderTab("cloud-providers", { isVisible: true });
    expect(await screen.findByText("Hetzner prod")).toBeTruthy();
    expect(screen.getByText(locales.add)).toBeTruthy();
  });

  it("shows the empty state", async () => {
    const get = vi.fn(async (path: string) => ({
      data:
        path === "/accounts"
          ? { accounts: [] }
          : path === "/providers"
            ? { providers: [] }
            : { credentials: [] },
    }));
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: { get } as never,
    });
    rendered.renderTab("cloud-providers", { isVisible: true });
    expect(await screen.findByText(locales.empty)).toBeTruthy();
  });
});

describe("cloud accounts dashboard card", () => {
  it("lists accounts with their sync state", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["cloud-providers.view"],
      api: {
        get: vi.fn(async () => ({
          data: {
            accounts: [
              {
                id: 1,
                provider: "hetzner",
                name: "Prod",
                folder: null,
                defaultUser: null,
                defaultCredentialId: null,
                addressPreference: "public",
                syncMode: "auto",
                intervalMinutes: 60,
                onRemoved: "keep",
                status: "error",
                lastError: "bad token",
                lastSyncAt: null,
              },
            ],
          },
        })),
      } as never,
    });
    expect(rendered.registered.dashboardCards()).toEqual(["cloud-accounts"]);
    rendered.renderDashboardCard("cloud-accounts");
    expect(await screen.findByText("Prod")).toBeTruthy();
    expect(screen.getByText(/bad token/)).toBeTruthy();
  });
});
