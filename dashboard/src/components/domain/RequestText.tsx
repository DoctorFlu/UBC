import { ClampedText } from "@/components/ui/ClampedText";
import { oneBlock } from "@/lib/agent-text";
import { clip } from "@/lib/text";

/** The most of a request any page draws: what the agent API accepts. */
export const MAX_REQUEST_CHARACTERS = 2_000;

/**
 * The owner's request as the agent reported it, drawn the same way wherever it appears (the hedge plan,
 * its evidence chain, an intent's sealed reason): one block of plain text, since the agent wrote it, cut
 * to three lines with "Show more" when it is longer.
 */
export function RequestText({ text, className }: { text: string; className?: string }) {
  return (
    <ClampedText
      text={clip(oneBlock(text), MAX_REQUEST_CHARACTERS)}
      lines={3}
      className={className}
      data-testid="request-text"
    />
  );
}
