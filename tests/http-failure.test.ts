import assert from "node:assert/strict";
import test from "node:test";

import { describeHttpFailure, summarizeErrorBody } from "../src/http-failure.ts";
import { fetchYamatoStatus } from "../src/scrapers/yamato.ts";

const AKAMAI_DENIED_PAGE = `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>

You don't have permission to access "http&#58;&#47;&#47;www&#46;kuronekoyamato&#46;co&#46;jp&#47;ytc&#47;chien&#47;chien&#95;hp&#46;html" on this server.<P>
Reference&#32;&#35;18&#46;5a2c3e17&#46;1763510400&#46;1b2c3d4e
</BODY>
</HTML>`;

test("describeHttpFailure reports status, blocker headers and the body text", async () => {
  const response = new Response(AKAMAI_DENIED_PAGE, {
    status: 403,
    statusText: "Forbidden",
    headers: {
      server: "AkamaiGHost",
      "content-type": "text/html",
      "akamai-grn": "0.5a2c3e17.1763510400.1b2c3d4e",
      "x-unrelated": "ignored",
    },
  });

  const description = await describeHttpFailure(response);

  assert.match(description, /^403 Forbidden /);
  assert.match(description, /server=AkamaiGHost/);
  assert.match(description, /akamai-grn=0\.5a2c3e17\.1763510400\.1b2c3d4e/);
  assert.doesNotMatch(description, /x-unrelated/);
  assert.match(description, /body="Access Denied Access Denied You don't have permission/);
  assert.match(description, /Reference #18\.5a2c3e17\.1763510400\.1b2c3d4e/);
});

test("describeHttpFailure omits empty parts", async () => {
  assert.equal(await describeHttpFailure(new Response(null, { status: 503 })), "503");
});

test("describeHttpFailure caps a large body", async () => {
  const description = await describeHttpFailure(new Response("x".repeat(100_000), { status: 500 }));
  assert.ok(description.length < 400, `unexpectedly long: ${description.length}`);
  assert.match(description, /…"$/);
});

test("summarizeErrorBody drops scripts, styles and comments", () => {
  assert.equal(
    summarizeErrorBody("<style>a{}</style><script>var x=1</script><!-- c --><p>Blocked&nbsp;by\n WAF</p>"),
    "Blocked by WAF",
  );
});

test("describeHttpFailure cannot produce Google Chat mentions or links", async () => {
  const response = new Response("<p>&lt;users/all&gt; see &lt;https://evil.example|here&gt;</p>", {
    status: 403,
    headers: { server: "<users/all>" },
  });
  const description = await describeHttpFailure(response);
  assert.doesNotMatch(description, /[<>]/);
  assert.match(description, /server=‹users\/all›/);
  assert.match(description, /‹users\/all› see ‹https:\/\/evil\.example\|here›/);
});

test("fetchYamatoStatus puts the failure details in its error", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(AKAMAI_DENIED_PAGE, {
      status: 403,
      statusText: "Forbidden",
      headers: { server: "AkamaiGHost" },
    });
  };
  try {
    await assert.rejects(
      fetchYamatoStatus({ retryDelayMs: 0 }),
      /Yamato fetch failed after 2 attempts: 403 Forbidden \[server=AkamaiGHost; [^\]]*\] body="Access Denied/,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchYamatoStatus sends browser-like headers and recovers on retry", async () => {
  const originalFetch = globalThis.fetch;
  const seenHeaders: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    seenHeaders.push(new Headers(init?.headers));
    if (seenHeaders.length === 1) return new Response("Technical Difficulties", { status: 403 });
    return new Response(
      "<p>●荷受けを停止している地域</p><table><tr><th>都道府県</th><th>備考</th></tr><tr><td>石川県</td><td>荷受け停止</td></tr></table>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
  try {
    const source = await fetchYamatoStatus({ retryDelayMs: 0 });
    assert.equal(seenHeaders.length, 2);
    assert.match(seenHeaders[0].get("user-agent") ?? "", /^Mozilla\/5\.0 /);
    assert.match(seenHeaders[0].get("accept-language") ?? "", /^ja/);
    assert.match(source.text, /石川県/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchYamatoStatus does not retry a 404", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("Not Found", { status: 404, statusText: "Not Found" });
  };
  try {
    await assert.rejects(fetchYamatoStatus({ retryDelayMs: 0 }), /Yamato fetch failed: 404 Not Found/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
