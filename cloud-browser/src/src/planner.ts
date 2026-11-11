import { z } from "zod";
import { config } from "./config.js";
import type { PageSnapshot } from "./extract.js";
import type { PlatformPolicy } from "./policy.js";

export type Finding = { title: string; detail?: string; url?: string };

export type AgentAction =
  | { kind: "goto"; url: string }
  | { kind: "click"; ref: string; label?: string }
  | { kind: "type"; ref: string; text: string; submit: boolean }
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "wait"; ms: number }
  | { kind: "read_page" }
  | { kind: "draft_action"; target: string; content: string; rationale: string }
  | { kind: "finish"; summary: string; findings: Finding[] };

export type Decision = { thought: string; action: AgentAction };

export type PlannerStep = {
  goal: string;
  step: number;
  maxSteps: number;
  platform: string;
  mode: "read" | "agent";
  policy: Pick<PlatformPolicy, "actionMode" | "actionNote" | "draftAllowed" | "label">;
  snapshot: PageSnapshot;
  history: Array<{ action: string; result: string }>;
};

export interface Planner {
  next(input: PlannerStep): Promise<Decision>;
}

const findingSchema = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().trim().max(1200).optional(),
  url: z.string().trim().max(600).optional(),
});

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), url: z.string().url().max(600) }),
  z.object({ kind: z.literal("click"), ref: z.string().regex(/^e\d{1,3}$/), label: z.string().max(120).optional() }),
  z.object({ kind: z.literal("type"), ref: z.string().regex(/^e\d{1,3}$/), text: z.string().max(1500), submit: z.boolean() }),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.number().int().min(1).max(4000).optional() }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(100).max(8000) }),
  z.object({ kind: z.literal("read_page") }),
  z.object({ kind: z.literal("draft_action"), target: z.string().max(200), content: z.string().min(1).max(1500), rationale: z.string().max(400) }),
  z.object({ kind: z.literal("finish"), summary: z.string().min(1).max(2000), findings: z.array(findingSchema).max(25) }),
]);

const decisionSchema = z.object({ thought: z.string().max(600), action: actionSchema });

export class PlannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerUnavailableError";
  }
}

/**
 * Uses the dashboard AI endpoint (Gemini/Groq with existing failover + quotas)
 * so model keys stay in the app and never reach the browser host.
 */
export class AppLlmPlanner implements Planner {
  async next(input: PlannerStep): Promise<Decision> {
    if (!config.appUrl) throw new PlannerUnavailableError("app_url_not_configured");
    const response = await fetch(`${config.appUrl}${config.plannerPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
        ...(config.dashboardBypass ? { "x-vercel-protection-bypass": config.dashboardBypass } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(45_000),
    });
    const data = (await response.json().catch(() => null)) as { decision?: unknown; message?: string } | null;
    if (!response.ok || !data?.decision) {
      throw new PlannerUnavailableError(data?.message || `planner_http_${response.status}`);
    }
    const parsed = decisionSchema.safeParse(data.decision);
    if (!parsed.success) throw new PlannerUnavailableError("planner_invalid_decision");
    return parsed.data;
  }
}

/**
 * Deterministic read-only planner: opens the account inbox, waits for the app
 * to render, extracts the visible content and finishes. It never performs
 * side effects and works without any AI provider configured.
 */
export class ReadOnlyPlanner implements Planner {
  private stage = 0;

  constructor(private readonly inboxUrl: string) {}

  async next(input: PlannerStep): Promise<Decision> {
    if (this.stage === 0) {
      this.stage = 1;
      return {
        thought: "فتح صندوق الرسائل للقراءة فقط.",
        action: { kind: "goto", url: this.inboxUrl },
      };
    }
    if (this.stage === 1) {
      this.stage = 2;
      return { thought: "الانتظار حتى يكتمل تحميل المحتوى.", action: { kind: "wait", ms: 2500 } };
    }
    if (this.stage === 2) {
      this.stage = 3;
      return { thought: "قراءة النص الظاهر في الصفحة.", action: { kind: "read_page" } };
    }
    const text = input.snapshot.text;
    const findings = extractFindings(text);
    return {
      thought: "تلخيص ما ظهر فعلياً في الصفحة.",
      action: {
        kind: "finish",
        summary: findings.length
          ? `تمت قراءة ${findings.length} عنصراً ظاهراً من ${input.policy.label}. النص الكامل محفوظ في نتيجة المهمة للمراجعة.`
          : `تم فتح ${input.policy.label} لكن لم يظهر نص قابل للقراءة. تحقق من حالة تسجيل الدخول داخل المتصفح.`,
        findings,
      },
    };
  }
}

export function extractFindings(text: string, limit = 15): Finding[] {
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 18 && line.length <= 400);
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ title: line });
    if (findings.length >= limit) break;
  }
  return findings;
}
