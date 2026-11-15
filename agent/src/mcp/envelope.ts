import * as z from "zod";

/**
 * The result envelope for tools that act or check whether an action may happen.
 *
 * A denial is a verdict, not an error: when the mandate stops a trade the tool succeeds and says
 * `rejected` with machine-readable reasons, so the agent can explain it instead of retrying.
 *
 * - `approved`: the action was accepted.
 * - `rejected`: the mandate refused it. Final until the owner changes the mandate.
 * - `held`: waiting for someone, usually the owner approving in the console.
 * - `ok`: a read or check that completed, with nothing to approve.
 * - `unavailable`: the server cannot do this yet, usually because setup is incomplete.
 */
export const VERDICT_STATUSES = ["approved", "rejected", "held", "ok", "unavailable"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export const ReasonSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .describe("Stable UPPER_SNAKE_CASE reason code, for example DAILY_LIMIT_EXCEEDED"),
  message: z.string().describe("One plain-language sentence explaining the reason"),
});
export type Reason = z.infer<typeof ReasonSchema>;

export const NextActionSchema = z.object({
  actor: z.enum(["agent", "owner"]).describe("Who must act next"),
  hint: z.string().describe("What that actor should do, in one sentence"),
});
export type NextAction = z.infer<typeof NextActionSchema>;

export const VerdictSchema = z.object({
  status: z.enum(VERDICT_STATUSES),
  reasons: z.array(ReasonSchema),
  nextAction: NextActionSchema.optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** Output schema for a tool whose result is a verdict plus tool-specific fields. */
export function verdictSchema<Shape extends z.ZodRawShape>(shape: Shape) {
  return VerdictSchema.extend(shape);
}

export function verdict(
  status: VerdictStatus,
  reasons: readonly Reason[] = [],
  nextAction?: NextAction,
): Verdict {
  return nextAction === undefined
    ? { status, reasons: [...reasons] }
    : { status, reasons: [...reasons], nextAction };
}

export const approved = (reasons: readonly Reason[] = [], nextAction?: NextAction) =>
  verdict("approved", reasons, nextAction);
export const rejected = (reasons: readonly Reason[], nextAction?: NextAction) =>
  verdict("rejected", reasons, nextAction);
export const held = (reasons: readonly Reason[], nextAction?: NextAction) =>
  verdict("held", reasons, nextAction);
export const ok = (reasons: readonly Reason[] = [], nextAction?: NextAction) =>
  verdict("ok", reasons, nextAction);
export const unavailable = (reasons: readonly Reason[], nextAction?: NextAction) =>
  verdict("unavailable", reasons, nextAction);

export const reason = (code: string, message: string): Reason => ({ code, message });

/**
 * A one-line summary of a verdict for the text part of a tool result, for example
 * `rejected: DAILY_LIMIT_EXCEEDED (Today's limit of 500 USDC is used up). Next, owner: Raise the limit in the console.`
 */
export function summarizeVerdict(v: Verdict): string {
  const reasons = v.reasons.map((r) => `${r.code} (${r.message})`).join("; ");
  const next = v.nextAction === undefined ? "" : ` Next, ${v.nextAction.actor}: ${v.nextAction.hint}`;
  return `${v.status}${reasons === "" ? "." : `: ${reasons}.`}${next}`;
}
