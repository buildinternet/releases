import { describe, it, expect } from "bun:test";
import { verifyDomainControl } from "./claim-verify.js";

const TOKEN = "relv_test-token-value";
const DOMAIN = "acme.example.com";

function fetchImplFor(handlers: {
  wellKnown?: () => Promise<Response>;
  dns?: () => Promise<Response>;
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/.well-known/releases-verify.txt")) {
      if (handlers.wellKnown) return handlers.wellKnown();
      return new Response(null, { status: 404 });
    }
    if (url.includes("cloudflare-dns.com/dns-query")) {
      if (handlers.dns) return handlers.dns();
      return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function textResponse(body: string, status = 200): Promise<Response> {
  return Promise.resolve(new Response(body, { status, headers: { "content-type": "text/plain" } }));
}

function dohResponse(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/dns-json" },
    }),
  );
}

describe("verifyDomainControl", () => {
  it("well-known exact match verifies", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse(TOKEN),
      dns: () => dohResponse({ Status: 3 }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.verified).toBe(true);
    expect(result.method).toBe("well-known");
    expect(result.checked.wellKnown).toBe("ok");
    expect(result.checked.dnsTxt).toBe("mismatch");
  });

  it("well-known body with trailing newline still verifies (trim)", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse(`${TOKEN}\n`),
      dns: () => dohResponse({ Status: 3 }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.verified).toBe(true);
    expect(result.checked.wellKnown).toBe("ok");
  });

  it("well-known mismatch, both mechanisms checked", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("not-the-token"),
      dns: () => dohResponse({ Status: 3 }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.verified).toBe(false);
    expect(result.method).toBeNull();
    expect(result.checked.wellKnown).toBe("mismatch");
    expect(result.checked.dnsTxt).toBe("mismatch");
  });

  it("well-known HTML challenge page counts as unreachable, not mismatch", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () =>
        Promise.resolve(
          new Response("<html><body>Just a moment...</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        ),
      dns: () => dohResponse({ Status: 3 }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.checked.wellKnown).toBe("unreachable");
    expect(result.verified).toBe(false);
  });

  it("well-known fetch throw is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.checked.wellKnown).toBe("unreachable");
    expect(result.checked.dnsTxt).toBe("unreachable");
    expect(result.verified).toBe(false);
  });

  it("private/local host is refused as unreachable", async () => {
    const fetchImpl = fetchImplFor({});
    const result = await verifyDomainControl("localhost", TOKEN, { fetchImpl });
    expect(result.checked.wellKnown).toBe("unreachable");
    expect(result.verified).toBe(false);
  });

  it("DNS TXT ok via quoted answer data", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("nope"),
      dns: () =>
        dohResponse({
          Status: 0,
          Answer: [{ name: `_releases-challenge.${DOMAIN}.`, type: 16, data: `"${TOKEN}"` }],
        }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.verified).toBe(true);
    expect(result.method).toBe("dns-txt");
    expect(result.checked.dnsTxt).toBe("ok");
  });

  it("DNS TXT ok via unquoted answer data", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("nope"),
      dns: () =>
        dohResponse({
          Status: 0,
          Answer: [{ name: `_releases-challenge.${DOMAIN}.`, type: 16, data: TOKEN }],
        }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.verified).toBe(true);
    expect(result.checked.dnsTxt).toBe("ok");
  });

  it("DNS NXDOMAIN is a mismatch, not unreachable", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("nope"),
      dns: () => dohResponse({ Status: 3 }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.checked.dnsTxt).toBe("mismatch");
  });

  it("DoH 500 is unreachable", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("nope"),
      dns: () => dohResponse({ error: "boom" }, 500),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.checked.dnsTxt).toBe("unreachable");
  });

  it("malformed DoH JSON is unreachable", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("nope"),
      dns: () => Promise.resolve(new Response("not json", { status: 200 })),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.checked.dnsTxt).toBe("unreachable");
  });

  it("either mechanism passing verifies overall (DNS only)", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("nope"),
      dns: () =>
        dohResponse({
          Status: 0,
          Answer: [{ name: `_releases-challenge.${DOMAIN}.`, type: 16, data: TOKEN }],
        }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.verified).toBe(true);
    expect(result.method).toBe("dns-txt");
  });

  it("well-known oversized streamed body is unreachable and the stream is cancelled early", async () => {
    const CHUNK_SIZE = 8 * 1024;
    // 64KB MAX_BYTES + a few chunks past it — if the reader were buffering
    // the whole thing (e.g. via res.text()) before checking length, this
    // would still pass; the point of this test is that we stop pulling
    // chunks once the running total crosses MAX_BYTES.
    const TOTAL_CHUNKS = 20;
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cancelled) return;
        if (pulled >= TOTAL_CHUNKS) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(CHUNK_SIZE).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = fetchImplFor({
      wellKnown: () =>
        Promise.resolve(
          new Response(stream, { status: 200, headers: { "content-type": "text/plain" } }),
        ),
      dns: () => dohResponse({ Status: 3 }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.checked.wellKnown).toBe("unreachable");
    expect(result.verified).toBe(false);
    // Bounded: reader should give up well before consuming every chunk.
    expect(pulled).toBeLessThan(TOTAL_CHUNKS);
    expect(cancelled).toBe(true);
  });

  it("neither mechanism passing does not verify", async () => {
    const fetchImpl = fetchImplFor({
      wellKnown: () => textResponse("nope"),
      dns: () => dohResponse({ Status: 3 }),
    });
    const result = await verifyDomainControl(DOMAIN, TOKEN, { fetchImpl });
    expect(result.verified).toBe(false);
    expect(result.method).toBeNull();
  });
});
