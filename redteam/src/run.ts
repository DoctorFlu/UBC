/**
 * Runs the attacks in order against one target and records each outcome.
 *
 * After every attack it re-reads the roles and the rules. If owner-only state changed in a way no
 * scenario asked for, it records a `BREACH` and stops at once, so a real break never goes on to
 * do more damage (this matters most against the live stack).
 */
import type { PolicyRules, Roles } from "@mandate/shared";
import type { Attack, AttackContext, AttackRecord, EndState, Observation, Scenario } from "./types";

export interface RunOutcome {
  records: AttackRecord[];
  aborted: string | null;
}

const sameRoles = (a: Roles, b: Roles) =>
  a.user.toLowerCase() === b.user.toLowerCase() &&
  a.agent.toLowerCase() === b.agent.toLowerCase() &&
  a.executor.toLowerCase() === b.executor.toLowerCase();

const sameRules = (a: PolicyRules, b: PolicyRules) => JSON.stringify(a) === JSON.stringify(b);

function record(
  attack: Attack,
  fields: Partial<AttackRecord> & Pick<AttackRecord, "verdict" | "actual">,
): AttackRecord {
  return {
    id: attack.id,
    name: attack.name,
    surface: attack.surface,
    tried: attack.tried,
    expected: attack.expected,
    expectedVerdict: attack.expectedVerdict,
    limit: attack.limit ?? null,
    finding: attack.finding ?? null,
    txHashes: [],
    intentIds: [],
    asExpected: false,
    ...fields,
  };
}

/** Owner-side setup for a group of attacks, and how to undo it. */
interface ScenarioHooks {
  setup: (ctx: AttackContext) => Promise<void>;
  teardown: (ctx: AttackContext) => Promise<void>;
  /** The rules expected while the scenario is active. */
  rules: (baseline: PolicyRules) => PolicyRules;
}

const SCENARIOS: Record<Scenario, ScenarioHooks> = {
  paused: {
    async setup(ctx) {
      await ctx.owner.setPaused(true);
    },
    async teardown(ctx) {
      if ((await ctx.reader.getRules()).paused) await ctx.owner.setPaused(false);
    },
    rules: (baseline) => ({ ...baseline, paused: true }),
  },
  "daily-loss": {
    async setup(ctx) {
      if (ctx.executor === null) throw new Error("the daily-loss scenario needs the executor key");
      // The executor records a loss as large as the limit on one of the attacker's approved buys.
      for (const { intentId, amountCents } of ctx.state.approved) {
        if ((await ctx.reader.getIntent(intentId))?.status !== "approved") continue;
        await ctx.executor.recordResult({
          intentId,
          filled: true,
          filledCents: amountCents,
          pnlCents: -ctx.rules.dailyLossCents,
        });
        return;
      }
      throw new Error("no approved intent left for the executor to record a loss on");
    },
    // Losses cannot be undone; this scenario runs last and only on our own chain.
    async teardown() {},
    rules: (baseline) => baseline,
  },
};

export async function runAttacks(
  ctx: AttackContext,
  attacks: readonly Attack[],
  onRecord: (record: AttackRecord) => void,
): Promise<RunOutcome> {
  const records: AttackRecord[] = [];
  const baselineRoles = await ctx.reader.getRoles();
  const push = (r: AttackRecord) => {
    records.push(r);
    onRecord(r);
  };

  /** Runs one attack; returns an abort reason when owner-only state changed unexpectedly. */
  async function runOne(attack: Attack, expectedRules: PolicyRules): Promise<string | null> {
    let result: AttackRecord;
    try {
      const o: Observation = await attack.run(ctx);
      result = record(attack, {
        verdict: o.verdict,
        actual: o.actual,
        txHashes: o.txHashes ?? [],
        intentIds: o.intentIds ?? [],
        asExpected: o.verdict === attack.expectedVerdict && o.matched !== false,
      });
    } catch (error) {
      result = record(attack, {
        verdict: "ERROR",
        actual: `the attack could not run: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    push(result);
    const [roles, rules] = await Promise.all([ctx.reader.getRoles(), ctx.reader.getRules()]);
    if (sameRoles(roles, baselineRoles) && sameRules(rules, expectedRules)) return null;
    const what = [
      ...(sameRoles(roles, baselineRoles) ? [] : [`roles changed to ${JSON.stringify(roles)}`]),
      ...(sameRules(rules, expectedRules) ? [] : [`rules changed to ${JSON.stringify(rules)}`]),
    ].join("; ");
    const reason = `owner-only state changed during ${attack.id}: ${what}`;
    push({
      ...record(attack, { verdict: "BREACH", actual: reason }),
      id: "invariant.owner-state",
      name: "Owner-only state is unchanged after each attack",
      tried: `Re-read the roles and rules after ${attack.id}.`,
      expected: "Roles and rules exactly as the owner left them.",
      expectedVerdict: "held",
      limit: null,
      finding: null,
    });
    return reason;
  }

  for (let i = 0; i < attacks.length;) {
    const attack = attacks[i] as Attack;
    const scenario = attack.scenario;
    // A scenario covers the consecutive attacks that need it.
    let end = i + 1;
    while (scenario !== undefined && end < attacks.length && attacks[end]?.scenario === scenario) end += 1;
    const group = attacks.slice(i, end);
    i = end;

    const runnable = group.filter((a) => {
      if (ctx.target === "stack" && a.selfOnly !== undefined) {
        push(
          record(a, {
            verdict: "SKIPPED",
            actual: `not run against the live stack: ${a.selfOnly}`,
            asExpected: true,
          }),
        );
        return false;
      }
      return true;
    });
    if (runnable.length === 0) continue;

    const hooks = scenario === undefined ? undefined : SCENARIOS[scenario];
    const expectedRules = hooks === undefined ? ctx.rules : hooks.rules(ctx.rules);
    if (hooks !== undefined) await hooks.setup(ctx);
    // Undo the scenario even if the process is interrupted while it is active.
    const onInterrupt = () => {
      void (hooks?.teardown(ctx) ?? Promise.resolve()).finally(() => process.exit(130));
    };
    if (hooks !== undefined) process.once("SIGINT", onInterrupt);
    try {
      for (const a of runnable) {
        const aborted = await runOne(a, expectedRules);
        if (aborted !== null) return { records, aborted };
      }
    } finally {
      if (hooks !== undefined) {
        process.removeListener("SIGINT", onInterrupt);
        await hooks.teardown(ctx);
      }
    }
  }
  return { records, aborted: null };
}

/** Reads what the run left behind, for the report and the live-stack handover. */
export async function endState(
  ctx: AttackContext,
  before: { intents: number; committedCents: number; roles: Roles },
): Promise<EndState> {
  const [snapshot, roles, intents] = await Promise.all([
    ctx.reader.getSnapshot(),
    ctx.reader.getRoles(),
    ctx.reader.getIntentCount(),
  ]);
  const held: number[] = [];
  for (const id of ctx.state.heldIntentIds) {
    if ((await ctx.reader.getIntent(id))?.status === "needs_approval") held.push(id);
  }
  return {
    intentsBefore: before.intents,
    intentsAfter: intents,
    committedBeforeCents: before.committedCents,
    committedAfterCents: snapshot.committedCents,
    budgetCents: snapshot.rules.budgetCents,
    paused: snapshot.rules.paused,
    rolesUnchanged: sameRoles(roles, before.roles),
    rulesUnchanged: sameRules(snapshot.rules, ctx.rules),
    heldIntentIds: held,
  };
}
