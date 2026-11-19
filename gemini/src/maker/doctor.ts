/**
 * The mirror maker's doctor (`npm run gemini:maker:doctor`). Read-only: it places nothing, cancels
 * nothing and never accepts terms, and it prints no key and no secret, only whether each is set, its
 * documented kind and its length.
 *
 * It checks the maker's settings, then both sandbox accounts (the maker's, and the executor's when its key
 * is set here): role, Prediction Markets terms, USD balance. Then the maker's account: its open orders
 * (its own and any others) and what it holds. Last, every rung in scope: production's book, the sandbox's,
 * what the maker has resting there, and what it would quote now, or why not.
 *
 * Exit status: 0 ready, 1 not ready, 2 the sandbox could not be reached.
 */
import { keyScope } from "../private-settings";
import { createGeminiPrivateClient, type GeminiCredentials, type GeminiPrivateClient } from "../private";
import { isGeminiPrivateError } from "../private-errors";
import { MirrorMaker, type MarketReader } from "./maker";
import { quoteKey } from "./mirror";
import { makerSettings, MAKER_ORDER_PREFIX, type MakerSettings } from "./settings";

export type MakerDoctorStatus = 0 | 1 | 2;

export interface MakerDoctorOptions {
  env: Record<string, string | undefined>;
  say: (line: string) => void;
  production: MarketReader;
  sandbox: MarketReader;
  /** Builds a signed sandbox client; tests pass one on a fake. */
  sandboxClient?: (credentials: GeminiCredentials) => GeminiPrivateClient;
  /** The clock the maker's view reads (expiry and staleness), in milliseconds. Default: the real clock. */
  now?: () => number;
}

function describeKey(key: string): string {
  if (key === "") return "not set";
  const scope = keyScope(key);
  return `set, ${scope === "unknown" ? "no documented prefix" : `${scope} key`}, ${String(key.length)} characters`;
}

function problemOf(error: unknown): string {
  if (isGeminiPrivateError(error)) return `${error.kind}${error.reason ? ` (${error.reason})` : ""}`;
  return error instanceof Error ? error.message : String(error);
}

function unreachable(error: unknown): boolean {
  return isGeminiPrivateError(error) && (error.outcomeUnknown || error.kind === "unavailable");
}

const cents = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : String(value);

/** Role, terms and USD of one account; the problems that make it unusable for trading. */
async function checkAccount(
  name: string,
  client: GeminiPrivateClient,
  say: (line: string) => void,
): Promise<{ problems: string[]; offline: boolean }> {
  const problems: string[] = [];
  try {
    const roles = await client.roles();
    say(
      `${name}: roles ${roles.isTrader ? "Trader" : "no Trader role"}${roles.isFundManager ? ", Fund Manager" : ""}`,
    );
    if (!roles.isTrader) problems.push(`${name} key has no Trader role`);
  } catch (error) {
    say(`${name}: the sandbox did not accept the key: ${problemOf(error)}`);
    return { problems: [`${name} key is not a working sandbox key`], offline: unreachable(error) };
  }
  try {
    const terms = await client.termsStatus();
    say(
      `${name}: Prediction Markets terms ${terms.hasAcceptedLatest ? "accepted" : "NOT accepted"} (version ${cents(terms.acceptedVersion)} of ${cents(terms.latestVersion)})`,
    );
    if (!terms.hasAcceptedLatest)
      problems.push(
        `${name} has not accepted the latest terms (the account owner accepts them on Gemini's sandbox site)`,
      );
  } catch (error) {
    say(`${name}: terms could not be read (${problemOf(error)}); orders say so if they are not accepted`);
  }
  try {
    const usd = (await client.balances()).find((balance) => balance.currency.toUpperCase() === "USD");
    say(`${name}: USD available ${usd?.available ?? usd?.amount ?? "none"}`);
    if (!usd || Number(usd.available ?? usd.amount ?? "0") <= 0)
      problems.push(`${name} has no USD available`);
  } catch (error) {
    say(`${name}: balances could not be read: ${problemOf(error)}`);
  }
  return { problems, offline: false };
}

