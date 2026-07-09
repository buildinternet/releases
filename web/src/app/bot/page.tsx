import type { Metadata } from "next";
import {
  WEB_BOT_AUTH_DIRECTORY_URL,
  WEB_BOT_AUTH_SIGNATURE_AGENT,
  WEB_BOT_AUTH_USER_AGENT,
} from "@buildinternet/releases-core/web-bot-auth";

export const metadata: Metadata = {
  title: "Releases crawler",
  description:
    "How the Releases crawler identifies itself, what it fetches, and how to control its access.",
};

const USER_AGENT = WEB_BOT_AUTH_USER_AGENT;

export default function BotPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <article className="max-w-3xl w-full mx-auto px-6 py-10 flex-1 prose prose-stone dark:prose-invert prose-headings:tracking-tight prose-code:before:content-none prose-code:after:content-none prose-code:bg-stone-100 prose-code:dark:bg-stone-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-mono">
        <h1>The Releases crawler</h1>
        <p>
          Releases (<a href="https://releases.sh">releases.sh</a>) is a changelog indexer and
          registry for AI agents and developers. Our crawler fetches publicly available changelog
          and release-note pages so they can be searched and summarized.
        </p>

        <h2>How to identify our requests</h2>
        <ul>
          <li>
            <strong>User-Agent:</strong> <code>{USER_AGENT}</code>
          </li>
          <li>
            <strong>Web Bot Auth:</strong> direct requests are signed with HTTP Message Signatures.
            Our public keys are published at{" "}
            <a href={WEB_BOT_AUTH_DIRECTORY_URL}>{WEB_BOT_AUTH_DIRECTORY_URL}</a> and our{" "}
            <code>Signature-Agent</code> is <code>{WEB_BOT_AUTH_SIGNATURE_AGENT}</code>.
          </li>
          <li>
            Some JavaScript-rendered pages are fetched via Cloudflare Browser Rendering, which
            identifies itself separately as Cloudflare Browser Rendering.
          </li>
        </ul>

        <h2>Crawl behavior</h2>
        <ul>
          <li>
            We honor <code>robots.txt</code>.
          </li>
          <li>
            Polling backs off automatically (1h to 48h) when a source stops changing, and we fetch
            each source on a per-source interval, so we do not hammer origins.
          </li>
          <li>We fetch only changelog / release-note content, not full sites.</li>
        </ul>

        <h2>Contact and exclusion</h2>
        <p>
          To request that we stop crawling a source, email{" "}
          <a href="mailto:hello@buildinternet.com">hello@buildinternet.com</a> or disallow{" "}
          <code>{USER_AGENT}</code> in your <code>robots.txt</code>.
        </p>
      </article>
    </div>
  );
}
