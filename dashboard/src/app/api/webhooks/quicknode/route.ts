import { getConsoleService } from "@/server/console";
import { receiveStreamDelivery } from "@/server/http/stream-webhook";

export const dynamic = "force-dynamic";

/** QuickNode Stream deliveries of Policy contract logs, verified and fed into the same pipeline as the poller. */
export function POST(request: Request) {
  return receiveStreamDelivery(request, getConsoleService());
}
