/**
 * The Gemini doctor against the fake sandbox: what the owner sees for each kind of key, that it refuses a
 * key and a GEMINI_ENV that disagree, that it never calls production or changes anything, and that it
 * never prints the key or the secret.
 */
import { describe, expect, it } from "vitest";
import { geminiDoctor } from "../src/doctor";
import { createGeminiPrivateClient, type GeminiCredentials } from "../src/private";
import { FakeGeminiPrivate, unpacedLimiter } from "../testing/fake-private";

const SANDBOX_KEY = "account-SANDBOXKEY0000000001";
const SANDBOX_SECRET = "3vQ9sandboxSecretNeverPrinted";
const OTHER_KEY = "account-PRODUCTIONKEY000000001";
const OTHER_SECRET = "9xProductionSecretNeverPrinted";

async function run(
  env: Record<string, string | undefined>,
  setUp: (fake: FakeGeminiPrivate) => void = () => {},
) {
  const fake = new FakeGeminiPrivate({ apiKey: SANDBOX_KEY, apiSecret: SANDBOX_SECRET });
  setUp(fake);
  const hosts: string[] = [];
  const lines: string[] = [];
  const status = await geminiDoctor({
    env,
    say: (line) => lines.push(line),
    sandboxClient: (credentials: GeminiCredentials) =>
      createGeminiPrivateClient({
        environment: "sandbox",
        credentials,
        limiter: unpacedLimiter(),
        fetch: (input, init) => {
          hosts.push(new URL(input).host);
          return fake.fetch(input, init);
        },
      }),
  });
  const output = lines.join("\n");
  for (const secret of [SANDBOX_KEY, SANDBOX_SECRET, OTHER_KEY, OTHER_SECRET]) {
    expect(output).not.toContain(secret);
  }
  // Read-only, and only ever the sandbox.
  expect(new Set(hosts)).toEqual(new Set(hosts.length > 0 ? ["api.sandbox.gemini.com"] : []));
  expect(fake.requests.map((request) => request.path)).not.toContain("/v1/prediction-markets/order");
  expect(fake.requests.map((request) => request.path)).not.toContain("/v1/prediction-markets/terms/accept");
  return { status, output, verdict: lines.at(-1) ?? "", fake };
}

const sandboxEnv = { GEMINI_ENV: "sandbox", GEMINI_API_KEY: SANDBOX_KEY, GEMINI_API_SECRET: SANDBOX_SECRET };

describe("the Gemini doctor", () => {
  it("says READY for a sandbox key with the Trader role, the terms accepted and USD", async () => {
    const { status, output, verdict } = await run(sandboxEnv);
    expect(status).toBe(0);
    expect(output).toContain("GEMINI_API_KEY:    set, account key, 28 characters");
    expect(output).toContain("it is a SANDBOX key (test funds only)");
    expect(output).toContain("Roles: Trader");
    expect(output).toContain("USD available: 100000.00");
    expect(verdict).toMatch(/^READY: /);
  });

  it("refuses a key the sandbox does not know while GEMINI_ENV is sandbox, and stops there", async () => {
    const { status, output, verdict, fake } = await run({
      GEMINI_API_KEY: OTHER_KEY,
      GEMINI_API_SECRET: OTHER_SECRET,
    });
    expect(status).toBe(1);
    expect(output).toContain("GEMINI_ENV:        sandbox (the default)");
    expect(output).toContain("The sandbox does not know this key (InvalidApiKey): it is NOT a sandbox key.");
    expect(verdict).toMatch(/^REFUSED: GEMINI_ENV is sandbox, but this key is not a sandbox key\./);
    expect(fake.requests).toHaveLength(0);
  });

  it("checks nothing for production, even when GEMINI_ENV says production and the key fits", async () => {
    const { status, verdict } = await run({
      GEMINI_ENV: "production",
      GEMINI_LIVE_TRADING: "on",
      GEMINI_API_KEY: OTHER_KEY,
      GEMINI_API_SECRET: OTHER_SECRET,
    });
    expect(status).toBe(1);
    expect(verdict).toMatch(/^NOT CHECKED: .* this doctor makes no call to production\./);
  });

  it("refuses a sandbox key while GEMINI_ENV says production", async () => {
    const { status, verdict } = await run({
      ...sandboxEnv,
      GEMINI_ENV: "production",
      GEMINI_LIVE_TRADING: "on",
    });
    expect(status).toBe(1);
    expect(verdict).toMatch(/^REFUSED: GEMINI_ENV is production, but this is a sandbox key\./);
  });

  it("says when the secret is not the key's", async () => {
    const { status, verdict } = await run({ ...sandboxEnv, GEMINI_API_SECRET: OTHER_SECRET });
    expect(status).toBe(1);
    expect(verdict).toMatch(/InvalidSignature\), so GEMINI_API_SECRET is most likely not this key's secret/);
  });

  it("lists what is missing: the role, the terms, the funds", async () => {
    const { status, verdict } = await run(sandboxEnv, (fake) => {
      fake.roles = { isTrader: false, isFundManager: false, isAuditor: true };
      fake.termsAccepted = false;
      fake.balances = [];
    });
    expect(status).toBe(1);
    expect(verdict).toBe(
      "NOT READY: the key lacks the Trader role, which placing orders needs; the latest Prediction Markets " +
        "terms are not accepted: sign in at https://exchange.sandbox.gemini.com, open Prediction Markets " +
        "and accept them there; the account has no USD available to buy contracts.",
    );
  });

  it("refuses a master key and missing settings without asking anything", async () => {
    const master = await run({ ...sandboxEnv, GEMINI_API_KEY: "master-ABCDEF0123456789" });
    expect(master.status).toBe(1);
    expect(master.verdict).toMatch(/^NOT READY: this is a master key/);
    expect(master.fake.requests).toHaveLength(0);

    const missing = await run({ GEMINI_API_KEY: SANDBOX_KEY });
    expect(missing.status).toBe(1);
    expect(missing.output).toContain("GEMINI_API_SECRET: not set");
    expect(missing.verdict).toBe("NOT READY: GEMINI_API_KEY and GEMINI_API_SECRET must both be set.");

    const unknownEnv = await run({ ...sandboxEnv, GEMINI_ENV: "staging" });
    expect(unknownEnv.status).toBe(1);
    expect(unknownEnv.verdict).toMatch(/^NOT READY: GEMINI_ENV must be/);

    const liveWithoutOptIn = await run({ ...sandboxEnv, GEMINI_ENV: "production" });
    expect(liveWithoutOptIn.status).toBe(1);
    expect(liveWithoutOptIn.verdict).toMatch(/GEMINI_LIVE_TRADING/);
  });

  it("says UNKNOWN, with status 2, when the sandbox does not answer", async () => {
    const { status, verdict } = await run(sandboxEnv, (fake) => {
      fake.failing = true;
    });
    expect(status).toBe(2);
    expect(verdict).toMatch(/^UNKNOWN: the sandbox did not answer usefully/);
  });
});
