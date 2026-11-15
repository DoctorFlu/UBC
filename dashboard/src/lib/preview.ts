/**
 * `?state=loading|empty|error` on any console view renders that state with the real layout, so
 * reviewers and tests can see every state without breaking the data source. Remove nothing when
 * real data lands: the same states then come from the data source itself.
 */
export type PreviewState = "loading" | "empty" | "error";

export function previewState(
  searchParams: Record<string, string | string[] | undefined>,
): PreviewState | undefined {
  const value = searchParams.state;
  return value === "loading" || value === "empty" || value === "error" ? value : undefined;
}
