import type { LookupAddress } from "node:dns";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryWakeStore, WakeNotifier, WakeRefused, WakeTarget } from "../src";
import {
  WEBHOOK_REFUSALS,
  checkWebhookUrl,
  guardedWakeFetch,
  isBlockedAddress,
  normalizeAllowedHost,
  resolveWebhookAddress,
  vetWebhookUrl,
  type WebhookPolicy,
  type WebhookResolver,
} from "../src/node";

const HOST = "hooks.example.test";
const POLICY: WebhookPolicy = { hosts: [HOST], allowLocal: false };

/** A resolver that answers `addresses` for every name, and counts the lookups. */
function answers(...addresses: string[]): WebhookResolver & { calls: () => number } {
  let calls = 0;
  const resolve: WebhookResolver = () => {
    calls += 1;
    return Promise.resolve(
      addresses.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 })),
    );
  };
  return Object.assign(resolve, { calls: () => calls });
}

describe("checkWebhookUrl", () => {
  const refusal = (url: string, policy: WebhookPolicy = POLICY) => {
    const checked = checkWebhookUrl(url, policy);
    return checked.ok ? null : checked.reason;
  };

  it("takes an https address on an allowed host, and gives the host the console shows", () => {
    expect(checkWebhookUrl(`https://${HOST}/routines/r1/run?x=1`, POLICY)).toMatchObject({
      ok: true,
      checked: { host: HOST },
    });
    // The default port is the same host.
    expect(refusal(`https://${HOST}:443/run`)).toBeNull();
    // Case and the WHATWG parser's other normalizations do not matter.
    expect(refusal(`HTTPS://Hooks.Example.TEST/run`)).toBeNull();
  });

  it("refuses what is not an https URL", () => {
    expect(refusal("not a url")).toBe("not_a_url");
    expect(refusal("")).toBe("not_a_url");
    expect(refusal(`https://${HOST}/${"a".repeat(2100)}`)).toBe("not_a_url");
    expect(refusal(`http://${HOST}/run`)).toBe("not_https");
    expect(refusal(`ftp://${HOST}/run`)).toBe("not_https");
    expect(refusal(`file:///etc/passwd`)).toBe("not_https");
  });

  it("refuses credentials in the address", () => {
    expect(refusal(`https://user:pass@${HOST}/run`)).toBe("credentials");
    expect(refusal(`https://user@${HOST}/run`)).toBe("credentials");
  });

  it("compares the host exactly: no suffix, wildcard, trailing dot or other port", () => {
    for (const url of [
      `https://evil.${HOST}/run`,
      `https://${HOST}.evil.example/run`,
      `https://${HOST}./run`,
      `https://${HOST}:8443/run`,
      `https://xhooks.example.test/run`,
      "https://169.254.169.254/latest/meta-data",
      "https://127.0.0.1/run",
      "https://[::1]/run",
    ]) {
      expect(refusal(url), url).toBe("host_not_allowed");
    }
    // A wildcard entry is not a pattern: it never matches anything.
    expect(refusal(`https://a.${HOST}/run`, { hosts: [`*.${HOST}`], allowLocal: false })).toBe(
      "host_not_allowed",
    );
    // A port is allowed when the list names it, and only that port.
    const ported: WebhookPolicy = { hosts: [`${HOST}:8443`], allowLocal: false };
    expect(refusal(`https://${HOST}:8443/run`, ported)).toBeNull();
    expect(refusal(`https://${HOST}/run`, ported)).toBe("host_not_allowed");
  });

  it("compares on the punycode form", () => {
    const policy: WebhookPolicy = { hosts: ["bücher.example"], allowLocal: false };
    expect(refusal("https://xn--bcher-kva.example/run", policy)).toBeNull();
    expect(refusal("https://bücher.example/run", policy)).toBeNull();
    expect(normalizeAllowedHost("bücher.example")).toBe("xn--bcher-kva.example");
  });

  it("allows nothing when the list is empty, and ignores entries that are not bare hosts", () => {
    expect(refusal(`https://${HOST}/run`, { hosts: [], allowLocal: false })).toBe("host_not_allowed");
    for (const entry of ["", " ", `https://${HOST}`, `${HOST}/path`, `user@${HOST}`, `${HOST}?q`]) {
      expect(normalizeAllowedHost(entry), entry).toBeNull();
    }
  });

  it("with the test switch, takes plain http to a listed host and port only", () => {
    const local: WebhookPolicy = { hosts: ["127.0.0.1:4100"], allowLocal: true };
    expect(refusal("http://127.0.0.1:4100/hook", local)).toBeNull();
    expect(refusal("http://127.0.0.1:4101/hook", local)).toBe("host_not_allowed");
    expect(refusal("http://127.0.0.1/hook", local)).toBe("host_not_allowed");
    expect(refusal("http://10.0.0.1:4100/hook", local)).toBe("host_not_allowed");
  });

  it("never quotes the address in a reason", () => {
    for (const reason of Object.values(WEBHOOK_REFUSALS)) {
      expect(reason).not.toMatch(/https?:|example|secret/);
    }
  });
});

