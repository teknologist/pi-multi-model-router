import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.ts";
import { routeRequest } from "./src/router.ts";
import { record, render, type UsageLedger } from "./src/usage.ts";

export default async function multiModelRouter(api: ExtensionAPI): Promise<void> {
  const loaded = await loadConfig();
  if (loaded.status === "missing") {
    console.error(loaded.diagnostic);
    return;
  }

  const owned: { provider: string; id: string }[] = [];
  const ledger: UsageLedger = new Map();
  // The sequential agent loop has at most one assistant message in flight.
  let pending: { entryKey: string; startedAt: number } | undefined;

  const ownedKey = (provider: string, id: string): string => JSON.stringify([provider, id]);
  const findOwned = (provider?: string, id?: string) =>
    owned.find((entry) => entry.provider === provider && entry.id === id);

  api.on("session_start", (_event, ctx) => {
    ledger.clear();
    pending = undefined;
    ctx.ui.setStatus("multi-model-router", undefined);
  });
  api.on("message_start", (event, ctx) => {
    const entry = event.message?.role === "assistant" ? findOwned(ctx.model?.provider, ctx.model?.id) : undefined;
    if (entry) pending = { entryKey: ownedKey(entry.provider, entry.id), startedAt: performance.now() };
  });
  api.on("message_end", (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const message = event.message;
    const counted = pending;
    pending = undefined;
    if (!counted || message.stopReason === "error" || message.stopReason === "aborted"
      || typeof message.provider !== "string" || !message.provider
      || typeof message.model !== "string" || !message.model) return;
    record(ledger, counted.entryKey, message.provider, message.model, message.usage?.output,
      performance.now() - counted.startedAt);
    // Publish for the entry selected at end, so mid-stream switches stay coherent.
    const active = findOwned(ctx.model?.provider, ctx.model?.id);
    const status = active ? render(ledger, ownedKey(active.provider, active.id)) : undefined;
    ctx.ui.setStatus("multi-model-router", status);
  });
  api.on("model_select", (event, ctx) => {
    const entry = findOwned(event.model.provider, event.model.id);
    ctx.ui.setStatus("multi-model-router", entry ? render(ledger, ownedKey(entry.provider, entry.id)) : undefined);
  });
  api.on("session_shutdown", (_event, ctx) => {
    ledger.clear();
    pending = undefined;
    ctx.ui.setStatus("multi-model-router", undefined);
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
