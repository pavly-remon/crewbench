/** Guard well under Linux's 128 KiB MAX_ARG_STRLEN per argv element --
 * ported from crewbench_dispatch.py's MAX_ARGV_BYTES. */
export const MAX_ARGV_BYTES = 100_000;

/** Fail fast with a clear error instead of letting exec() fail with E2BIG. */
export function checkArgvSize(cmd: readonly string[]): void {
  for (const element of cmd) {
    const size = Buffer.byteLength(element, "utf-8");
    if (size > MAX_ARGV_BYTES) {
      throw new Error(
        `a single command-line argument is ${size} bytes, over the ${MAX_ARGV_BYTES}-byte ` +
          "guard (real OS limits are ~128 KiB and vary by platform) — this would likely fail " +
          `with E2BIG; the offending value starts with: ${JSON.stringify(element.slice(0, 200))}`,
      );
    }
  }
}