describe("isBlockedAddress", () => {
  it("blocks private, loopback, link-local, metadata and other special ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.170",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::1",
      "fc00::1",
      "fd00:ec2::254",
      "fe80::1",
      "ff02::1",
      "not an address",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("lets public addresses through", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe("resolveWebhookAddress", () => {
  const url = new URL(`https://${HOST}/run`);

  it("takes a name whose every address is public, and picks the first", async () => {
    await expect(resolveWebhookAddress(url, POLICY, answers("1.1.1.1", "2606:4700::1111"))).resolves.toEqual({
      ok: true,
      address: { address: "1.1.1.1", family: 4 },
    });
  });

  it("refuses a name that resolves to a private address, even next to a public one", async () => {
    for (const set of [
      ["10.0.0.5"],
      ["127.0.0.1"],
      ["169.254.169.254"],
      ["::1"],
      ["fd00:ec2::254"],
      ["::ffff:127.0.0.1"],
      ["1.1.1.1", "192.168.0.10"],
    ]) {
      await expect(resolveWebhookAddress(url, POLICY, answers(...set)), set.join()).resolves.toEqual({
        ok: false,
        reason: "address_not_allowed",
      });
    }
  });

  it("refuses an allowed IP literal in a private range without asking DNS", async () => {
    const resolve = answers("1.1.1.1");
    const literal: WebhookPolicy = { hosts: ["169.254.169.254", "[::1]"], allowLocal: false };
    await expect(
      resolveWebhookAddress(new URL("https://169.254.169.254/latest"), literal, resolve),
    ).resolves.toMatchObject({ ok: false, reason: "address_not_allowed" });
    await expect(
      resolveWebhookAddress(new URL("https://[::1]/run"), literal, resolve),
    ).resolves.toMatchObject({
      ok: false,
      reason: "address_not_allowed",
    });
    expect(resolve.calls()).toBe(0);
  });

  it("refuses a name with no address", async () => {
    await expect(resolveWebhookAddress(url, POLICY, answers())).resolves.toEqual({
      ok: false,
      reason: "no_address",
    });
    const failing: WebhookResolver = () => Promise.reject(new Error(`ENOTFOUND ${HOST}`));
    await expect(resolveWebhookAddress(url, POLICY, failing)).resolves.toEqual({
      ok: false,
      reason: "no_address",
    });
  });

  it("with the test switch, admits loopback and still no other private range", async () => {
    const local: WebhookPolicy = { hosts: [HOST], allowLocal: true };
    await expect(resolveWebhookAddress(url, local, answers("127.0.0.1"))).resolves.toMatchObject({
      ok: true,
    });
    await expect(resolveWebhookAddress(url, local, answers("::1"))).resolves.toMatchObject({ ok: true });
    for (const address of ["10.0.0.5", "169.254.169.254", "192.168.0.10", "fd00::1"]) {
      await expect(resolveWebhookAddress(url, local, answers(address)), address).resolves.toEqual({
        ok: false,
        reason: "address_not_allowed",
      });
    }
  });

  it("vets an address in one call, as when a webhook is saved", async () => {
    await expect(vetWebhookUrl(`https://${HOST}/run`, POLICY, answers("1.1.1.1"))).resolves.toEqual({
      ok: true,
      host: HOST,
    });
    await expect(vetWebhookUrl(`https://${HOST}/run`, POLICY, answers("10.0.0.1"))).resolves.toEqual({
      ok: false,
      reason: "address_not_allowed",
    });
    await expect(vetWebhookUrl("https://other.example/run", POLICY, answers("1.1.1.1"))).resolves.toEqual({
      ok: false,
      reason: "host_not_allowed",
    });
  });
});

describe("guardedWakeFetch", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  /** A local receiver; `handle` answers each request. */
  async function receiver(
    handle: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ port: number; requests: { url: string; authorization: string; body: string }[] }> {
    const requests: { url: string; authorization: string; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        requests.push({ url: request.url ?? "", authorization: request.headers.authorization ?? "", body });
        handle(request, response);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return { port: (server.address() as AddressInfo).port, requests };
  }

  const init = (signal?: AbortSignal): RequestInit => ({
    method: "POST",
    headers: { authorization: "Bearer k-123", "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
    redirect: "manual",
    signal: signal ?? AbortSignal.timeout(5_000),
  });

  it("posts to the address it checked, and answers with the status alone", async () => {
    const rx = await receiver((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("SECRET-BODY-FROM-RECEIVER");
    });
    // The name exists only in this resolver: the request reaches the server only through the checked address.
    const resolve = answers("127.0.0.1");
    const fetch = guardedWakeFetch(
      () => ({ hosts: [`receiver.test:${String(rx.port)}`], allowLocal: true }),
      {
        resolve,
      },
    );
    const response = await fetch(`http://receiver.test:${String(rx.port)}/hook?run=1`, init());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(rx.requests).toEqual([
      { url: "/hook?run=1", authorization: "Bearer k-123", body: JSON.stringify({ hello: "world" }) },
    ]);
    expect(resolve.calls()).toBe(1);
  });

  it("never follows a redirect, also not to a private address", async () => {
    const inside = await receiver((_request, response) => {
      response.end("internal");
    });
    const rx = await receiver((_request, response) => {
      response.writeHead(302, { location: `http://169.254.169.254/latest/meta-data` });
      response.end();
    });
    const fetch = guardedWakeFetch(() => ({ hosts: [`127.0.0.1:${String(rx.port)}`], allowLocal: true }));
    const response = await fetch(`http://127.0.0.1:${String(rx.port)}/hook`, init());
    expect(response.status).toBe(302);
    expect(inside.requests).toEqual([]);
    expect(rx.requests).toHaveLength(1);
  });

  it("checks the address again on every send, against the allowlist as it is now", async () => {
    const rx = await receiver((_request, response) => {
      response.end();
    });
    let hosts = [`127.0.0.1:${String(rx.port)}`];
    const fetch = guardedWakeFetch(() => ({ hosts, allowLocal: true }));
    await expect(fetch(`http://127.0.0.1:${String(rx.port)}/hook`, init())).resolves.toMatchObject({
      status: 200,
    });
    hosts = [];
    await expect(fetch(`http://127.0.0.1:${String(rx.port)}/hook`, init())).rejects.toBeInstanceOf(
      WakeRefused,
    );
    expect(rx.requests).toHaveLength(1);
  });

  it("refuses a name that now resolves to a private address (rebinding), before connecting", async () => {
    const fetch = guardedWakeFetch(() => POLICY, { resolve: answers("10.0.0.7") });
    const refusal = await fetch(`https://${HOST}/routines/secret-path/run`, init()).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(WakeRefused);
    expect((refusal as WakeRefused).label).toBe(
      "refused: that host points to a private network address, so the console will not call it",
    );
    expect((refusal as Error).message).not.toContain("secret-path");
  });

  it("refuses loopback without the test switch", async () => {
    const rx = await receiver((_request, response) => {
      response.end();
    });
    const fetch = guardedWakeFetch(() => ({ hosts: [`127.0.0.1:${String(rx.port)}`], allowLocal: false }));
    await expect(fetch(`https://127.0.0.1:${String(rx.port)}/hook`, init())).rejects.toBeInstanceOf(
      WakeRefused,
    );
    await expect(fetch(`http://127.0.0.1:${String(rx.port)}/hook`, init())).rejects.toBeInstanceOf(
      WakeRefused,
    );
    expect(rx.requests).toEqual([]);
  });

  it("gives up at the request's time limit, from the name lookup through the headers", async () => {
    const rx = await receiver(() => {
      // Never answers.
    });
    const fetch = guardedWakeFetch(() => ({ hosts: [`127.0.0.1:${String(rx.port)}`], allowLocal: true }));
    const started = Date.now();
    const error = await fetch(
      `http://127.0.0.1:${String(rx.port)}/hook`,
      init(AbortSignal.timeout(200)),
    ).catch((failure: unknown) => failure);
    expect((error as Error).name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(2_000);

    const slowDns: WebhookResolver = () => new Promise(() => undefined);
    const stuck = guardedWakeFetch(() => POLICY, { resolve: slowDns });
    const dnsError = await stuck(`https://${HOST}/run`, init(AbortSignal.timeout(100))).catch(
      (failure: unknown) => failure,
    );
    expect((dnsError as Error).name).toBe("TimeoutError");
  });

  it("refuses an answer with oversized headers instead of reading on", async () => {
    const rx = await receiver((_request, response) => {
      response.writeHead(200, { "x-padding": "a".repeat(64 * 1024) });
      response.end();
    });
    const fetch = guardedWakeFetch(() => ({ hosts: [`127.0.0.1:${String(rx.port)}`], allowLocal: true }));
    await expect(fetch(`http://127.0.0.1:${String(rx.port)}/hook`, init())).rejects.toThrow();
  });

  it("drives a notifier: a refused host fails once with a fixed reason that quotes nothing", async () => {
    const store = new MemoryWakeStore();
    const logs: string[] = [];
    const notifier = new WakeNotifier({
      target: new WakeTarget("https://elsewhere.example/routines/secret-path/run", "k-secret"),
      dailyCap: 5,
      store,
      fetch: guardedWakeFetch(() => POLICY, { resolve: answers("1.1.1.1") }),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    notifier.start();
    notifier.offer([
      {
        kind: "mandate_changed",
        detail: { change: "paused", paused: true },
        sourceId: "p",
        occurredAt: Date.now(),
      },
    ]);
    await notifier.flush();
    notifier.stop();
    const [delivery] = [...store.deliveries.values()];
    expect(delivery).toMatchObject({
      status: "failed",
      attempts: 1,
      result: "refused: this console does not post wake-ups to that host, not retried",
    });
    const seen = JSON.stringify([...store.deliveries.values()]) + logs.join("\n");
    expect(seen).not.toMatch(/elsewhere|secret-path|k-secret/);
  });
});
