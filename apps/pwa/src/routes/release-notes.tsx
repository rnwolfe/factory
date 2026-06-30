import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Inline } from "../components/markdown-block.tsx";
import { trpc } from "../lib/trpc.ts";

type Entry = Awaited<ReturnType<typeof trpc.changelog.all.query>>[number];
type Bullet = Entry["sections"][number]["bullets"][number];

/** One changelog bullet plus any nested sub-bullets, rendered recursively. */
function BulletItem({ bullet }: { bullet: Bullet }) {
  return (
    <li className="text-[13px] text-[var(--color-fg-1)] leading-relaxed">
      {bullet.lead ? (
        <>
          <span className="text-[var(--color-fg)] font-medium">
            <Inline text={bullet.lead} />.
          </span>{" "}
          <span className="text-[var(--color-fg-2)]">
            <Inline text={bullet.body} />
          </span>
        </>
      ) : (
        <span className="text-[var(--color-fg-2)]">
          <Inline text={bullet.body} />
        </span>
      )}
      {bullet.children?.length ? (
        <ul className="ml-4 mt-1.5 space-y-1 list-disc marker:text-[var(--color-fg-3)]">
          {bullet.children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: bullets are positional, no stable id
            <BulletItem key={i} bullet={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ReleaseNotes() {
  const all = useQuery({
    queryKey: ["changelog.all"],
    queryFn: () => trpc.changelog.all.query(),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="space-y-3 md:max-w-3xl md:mx-auto">
      <div className="flex items-center gap-2 px-1">
        <Sparkles size={14} className="text-[var(--color-fg-2)]" />
        <span className="display text-lg text-[var(--color-fg)]">release notes</span>
      </div>

      {all.isLoading ? (
        <div className="surface px-4 py-5 space-y-2">
          <div className="skel h-3 w-1/3" />
          <div className="skel h-3 w-2/3" />
          <div className="skel h-3 w-1/2" />
        </div>
      ) : all.isError ? (
        <div className="surface px-4 py-3 mono text-[11px] text-[var(--color-verdict-trashed)]">
          couldn't load changelog: {(all.error as Error).message}
        </div>
      ) : all.data && all.data.length > 0 ? (
        <ol className="space-y-3">
          {all.data.map((entry) => (
            <EntryCard key={entry.version} entry={entry} />
          ))}
        </ol>
      ) : (
        <div className="surface px-4 py-3 mono text-[11px] text-[var(--color-fg-3)]">
          no entries yet.
        </div>
      )}
    </div>
  );
}

function EntryCard({ entry }: { entry: Entry }) {
  return (
    <li className="surface">
      <header className="px-4 py-3 border-b border-[var(--color-line)] flex items-baseline gap-2 flex-wrap">
        <span className="display text-[15px] text-[var(--color-fg)] tabular-nums">
          v{entry.version}
        </span>
        {entry.date ? (
          <span className="mono text-[10.5px] text-[var(--color-fg-3)]">{entry.date}</span>
        ) : null}
      </header>
      <div className="px-4 py-3 space-y-4">
        {entry.intro ? (
          <p className="text-[13px] text-[var(--color-fg-1)] leading-relaxed">
            <Inline text={entry.intro} />
          </p>
        ) : null}
        {entry.sections.map((section) => (
          <section key={section.heading}>
            <h3 className="mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--color-fg-3)] mb-2">
              {section.heading}
            </h3>
            <ul className="space-y-2.5">
              {section.bullets.map((bullet, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: bullets are positional, no stable id
                <BulletItem key={i} bullet={bullet} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </li>
  );
}
