// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeAll, expect, test } from "vitest";

import { Gate } from "./Gate";

beforeAll(() => {
  HTMLElement.prototype.showPopover = function () {};
  HTMLElement.prototype.hidePopover = function () {};
  Element.prototype.getAnimations = () => [];
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.checkVisibility = () => true;
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList;
  document.elementFromPoint = () => null;
  document.elementsFromPoint = () => [];
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

const agent = createAgent();

const verdict = () => within(screen.getByTestId("verdict"));
const ruleState = (rule: string) =>
  screen.getByTestId("schedule").querySelector(`[data-rule="${rule}"]`)?.getAttribute("data-state");

test("an agent can find every control of the gate by name", () => {
  render(<Gate />);
  const components = agent.snapshot().filter((entry) => !entry.offPage && entry.component !== "more");
  for (const entry of components) {
    expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  }
  const labels = components.map((entry) => entry.label);
  for (const label of ["Trade size", "Exact amount", "Market", "Pause agent"]) {
    expect(labels, `${label} is missing from the snapshot`).toContain(label);
  }
});

test("the verdict follows the controls through the shared rule check", async () => {
  render(<Gate />);
  expect(verdict().getByText("Approved")).toBeTruthy();

  const held = await agent.act({ steps: [{ ref: "Trade size", action: "setValue", args: [22] }] });
  expect(held.ok, held.error?.message).toBe(true);
  expect(verdict().getByText("Held for your signature")).toBeTruthy();
  expect(ruleState("approval")).toBe("held");

  const over = await agent.act({ steps: [{ ref: "Exact amount", action: "setValue", args: [30] }] });
  expect(over.ok, over.error?.message).toBe(true);
  expect(verdict().getByText("Rejected")).toBeTruthy();
  expect(verdict().getByText("over max trade size")).toBeTruthy();
  expect(ruleState("maxTrade")).toBe("tripped");
  expect(ruleState("markets")).toBe("idle");

  const sports = await agent.act({
    steps: [
      { ref: "Trade size", action: "setValue", args: [10] },
      { ref: "Market", action: "setValue", args: ["Sports"] },
    ],
  });
  expect(sports.ok, sports.error?.message).toBe(true);
  expect(verdict().getByText("category not allowed")).toBeTruthy();

  await act(async () => {
    const paused = await agent.act({ steps: [{ ref: "Pause agent", action: "toggle" }] });
    expect(paused.ok, paused.error?.message).toBe(true);
  });
  expect(verdict().getByText("agent paused")).toBeTruthy();
  expect(ruleState("paused")).toBe("tripped");
  expect(ruleState("dailyLoss")).toBe("idle");
});

test("announces the verdict and its reason once, politely", async () => {
  render(<Gate />);
  const live = document.querySelector('[aria-live="polite"]');
  expect(live?.textContent).toBe("Approved.");
  await agent.act({ steps: [{ ref: "Trade size", action: "setValue", args: [40] }] });
  expect(live?.textContent).toBe("Rejected: over max trade size.");
});
