export default function AnalysisPage() {
  return (
    <>
      <h1>Summaries &amp; Comparisons</h1>
      <p className="text-lg text-stone-600 dark:text-stone-400 -mt-4">
        AI-powered analysis of release activity across sources and organizations.
      </p>

      <h2>Summary</h2>
      <p>
        Generate a natural-language summary of recent releases for a source or across an entire organization.
      </p>
      <pre><code>{`released summary my-source
released summary --org vercel --days 7
released summary my-source --instructions "focus on breaking changes"
released summary --json`}</code></pre>

      <h3>Options</h3>
      <table>
        <thead>
          <tr><th>Flag</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>--days &lt;n&gt;</code></td><td>Look-back window in days (default 30)</td></tr>
          <tr><td><code>--org &lt;slug&gt;</code></td><td>Summarize across all sources in an org</td></tr>
          <tr><td><code>--instructions &lt;text&gt;</code></td><td>Additional guidance for the summarizer</td></tr>
          <tr><td><code>--json</code></td><td>Structured output</td></tr>
        </tbody>
      </table>

      <h2>Compare</h2>
      <p>
        Generate a head-to-head comparison of recent releases between two sources.
        Useful for competitive analysis or tracking convergence between related tools.
      </p>
      <pre><code>{`released compare next-js remix --days 30
released compare neon-changelog planetscale-changelog --days 60
released compare --json`}</code></pre>

      <h3>What the comparison covers</h3>
      <ul>
        <li><strong>Convergent features</strong> — capabilities both products shipped in the same window</li>
        <li><strong>Divergent bets</strong> — areas where one is investing and the other isn&apos;t</li>
        <li><strong>Breaking changes</strong> — deprecations or migrations that signal strategic shifts</li>
      </ul>

      <h2>Example: competitive intelligence</h2>
      <p>
        Compare recent activity across competing products:
      </p>
      <pre><code>{`# Summarize each company's recent releases
released summary --org neon --days 60
released summary --org supabase --days 60

# Run head-to-head comparisons
released compare neon-changelog planetscale-changelog --days 60
released compare neon-changelog supabase --days 60`}</code></pre>
    </>
  );
}
