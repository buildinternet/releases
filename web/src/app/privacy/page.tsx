import Link from "next/link";
import type { Metadata } from "next";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How releases.sh handles data collected from the web, API, CLI, and MCP server.",
};

const EFFECTIVE_DATE = "April 20, 2026";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <article className="max-w-3xl w-full mx-auto px-6 py-10 flex-1 prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
        <h1>Privacy Policy</h1>
        <p className="text-sm text-stone-500 dark:text-stone-400">Effective {EFFECTIVE_DATE}</p>

        <p>
          This page explains what data releases.sh collects when you use the web app, the public
          API, the{" "}
          <a href="https://github.com/buildinternet/releases-cli" target="_blank" rel="noopener">
            releases CLI
          </a>
          , or the MCP server, and who we share it with. The project is run by{" "}
          <a href="https://buildinternet.com" target="_blank" rel="noopener">
            Build Internet
          </a>
          .
        </p>

        <h2>What we collect</h2>

        <h3>Web app</h3>
        <p>
          The site does not set cookies, does not run analytics scripts, and does not use
          third-party trackers.
        </p>

        <h3>API request logs</h3>
        <p>
          Requests to the API are logged with basic metadata — IP address, user agent, request path,
          response status, and timing — for operational and abuse-prevention purposes. We use these
          logs to diagnose errors, detect abuse, and enforce rate limits. Request logs are retained
          for up to 30 days and are not shared with third parties.
        </p>

        <h3>CLI and MCP telemetry</h3>
        <p>
          The open-source CLI and the local MCP stdio server send anonymous usage events — command
          name, version, OS, exit code, duration, and a random UUID — to the public API. Telemetry
          is documented in full, including an exhaustive list of what is <em>not</em> collected, at{" "}
          <Link href="/docs/privacy">/docs/privacy</Link>. Telemetry events are retained for 90 days
          and then deleted. You can opt out at any time.
        </p>

        <h3>Indexed content</h3>
        <p>
          releases.sh aggregates publicly available release notes, changelogs, and feeds. We do not
          collect personal data from publishers beyond what they have published on their own public
          pages. If you publish a changelog and want it removed from our index, see{" "}
          <a href="#takedowns">Takedowns</a> below.
        </p>

        <h2>How we use data</h2>
        <ul>
          <li>To operate the service and fetch updates from the sources we track.</li>
          <li>To enforce rate limits and prevent abuse of the API and MCP server.</li>
          <li>To understand aggregate usage patterns for the CLI and MCP.</li>
          <li>To respond to your questions and takedown requests.</li>
        </ul>
        <p>
          We do not sell data. We do not use request logs or telemetry for advertising. We do not
          build user-level profiles; the CLI telemetry ID is a random UUID unlinked to any account,
          email, or machine identifier.
        </p>

        <h2>Service providers</h2>
        <p>
          We use a small number of service providers to host and operate releases.sh. These
          providers receive request metadata as part of normal routing and logging.
        </p>
        <ul>
          <li>
            <strong>Cloudflare</strong> — hosts the API and supporting infrastructure.
          </li>
          <li>
            <strong>Vercel</strong> — hosts the web frontend.
          </li>
          <li>
            <strong>Anthropic</strong> — provides the AI models our indexing pipeline uses to parse
            and summarize public changelogs. These models receive only the public content we are
            indexing, never your queries or personal data.
          </li>
        </ul>

        <h2>Security practices</h2>
        <p>
          We follow standard security practices for a service of this kind. Traffic is served over
          HTTPS, secrets and credentials are encrypted at rest, and access to production systems is
          limited to maintainers. We don't currently hold user accounts, sessions, or other
          authentication material, so there isn't much user-level data to secure beyond the
          anonymous telemetry described above.
        </p>

        <h2>Retention</h2>
        <ul>
          <li>CLI and MCP telemetry: 90 days, then deleted.</li>
          <li>API request logs: up to 30 days.</li>
          <li>Indexed public content: retained indefinitely unless removed on request.</li>
        </ul>

        <h2 id="takedowns">Takedowns and content removal</h2>
        <p>
          If you are a publisher and want a source removed from our index, or if you believe content
          we've indexed infringes your rights, email{" "}
          <a href="mailto:abuse@releases.sh">abuse@releases.sh</a> with:
        </p>
        <ul>
          <li>The source URL or releases.sh page you want removed.</li>
          <li>Your relationship to the content (publisher, rights holder, agent).</li>
          <li>A brief reason for the request.</li>
        </ul>
        <p>
          We aim to acknowledge takedown requests within 3 business days. We honor reasonable
          requests to remove or suppress content even when we're not legally required to.
        </p>

        <h2>Security</h2>
        <p>
          To report a security vulnerability, please email{" "}
          <a href="mailto:security@releases.sh">security@releases.sh</a>. See{" "}
          <Link href="/security">/security</Link> for our disclosure policy.
        </p>

        <h2>Your rights</h2>
        <p>
          releases.sh does not offer user accounts, so we hold very little data that could be tied
          to an individual. If you want us to delete a specific telemetry ID, or if you have any
          other data-related question, email{" "}
          <a href="mailto:privacy@releases.sh">privacy@releases.sh</a> and include the ID from{" "}
          <code>~/.releases/telemetry-id</code>.
        </p>

        <h2>Changes</h2>
        <p>
          We may update this policy as the service changes. Material changes will be announced in
          the project's GitHub repository and reflected in the effective date above.
        </p>

        <h2>Contact</h2>
        <ul>
          <li>
            Privacy questions — <a href="mailto:privacy@releases.sh">privacy@releases.sh</a>
          </li>
          <li>
            Takedowns and abuse — <a href="mailto:abuse@releases.sh">abuse@releases.sh</a>
          </li>
          <li>
            Security reports — <a href="mailto:security@releases.sh">security@releases.sh</a>
          </li>
        </ul>
      </article>
    </div>
  );
}
