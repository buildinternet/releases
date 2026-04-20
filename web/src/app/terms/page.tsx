import Link from "next/link";
import type { Metadata } from "next";
import { Header } from "@/components/header";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Acceptable use, rate limits, and takedown policy for the releases.sh web app, API, and MCP server.",
};

const EFFECTIVE_DATE = "April 20, 2026";

export default function TermsPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <article className="max-w-3xl w-full mx-auto px-6 py-10 flex-1 prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
        <h1>Terms of Service</h1>
        <p className="text-sm text-stone-500 dark:text-stone-400">Effective {EFFECTIVE_DATE}</p>

        <p>
          These terms cover use of the releases.sh website, the public API, the remote MCP server,
          and the open-source CLI. By using any of these, you agree to the terms below. If you don't
          agree, please don't use the service.
        </p>

        <h2>The service</h2>
        <p>
          releases.sh is a public index of release notes, changelogs, and version updates pulled
          from third-party sources. It is provided free of charge on a best-effort basis. We may
          change, rate-limit, suspend, or discontinue any part of the service at any time.
        </p>

        <h2>Acceptable use</h2>
        <p>When you use the service, you agree not to:</p>
        <ul>
          <li>
            Circumvent, disable, or overload rate limits, authentication, or other protective
            measures.
          </li>
          <li>
            Scrape the service in a way that degrades performance for other users. Use the API or
            MCP endpoints — they exist so you don't have to scrape.
          </li>
          <li>
            Use the service to attack, probe, or reverse engineer third-party systems, or to
            distribute malware.
          </li>
          <li>
            Republish or resell bulk exports of the index in a way that competes with the service,
            removes attribution to publishers, or misrepresents releases.sh as the origin of the
            content.
          </li>
          <li>Use the service in violation of applicable law.</li>
        </ul>
        <p>
          We may block IPs, revoke API keys, or otherwise restrict access to protect the service or
          its users.
        </p>

        <h2>Rate limits and fair use</h2>
        <p>
          Unauthenticated endpoints are rate-limited per IP. Agents and integrations should handle
          rate-limit responses with exponential backoff. If you need higher limits for a legitimate
          integration, email <a href="mailto:hi@releases.sh">hi@releases.sh</a>.
        </p>

        <h2>Content and attribution</h2>
        <p>
          The release notes, changelog entries, and product descriptions indexed by releases.sh are
          authored by the original publishers. We make no ownership claim over that content;
          copyright and other rights remain with the publishers. releases.sh surfaces the content
          for discovery and reference, typically with a link back to the source.
        </p>
        <p>
          The site's own structure — schema, summaries, evaluations, and code — is produced by{" "}
          <a href="https://buildinternet.com" target="_blank" rel="noopener">
            Build Internet
          </a>
          . The CLI is open source under the license in its repository.
        </p>

        <h2>Takedowns</h2>
        <p>
          If you are a publisher or rights holder and want content removed from our index, email{" "}
          <a href="mailto:abuse@releases.sh">abuse@releases.sh</a>. Include the source or page URL
          and your relationship to the content. We aim to acknowledge within 3 business days and
          honor reasonable requests even when not legally required to. See the{" "}
          <Link href="/privacy#takedowns">Privacy Policy</Link> for more detail.
        </p>

        <h2>Third-party content</h2>
        <p>
          releases.sh links to and summarizes content hosted elsewhere. We don't control that
          content and make no warranty about its accuracy. Follow the source link before acting on
          anything time-sensitive, and check the original publisher's license before redistributing
          their content.
        </p>

        <h2>Disclaimer</h2>
        <p>
          The service is provided "as is" and "as available", without warranties of any kind,
          express or implied, including fitness for a particular purpose, accuracy, availability, or
          non-infringement. To the fullest extent permitted by law, Build Internet is not liable for
          any indirect, incidental, or consequential damages arising from your use of the service.
        </p>

        <h2>Changes to these terms</h2>
        <p>
          We may update these terms as the service changes. Material changes will be announced in
          the project's GitHub repository and reflected in the effective date above. Continued use
          of the service after a change constitutes acceptance of the updated terms.
        </p>

        <h2>Contact</h2>
        <ul>
          <li>
            General — <a href="mailto:hi@releases.sh">hi@releases.sh</a>
          </li>
          <li>
            Takedowns and abuse — <a href="mailto:abuse@releases.sh">abuse@releases.sh</a>
          </li>
          <li>
            Security reports — <a href="mailto:security@releases.sh">security@releases.sh</a>
          </li>
          <li>
            Privacy — <a href="mailto:privacy@releases.sh">privacy@releases.sh</a>
          </li>
        </ul>
      </article>
    </div>
  );
}
