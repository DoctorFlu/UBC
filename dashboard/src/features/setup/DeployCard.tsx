"use client";

import { Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type Abi, BaseError, UserRejectedRequestError } from "viem";
import { useConfig } from "wagmi";
import { deployContract, waitForTransactionReceipt } from "wagmi/actions";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import type { WalletDeployView } from "@/lib/accounts/types";
import { useMandateScope } from "@/lib/mandate/MandateContext";
import { useWalletState } from "@/lib/wallet/useWalletState";

import styles from "./setup.module.css";

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Not JSON.
  }
  return `The console answered ${response.status.toString()}.`;
}

/**
 * A mandate without its Policy contract yet (#95): on the demo chain the console deploys it (again, after
 * a failed first try); on Arc the owner's wallet deploys it, and the console checks the transaction before
 * it follows the contract. Either way the contract names this mandate's agent and the shared executor.
 */
export function DeployCard() {
  const scope = useMandateScope();
  const router = useRouter();
  const toast = useToast();
  const config = useConfig();
  const wallet = useWalletState();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A contract the wallet deployed but the console has not accepted yet: a retry sends it again rather
  // than deploying a second one.
  const [deployedTx, setDeployedTx] = useState<`0x${string}` | null>(null);
  if (!scope || scope.mandate.contract !== null || scope.mandate.deployment === "env") return null;
  const { mandate, deployer } = scope;
  const url = `/api/console/mandates/${encodeURIComponent(mandate.id)}/deployment`;

  async function deploy() {
    setBusy(true);
    setProblem(null);
    try {
      let txHash: `0x${string}` | null = deployedTx;
      if (deployer === "wallet" && txHash === null) {
        if (wallet.kind !== "connected") {
          setProblem("Connect the wallet that will own this mandate first.");
          return;
        }
        const plan = await fetch(url, { cache: "no-store" });
        if (!plan.ok) {
          setProblem(await errorText(plan));
          return;
        }
        const view = (await plan.json()) as WalletDeployView;
        txHash = await deployContract(config, {
          abi: view.abi as Abi,
          bytecode: view.bytecode,
          args: view.args,
          chainId: view.chainId,
          account: wallet.address,
        });
        setDeployedTx(txHash);
        await waitForTransactionReceipt(config, { hash: txHash, chainId: view.chainId });
      }
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash }),
      });
      if (!response.ok) {
        // 422: the console checked the transaction and it is not this mandate's contract; start over.
        if (response.status === 422) setDeployedTx(null);
        setProblem(
          txHash === null || response.status === 422
            ? await errorText(response)
            : `${await errorText(response)} Your contract is deployed; try again to send it to the console.`,
        );
        return;
      }
      setDeployedTx(null);
      toast({
        title: "Contract deployed",
        description: "Set its first rules on the Rules page: until then it rejects every intent.",
        tone: "success",
      });
      router.refresh();
    } catch (error) {
      const declined =
        error instanceof BaseError && error.walk((cause) => cause instanceof UserRejectedRequestError);
      if (declined) {
        toast({ title: "Not deployed", description: "You declined it in your wallet. Nothing was sent." });
      } else {
        setProblem(error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error));
      }
    } finally {
      setBusy(false);
    }
  }

  const byWallet = deployer === "wallet";
  return (
    <Card
      title="Deploy this mandate's contract"
      description={
        byWallet
          ? "Your wallet deploys the Policy contract and becomes its owner. It names this mandate's agent and the console's executor."
          : "The console deploys the Policy contract and holds its owner key; your passkey confirms each owner action."
      }
      headingLevel={2}
      tone="attention"
    >
      <div className={styles.deploy} data-testid="deploy-card">
        <Button
          variant="primary"
          icon={<Rocket aria-hidden />}
          loading={busy}
          disabled={!scope.canAct || deployer === null}
          onClick={() => void deploy()}
        >
          {deployedTx ? "Send deployment again" : byWallet ? "Deploy with wallet" : "Deploy contract"}
        </Button>
        {!scope.canAct ? <p className={styles.muted}>Only a workspace admin can deploy it.</p> : null}
        {problem ? (
          <p className={styles.deployProblem} role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
