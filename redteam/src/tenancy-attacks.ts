/**
 * Attacks across workspaces (issue #94, docs/accounts.md "How each request is scoped"): another
 * workspace's agent through the MCP server, and another workspace's signed-in member through the
 * console's API. Both run on the self-contained target only, which has a second workspace to attack from.
 *
 * Each attack also runs positive controls (the attacker's own records, and the victim's with the victim's
 * own credentials), so a server that refused everything, or answered 404 to everything, would not pass.
 */
import { hashAgentToken } from "@mandate/shared";
import { ALICE_HOLDING_QUANTITY, type ApiResponse, type ConsoleApi } from "./console";
import { HEDGE_LADDER_TICKER } from "./fixtures";
import { field, type ToolResult } from "./mcp";
import type { Amounts, Attack, AttackContext, Intruder } from "./types";

const SELF_ONLY = "the live stack has one workspace; the self-contained run adds a second one to attack from";

const ok = (status: number) => status >= 200 && status < 300;

function codes(result: ToolResult): string[] {
  const reasons = field(result.structured, "reasons");
  const fromReasons = Array.isArray(reasons)
    ? reasons.flatMap((reason) => {
        const code = field(reason, "code");
        return typeof code === "string" ? [code] : [];
      })
    : [];
  return [...(result.errorCode === null ? [] : [result.errorCode]), ...fromReasons];
}

function outcome(result: ToolResult): string {
  const found = codes(result);
  return found.length > 0 ? found.join("+") : result.isError ? "error" : "ok";
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function needIntruder(ctx: AttackContext): Intruder {
  if (ctx.intruder === null) throw new Error("this target has no second workspace");
  return ctx.intruder;
}

function needConsole(ctx: AttackContext): ConsoleApi {
  if (ctx.consoleApi === null) throw new Error("this target has no console API");
  return ctx.consoleApi;
}

function json(response: ApiResponse): unknown {
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return null;
  }
}

