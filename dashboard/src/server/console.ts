import "server-only";

import { readConsoleConfig } from "./config";
import { ConsoleService } from "./console-service";
import { openDatabase } from "./db";

/**
 * One console service per server process. It lives on `globalThis` because Next.js may load server
 * modules more than once (route handlers and server components, and again after a dev reload).
 */
const KEY = Symbol.for("mandate.console-service");

type Holder = Record<typeof KEY, ConsoleService | undefined>;

/** The running console service, created and started on first use. */
export function getConsoleService(): ConsoleService {
  const holder = globalThis as unknown as Holder;
  let service = holder[KEY];
  if (!service) {
    const config = readConsoleConfig();
    service = new ConsoleService(config, openDatabase(config.dataDir));
    holder[KEY] = service;
  }
  service.start();
  return service;
}

/** Replaces the process-wide service; for tests that call route handlers directly. */
export function setConsoleServiceForTests(service: ConsoleService | undefined): void {
  (globalThis as unknown as Holder)[KEY] = service;
}
