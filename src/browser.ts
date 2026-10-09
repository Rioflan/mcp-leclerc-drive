/**
 * ChromeSession — runs HTTP requests inside a real Chrome via the Chrome
 * DevTools Protocol (CDP), so they carry a genuine browser fingerprint and
 * execute DataDome's JS challenge. This is what lets the tool survive DataDome's
 * "active" mode, which blocks headless clients and cookie-replay (HTTP 403)
 * while letting a real browser through.
 *
 * How it works:
 *  - launches the user's installed Chrome with a *persistent, dedicated* profile
 *    and a debug port, and NO automation flags (navigator.webdriver stays false);
 *  - connects over CDP with Node's built-in WebSocket — no external dependency;
 *  - `fetch()` navigates a page to the right origin (once, then reused) and runs
 *    `window.fetch` in that page's context via Runtime.evaluate. Cookies, TLS
 *    fingerprint and the solved DataDome challenge all come for free.
 *
 * The user logs into Leclerc Drive once in the window; the persistent profile
 * keeps the session across restarts.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface PageResponse {
  status: number;
  ok: boolean;
  statusText: string;
  text(): string;
  json(): unknown;
}

export interface ChromeOptions {
  /** Path to the Chrome binary; auto-detected per-OS when omitted. */
  chromePath?: string;
  /** Persistent user-data-dir so the Leclerc login survives restarts. */
  profileDir: string;
  /** Remote debugging port. */
  port: number;
  /** Headless is detectable by DataDome — default false (a window opens). */
  headless: boolean;
  /**
   * Work in a tab of its own, opened on connect and closed by close(), instead
   * of the first open tab. Lets several clients (or a user watching the window)
   * share one Chrome without navigating each other's tab.
   */
  dedicatedTab?: boolean;
}

