import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Compare the mock host against a real signing host, method by method.
 *
 * Both reports are written by the same generated battery -- the CLI's via
 * `scripts/battery.sh`, the mock's via `scripts/fidelity-report.ts` -- so the
 * rows line up and a difference means the two hosts answered differently.
 *
 * This guards the claim the whole test host rests on: that a product sees the
 * same protocol behaviour here as it would against a host that ships. The
 * surface guards (`mock-host-surface`, `test-host-surface`) check that methods
 * EXIST on both sides; this checks what they DO.
 */
function readReport(name: string): Map<string, "pass" | "fail"> {
  const path = fileURLToPath(
    new URL(`../../../../../explorer/diagnosis-reports/spa/${name}`, import.meta.url),
  );
  const rows = new Map<string, "pass" | "fail">();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*(\S+)\s*\|/.exec(line);
    if (match) rows.set(match[1], match[2].includes("✅") ? "pass" : "fail");
  }
  return rows;
}

describe("mock host fidelity", () => {
  const mock = readReport("mock-host.md");
  const real = readReport("signing-host-cli.md");
  const shared = [...mock.keys()].filter((id) => real.has(id));

  it("parsed both reports", () => {
    // Without this a regex that matched nothing would make every assertion
    // below vacuously true -- the failure mode these guards exist to avoid.
    expect(mock.size).toBeGreaterThan(50);
    expect(real.size).toBeGreaterThan(50);
    expect(shared.length).toBeGreaterThan(50);
  });

  it("never passes where a real host fails", () => {
    // The load-bearing property. A mock that succeeds where the shipping host
    // errors teaches a product the wrong thing, and the test that relies on it
    // passes for a reason that will not survive contact with production.
    // Divergence in the other direction is a gap, which is disappointing; this
    // direction is a lie, which is worse.
    const falseGreens = shared.filter(
      (id) => mock.get(id) === "pass" && real.get(id) === "fail",
    );
    expect(falseGreens).toEqual([]);
  });

  it("agrees with a real host on most of the surface", () => {
    const agree = shared.filter((id) => mock.get(id) === real.get(id));
    // A floor, not a target. Chain-routed methods fail in the mock report
    // because the generator closes the chain to make the battery terminate,
    // so exact agreement is not the expectation -- a collapse is the signal.
    expect(agree.length).toBeGreaterThanOrEqual(30);
  });
});
