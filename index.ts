import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { routeRequest } from "./src/router.ts";

export default async function multiModelRouter(api: ExtensionAPI): Promise<void> {
  const loaded = await loadConfig();
  if (loaded.status === "missing") {
    console.error(loaded.diagnostic);
    return;
  }

  const owned: { provider: string; id: string }[] = [];
  api.on("session_shutdown", () => {
    for (const key of owned.splice(0)) api.unregisterVirtualModel(key.provider, key.id);
  });
  for (const entry of loaded.config.virtualModels) {
    api.registerVirtualModel({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
      route: (request, context) => routeRequest(entry, request, context.modelRegistry),
    });
    owned.push({ provider: entry.provider, id: entry.id });
  }
}
