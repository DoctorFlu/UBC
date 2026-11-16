"use client";

import { Plus, Power, RefreshCw, Settings, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { MarketName, OrderSummary } from "@/components/domain/Intent";
import { ArrowLink } from "@/components/ui/ArrowLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Input, Select } from "@/components/ui/Field";
import { HexValue } from "@/components/ui/HexValue";
import { HoldButton } from "@/components/ui/HoldButton";
import { LimitMeter } from "@/components/ui/LimitMeter";
import { LiveIndicator } from "@/components/ui/LiveIndicator";
import { Money, Percent } from "@/components/ui/Money";
import { PageHeader } from "@/components/ui/PageHeader";
import { Stat, StatGroup } from "@/components/ui/Stat";
import { EmptyState, ErrorState, Skeleton, SkeletonText } from "@/components/ui/States";
import { StatusChip } from "@/components/ui/StatusChip";
import { type Column, Table } from "@/components/ui/Table";
import { Tabs } from "@/components/ui/Tabs";
import { type ToastTone, useToast } from "@/components/ui/Toast";
import { Toggle } from "@/components/ui/Toggle";
import type { IntentView } from "@mandate/shared";
import { formatContractPrice, formatPercentBps, formatUsdCents, formatUsdCentsDelta } from "@/lib/format";
import { AGENT_ADDRESS, fixtureSnapshot } from "@/fixtures";

import styles from "./gallery.module.css";

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <h2 id={id} className={styles.sectionTitle}>
          {title}
        </h2>
        {note ? <p className={styles.sectionNote}>{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.specimen}>
      <span className={styles.specimenLabel}>{label}</span>
      <div className={styles.specimenBody}>{children}</div>
    </div>
  );
}

const swatches = [
  ["Ground", "--color-ground"],
  ["Panel", "--color-panel"],
  ["Surface", "--color-surface"],
  ["Sunken", "--color-surface-sunken"],
  ["Ink", "--color-ink"],
  ["Rule", "--color-rule-strong"],
  ["Approved", "--color-approved-lamp"],
  ["Held", "--color-held-lamp"],
  ["Rejected", "--color-rejected-lamp"],
  ["Executed", "--color-filled-lamp"],
  ["Failed", "--color-unfilled-lamp"],
  ["Paused", "--color-paused-marker"],
] as const;

const typeScale = [
  ["3xl", "--text-3xl"],
  ["2xl", "--text-2xl"],
  ["xl", "--text-xl"],
  ["lg", "--text-lg"],
  ["md", "--text-md"],
  ["base", "--text-base"],
  ["sm", "--text-sm"],
  ["xs", "--text-xs"],
] as const;

const exampleIntents: readonly IntentView[] = [...(fixtureSnapshot.chain?.intents ?? [])]
  .reverse()
  .slice(0, 3);

const tableColumns: readonly Column<IntentView>[] = [
  {
    key: "market",
    header: "Market",
    cell: (intent) => <MarketName symbol={intent.market} category={intent.category} />,
    role: "primary",
  },
  { key: "order", header: "Order", cell: (intent) => <OrderSummary intent={intent} />, nowrap: true },
  {
    key: "amount",
    header: "Amount",
    cell: (intent) => (intent.amountCents === null ? "Unknown" : <Money cents={intent.amountCents} />),
    align: "end",
  },
  {
    key: "verdict",
    header: "Verdict",
    cell: (intent) => <StatusChip status={intent.status} reason={intent.reason} />,
  },
];

const toastTones: readonly ToastTone[] = ["neutral", "success", "held", "danger", "info"];

