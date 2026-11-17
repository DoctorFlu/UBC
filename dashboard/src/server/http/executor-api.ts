import "server-only";

import {
  hashSettlement,
  putSettlementRequestSchema,
  settlementMessage,
  settlementProblems,
  storedSettlementSchema,
} from "@mandate/shared";
import { type Hex, isAddressEqual, recoverMessageAddress } from "viem";

import type { ConsoleService } from "../console-service";
import type { SettlementRow } from "../store/settlements";
import { apiError, json, readBody } from "./responses";

/**
 * The executor's side of the console (`CONSOLE_EXECUTOR_ROUTES`, issue #92): where it records what each
 * filled position paid when its market resolved, because the Policy contract cannot hold that.
 *
 * There is no shared secret. A record is stored only when its signature recovers to the contract's
 * `executor()`, the one account that may record results onchain, and only for an intent the chain shows
 * as a filled buy of the same market, outcome, cost and limit price. The first record of an intent wins.
 */
export async function putSettlement(
  request: Request,
  service: ConsoleService,
  params: Record<string, string>,
): Promise<Response> {
  try {
    return await handlePut(request, service, params);
  } catch (error) {
    console.error(`[console] PUT ${new URL(request.url).pathname} failed`, error);
    return apiError(500, "internal_error", "The console failed to handle this request. Try again.");
  }
}

function intentIdParam(value: string | undefined): number | null {
  if (value === undefined || !/^(0|[1-9]\d{0,15})$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

async function handlePut(
  request: Request,
  service: ConsoleService,
  params: Record<string, string>,
): Promise<Response> {
  const intentId = intentIdParam(params.intentId);
  if (intentId === null) {
    return apiError(422, "invalid_parameter", "The intent id must be a whole number, starting at 0.");
  }
  const body = await readBody(request, putSettlementRequestSchema);
  if (!body.ok) return body.response;
  const { document, signature } = body.data;
  if (document.intentId !== intentId) {
    return apiError(422, "intent_mismatch", "The document's intentId must be the intent id in the path.");
  }
  const problems = settlementProblems(document);
  if (problems.length > 0) {
    return apiError(422, "invalid_settlement", `The settlement does not add up: ${problems.join("; ")}.`);
  }

  const deployment = service.deployment;
  const deploymentId = service.deploymentId;
  const roles = await service.currentRoles();
  if (!deployment || !deploymentId || !roles) {
    return apiError(
      503,
      "chain_unavailable",
      "The console is not following a Policy contract yet. Try again shortly.",
    );
  }
  if (document.chainId !== deployment.chainId || !isAddressEqual(document.policy, deployment.address)) {
    return apiError(
      422,
      "wrong_deployment",
      "The settlement names another chain or Policy contract than the one this console follows.",
    );
  }

  const hash = hashSettlement(document);
  let signer: `0x${string}`;
  try {
    signer = await recoverMessageAddress({ message: settlementMessage(hash), signature });
  } catch {
    return apiError(422, "invalid_signature", "The signature cannot be read.");
  }
  if (!isAddressEqual(signer, roles.executor)) {
    return apiError(
      403,
      "not_executor",
      "The settlement is not signed by the contract's executor, the only account that records results.",
    );
  }

  const intent = service.snapshot().chain?.intents.find((candidate) => candidate.id === intentId);
  if (!intent || intent.status === "approved") {
    // The executor settles days after the fill, but a test can be quicker than the console's next poll.
    return apiError(
      409,
      "not_executed",
      `The console has not seen intent ${String(intentId)} filled yet. Try again shortly.`,
    );
  }
  if (
    intent.status !== "executed" ||
    intent.isBuy !== true ||
    intent.market !== document.market ||
    intent.outcome !== document.outcome ||
    intent.filledCents !== document.costCents ||
    intent.limitPrice !== document.limitPrice
  ) {
    return apiError(
      422,
      "intent_mismatch",
      `Intent ${String(intentId)} onchain is not a filled buy of this market, outcome, cost and limit price.`,
    );
  }

  const result = service.settlements.put(deploymentId, {
    intentId,
    hash,
    document,
    signature: signature.toLowerCase() as Hex,
    signer,
  });
  if (!result.ok) {
    return apiError(
      409,
      "conflict",
      `Intent ${String(intentId)} already has a settlement, ${result.existing.hash}; the first record stands.`,
    );
  }
  if (result.created) service.settlementStored(document.eventTicker);
  return json(storedSettlementSchema.parse(responseOf(result.row, document)), result.created ? 201 : 200);
}

function responseOf(row: SettlementRow, document: unknown) {
  return {
    intentId: row.intentId,
    hash: row.hash,
    document,
    signature: row.signature,
    signer: row.signer,
    storedAt: row.storedAt,
  };
}
