import { getConsoleService } from "@/server/console";
import { getDeployment, postDeployment } from "@/server/http/mandates-api";

export const dynamic = "force-dynamic";

/** What the owner's wallet sends to deploy this mandate's contract. */
export async function GET(
  request: Request,
  context: RouteContext<"/api/console/mandates/[mandateId]/deployment">,
) {
  return getDeployment(request, getConsoleService(), await context.params);
}

/** The owner wallet's deployment to check, or (demo chain) the console's own deployment again. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/console/mandates/[mandateId]/deployment">,
) {
  return postDeployment(request, getConsoleService(), await context.params);
}
