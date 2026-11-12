import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { evaluate, frozen } from "./evaluation.ts";

const [consent, output, ...extra] = process.argv.slice(2);
if (consent !== "--allow-paid-typesafe" || !output || extra.length > 0) {
  console.error("Live evaluation requires --allow-paid-typesafe and a new output path. It makes 52 paid native classifier calls, plus native transport retries.");
  process.exitCode = 1;
} else {
  try {
    const file = await open(output, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ frozen, status: "pending", startedAt: new Date().toISOString() }, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    try {
      const classifier = runtime.getModelOfType("classifier", "typesafe", "jev-latest");
      if (!classifier || !runtime.hasConfiguredAuth(classifier.provider)) throw new Error("Classifier unavailable");
      const report = await evaluate((context) => runtime.classify(classifier, context));
      const content = Buffer.from(JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2) + "\n");
      const temporaryPath = join(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
      const temporaryFile = await open(temporaryPath, "wx", 0o600);
      let published = false;
      try {
        try {
          let offset = 0;
          while (offset < content.length) {
            const { bytesWritten } = await temporaryFile.write(content, offset, content.length - offset, offset);
            if (bytesWritten === 0) throw new Error("Report write made no progress");
            offset += bytesWritten;
          }
          await temporaryFile.sync();
        } finally {
          await temporaryFile.close();
        }
        await rename(temporaryPath, output);
        published = true;
      } finally {
        if (!published) await rm(temporaryPath, { force: true });
      }
      console.log(JSON.stringify({ pass: report.pass, summary: report.summary, errors: report.errors, deepToQuick: report.deepToQuick, disagreements: report.disagreements }));
      process.exitCode = report.pass ? 0 : 1;
    } finally {
      await runtime.settleCredentialWrites();
    }
  } catch {
    console.error("Evaluation did not complete. Check the new output path and native registered TypeSafe credentials. Transport details are not logged.");
    process.exitCode = 1;
  }
}
