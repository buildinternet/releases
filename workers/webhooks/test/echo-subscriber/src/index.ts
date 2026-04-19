export default {
  async fetch(req: Request): Promise<Response> {
    const body = await req.text();
    const headers = Object.fromEntries(req.headers.entries());
    console.log(JSON.stringify({ kind: "echo", method: req.method, headers, body }));
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
