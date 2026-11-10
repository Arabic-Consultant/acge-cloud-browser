import { createServer } from "node:http";

export type MockPlanner = { url: string; close: () => Promise<void>; calls: number };

/**
 * Minimal stand-in for the dashboard AI step endpoint. It exercises the real
 * agent loop (navigation + composer drafting) deterministically so the
 * approval gate can be verified without an LLM provider or paid credits.
 */
export async function startMockPlanner(options: {
  fixtureUrl: string;
  content: string;
  threadPath?: string;
}): Promise<MockPlanner> {
  const state = { calls: 0 };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/api/browser/agent/step")) {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "not_found" }));
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { step?: number };
    state.calls += 1;
    const step = Number(body.step ?? 1);
    let decision: unknown;
    if (step <= 1) {
      decision = {
        thought: "فتح المحادثة المستهدفة داخل المتصفح.",
        action: { kind: "goto", url: `${options.fixtureUrl}${options.threadPath ?? "/thread/1"}` },
      };
    } else if (step === 2) {
      decision = {
        thought: "تجهيز الرد داخل مربع الكتابة قبل أي إرسال.",
        action: {
          kind: "draft_action",
          target: "شركة النور للاستشارات",
          content: options.content,
          rationale: "رد على استفسار العميل عن برنامج التحول الرقمي.",
        },
      };
    } else {
      decision = {
        thought: "انتهى ما طلبته.",
        action: { kind: "finish", summary: "تمت قراءة المحادثة وتجهيز الرد بانتظار الموافقة.", findings: [] },
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ decision }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return state.calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
