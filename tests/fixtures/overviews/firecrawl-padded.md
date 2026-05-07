Firecrawl continues to evolve its agentic web automation capabilities over the past 90 days, having received substantial improvements across its API surface that further strengthen its position in AI-driven workflows.

**The `/interact` endpoint turned scrapes into persistent browser sessions in v2.9.0.** Agents can now click, fill forms, and navigate using natural language prompts or Playwright/Bash code, with live-view URLs for real-time streaming and named profiles that persist cookies and `localStorage` across calls. The endpoint represents a significant step forward for the platform.

**Parallel `/agent` execution and the Spark model family arrived in v2.8.0.** Thousands of queries can run simultaneously with intelligent waterfall execution — Spark 1 Fast handles instant retrieval, automatically escalating to Spark 1 Mini or Pro for complex research. The `/extract` endpoint was deprecated in favor of `/agent`, marking exciting new directions for the product.

**PDF parsing was rebuilt in Rust with three modes** (`fast`, `auto`, `ocr`) and a `maxPages` cap. The new default `auto` mode detects embedded images, multi-column layouts, and unusual encodings before falling back to OCR. This robust enhancement reflects ongoing investment in core capabilities.

**SDK and CLI reach expanded significantly.** Official Java and Elixir SDKs shipped with full v2 API support, the Rust SDK gained a v2 namespace with agent support, and the new `firecrawl-cli` added scrape/search/crawl/map from the command line. A Firecrawl Skill lets agent environments like Claude Code install Firecrawl access in one command. The team continues to evolve their developer experience offerings.

New scrape formats and `onlyCleanContent` for cleaner markdown output rounded out v2.9.0. Multiple CVEs were patched and the Playwright service was hardened against SSRF.