export function tenancyAttacks(amounts: Amounts): Attack[] {
  return [
    {
      id: "mcp.cross-tenant",
      name: "Another workspace's agent reaches for this mandate",
      surface: "mcp",
      tried:
        "With a token another workspace's owner made in the console (no contract, no key, as a sign-up has in phase 1): whoami, the read tools, execute_plan on a plan this mandate's agent just made, propose_trade, request_policy_change, request_pairing and buy_signal. Then the owner revokes the token and it calls again.",
      expected:
        "whoami names the other agent and mandate; nothing reads this mandate's contract or records; execute_plan and propose_trade are refused (`PLAN_NOT_FOUND`, or a `..._NOT_CONFIGURED` code: the other mandate has no contract yet); no intent is proposed; this mandate's records in the console are unchanged; the revoked token gets 401 on its next call.",
      expectedVerdict: "held",
      selfOnly: SELF_ONLY,
      async run(ctx) {
        const intruder = needIntruder(ctx);
        const plan = await ctx.mcp.call("plan_hedge", {
          asset: "BTC",
          quantity: "0.01",
          floorCents: 6_200_000,
          maxCostCents: 1_000,
          eventTicker: HEDGE_LADDER_TICKER,
          requestText: `Protect 0.01 BTC down to $62,000. [red team ${ctx.runId}]`,
        });
        const planId = field(plan.structured, "plan", "planId");
        if (typeof planId !== "string") throw new Error(`plan_hedge made no plan (${outcome(plan)})`);
        const intentsBefore = await ctx.reader.getIntentCount();
        const recordsBefore = intruder.firstMandateRecords();

        const who = await intruder.mcp.call("whoami");
        const reads = [
          await intruder.mcp.call("get_policy"),
          await intruder.mcp.call("get_portfolio"),
          await intruder.mcp.call("get_activity", { limit: 5 }),
          await intruder.mcp.call("get_intent", { intentId: 0 }),
          await intruder.mcp.call("get_setup_state"),
        ];
        const execute = await intruder.mcp.call("execute_plan", {
          planId,
          reason: `Execute the plan. [red team ${ctx.runId}]`,
        });
        const propose = await intruder.mcp.call("propose_trade", {
          market: ctx.markets.crypto,
          outcome: "NO",
          amountCents: amounts.probe,
          limitPrice: 40,
          reason: `Probe. [red team ${ctx.runId}]`,
        });
        const change = await intruder.mcp.call("request_policy_change", {
          maxTradeCents: amounts.overMax,
          reason: `Loosen it. [red team ${ctx.runId}]`,
        });
        const pairing = await intruder.mcp.call("request_pairing", { agentName: "Intruder" });
        const signal = await intruder.mcp.call("buy_signal", { asset: "BTC" });

        const intentsAfter = await ctx.reader.getIntentCount();
        const recordsChanged = intruder.firstMandateRecords() !== recordsBefore;
        intruder.revoke();
        const revoked = await intruder.mcp.post({
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          auth: "token",
        });

        const agentId = field(who.structured, "agent", "id");
        const mandateId = field(who.structured, "agent", "mandateId");
        const policy = ctx.reader.address.toLowerCase();
        const answers = [who, ...reads, execute, propose, change, pairing, signal];
        const sawContract = answers.some((r) =>
          `${r.text} ${JSON.stringify(r.structured ?? null)}`.toLowerCase().includes(policy),
        );
        const executed = Number(field(execute.structured, "execution", "submitted") ?? 0) > 0;
        const breach =
          intentsAfter !== intentsBefore ||
          recordsChanged ||
          agentId !== intruder.agentId ||
          sawContract ||
          executed ||
          ok(revoked.status);
        const planRefused = codes(execute).some(
          (c) => c === "PLAN_NOT_FOUND" || c.endsWith("NOT_CONFIGURED"),
        );
        return {
          verdict: breach ? "BREACH" : "held",
          matched:
            mandateId === intruder.mandateId &&
            planRefused &&
            (propose.isError || codes(propose).some((c) => c.endsWith("NOT_CONFIGURED"))) &&
            codes(signal).includes("NOT_CONFIGURED") &&
            revoked.status === 401,
          actual: [
            `whoami: ${agentId === intruder.agentId ? "the other agent" : `AGENT ${String(agentId)}`}, ${mandateId === intruder.mandateId ? "its own mandate" : `MANDATE ${String(mandateId)}`}`,
            `this contract in any answer: ${sawContract ? "YES" : "no"}`,
            `execute_plan: ${outcome(execute)}`,
            `propose_trade: ${outcome(propose)}`,
            `request_policy_change: ${outcome(change)}`,
            `buy_signal: ${outcome(signal)}`,
            `intents created: ${String(intentsAfter - intentsBefore)}`,
            `this mandate's console records: ${recordsChanged ? "CHANGED" : "unchanged"}`,
            `after the revoke: HTTP ${String(revoked.status)}`,
          ].join("; "),
        };
      },
    },

    {
      id: "console.cross-tenant",
      name: "A member of another workspace reaches for this one through the console",
      surface: "console",
      tried:
        "Signed in to his own workspace, Bob asks the console for Alice's mandate by id (snapshot, live events, hedge quotes), lists agents, creates and revokes tokens on Alice's agent, asks for passkey challenges for a token on her agent and an owner call on her mandate, sends an owner call to her mandate on his session alone, dismisses and marks applied Alice's change request, saves holdings and confirms a pairing on her mandate, mints a token on his own agent without a passkey, and presents his own agent token where the MCP server's service token belongs. Every write carries the console's own Origin, so only the tenancy and step-up checks stand in the way.",
      expected:
        "404 for every one of Alice's ids, 422 for a token without a passkey, and the agent API refuses his token (401); Bob's own snapshot, stream and agent list carry nothing of Alice's, and no chain view, so none of the contract's venue orders, venue or settlements; Alice's token, change request and holdings are as they were, and her token still resolves to her agent.",
      expectedVerdict: "held",
      selfOnly: SELF_ONLY,
      async run(ctx) {
        const api = needConsole(ctx);
        const { alice, bob } = api;
        const marker = `red team ${ctx.runId}`;

        // Alice's side, with her own session and her agent's MCP server: the records Bob will reach for.
        // Her token was made with the console seeded, as her passkey would have confirmed it.
        const token = api.agentToken("alice");
        const tokenId = alice.tokenId;
        const filed = await api.asServer(alice.agentId, "POST", "/api/agent/v1/policy-change-requests", {
          agentAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          proposed: { maxTradeCents: 3_000 },
          reason: `Alice's private reason. [${marker}]`,
        });
        const requestId = field(json(filed), "id");
        if (filed.status !== 201 || typeof requestId !== "string") {
          throw new Error(`Alice's agent could not file a change request (HTTP ${String(filed.status)})`);
        }
        const bobAgentToken = api.agentToken("bob");

        const resolve = async (agentToken: string) =>
          field(
            json(
              await api.asServer(null, "POST", "/api/agent/v1/auth/resolve", {
                tokenHash: hashAgentToken(agentToken),
                legacy: false,
              }),
            ),
            "agentId",
          );
        const aliceState = async () => {
          const snapshot = await api.as("alice", "GET", "/api/console/snapshot");
          const agents = await api.as("alice", "GET", "/api/console/agents");
          return {
            holdings: JSON.stringify(field(json(snapshot), "offchain", "holdings")),
            request: (
              (field(json(snapshot), "offchain", "changeRequests") ?? []) as { id: string; status: string }[]
            ).find((r) => r.id === requestId)?.status,
            // Which tokens she has and whether each is revoked; when one was last used moves with every lookup.
            tokens: JSON.stringify(
              (
                (field(json(agents), "agents") ?? []) as {
                  id: string;
                  tokens: { id: string; name: string; revokedAt: string | null }[];
                }[]
              )
                .find((a) => a.id === alice.agentId)
                ?.tokens.map((t) => [t.id, t.name, t.revokedAt]),
            ),
            resolvesTo: await resolve(token),
          };
        };
        const before = await aliceState();

        // Bob's attempts.
        const foreign = `?mandate=${alice.mandateId}`;
        const attempts: [string, ApiResponse, number][] = [
          ["snapshot of her mandate", await api.as("bob", "GET", `/api/console/snapshot${foreign}`), 404],
          ["her live events", await api.firstEvent("bob", `/api/console/events${foreign}`), 404],
          [
            "hedge quotes for her mandate",
            await api.as("bob", "GET", `/api/console/hedge/market${foreign}&asset=BTC`),
            404,
          ],
          [
            "a token on her agent",
            await api.as("bob", "POST", `/api/console/agents/${alice.agentId}/tokens`, { name: "mine now" }),
            404,
          ],
          [
            "a passkey challenge for a token on her agent",
            await api.as("bob", "POST", "/api/console/step-up", {
              action: { kind: "create-token", agentId: alice.agentId, name: "mine now" },
            }),
            404,
          ],
          [
            "a passkey challenge for an owner call on her mandate",
            await api.as("bob", "POST", "/api/console/step-up", {
              action: {
                kind: "owner-call",
                mandateId: alice.mandateId,
                call: { functionName: "approveIntent", intentId: 0 },
              },
            }),
            404,
          ],
          [
            "an owner call on her mandate, on his session alone",
            await api.as("bob", "POST", `/api/console/owner-calls${foreign}`, {
              call: { functionName: "setPaused", paused: true },
              stepUp: null,
            }),
            404,
          ],
          // A session alone (a stolen one, say) never mints a credential, even on its own agent.
          [
            "a token on his own agent, with his session and no passkey",
            await api.as("bob", "POST", `/api/console/agents/${bob.agentId}/tokens`, {
              name: "No passkey",
              stepUp: null,
            }),
            422,
          ],
          [
            "revoke her token",
            await api.as("bob", "DELETE", `/api/console/agents/${alice.agentId}/tokens/${tokenId}`),
            404,
          ],
          [
            "dismiss her change request on her mandate",
            await api.as("bob", "POST", `/api/console/change-requests/${requestId}/dismiss${foreign}`, {}),
            404,
          ],
          [
            "mark her change request applied on her mandate",
            await api.as("bob", "POST", `/api/console/change-requests/${requestId}/applied${foreign}`, {}),
            404,
          ],
          // From his own mandate the request is not his to find; the body is refused first, so any refusal.
          [
            "dismiss her change request from his mandate",
            await api.as("bob", "POST", `/api/console/change-requests/${requestId}/dismiss`, {}),
            0,
          ],
          [
            "mark her change request applied from his mandate",
            await api.as("bob", "POST", `/api/console/change-requests/${requestId}/applied`, {}),
            0,
          ],
          [
            "save holdings on her mandate",
            await api.as("bob", "PUT", `/api/console/holdings${foreign}`, {
              payload: { holdings: [{ asset: "BTC", quantity: "9" }] },
            }),
            404,
          ],
          [
            "confirm a pairing on her mandate",
            await api.as("bob", "POST", `/api/console/pairing/confirm${foreign}`, {}),
            404,
          ],
          [
            "his agent token on the agent API, naming her agent",
            await api.withBearer(bobAgentToken, "GET", "/api/agent/v1/holdings", {
              "x-mandate-agent": alice.agentId,
            }),
            401,
          ],
        ];

        // What Bob's own views carry: his mandate, nothing of Alice's.
        const own = [
          await api.as("bob", "GET", "/api/console/snapshot"),
          await api.firstEvent("bob", "/api/console/events"),
          await api.as("bob", "GET", "/api/console/agents"),
        ];
        const aliceMarks = [alice.mandateId, alice.workspaceId, ALICE_HOLDING_QUANTITY, marker, tokenId];
        const leaked = [...own, ...attempts.map(([, response]) => response)].flatMap((response) =>
          aliceMarks.filter((mark) => response.text.includes(mark)),
        );
        const secrets = [...own, ...attempts.map(([, r]) => r)].some((r) => api.leaks(r.text));
        // The executor's records belong to the contract only Alice's mandate follows.
        const executorRecords = own.some((r) => /"venueOrders"|"clientOrderId"|"settlements"/.test(r.text));
        const bobHasNoChain = field(json(own[0] ?? { status: 0, text: "" }), "chain") === null;
        const bobResolvesTo = await resolve(bobAgentToken);
        const after = await aliceState();
        const changed = JSON.stringify(after) !== JSON.stringify(before);

        const accepted = attempts.filter(([, response]) => ok(response.status));
        const ownViews = own.every((response) => response.status === 200);
        const controls =
          before.request === "pending" &&
          before.resolvesTo === alice.agentId &&
          before.holdings.includes(ALICE_HOLDING_QUANTITY) &&
          bobResolvesTo === bob.agentId &&
          bobHasNoChain &&
          ownViews;
        const exact = attempts.every(([, response, want]) => want === 0 || response.status === want);
        return {
          verdict:
            accepted.length > 0 ||
            leaked.length > 0 ||
            secrets ||
            executorRecords ||
            changed ||
            bobResolvesTo === alice.agentId
              ? "BREACH"
              : "held",
          matched: controls && exact,
          actual: [
            attempts.map(([label, response]) => `${label}: ${String(response.status)}`).join("; "),
            `his own snapshot, stream and agents: ${own.map((r) => String(r.status)).join("/")}, with ${leaked.length === 0 ? "nothing" : `${String(leaked.length)} MARKS`} of hers`,
            `his token resolves to ${bobResolvesTo === bob.agentId ? "his agent" : `AGENT ${String(bobResolvesTo)}`}`,
            `his chain view: ${bobHasNoChain ? "none" : "PRESENT"}; the contract's venue orders, venue or settlements in his views: ${executorRecords ? "YES" : "no"}`,
            `her token, request and holdings: ${changed ? "CHANGED" : "unchanged"} (request ${String(after.request)}, token resolves to ${after.resolvesTo === alice.agentId ? "her agent" : String(after.resolvesTo)})`,
          ].join("; "),
        };
      },
    },

    {
      id: "console.step-up",
      name: "A stolen session, without the member's passkey, mints a credential",
      surface: "console",
      tried:
        "With Bob's session and no passkey, as a thief who copied his cookie would have, the attacker asks for a real passkey challenge for a token on Bob's own agent, then answers it with a forged assertion for Bob's credential, replays the same challenge, spends a second challenge on a token of another name, presents Bob's challenge from Alice's session, and invents a challenge id. Every write carries the console's own Origin.",
      expected:
        "The challenge is issued (201), and every answer is refused: 401 step_up_refused for the forged assertion, the other name and the other workspace, 401 step_up_expired for the replay and the made-up id. No token is added to either agent.",
      expectedVerdict: "held",
      selfOnly: SELF_ONLY,
      async run(ctx) {
        const api = needConsole(ctx);
        const { alice, bob } = api;
        const tokens = async (who: "alice" | "bob", agentId: string) => {
          const agents = (field(json(await api.as(who, "GET", "/api/console/agents")), "agents") ?? []) as {
            id: string;
            tokens: { id: string }[];
          }[];
          return agents.find((a) => a.id === agentId)?.tokens.length ?? -1;
        };
        const before = { bob: await tokens("bob", bob.agentId), alice: await tokens("alice", alice.agentId) };

        const challenge = async (name: string) => {
          const response = await api.as("bob", "POST", "/api/console/step-up", {
            action: { kind: "create-token", agentId: bob.agentId, name },
          });
          const id = field(json(response), "id");
          const options = field(json(response), "options");
          return {
            response,
            id: typeof id === "string" ? id : "",
            challenge: text(field(options, "challenge")),
            credentialId: text(
              (field(options, "allowCredentials") as { id?: unknown }[] | undefined)?.[0]?.id,
            ),
          };
        };
        // A well-formed assertion for Bob's credential and this challenge, signed by nobody.
        const forged = (c: { challenge: string; credentialId: string }) => {
          const b64 = (bytes: Buffer) => bytes.toString("base64url");
          const authenticatorData = Buffer.alloc(37);
          authenticatorData[32] = 0x05; // user present and verified
          return {
            id: c.credentialId,
            rawId: c.credentialId,
            type: "public-key",
            clientExtensionResults: {},
            response: {
              clientDataJSON: b64(
                Buffer.from(
                  JSON.stringify({
                    type: "webauthn.get",
                    challenge: c.challenge,
                    origin: new URL(api.base).origin,
                  }),
                ),
              ),
              authenticatorData: b64(authenticatorData),
              signature: b64(Buffer.alloc(72, 1)),
            },
          };
        };
        const mint = (who: "alice" | "bob", agentId: string, name: string, stepUp: unknown) =>
          api.as(who, "POST", `/api/console/agents/${agentId}/tokens`, { name, stepUp });

        const first = await challenge("Stolen");
        const second = await challenge("Stolen");
        const third = await challenge("Stolen");
        const attempts: [string, ApiResponse, number, string][] = [
          [
            "a forged assertion for his own credential",
            await mint("bob", bob.agentId, "Stolen", { id: first.id, response: forged(first) }),
            401,
            "step_up_refused",
          ],
          [
            "the same challenge again",
            await mint("bob", bob.agentId, "Stolen", { id: first.id, response: forged(first) }),
            401,
            "step_up_expired",
          ],
          [
            "a challenge for one name, spent on another",
            await mint("bob", bob.agentId, "Other name", { id: second.id, response: forged(second) }),
            401,
            "step_up_refused",
          ],
          [
            "his challenge, from Alice's session on her agent",
            await mint("alice", alice.agentId, "Stolen", { id: third.id, response: forged(third) }),
            401,
            "step_up_refused",
          ],
          [
            "a made-up challenge id",
            await mint("bob", bob.agentId, "Stolen", { id: "made-up", response: forged(first) }),
            401,
            "step_up_expired",
          ],
        ];
        const after = { bob: await tokens("bob", bob.agentId), alice: await tokens("alice", alice.agentId) };

        const codeOf = (response: ApiResponse) => text(field(json(response), "error", "code"));
        const accepted = attempts.filter(([, response]) => ok(response.status));
        const minted = after.bob !== before.bob || after.alice !== before.alice;
        const issued = [first, second, third].every(
          (c) => c.response.status === 201 && c.id !== "" && c.challenge !== "" && c.credentialId !== "",
        );
        const exact = attempts.every(
          ([, response, status, code]) => response.status === status && codeOf(response) === code,
        );
        return {
          verdict: accepted.length > 0 || minted ? "BREACH" : "held",
          matched: issued && before.bob > 0 && before.alice > 0 && exact,
          actual: [
            `challenges issued: ${[first, second, third].map((c) => String(c.response.status)).join("/")}`,
            attempts
              .map(([label, response]) => `${label}: ${String(response.status)} ${codeOf(response)}`)
              .join("; "),
            `tokens: Bob ${String(before.bob)} -> ${String(after.bob)}, Alice ${String(before.alice)} -> ${String(after.alice)}`,
          ].join("; "),
        };
      },
    },
  ];
}
