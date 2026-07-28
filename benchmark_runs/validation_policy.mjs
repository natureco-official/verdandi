import { createHash } from "node:crypto";

const TSC_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/gm;
const TSC_DIAGNOSTIC_WITH_MESSAGE = /^(.+?)\(\d+,\d+\): error (TS\d+): (.+)$/gm;

export function diagnosticContentSignature(stdout) {
  const diagnostics = [...stdout.matchAll(TSC_DIAGNOSTIC_WITH_MESSAGE)].map(match =>
    `${match[1].replaceAll("\\", "/")}:${match[2]}:${match[3].trim()}`);
  if (!diagnostics.length) return null;
  return createHash("sha256").update(diagnostics.join("\n")).digest("hex");
}

/** Accept only an explicitly declared, non-empty set of pre-existing diagnostics. */
export function classifyAcceptedBaselineFailure(command, result) {
  if (result.exitCode === 0 || result.timedOut ||
      (!command.expectedDiagnosticSha256 && !command.expectedDiagnosticContentSha256)) {
    return false;
  }
  if (result.stderr.trim()) return false;
  const diagnostics = [...result.stdout.matchAll(TSC_DIAGNOSTIC)].map(match =>
    `${match[1].replaceAll("\\", "/")}:${match[2]}:${match[3]}:${match[4]}`);
  if (!diagnostics.length) return false;
  if (command.expectedDiagnosticContentSha256) {
    return diagnosticContentSignature(result.stdout) === command.expectedDiagnosticContentSha256;
  }
  const signature = createHash("sha256").update(diagnostics.join("\n")).digest("hex");
  return signature === command.expectedDiagnosticSha256;
}
