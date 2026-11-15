/**
 * Starts the console backend when the server starts, so the event store is rebuilt and caught up with
 * the chain before the first page asks for it. Nothing runs during `next build`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { PHASE_PRODUCTION_BUILD } = await import("next/constants");
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return;
  const { getConsoleService } = await import("./server/console");
  getConsoleService();
}
