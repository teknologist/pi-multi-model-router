type UsageRecords = Map<string, { modelId: string; outputTokens: number; elapsedMs: number }> & {
  lastModelKey?: string;
};

export type UsageLedger = Map<string, UsageRecords>;

export function record(
  ledger: UsageLedger,
  entryKey: string,
  provider: string,
  modelId: string,
  outputTokens: number,
  elapsedMs?: number,
): void {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return;
  const records: UsageRecords = ledger.get(entryKey) ?? new Map();
  // JSON pair key: provider and id may both contain “/”.
  const key = JSON.stringify([provider, modelId]);
  const usage = records.get(key) ?? { modelId, outputTokens: 0, elapsedMs: 0 };
  usage.outputTokens += outputTokens;
  if (elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs > 0) usage.elapsedMs += elapsedMs;
  records.set(key, usage);
  records.lastModelKey = key;
  ledger.set(entryKey, records);
}

export function render(ledger: UsageLedger, entryKey: string): string | undefined {
  const entry = ledger.get(entryKey);
  const records = [...(entry?.values() ?? [])];
  if (records.length === 0) return undefined;
  const total = records.reduce((sum, usage) => sum + usage.outputTokens, 0);
  const shares = records.map((usage, index) => {
    const exact = usage.outputTokens / total * 100;
    return { index, pct: Math.floor(exact), remainder: exact % 1 };
  });
  const remaining = 100 - shares.reduce((sum, share) => sum + share.pct, 0);
  const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const share of ranked.slice(0, remaining)) share.pct++;
  return records.map((usage, index) => {
    const speed = usage.elapsedMs > 0 ? ` · ${(usage.outputTokens / (usage.elapsedMs / 1000)).toFixed(1)} t/s` : "";
    const label = usage === entry?.get(entry.lastModelKey ?? "")
      ? `\u001b[1m${usage.modelId}\u001b[22m` : usage.modelId;
    return `${label}: ${shares[index]?.pct}%${speed}`;
  }).join(" | ");
}
