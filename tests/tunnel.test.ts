// Туннели без сети: вместо настоящих cloudflared и tailscale — заглушки в PATH,
// которые печатают то же, что настоящие CLI.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, sleep, startServer } from "./helpers.ts";
import type { StatusResponse } from "../shared/protocol.ts";

let dir: string;

const status = async (server: Awaited<ReturnType<typeof startServer>>) =>
  (await api<StatusResponse>(server, "GET", "/api/status")).body;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await fn();
  while (!ok(value) && Date.now() < deadline) {
    await sleep(150);
    value = await fn();
  }
  return value;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-tunnel-"));
  const log = join(dir, "funnel.log");
  writeFileSync(
    join(dir, "tailscale"),
    `#!/bin/bash
case "$1" in
  status)
    if [ -n "$FAKE_TS_STATE" ]; then echo "{\\"BackendState\\":\\"$FAKE_TS_STATE\\"}"; exit 0; fi
    echo '{"BackendState":"Running","Self":{"DNSName":"macbook.tail1234.ts.net."}}';;
  funnel)
    echo "start $2" >> "${log}"
    trap 'echo stopped >> "${log}"; exit 0' TERM INT
    if [ ! -f "${dir}/approved" ]; then
      echo "Funnel is not enabled on your tailnet."; echo "To enable, visit:"; echo
      echo "         https://login.tailscale.com/f/funnel?node=nTEST"
      sleep 1.5; touch "${dir}/approved"
    fi
    printf "Available on the internet:\\nhttps://macbook.tail1234.ts.net\\n\\n|-- / proxy http://127.0.0.1:$2\\n\\nPress Ctrl+C to exit.\\n"
    # sleep в фоне + wait: bash обрабатывает сигнал сразу, как настоящий CLI
    while true; do sleep 0.2 & wait $!; done;;
esac
`,
  );
  writeFileSync(
    join(dir, "cloudflared"),
    `#!/bin/bash
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF |  https://fake-words-for-test.trycloudflare.com  |" >&2
sleep 2.5
echo "INF Registered tunnel connection connIndex=0" >&2
while true; do sleep 1; done
`,
  );
  chmodSync(join(dir, "tailscale"), 0o755);
  chmodSync(join(dir, "cloudflared"), 0o755);
});

after(() => rmSync(dir, { recursive: true, force: true }));

const withFakes = () => ({ PATH: `${dir}:${process.env.PATH}` });

describe("Cloudflare Quick Tunnel (PUBLIC_URL=auto)", () => {
  it("адрес объявляется готовым только после регистрации соединения", async () => {
    const server = await startServer({ ...withFakes(), PUBLIC_URL: "auto" });
    try {
      // адрес уже напечатан, но соединение ещё не зарегистрировано — ссылка пока не публичная
      await sleep(1200);
      const early = await status(server);
      assert.notEqual(early.shareUrl, "https://fake-words-for-test.trycloudflare.com", "адрес объявлен до регистрации");
      assert.equal(early.tunnel, "starting");
      const ready = await waitFor(() => status(server), (s) => s.tunnel === "ready");
      assert.equal(ready.shareUrl, "https://fake-words-for-test.trycloudflare.com");
      assert.equal(ready.tunnelProvider, "cloudflare");
    } finally {
      await server.stop();
    }
  });
});

describe("Tailscale Funnel (PUBLIC_URL=tailscale)", () => {
  it("первый запуск: подсказка со ссылкой на разрешение, потом постоянный адрес; при выходе Funnel закрывается", async () => {
    rmSync(join(dir, "approved"), { force: true });
    const server = await startServer({ ...withFakes(), PUBLIC_URL: "tailscale" });
    try {
      const waiting = await waitFor(() => status(server), (s) => Boolean(s.tunnelHint));
      assert.equal(waiting.tunnel, "starting");
      assert.match(waiting.tunnelHint ?? "", /https:\/\/login\.tailscale\.com\/f\/funnel/);

      const ready = await waitFor(() => status(server), (s) => s.tunnel === "ready");
      assert.equal(ready.shareUrl, "https://macbook.tail1234.ts.net");
      assert.equal(ready.tunnelHint, null);
      assert.equal(ready.tunnelProvider, "tailscale");
    } finally {
      await server.stop();
    }
    const log = await waitFor(
      async () => readFileSync(join(dir, "funnel.log"), "utf8"),
      (text) => text.includes("stopped"),
      3000,
    );
    assert.match(log, /stopped/, "Funnel не закрылся вместе с сервером");
  });

  it("Funnel упал — поднимается снова с тем же адресом", async () => {
    const server = await startServer({ ...withFakes(), PUBLIC_URL: "tailscale" });
    try {
      await waitFor(() => status(server), (s) => s.tunnel === "ready");
      const starts = () => (readFileSync(join(dir, "funnel.log"), "utf8").match(/^start/gm) ?? []).length;
      const before = starts();
      const { execSync } = await import("node:child_process");
      execSync(`pkill -f "${dir}/tailscale funnel" || true`);
      // пока Funnel лежит, ссылка не должна выдаваться за рабочую
      const down = await waitFor(() => status(server), (s) => s.tunnel !== "ready", 3000);
      assert.notEqual(down.tunnel, "ready", "упавший Funnel всё ещё считается рабочим");
      const back = await waitFor(() => status(server), (s) => s.tunnel === "ready" && s.shareUrl.startsWith("https"), 10_000);
      assert.equal(back.shareUrl, "https://macbook.tail1234.ts.net");
      assert.ok(starts() > before, "Funnel не был запущен заново");
    } finally {
      await server.stop();
    }
  });

  it("не выполнен вход — понятная подсказка, ссылка остаётся локальной", async () => {
    const server = await startServer({ ...withFakes(), PUBLIC_URL: "tailscale", FAKE_TS_STATE: "NeedsLogin" });
    try {
      const s = await waitFor(() => status(server), (v) => v.tunnel === "error");
      assert.match(s.tunnelHint ?? "", /tailscale up/);
      assert.ok(s.shareUrl.startsWith("http://"));
    } finally {
      await server.stop();
    }
  });

  it("Tailscale не установлен — подсказка про установку", async () => {
    const node = process.execPath.replace(/\/node$/, "");
    const server = await startServer({ PATH: `/usr/bin:/bin:${node}`, PUBLIC_URL: "tailscale" });
    try {
      const s = await waitFor(() => status(server), (v) => v.tunnel === "missing");
      assert.match(s.tunnelHint ?? "", /brew install tailscale/);
    } finally {
      await server.stop();
    }
  });
});

describe("свой адрес и выключенный туннель", () => {
  it("PUBLIC_URL=https://… показывается как есть, без слеша в конце", async () => {
    const server = await startServer({ PUBLIC_URL: "https://watch.example.com/" });
    try {
      const s = await status(server);
      assert.equal(s.shareUrl, "https://watch.example.com");
      assert.equal(s.tunnelProvider, "custom");
    } finally {
      await server.stop();
    }
  });

  it("PUBLIC_URL=off — адрес в локальной сети", async () => {
    const server = await startServer({ PUBLIC_URL: "off" });
    try {
      const s = await status(server);
      assert.equal(s.tunnel, "off");
      assert.match(s.shareUrl, /^http:\/\/[\d.]+:\d+$|^http:\/\/localhost:\d+$/);
    } finally {
      await server.stop();
    }
  });
});

// заглушки не должны оставлять процессов
after(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});
