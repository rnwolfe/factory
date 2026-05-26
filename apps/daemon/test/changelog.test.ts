import { describe, expect, test } from "bun:test";
import { parseChangelog } from "../src/changelog.ts";

describe("parseChangelog", () => {
  test("parses a single entry with intro, sections, and bold-lead bullets", () => {
    const raw = `# Changelog

## v0.11.0 — 2026-05-25

Some intro prose
across two lines.

### Added
- **Retry-in-worktree.** Restart blocked runs on the prior worktree.
- A bare bullet without a bold lead.

### Fixed
- **Empty events.** Two related bugs in the run-page route.
`;
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(1);
    const first = entries[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.version).toBe("0.11.0");
    expect(first.date).toBe("2026-05-25");
    expect(first.intro).toBe("Some intro prose\nacross two lines.");
    expect(first.sections).toHaveLength(2);
    const added = first.sections[0];
    expect(added).toBeDefined();
    if (!added) return;
    expect(added.heading).toBe("Added");
    expect(added.bullets).toHaveLength(2);
    expect(added.bullets[0]).toEqual({
      lead: "Retry-in-worktree",
      body: "Restart blocked runs on the prior worktree.",
    });
    expect(added.bullets[1]).toEqual({
      lead: null,
      body: "A bare bullet without a bold lead.",
    });
  });

  test("parses multiple entries, newest first preserved in source order", () => {
    const raw = `## v0.11.0 — 2026-05-25
### Added
- New thing.

## v0.10.6 — 2026-05-24
### Fixed
- Old fix.
`;
    const entries = parseChangelog(raw);
    expect(entries.map((e) => e.version)).toEqual(["0.11.0", "0.10.6"]);
  });

  test("tolerates entries with no date and no intro", () => {
    const raw = `## v0.1.0

### Added
- Initial release.
`;
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(1);
    const first = entries[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.version).toBe("0.1.0");
    expect(first.date).toBeNull();
    expect(first.intro).toBe("");
    expect(first.sections).toHaveLength(1);
  });

  test("joins indented continuation lines into the prior bullet", () => {
    const raw = `## v0.1.0 — 2026-01-01
### Added
- **Big thing.** First sentence.
  Continued on the next line.
`;
    const entries = parseChangelog(raw);
    const bullets = entries[0]?.sections[0]?.bullets ?? [];
    expect(bullets).toHaveLength(1);
    expect(bullets[0]?.body).toBe("First sentence. Continued on the next line.");
  });

  test("returns empty array on a file with no version headers", () => {
    expect(parseChangelog("Just some prose.\nNo headers.")).toEqual([]);
  });
});
