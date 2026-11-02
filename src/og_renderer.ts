import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { safeLogError } from "./security";
import type { WorldDO } from "./world_do";

export async function refreshOgScreenshots(
  env: Env,
  stub: DurableObjectStub<WorldDO>,
  siteOrigin: string,
): Promise<{ refreshed: boolean; note: string; capturedAt?: number }> {
  if (!env.BROWSER) {
    return { refreshed: false, note: "BROWSER binding unavailable" };
  }

  const origin = siteOrigin.replace(/\/+$/, "");
  const targetUrl = `${origin}/?og=1&ts=${Date.now()}`;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as BrowserWorker);
    const page = await browser.newPage();

    // 1. Landscape 16:9 (1376x768)
    await page.setViewport({ width: 1376, height: 768, deviceScaleFactor: 1 });
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 25_000 });
    await page
      .waitForFunction("window.__geminIslandOgReady === true", { timeout: 18_000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 450));
    const landscape = (await page.screenshot({
      type: "jpeg",
      quality: 82,
      encoding: "base64",
    })) as string;

    // 2. Square 1:1 (1024x1024)
    await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
    await page.evaluate("window.dispatchEvent(new Event('resize'))");
    await new Promise((r) => setTimeout(r, 320));
    const square = (await page.screenshot({
      type: "jpeg",
      quality: 82,
      encoding: "base64",
    })) as string;

    // 3. Vertical 9:16 (768x1376)
    await page.setViewport({ width: 768, height: 1376, deviceScaleFactor: 1 });
    await page.evaluate("window.dispatchEvent(new Event('resize'))");
    await new Promise((r) => setTimeout(r, 320));
    const vertical = (await page.screenshot({
      type: "jpeg",
      quality: 82,
      encoding: "base64",
    })) as string;

    const capturedAt = Date.now();
    await stub.saveOgSnapshots({
      landscape,
      square,
      vertical,
      capturedAt,
    });

    return {
      refreshed: true,
      note: "Captured 24h live GeminIsland OG cards (1376x768, 1024x1024, 768x1376)",
      capturedAt,
    };
  } catch (err) {
    safeLogError("og_renderer", err, [env.GEMINI_API_KEY, env.CREATOR_HMAC_SECRET]);
    return { refreshed: false, note: "Transient browser capture error" };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
