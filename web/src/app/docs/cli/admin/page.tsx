import { notFound } from "next/navigation";
import { adminDocs } from "@/flags";

export default async function AdminPage() {
  const showAdmin = await adminDocs();
  if (!showAdmin) notFound();

  return (
    <>
      <h1>Source Management</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        Add, edit, remove, and organize changelog sources. Requires an API key.
      </p>

      <h2>Add sources</h2>
      <pre><code>{`released add "Next.js" --url https://github.com/vercel/next.js
released add "Linear" --url https://linear.app/changelog
released add --name "My Blog" --url https://example.com/changelog`}</code></pre>
      <p>
        By default, <code>add</code> runs automated pre-checks to determine the best ingestion
        method. GitHub URLs use the Releases API directly; other URLs are evaluated for feed
        discovery, provider detection, and scrape feasibility.
      </p>
      <p>
        Override detection with <code>--type github</code>, <code>--type scrape</code>, or{" "}
        <code>--type feed</code>. If you know the feed URL, provide it directly:
      </p>
      <pre><code>{`released add "Claude Code" --url https://docs.anthropic.com/en/changelog \\
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml`}</code></pre>

      <h2>Edit sources</h2>
      <pre><code>{`released edit next-js --url https://github.com/vercel/next.js/releases
released edit my-blog --org acme
released edit my-blog --type feed
released edit my-blog --primary`}</code></pre>

      <h2>Remove sources</h2>
      <pre><code>{`released remove my-blog`}</code></pre>

      <h2>Evaluate</h2>
      <p>Evaluate a URL without adding it as a source:</p>
      <pre><code>{`released evaluate https://linear.app/changelog`}</code></pre>

      <h2>Organizations</h2>
      <p>Group sources under organizations for aggregate queries:</p>
      <pre><code>{`released org add "Vercel"
released org link vercel --platform github --handle vercel
released org list
released org show vercel`}</code></pre>

      <h2>Products</h2>
      <p>Group sources under products within an organization:</p>
      <pre><code>{`released product add "Next.js" --org vercel --url https://nextjs.org
released product list vercel
released product edit nextjs --description "React framework for production"
released product remove nextjs`}</code></pre>
      <p>
        Convert an org that should be a product:
      </p>
      <pre><code>{`released product adopt nextjs --into vercel`}</code></pre>

      <h2>Domain aliases</h2>
      <p>Map alternate domains to organizations or products:</p>
      <pre><code>{`released org alias add anthropic claude.ai claude.com
released product alias add nextjs nextjs.org`}</code></pre>

      <h2>Categories &amp; tags</h2>
      <pre><code>{`released org add "Acme" --category cloud --tags typescript,edge
released org tag add acme react serverless
released product tag add acme-cli testing`}</code></pre>

      <h2>Import from manifest</h2>
      <p>Bulk-import organizations and sources from a JSON file:</p>
      <pre><code>{`released import manifest.json
released import manifest.json --dry-run
released import manifest.json --skip-existing`}</code></pre>

      <h2>Onboarding</h2>
      <p>Use the AI agent to discover, validate, and add sources for a company:</p>
      <pre><code>{`released onboard "Vercel"
released onboard "Stripe" --domain stripe.com --github-org stripe`}</code></pre>

      <h2>Discover</h2>
      <p>Find changelog pages for a domain:</p>
      <pre><code>{`released discover vercel.com
released discover vercel.com --verify
released discover vercel.com --add`}</code></pre>

      <h2>Ignored &amp; blocked URLs</h2>
      <pre><code>{`released ignore add https://example.com/blog --org vercel --reason "Not a changelog"
released ignore list --org vercel
released block add medium.com --domain --reason "Aggregator"
released block list`}</code></pre>

      <h2>Release management</h2>
      <pre><code>{`released release show rel_abc123
released release edit rel_abc123 --title "Fixed title"
released release delete rel_abc123
released release suppress rel_abc123 --reason "promotional content"`}</code></pre>

      <h2>Summarize (rolling)</h2>
      <p>Generate cached AI summaries with configurable windows:</p>
      <pre><code>{`released summarize next-js
released summarize next-js --window 30
released summarize next-js --monthly`}</code></pre>

      <h2>Source health checks</h2>
      <pre><code>{`released check
released check next-js`}</code></pre>

      <h2>Fetch log</h2>
      <pre><code>{`released fetch-log
released fetch-log next-js --limit 50`}</code></pre>

      <h2>Task management</h2>
      <p>Manage remote fetch and discovery sessions:</p>
      <pre><code>{`released task list
released task cancel <sessionId>`}</code></pre>
    </>
  );
}
