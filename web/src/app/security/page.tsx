import Link from "next/link";
import type { Metadata } from "next";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "Security",
  description: "How to report security vulnerabilities in releases.sh.",
};

export default function SecurityPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <article className="max-w-3xl w-full mx-auto px-6 py-10 flex-1 prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
        <h1>Security</h1>

        <p>
          If you've found a security issue in the releases.sh web app, API, CLI, or MCP server, we
          want to hear from you. Please email{" "}
          <a href="mailto:security@releases.sh">security@releases.sh</a> with details.
        </p>

        <p>We do not offer a bug bounty or paid reward program, and we have no plans to do so.</p>

        <p>
          For issues in the open-source CLI, you're also welcome to open a pull request or issue
          directly at{" "}
          <a href="https://github.com/buildinternet/releases-cli" target="_blank" rel="noopener">
            buildinternet/releases-cli
          </a>
          . If the issue is sensitive, please email instead.
        </p>

        <h2>What to include</h2>
        <ul>
          <li>The affected endpoint, page, or binary.</li>
          <li>Steps to reproduce and, if possible, a minimal proof of concept.</li>
          <li>The impact you observed or believe is possible.</li>
          <li>Your contact info if you want credit once the issue is fixed.</li>
        </ul>

        <h2>Scope</h2>
        <p>In scope:</p>
        <ul>
          <li>
            <code>releases.sh</code> and its subdomains (<code>api.releases.sh</code>,{" "}
            <code>*.releases.sh</code>).
          </li>
          <li>
            The open-source CLI at{" "}
            <a href="https://github.com/buildinternet/releases-cli" target="_blank" rel="noopener">
              buildinternet/releases-cli
            </a>
            .
          </li>
          <li>The remote MCP server.</li>
        </ul>
        <p>Out of scope:</p>
        <ul>
          <li>
            Vulnerabilities in indexed third-party content — report those to the original publisher.
          </li>
          <li>
            Missing security headers or TLS configuration that doesn't lead to a concrete issue.
          </li>
          <li>Rate-limit bypass reports already covered by our public rate-limit policy.</li>
          <li>
            Volumetric attacks (DDoS, mass scraping, spam) — these are handled by our upstream
            provider; no report is needed.
          </li>
          <li>Automated scanner output without a working proof of concept.</li>
        </ul>

        <h2>Safe harbor</h2>
        <p>
          We won't pursue legal action against researchers who make a good-faith effort to follow
          this policy: no data exfiltration beyond what's needed to demonstrate the issue, no
          disruption of the service, no access to other users' data, and reasonable time to fix
          before public disclosure.
        </p>

        <h2>Also see</h2>
        <p>
          Our <Link href="/.well-known/security.txt">security.txt</Link> (
          <a href="https://www.rfc-editor.org/rfc/rfc9116" target="_blank" rel="noopener">
            RFC 9116
          </a>
          ) lists the same contact in machine-readable form.
        </p>
      </article>
    </div>
  );
}