export async function makerDoctor(options: MakerDoctorOptions): Promise<MakerDoctorStatus> {
  const { env, say } = options;
  const finish = (status: MakerDoctorStatus, verdict: string): MakerDoctorStatus => {
    say("");
    say(verdict);
    return status;
  };
  say(`GEMINI_MAKER_API_KEY:    ${describeKey(env.GEMINI_MAKER_API_KEY?.trim() ?? "")}`);
  say(`GEMINI_MAKER_API_SECRET: ${env.GEMINI_MAKER_API_SECRET?.trim() ? "set" : "not set"}`);
  say(`GEMINI_API_KEY:          ${describeKey(env.GEMINI_API_KEY?.trim() ?? "")} (the executor's account)`);
  let settings: MakerSettings;
  try {
    settings = makerSettings(env);
  } catch (error) {
    return finish(1, `NOT READY: ${error instanceof Error ? error.message : String(error)}`);
  }
  say("The maker's key and the executor's key differ.");
  say(`Scope: ${settings.kinds.join(", ")} ladders of ${settings.assets.join(", ")}`);
  const build =
    options.sandboxClient ??
    ((credentials: GeminiCredentials) => createGeminiPrivateClient({ environment: "sandbox", credentials }));
  const maker = build(settings.credentials);
  say("");
  const makerCheck = await checkAccount("maker", maker, say);
  if (makerCheck.offline) return finish(2, "UNKNOWN: the sandbox did not answer");
  const problems = [...makerCheck.problems];
  const executorKey = env.GEMINI_API_KEY?.trim() ?? "";
  const executorSecret = env.GEMINI_API_SECRET?.trim() ?? "";
  if (executorKey !== "" && executorSecret !== "") {
    const executorCheck = await checkAccount(
      "executor",
      build({ apiKey: executorKey, apiSecret: executorSecret }),
      say,
    );
    problems.push(...executorCheck.problems);
  } else {
    say("executor: key not set here (npm run gemini:doctor checks it where the executor runs)");
  }
  if (makerCheck.problems.length > 0) return finish(1, `NOT READY: ${problems.join("; ")}`);

  say("");
  const open = await maker.activeOrders();
  const ours = open.filter((order) => order.clientOrderId?.startsWith(MAKER_ORDER_PREFIX) === true);
  say(
    `maker: ${String(ours.length)} open order(s) of its own, ${String(open.length - ours.length)} other(s)`,
  );
  const view = await new MirrorMaker({
    production: options.production,
    sandbox: options.sandbox,
    account: maker,
    settings,
    say,
    ...(options.now === undefined ? {} : { now: options.now }),
  }).view();
  if (view.holdings === null) {
    problems.push("the maker account's positions could not be read, so it would quote nothing");
  } else {
    const spent = view.holdings.reduce((sum, holding) => sum + holding.costCents, 0);
    say(
      `maker: holds ${String(view.holdings.length)} position(s), $${(spent / 100).toFixed(2)} in all (cap $${(settings.limits.maxInventoryNotionalCents / 100).toFixed(2)})`,
    );
  }
  say("");
  say(
    "Rungs in scope (YES bid/ask in cents; the maker's YES bid mirrors production's YES bid, its NO bid production's YES ask):",
  );
  const wanted = new Map(view.plan.quotes.map((quote) => [quoteKey(quote.symbol, quote.outcome), quote]));
  const skipped = new Map(
    view.plan.skips.map((skip) => [
      skip.outcome ? quoteKey(skip.symbol, skip.outcome) : skip.symbol,
      skip.reason,
    ]),
  );
  for (const rung of view.rungs) {
    const p = rung.production;
    const resting = view.resting.filter((quote) => quote.symbol === rung.symbol);
    const rest =
      resting
        .map(
          (quote) =>
            `${quote.outcome.toUpperCase()} ${String(quote.priceCents)}c x${String(quote.remainingHundredths / 100)}`,
        )
        .join(", ") || "none";
    const would = (["yes", "no"] as const)
      .map((outcome) => {
        const quote = wanted.get(quoteKey(rung.symbol, outcome));
        if (quote)
          return `${outcome.toUpperCase()} ${String(quote.priceCents)}c x${String(quote.hundredths / 100)}`;
        return `${outcome.toUpperCase()} none (${skipped.get(quoteKey(rung.symbol, outcome)) ?? skipped.get(rung.symbol) ?? "-"})`;
      })
      .join(", ");
    say(
      `  ${rung.symbol}: production ${p ? `${String(p.marketState)} ${cents(p.bid?.priceCents)}/${cents(p.ask?.priceCents)}` : "not listed"}` +
        ` | sandbox ${String(rung.sandbox.marketState)} ${cents(rung.sandbox.yesBidCents)}/${cents(rung.sandbox.yesAskCents)}` +
        ` | resting: ${rest} | would quote: ${would}`,
    );
  }
  if (view.rungs.length === 0) say("  none: the sandbox lists no ladder in scope right now");
  if (problems.length > 0) return finish(1, `NOT READY: ${problems.join("; ")}`);
  return finish(0, "READY");
}
