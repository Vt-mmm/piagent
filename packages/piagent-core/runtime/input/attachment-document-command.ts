import { spawn } from "node:child_process";

import { MAX_DOCUMENT_BYTES, PDF_TIMEOUT_MS, probeExecutableOnPath,
  type DocumentCommandResult } from "../../extensions/document-intake.ts";

export type AttachmentDocumentCommand = (executable: string, args: string[], input?: Buffer) =>
DocumentCommandResult | Promise<DocumentCommandResult>;

// The converter is external and may consume its full timeout. Run it without a
// shell and without blocking Pi's event loop, while bounding both output pipes.
export function runAttachmentDocumentCommand(executable: string, args: string[], input?: Buffer):
DocumentCommandResult | Promise<DocumentCommandResult> {
  if (executable === "command") return probeExecutableOnPath(args[1] ?? "");
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] }); }
    catch (cause) { resolve({ status: null, stdout: "", stderr: "", error: cause as Error }); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, settled = false;
    const finish = (result: DocumentCommandResult) => {
      if (settled) return; settled = true; clearTimeout(timer); resolve(result);
    };
    const overflow = () => {
      child.kill("SIGKILL");
      const error = new Error("document converter output exceeded its limit"); (error as NodeJS.ErrnoException).code = "ENOBUFS";
      finish({ status: null, stdout: "", stderr: "", error });
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > MAX_DOCUMENT_BYTES) overflow(); else stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_DOCUMENT_BYTES) overflow(); else stderr.push(chunk); });
    child.on("error", (error) => finish({ status: null, stdout: "", stderr: "", error }));
    child.on("close", (status) => finish({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL"); const error = new Error("document converter ETIMEDOUT");
      finish({ status: null, stdout: "", stderr: "", error });
    }, PDF_TIMEOUT_MS);
    timer.unref();
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