export function GalleryView() {
  const toast = useToast();
  const [dialog, setDialog] = useState<"dialog" | "sheet" | "drawer" | null>(null);
  const [toggle, setToggle] = useState(true);
  const [amount, setAmount] = useState("50");
  const [category, setCategory] = useState<"crypto" | "macro">("crypto");
  const amountInvalid = !/^\d+(\.\d{1,2})?$/.test(amount);

  return (
    <div className={styles.gallery}>
      <PageHeader
        title="Components"
        description="Every primitive the console is built from, with its variants and states. Views compose these; they do not restyle them."
        meta={<span>Source: src/components/ui</span>}
      />

      <nav className={styles.toc} aria-label="Sections">
        {["Tokens", "Buttons", "Status", "Values", "Figures", "Forms", "Structure", "States", "Overlays"].map(
          (name) => (
            <a key={name} href={`#${name.toLowerCase()}`}>
              {name}
            </a>
          ),
        )}
      </nav>

      <Section
        id="tokens"
        title="Tokens"
        note="Semantic color tokens and the type scale. Both themes are defined in styles/tokens.css."
      >
        <div className={styles.swatches}>
          {swatches.map(([name, token]) => (
            <div key={token} className={styles.swatch}>
              <span className={styles.chip} style={{ background: `var(${token})` }} />
              <span className={styles.swatchName}>{name}</span>
              <code className={styles.swatchToken}>{token}</code>
            </div>
          ))}
        </div>
        <div className={styles.typeScale}>
          {typeScale.map(([name, token]) => (
            <div key={token} className={styles.typeRow}>
              <code className={styles.swatchToken}>{name}</code>
              <span style={{ fontSize: `var(${token})` }}>Hold $28.80 for your signature</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="buttons"
        title="Buttons"
        note="Hold-to-confirm guards destructive and signing actions: hold it, or press it twice."
      >
        <Specimen label="Variants">
          <Button variant="primary" icon={<Plus aria-hidden />}>
            Primary
          </Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={<Trash2 aria-hidden />}>
            Danger
          </Button>
          <Button variant="dangerOutline">Danger outline</Button>
        </Specimen>
        <Specimen label="Sizes and states">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button iconOnly aria-label="Settings" icon={<Settings aria-hidden />} />
        </Specimen>
        <Specimen label="Hold to confirm">
          <HoldButton
            tone="danger"
            icon={<Power aria-hidden />}
            armedLabel="Confirm pause"
            showHint
            onConfirm={() => toast({ title: "Agent paused", tone: "danger" })}
          >
            Pause agent
          </HoldButton>
          <HoldButton
            tone="ink"
            showHint
            confirmedLabel="Approved"
            armedLabel="Confirm approval"
            onConfirm={() => toast({ title: "Approved", tone: "success" })}
          >
            Approve
          </HoldButton>
          <HoldButton tone="neutral" disabled onConfirm={() => undefined}>
            Disabled
          </HoldButton>
        </Specimen>
        <Specimen label="Link">
          <ArrowLink href="/activity">All activity</ArrowLink>
        </Specimen>
      </Section>

      <Section
        id="status"
        title="Status"
        note="Every verdict and fill state. Rejections carry the contract's reason code."
      >
        <Specimen label="Status chips">
          <StatusChip status="none" />
          <StatusChip status="approved" />
          <StatusChip status="needs_approval" />
          <StatusChip status="rejected" reason="over max trade size" />
          <StatusChip status="executed" />
          <StatusChip status="failed" />
          <StatusChip status="paused" />
        </Specimen>
        <Specimen label="Live connection">
          <LiveIndicator
            source="stream"
            health="live"
            detail="Receiving Policy events from the QuickNode Stream."
            lastEventAt="2026-11-15T14:05:40.000Z"
          />
          <LiveIndicator
            source="rpc"
            health="lagging"
            detail="The RPC poller is behind the chain head."
            lastEventAt="2026-11-15T14:05:40.000Z"
          />
          <LiveIndicator source="rpc" health="offline" detail="The chain can't be reached." />
          <LiveIndicator source="rpc" health="disconnected" detail="Reconnecting to the console." />
          <LiveIndicator source="stream" health="live" detail="Live." compact />
        </Specimen>
      </Section>

      <Section
        id="values"
        title="Values"
        note="Money enters as integer cents and leaves as an exact string, with tabular figures."
      >
        <Specimen label="Money">
          <Money cents={123_456} />
          <Money cents={-350} />
          <Money cents={1_250} sign="always" />
          <Money cents={5_000} trimWholeCents />
        </Specimen>
        <Specimen label="Percent and price">
          <Percent bps={4_125} />
          <Percent bps={-250} sign="always" />
          <span className="num">{formatContractPrice(37)}</span>
        </Specimen>
        <Specimen label="Formatter output">
          <code className={styles.code}>
            {[formatUsdCents(100_000), formatUsdCentsDelta(-1_820), formatPercentBps(9_999)].join("   ")}
          </code>
        </Specimen>
        <Specimen label="Address and transaction">
          <HexValue label="Agent" value={AGENT_ADDRESS} kind="address" />
          <HexValue value="0x25a8148bde19be4fcdc3fc46a5a33722c7a0407ca2a5a1df621d1b851422f3ec" kind="tx" />
          <span className={styles.inline}>
            Copy any text <CopyButton value="7Q4-K2M" what="pairing code" />
          </span>
        </Specimen>
      </Section>

      <Section
        id="figures"
        title="Figures"
        note="Stats with a labelled delta, and limits drawn as rated circuits."
      >
        <Card>
          <StatGroup>
            <Stat
              label="Spent today"
              value={<Money cents={41_250} />}
              delta={{ value: "+$28.80", direction: "up", sentiment: "neutral", period: "since 14:00" }}
            />
            <Stat
              label="Lost today"
              value={<Money cents={1_820} />}
              delta={{ value: "+$4.10", direction: "up", sentiment: "bad" }}
            />
            <Stat label="Blocked" value="2" delta={{ value: "0", direction: "flat", sentiment: "neutral" }} />
            <Stat
              label="Hedge result"
              value={<Money cents={21_010} sign="always" />}
              delta={{ value: "+$160.10", direction: "up", sentiment: "good" }}
            />
          </StatGroup>
        </Card>
        <div className={styles.meters}>
          <LimitMeter label="Under 80%" usedCents={41_250} limitCents={100_000} />
          <LimitMeter label="Near the limit" usedCents={4_300} limitCents={5_000} usedWord="of the limit" />
          <LimitMeter label="At the limit" usedCents={5_000} limitCents={5_000} usedWord="of the limit" />
        </div>
      </Section>

      <Section id="forms" title="Forms">
        <div className={styles.formGrid}>
          <Field
            label="Max order size"
            hint="Larger intents are rejected."
            error={amountInvalid ? "Enter a dollar amount, like 50 or 50.25." : undefined}
          >
            <Input prefix="$" suffix="USDC" inputMode="decimal" value={amount} onValueChange={setAmount} />
          </Field>
          <Field label="Market category" optional>
            <Select
              options={[
                { value: "crypto", label: "Crypto" },
                { value: "macro", label: "Macro" },
              ]}
              value={category}
              onChange={setCategory}
            />
          </Field>
          <Field label="Disabled">
            <Input value="Locked while paused" disabled readOnly />
          </Field>
          <div className={styles.toggles}>
            <Toggle
              label="Crypto markets"
              description="Allow intents on crypto markets."
              checked={toggle}
              onChange={setToggle}
            />
            <Toggle label="Disabled switch" checked={false} onChange={() => undefined} disabled />
          </div>
        </div>
      </Section>

      <Section id="structure" title="Structure">
        <Card
          title="Card title"
          description="A card groups one job. Its header can carry an action."
          actions={<ArrowLink href="/mandate">Mandate</ArrowLink>}
          footer={<span>Footer for totals or a timestamp</span>}
        >
          <SkeletonText lines={2} />
        </Card>
        <div className={styles.twoUp}>
          <Card title="Sunken" tone="sunken">
            For secondary panels.
          </Card>
          <Card title="Attention" tone="attention">
            For something waiting on the owner.
          </Card>
        </div>
        <Card padding="flush">
          <Tabs
            inset
            label="Example tabs"
            tabs={[
              {
                id: "table",
                label: "Table",
                count: 3,
                content: (
                  <Table
                    caption="Example intents"
                    captionHidden
                    columns={tableColumns}
                    rows={exampleIntents}
                    rowKey={(intent) => intent.id.toString()}
                    rowTone={(intent) =>
                      intent.status === "needs_approval"
                        ? "attention"
                        : intent.status === "rejected"
                          ? "muted"
                          : undefined
                    }
                  />
                ),
              },
              {
                id: "empty",
                label: "Empty table",
                content: (
                  <Table
                    caption="Empty"
                    captionHidden
                    columns={tableColumns}
                    rows={[]}
                    rowKey={(intent) => intent.id.toString()}
                    empty={
                      <EmptyState plain title="No intents yet">
                        Rows appear here as they land.
                      </EmptyState>
                    }
                  />
                ),
              },
            ]}
          />
        </Card>
      </Section>

      <Section
        id="states"
        title="States"
        note="Every view also renders these with ?state=loading, ?state=empty or ?state=error."
      >
        <div className={styles.twoUp}>
          <Card>
            <EmptyState title="Nothing waiting" action={<Button variant="secondary">Open activity</Button>}>
              Say what will appear here and how to make it happen.
            </EmptyState>
          </Card>
          <ErrorState
            title="Activity did not load"
            detail="fetch failed: ECONNREFUSED 127.0.0.1:8787"
            action={
              <Button variant="secondary" icon={<RefreshCw aria-hidden />}>
                Try again
              </Button>
            }
          >
            Say what went wrong and how to fix it.
          </ErrorState>
        </div>
        <Card title="Skeleton">
          <div className={styles.skeletons}>
            <Skeleton width="40%" height="1.5rem" />
            <SkeletonText lines={3} />
          </div>
        </Card>
      </Section>

      <Section
        id="overlays"
        title="Overlays"
        note="Modal dialogs: focus is trapped, Escape closes, and focus returns to the trigger."
      >
        <Specimen label="Dialog, sheet, drawer">
          <Button onClick={() => setDialog("dialog")}>Open dialog</Button>
          <Button onClick={() => setDialog("sheet")}>Open sheet</Button>
          <Button onClick={() => setDialog("drawer")}>Open drawer</Button>
        </Specimen>
        <Specimen label="Toasts">
          {toastTones.map((tone) => (
            <Button
              key={tone}
              size="sm"
              onClick={() =>
                toast({ title: `A ${tone} toast`, description: "It says what happened, in one line.", tone })
              }
            >
              {tone[0]?.toUpperCase()}
              {tone.slice(1)}
            </Button>
          ))}
        </Specimen>
      </Section>

      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        variant={dialog ?? "dialog"}
        title={dialog === "drawer" ? "Drawer" : dialog === "sheet" ? "Sheet" : "Dialog"}
        description="Overlays hold one decision or one panel of detail."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setDialog(null)}>
              Done
            </Button>
          </>
        }
      >
        <p>Close with Escape, the buttons, or a press outside the panel.</p>
      </Dialog>
    </div>
  );
}
