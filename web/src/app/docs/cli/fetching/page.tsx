import { notFound } from "next/navigation";
import { adminDocs } from "@/flags";

export default async function FetchingPage() {
  const showAdmin = await adminDocs();
  if (!showAdmin) notFound();
  return (
    <>
      <h1>Fetching Releases</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Pull new releases from configured sources into the index.
      </p>

      <h2>Basic usage</h2>
      <pre><code>{`released fetch                     # Fetch all sources
released fetch claude-code         # Fetch a single source
released fetch --source next-js    # Alternative slug syntax`}</code></pre>

      <h2>Smart fetching</h2>
      <p>
        Rather than fetching everything, Released offers several targeted modes that
        respect backoff timers and change detection:
      </p>
      <pre><code>{`released fetch --stale 6            # Sources not updated in 6+ hours
released fetch --unfetched          # Sources never fetched before
released fetch --changed            # Sources where poll detected changes
released fetch --retry-errors       # Sources that errored last time`}</code></pre>

      <h3>How backoff works</h3>
      <p>
        Sources track <code>consecutiveNoChange</code> and <code>consecutiveErrors</code> counters.
        These drive exponential backoff:
      </p>
      <ul>
        <li><strong>No change</strong>: 1h → 2h → 4h → … → 48h max</li>
        <li><strong>Errors</strong>: 1h → 2h → 4h → … → 72h max</li>
      </ul>
      <p>
        The <code>--stale</code> flag respects these timers via the <code>nextFetchAfter</code> column.
      </p>

      <h2>Limiting results</h2>
      <pre><code>{`released fetch my-source --max 50   # Cap at 50 releases
released fetch --all                # No limit (overrides default 200)`}</code></pre>
      <p>
        The default limit is 200 releases per source, which prevents hitting API pagination
        limits on platforms like GitHub (10K cap).
      </p>

      <h2>Dry run</h2>
      <p>Preview what would be fetched without writing to the database:</p>
      <pre><code>{`released fetch my-source --dry-run`}</code></pre>

      <h2>Force re-fetch</h2>
      <p>Delete existing releases and fetch fresh data:</p>
      <pre><code>{`released fetch my-source --force`}</code></pre>

      <h2>Crawl mode</h2>
      <p>
        For multi-page changelogs (scrape sources only), crawl mode follows pagination links
        to capture all entries:
      </p>
      <pre><code>{`released fetch my-source --crawl
released fetch my-source --crawl --crawl-pattern "https://example.com/changelog/*"`}</code></pre>
      <p>
        Once enabled, crawl mode persists in the source metadata. Use <code>--no-crawl</code> for
        a one-off override.
      </p>

      <h2>Concurrency</h2>
      <p>Fetch multiple sources in parallel:</p>
      <pre><code>{`released fetch --stale 6 --concurrency 5`}</code></pre>
      <p>Default is 1. Remote mode caps at 5.</p>

      <h2>Polling for changes</h2>
      <p>
        The <code>poll</code> command uses HTTP HEAD requests to detect upstream changes
        without fetching content. It sets the <code>changeDetectedAt</code> flag for use
        with <code>fetch --changed</code>.
      </p>
      <pre><code>{`released poll                # Check all feed sources
released poll --changed      # Show only sources with changes
released poll --json         # Machine-readable output`}</code></pre>

      <h2>Enrichment</h2>
      <p>
        Feed-based releases often have truncated content. The <code>enrich</code> command
        fetches the full page content for sparse releases:
      </p>
      <pre><code>{`released enrich my-source`}</code></pre>

      <h2>Options reference</h2>
      <table>
        <thead>
          <tr><th>Flag</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>--source &lt;slug&gt;</code></td><td>Source slug (alternative to positional arg)</td></tr>
          <tr><td><code>--max &lt;n&gt;</code></td><td>Max releases per source (default 200)</td></tr>
          <tr><td><code>--all</code></td><td>No limit on releases</td></tr>
          <tr><td><code>--since &lt;date&gt;</code></td><td>Only fetch after this ISO date</td></tr>
          <tr><td><code>--stale &lt;hours&gt;</code></td><td>Only sources older than N hours</td></tr>
          <tr><td><code>--unfetched</code></td><td>Only never-fetched sources</td></tr>
          <tr><td><code>--changed</code></td><td>Only sources with detected changes</td></tr>
          <tr><td><code>--retry-errors</code></td><td>Only sources that errored</td></tr>
          <tr><td><code>--crawl</code></td><td>Enable multi-page crawl</td></tr>
          <tr><td><code>--dry-run</code></td><td>Preview without writing</td></tr>
          <tr><td><code>--force</code></td><td>Delete and re-fetch</td></tr>
          <tr><td><code>--full</code></td><td>Force full re-parse</td></tr>
          <tr><td><code>--no-summarize</code></td><td>Skip post-fetch summary</td></tr>
          <tr><td><code>--concurrency &lt;n&gt;</code></td><td>Parallel sources (default 1, max 5)</td></tr>
          <tr><td><code>--json</code></td><td>Machine-readable output</td></tr>
        </tbody>
      </table>
    </>
  );
}