const DEFAULT_CHROME: Record<string, string> = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function tryJson(url: string, method = "GET"): Promise<Any> {
  try {
    const r = await fetch(url, { method });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export class ChromeSession {
  private ws?: Any;
  private msgId = 0;
  private readonly pending = new Map<number, (m: Any) => void>();
  private eventWaiters: Array<{ method: string; res: () => void }> = [];
  private currentUrl = "";
  private launching?: Promise<void>;
  private targetId?: string;

  constructor(private readonly opts: ChromeOptions) {}

  private chromeBinary(): string {
    return this.opts.chromePath || DEFAULT_CHROME[platform()] || "google-chrome";
  }

  private async ensureLaunched(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return;
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = undefined;
      });
    }
    return this.launching;
  }

  private async launch(): Promise<void> {
    const base = `http://127.0.0.1:${this.opts.port}`;

    // Reuse an already-running debug Chrome on this port (e.g. a previous run).
    let version = await tryJson(`${base}/json/version`);
    if (!version) {
      const args = [
        `--remote-debugging-port=${this.opts.port}`,
        `--user-data-dir=${this.opts.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--no-first-run",
        "about:blank",
      ];
      if (this.opts.headless) args.unshift("--headless=new");
      const child = spawn(this.chromeBinary(), args, { detached: true, stdio: "ignore" });
      child.unref();
      for (let i = 0; i < 40 && !version; i++) {
        await delay(500);
        version = await tryJson(`${base}/json/version`);
      }
      if (!version) {
        throw new Error(
          `Chrome ne démarre pas sur le port ${this.opts.port}. Vérifie que Google ` +
            `Chrome est installé (ou définis LECLERC_CHROME_PATH).`,
        );
      }
    }

    let page: Any;
    if (this.opts.dedicatedTab) {
      // Tab left over from a lost connection: close it before opening a new one.
      if (this.targetId) await tryJson(`${base}/json/close/${this.targetId}`);
      page = await tryJson(`${base}/json/new?about:blank`, "PUT");
      this.targetId = page?.id;
    } else {
      const targets: Any[] = (await tryJson(`${base}/json/list`)) || [];
      page = targets.find((t) => t.type === "page");
      if (!page) page = await tryJson(`${base}/json/new`, "PUT");
    }
    if (!page?.webSocketDebuggerUrl) {
      throw new Error("Impossible d'ouvrir un onglet CDP dans Chrome.");
    }

    const WS: Any = (globalThis as Any).WebSocket;
    const ws = new WS(page.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("Connexion CDP échouée."));
    });
    ws.onmessage = (e: Any) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.method) {
        this.eventWaiters = this.eventWaiters.filter((w) => {
          if (w.method === m.method) {
            w.res();
            return false;
          }
          return true;
        });
      }
    };
    ws.onclose = () => {
      // Unblock in-flight calls; the next fetch() reconnects (ensureLaunched).
      for (const res of this.pending.values()) res({ error: { message: "connexion CDP fermée" } });
      this.pending.clear();
      this.currentUrl = "";
    };
    this.ws = ws;
    await this.cdp("Page.enable");
    this.currentUrl = page.url || "";
  }

  private cdp(method: string, params: Any = {}): Promise<Any> {
    const id = ++this.msgId;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private waitEvent(method: string, timeoutMs = 20000): Promise<void> {
    return new Promise<void>((res) => {
      const w = { method, res: () => res() };
      this.eventWaiters.push(w);
      setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((x) => x !== w);
        res();
      }, timeoutMs);
    });
  }

  /** Navigate the page to `baseUrl`'s origin if it isn't already there. */
  private async ensurePage(baseUrl: string): Promise<void> {
    const target = new URL(baseUrl).origin;
    let current = "";
    try {
      current = new URL(this.currentUrl).origin;
    } catch {
      /* about:blank etc. */
    }
    if (current === target) return;
    const loaded = this.waitEvent("Page.loadEventFired");
    await this.cdp("Page.navigate", { url: baseUrl });
    await loaded;
    await delay(1800); // let the DataDome JS challenge resolve
    this.currentUrl = baseUrl;
  }

  /**
   * Run `fetch(url, opts)` inside a page on `baseUrl`'s origin. The page's
   * cookies, UA and solved DataDome challenge apply automatically, so do NOT
   * set Cookie/User-Agent in `opts.headers`.
   */
  async fetch(
    baseUrl: string,
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<PageResponse> {
    await this.ensureLaunched();
    await this.ensurePage(baseUrl);

    const args = {
      url,
      init: {
        method: opts.method || "GET",
        headers: opts.headers || {},
        body: opts.body,
        credentials: "include",
      },
    };
    const expression = `(async () => {
      const a = ${JSON.stringify(args)};
      try {
        const r = await fetch(a.url, a.init);
        const t = await r.text();
        return { status: r.status, ok: r.ok, statusText: r.statusText, body: t };
      } catch (e) { return { error: String(e) }; }
    })()`;

    const r = await this.cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const v = r.result?.result?.value;
    if (!v || v.error) {
      const detail = v?.error || r.result?.exceptionDetails?.text || "erreur inconnue";
      throw new Error(`Requête via le navigateur échouée: ${detail}`);
    }
    return {
      status: v.status,
      ok: v.ok,
      statusText: v.statusText,
      text: () => v.body,
      json: () => JSON.parse(v.body),
    };
  }

  /**
   * URLs of the pages open in the debug Chrome (e.g. the tab the user logged
   * into). Empty when Chrome is not running; never launches it.
   */
  async pageUrls(): Promise<string[]> {
    const targets: Any[] = (await tryJson(`http://127.0.0.1:${this.opts.port}/json/list`)) || [];
    return targets.filter((t) => t.type === "page" && typeof t.url === "string").map((t) => t.url);
  }

  async close(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    if (this.opts.dedicatedTab && this.targetId) {
      await tryJson(`http://127.0.0.1:${this.opts.port}/json/close/${this.targetId}`);
      this.targetId = undefined;
    }
  }
}
