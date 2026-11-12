import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { routeRequest } from "../src/router.ts";
import { entries, registryFixture, request } from "./fixtures/router.ts";

async function state(messages: Message[]) {
  const entry = entries[0];
  assert.ok(entry);
  const fixture = registryFixture();
  await routeRequest(entry, request(entry, { messages }), fixture.registry);
  return fixture.calls[0]?.context.state;
}

function reference(messages: Message[]) {
  const text = (message: Message): string => message.role !== "user" && message.role !== "assistant" ? ""
    : typeof message.content === "string" ? message.content
      : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  const latest = messages.findLastIndex((message) => message.role === "user");
  const history = messages.slice(0, latest).flatMap((message) => {
    const value = text(message);
    return value.length ? [`${message.role}: ${value}`] : [];
  }).join("\n");
  return { current: Array.from(text(messages[latest]!)).slice(0, 16_000).join(""), recent: Array.from(history).slice(-4_000).join("") };
}

test("classifier does not read text blocks outside the current or recent window", async () => {
  const excluded = { type: "text" as const, get text(): string { throw new Error("Read discarded text"); } };
  const messages: Message[] = [
    { role: "user", content: [excluded], timestamp: 0 },
    fauxAssistantMessage([excluded, { type: "text", text: "😀".repeat(4_000) }]),
    { role: "user", content: [{ type: "text", text: "😀".repeat(16_000) }, excluded], timestamp: 1 },
  ];
  assert.deepEqual(await state(messages), { current: "😀".repeat(16_000), recent: "😀".repeat(4_000) });
});

for (const unit of ["a", "😀", "a😀", "\ud800", "\udc00", "\udc00\ud800", "e\u0301"]) {
  test(`bounded extraction matches the original payload for ${JSON.stringify(unit)}`, async () => {
    for (const size of [0, 1, 3_999, 4_000, 4_001, 8_001, 16_001, 32_001]) {
      const value = unit.repeat(size);
      const messages: Message[] = [
        { role: "user", content: "old context", timestamp: 0 },
        fauxAssistantMessage([{ type: "text", text: "" }, { type: "thinking", thinking: "private" }, { type: "text", text: value }, { type: "text", text: "" }]),
        fauxAssistantMessage([{ type: "text", text: "" }, { type: "text", text: "" }]),
        { role: "user", content: [{ type: "text", text: "prefix" }, { type: "text", text: value }, { type: "text", text: "suffix" }], timestamp: 1 },
      ];
      assert.deepEqual(await state(messages), reference(messages));
      messages[2] = fauxAssistantMessage("");
      messages[3] = { role: "user", content: `prefix${value}suffix`, timestamp: 1 };
      assert.deepEqual(await state(messages), reference(messages));
    }
  });
}
