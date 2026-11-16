import { Footer, Nav, SkipLink } from "../components/Chrome";
import { APP_URL, SCORECARD_URL } from "../config";
import { Gate } from "../features/gate/Gate";
import { AgentExchange } from "../features/landing/AgentExchange";
import { DecideVignette, MandateVignette, ProposeVignette } from "../features/landing/Vignettes";

import agents from "../features/landing/agents.module.css";
import styles from "./page.module.css";

const STEPS = [
  {
    title: "Set the mandate",
    body: "Choose a budget, the largest single trade, the markets allowed, a daily loss limit, and the size above which you sign each order. Your wallet writes it to the contract.",
    picture: <MandateVignette />,
  },
  {
    title: "The agent proposes",
    body: "Your agent, such as Grok Bot, asks the Mandate MCP server to trade. It can check a trade first and cite the signals it paid for.",
    picture: <ProposeVignette />,
  },
  {
    title: "The contract decides",
    body: "The contract checks every rule, in order, and records its answer onchain: approved, held for your signature, or rejected with the reason.",
    picture: <DecideVignette />,
  },
] as const;

const PROOFS = [
  {
    title: "The rules live in the contract",
    body: "The agent's key can only propose. What goes through is decided by the contract, not by the agent's code or its prompt.",
  },
  {
    title: "Every reason is sealed",
    body: "Each proposal carries the request, the prices the agent saw, the signal it bought and its plan, kept under their hash. A rewritten reason no longer matches.",
  },
  {
    title: "One isolator",
    body: "A single pause from your wallet stops every new order. The agent cannot ask to undo it.",
  },
  {
    title: "Attacked with the agent's own key",
    body: "On 16 Nov 2026 we ran 42 attacks on a test chain, through the MCP server and straight at the contract: 35 were stopped, 7 went through but stayed inside the mandate's limits, and none broke it.",
  },
  {
    title: "A public scorecard",
    body: "Anyone can open an agent's scorecard and see every order it proposed and what the contract said.",
  },
] as const;

const TOOL_GROUPS = [
  {
    title: "Look",
    tools: ["get_policy", "get_portfolio", "get_activity", "get_intent", "list_markets", "get_ladder"],
  },
  {
    title: "Decide",
    tools: ["buy_signal", "simulate_trade", "propose_trade", "plan_hedge", "execute_plan"],
  },
  {
    title: "Ask you",
    tools: ["request_pairing", "request_policy_change"],
  },
] as const;

const OWNER_ONLY = [
  "Set or change the mandate",
  "Approve or reject a held order",
  "Pause and resume the agent",
  "Confirm which agent is paired",
  "Apply a rule change the agent asked for",
] as const;

const PARTNERS = [
  {
    name: "Arc",
    body: "The contract is built for Arc testnet. Today it runs on a local chain with Arc's chain id.",
  },
  { name: "Grok Bot", body: "Trades through the Mandate MCP server today." },
  { name: "Gemini prediction markets", body: "Live market data, read only. Order fills are simulated." },
  {
    name: "QuickNode Streams",
    body: "A stream of the contract's events is built and switches on once the contract is on Arc testnet.",
  },
  {
    name: "x402",
    body: "The agent pays $0.001 per signal in testnet USDC, through Circle Gateway on Arc testnet.",
  },
] as const;

export default function Home() {
  return (
    <>
      <SkipLink />
      <Nav />
      <main id="main" tabIndex={-1} className={styles.main}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <h1 id="hero-title" className={styles.heroTitle}>
              Your agent trades. You hold the breaker.
            </h1>
            <p className={styles.lede}>
              Mandate puts your trading rules in a contract. Every order your AI agent proposes is approved,
              held for your signature, or rejected before it can trade.
            </p>
            <div className={styles.actions}>
              <a className={styles.primary} href={APP_URL}>
                Launch app
              </a>
              <a className={styles.secondary} href={SCORECARD_URL}>
                See a live scorecard
              </a>
            </div>
            <p className={styles.note}>
              A hackathon build on test networks. Fills are simulated; no real money moves.
            </p>
          </div>
          <div className={styles.heroGate}>
            <Gate />
          </div>
        </section>

        <section id="how" className={styles.section} aria-labelledby="how-title">
          <h2 id="how-title" className={styles.sectionTitle}>
            How it works
          </h2>
          <ol className={styles.steps}>
            {STEPS.map((step, index) => (
              <li key={step.title} className={styles.step}>
                {step.picture}
                <h3 className={styles.stepTitle}>
                  <span className={`${styles.stepNumber} num`}>{index + 1}</span>
                  {step.title}
                </h3>
                <p className={styles.stepBody}>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="why" className={styles.section} aria-labelledby="why-title">
          <div className={styles.split}>
            <h2 id="why-title" className={styles.sectionTitle}>
              Why it holds
            </h2>
            <ul className={styles.proofs}>
              {PROOFS.map((proof) => (
                <li key={proof.title} className={styles.proof}>
                  <h3 className={styles.proofTitle}>{proof.title}</h3>
                  <p className={styles.proofBody}>{proof.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="agents" className={agents.band} aria-labelledby="agents-title">
          <div className={agents.inner}>
            <div className={agents.intro}>
              <h2 id="agents-title" className={styles.sectionTitle}>
                The agent acts. You keep control.
              </h2>
              <p className={agents.lede}>
                Any agent that speaks MCP can trade through Mandate. The server gives it tools to look, decide
                and ask, and none of them can sign for you.
              </p>
            </div>

            <div className={agents.columns}>
              <div className={agents.tools}>
                <h3 className={agents.columnTitle}>What the agent can call</h3>
                {TOOL_GROUPS.map((group) => (
                  <div key={group.title} className={agents.group}>
                    <p className={agents.groupTitle}>{group.title}</p>
                    <ul className={agents.toolList}>
                      {group.tools.map((tool) => (
                        <li key={tool}>
                          <code>{tool}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className={agents.owner}>
                <h3 className={agents.columnTitle}>What only your wallet can do</h3>
                <ul className={agents.ownerList}>
                  {OWNER_ONLY.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            <AgentExchange />
          </div>
        </section>

        <section className={styles.section} aria-labelledby="built-title">
          <div className={styles.split}>
            <h2 id="built-title" className={styles.sectionTitle}>
              Built with
            </h2>
            <dl className={styles.partners}>
              {PARTNERS.map((partner) => (
                <div key={partner.name} className={styles.partner}>
                  <dt className={styles.partnerName}>{partner.name}</dt>
                  <dd className={styles.partnerBody}>{partner.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <h2 id="closing-title" className={styles.closingTitle}>
            Put your agent on a circuit.
          </h2>
          <p className={styles.closingBody}>Open the console, pair your agent and sign your first mandate.</p>
          <div className={styles.actions}>
            <a className={styles.primary} href={APP_URL}>
              Launch app
            </a>
            <a className={styles.secondary} href={SCORECARD_URL}>
              See a live scorecard
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
