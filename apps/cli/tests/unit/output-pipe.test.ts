import { describe, it, expect, spyOn, afterEach } from "bun:test";
import { handleStdoutPipeError } from "../../src/lib/output.js";

describe("handleStdoutPipeError", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  afterEach(() => exitSpy?.mockRestore());

  it("exits cleanly (code 0) on a broken pipe (EPIPE)", () => {
    // The classic `… | head` case: the reader closed the pipe early. Without
    // this, the streaming writers (`--page-all`, `tail -f --json`) hang forever.
    exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const err: NodeJS.ErrnoException = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => handleStdoutPipeError(err)).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("rethrows any non-EPIPE stdout error (does not swallow it)", () => {
    exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const err: NodeJS.ErrnoException = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" });
    expect(() => handleStdoutPipeError(err)).toThrow("write ENOSPC");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
