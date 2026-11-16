import { readFile } from "node:fs/promises";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";

type Choice = "quick" | "balanced" | "deep";
interface Fixture { id: string; current: string; recent?: string; expected: Choice; allowed?: Choice[] }
interface Frozen {
  core: Fixture[]; holdout: Fixture[]; contextual: Fixture[];
  criteria: Record<Choice, string>; instructions: string;
  thresholds: { core: number; holdout: number; context: number; errors: number; deepToQuick: number };
}

export const frozen: Frozen = JSON.parse(await readFile(new URL("./fixtures/jev-fixtures.json", import.meta.url), "utf8"));
const sets = ["core", "holdout", "contextual"] as const;
type SetName = typeof sets[number];
interface Result { set: SetName; id: string; repeat: number; expected: Choice; allowed: Choice[]; choice?: Choice; error?: string }

function isChoice(value: string): value is Choice {
  return value === "quick" || value === "balanced" || value === "deep";
}

function summarize(results: Result[]) {
  const counts = { quick: 0, balanced: 0, deep: 0 };
  const confusion = {
    quick: { quick: 0, balanced: 0, deep: 0 },
    balanced: { quick: 0, balanced: 0, deep: 0 },
    deep: { quick: 0, balanced: 0, deep: 0 },
  };
  for (const result of results) {
    if (result.choice) {
      counts[result.choice]++;
      confusion[result.expected][result.choice]++;
    }
  }
  return {
    exact: [results.filter((r) => r.choice === r.expected).length, results.length] as const,
    allowed: [results.filter((r) => r.choice && r.allowed.includes(r.choice)).length, results.length] as const,
    counts, confusion,
  };
}

export async function evaluate(classify: (context: ClassifierContext) => Promise<ClassifierResult>) {
  const results: Result[] = [];
  for (const set of sets) {
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const fixture of frozen[set]) {
        const row: Result = { set, id: fixture.id, repeat, expected: fixture.expected, allowed: fixture.allowed ?? [fixture.expected] };
        try {
          const result = await classify({
            state: { current: fixture.current, recent: fixture.recent ?? "" },
            questions: { route: { type: "choice", instructions: frozen.instructions, criteria: frozen.criteria } },
          });
          const answer = result.answers.route;
          if (result.stopReason === "stop" && answer?.type === "choice" && isChoice(answer.choice)) row.choice = answer.choice;
          else row.error = "invalid classifier result";
        } catch {
          row.error = "classifier call failed";
        }
        results.push(row);
      }
    }
  }
  const summary = {
    core: summarize(results.filter((r) => r.set === "core")),
    holdout: summarize(results.filter((r) => r.set === "holdout")),
    contextual: summarize(results.filter((r) => r.set === "contextual")),
  };
  const disagreements = sets.flatMap((set) => frozen[set].flatMap((fixture) => {
    const choices = results.filter((r) => r.set === set && r.id === fixture.id).map((r) => r.choice ?? "error");
    return new Set(choices).size > 1 ? [{ set, id: fixture.id, choices }] : [];
  }));
  const errors = results.filter((r) => r.error).length;
  const deepToQuick = results.filter((r) => r.expected === "deep" && r.choice === "quick").length;
  const thresholds = frozen.thresholds;
  const pass = summary.core.allowed[0] >= thresholds.core && summary.holdout.allowed[0] >= thresholds.holdout
    && summary.contextual.allowed[0] >= thresholds.context && errors <= thresholds.errors && deepToQuick <= thresholds.deepToQuick;
  return { frozen, pass, summary, errors, deepToQuick, disagreements, results, holdoutStatus: "previously consumed, not unseen" };
}
