// Tool names overlap across runtimes, but their renderer schemas do not.
export function legacyToolCard<T>(mode: string, render: () => T): T | undefined {
  return mode === "hermes" ? undefined : render();
}

export function hermesToolResult(content: string | undefined, running: boolean) {
  if (content === undefined) {
    return { status: running ? "Working…" : "No result received", result: undefined };
  }
  try {
    const envelope = JSON.parse(content);
    if (
      envelope &&
      typeof envelope.preview === "string" &&
      envelope.fullOutputAvailable === false &&
      (envelope.failed === true || envelope.failed === false || envelope.failed === null)
    ) {
      const status =
        envelope.attributionUnknown === true
          ? "Unknown"
          : envelope.unattributable === true || envelope.failed === null
            ? "Result unavailable"
            : envelope.failed
              ? "Failed"
              : "Completed";
      return { status, result: envelope.preview };
    }
  } catch {
    // Older/raw results remain readable without asserting a successful outcome.
  }
  return { status: "Result unavailable", result: content };
}
