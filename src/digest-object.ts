import { YServer } from "y-partyserver";
import * as Y from "yjs";
import type { Env, Digest } from "./types";
import { generateDigest } from "./anthropic";
import { sendDigestEmail, sendConfirmationEmail } from "./resend";

const MAX_DIGESTS = 30;
const DIGEST_CONTEXT_COUNT = 3;
const SEND_HOUR = 8; // 8am in user's local timezone
const MAX_TOPICS = 20;
const MAX_TOPIC_LENGTH = 200;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export class DigestObject extends YServer<Env> {
  private lastKnownEmail: string | null = null;
  private lastVerificationSentAt: number = 0;
  private lastDigestGeneratedAt: number = 0;
  private roomName: string | null = null;

  // Server-authoritative confirmation state (stored in DO KV, NOT client-writable)
  private serverConfirmed: boolean = false;
  private serverConfirmedAt: number = 0;

  async onLoad() {
    const stored = (await this.ctx.storage.get("doc")) as
      | Uint8Array
      | undefined;
    if (stored) Y.applyUpdate(this.document, new Uint8Array(stored));

    // Ensure this.name is available even when woken by alarm (not fetch).
    // Persist on fetch-triggered loads; restore from KV or digest HTML on alarm loads.
    await this.ensureRoomName();

    this.lastKnownEmail = this.getEmail();

    // Load server-authoritative confirmation state from KV.
    // If unset, this is a pre-migration DO — grandfather in as confirmed.
    // New DOs always get confirmed=false written via checkEmailChanged on first email set.
    const kvConfirmed = await this.ctx.storage.get<boolean>("confirmed");
    if (kvConfirmed === undefined) {
      await this.setConfirmed(true);
    } else {
      this.serverConfirmed = kvConfirmed;
      this.serverConfirmedAt = (await this.ctx.storage.get<number>("confirmedAt")) ?? 0;
    }
    // Sync to Yjs for client display
    this.syncConfirmedToYjs();

    // Load persisted rate limits from KV
    this.lastVerificationSentAt = (await this.ctx.storage.get<number>("lastVerificationSentAt")) ?? 0;
    this.lastDigestGeneratedAt = (await this.ctx.storage.get<number>("lastDigestGeneratedAt")) ?? 0;

    // Backfill nextAlarmTime for existing alarms
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm) {
      const config = this.document.getMap("config");
      if (!config.get("nextAlarmTime")) {
        this.document.transact(() => {
          config.set("nextAlarmTime", existingAlarm);
        });
      }
    }

    // Watch topics array for bounds enforcement
    this.document.getArray("topics").observe(() => {
      this.enforceTopicBounds();
    });

    // Watch config changes for alarm scheduling + email change detection
    this.document.getMap("config").observe(() => {
      this.enforceServerFields();
      this.syncAlarmState().catch((e) =>
        console.error("Alarm sync error:", e)
      );
      this.checkEmailChanged().catch((e) =>
        console.error("Email change check error:", e)
      );
    });
  }

  /** Trim topics array if it exceeds bounds */
  private enforceTopicBounds(): void {
    const arr = this.document.getArray("topics");
    this.document.transact(() => {
      // Trim excess topics
      while (arr.length > MAX_TOPICS) {
        arr.delete(arr.length - 1, 1);
      }
      // Truncate overly long topic strings
      for (let i = 0; i < arr.length; i++) {
        const val = arr.get(i) as string;
        if (typeof val === "string" && val.length > MAX_TOPIC_LENGTH) {
          arr.delete(i, 1);
          arr.insert(i, [val.slice(0, MAX_TOPIC_LENGTH)]);
        }
      }
    });
  }

  /** Revert any client-side mutations to server-controlled fields */
  private enforceServerFields(): void {
    const config = this.document.getMap("config");
    const yjsConfirmed = (config.get("confirmed") as boolean) ?? false;
    const yjsConfirmedAt = (config.get("confirmedAt") as number) ?? 0;
    if (yjsConfirmed !== this.serverConfirmed || yjsConfirmedAt !== this.serverConfirmedAt) {
      this.syncConfirmedToYjs();
    }
  }

  /** Write server-authoritative confirmed state to Yjs (for client display) */
  private syncConfirmedToYjs(): void {
    this.document.transact(() => {
      const config = this.document.getMap("config");
      config.set("confirmed", this.serverConfirmed);
      config.set("confirmedAt", this.serverConfirmedAt);
    });
  }

  /** Set confirmation state (updates KV + instance vars + Yjs) */
  private async setConfirmed(confirmed: boolean): Promise<void> {
    this.serverConfirmed = confirmed;
    if (confirmed) {
      this.serverConfirmedAt = Date.now();
    } else {
      this.serverConfirmedAt = 0;
    }
    await this.ctx.storage.put("confirmed", this.serverConfirmed);
    await this.ctx.storage.put("confirmedAt", this.serverConfirmedAt);
    this.syncConfirmedToYjs();
  }

  private async checkEmailChanged(): Promise<void> {
    const currentEmail = this.getEmail();
    if (currentEmail !== this.lastKnownEmail) {
      // Validate new email — revert if invalid
      if (currentEmail && !isValidEmail(currentEmail)) {
        this.document.transact(() => {
          this.document.getMap("config").set("email", this.lastKnownEmail ?? "");
        });
        return;
      }
      this.lastKnownEmail = currentEmail;
      // Email changed — reset confirmation and invalidate token
      if (this.isConfirmed()) {
        await this.setConfirmed(false);
      }
      await this.ctx.storage.delete("confirmToken");
      // Auto-send verification for new/changed email
      if (currentEmail && !this.isConfirmed()) {
        this.sendVerification().catch((e) =>
          console.error("Auto-verification error:", e)
        );
      }
    }
  }

  async onSave() {
    await this.ctx.storage.put("doc", Y.encodeStateAsUpdate(this.document));
  }

  // --- State helpers ---

  private getEmail(): string | null {
    return (this.document.getMap("config").get("email") as string) ?? null;
  }

  private getTopics(): string[] {
    return (this.document.getArray("topics").toArray() as string[])
      .slice(0, MAX_TOPICS)
      .map((t) => (typeof t === "string" ? t.slice(0, MAX_TOPIC_LENGTH) : ""));
  }

  private getDigests(): Digest[] {
    return this.document.getArray("digests").toArray() as Digest[];
  }

  private isEnabled(): boolean {
    return (this.document.getMap("config").get("enabled") as boolean) ?? false;
  }

  private getFrequency(): string {
    return (this.document.getMap("config").get("frequency") as string) ?? "daily";
  }

  private getTimezone(): string {
    return (this.document.getMap("config").get("timezone") as string) ?? "UTC";
  }

  private isConfirmed(): boolean {
    return this.serverConfirmed;
  }

  private frequencyDays(): number {
    switch (this.getFrequency()) {
      case "every_other_day": return 2;
      case "weekly": return 7;
      case "biweekly": return 14;
      default: return 1;
    }
  }

  // --- Alarm management ---

  private lastScheduledFrequency: string | null = null;
  private lastScheduledTimezone: string | null = null;

  private async syncAlarmState(): Promise<void> {
    const enabled = this.isEnabled();
    const freq = this.getFrequency();
    const tz = this.getTimezone();
    const alarm = await this.ctx.storage.getAlarm();
    const shouldHaveAlarm = enabled && freq !== "manual";

    if (!shouldHaveAlarm && alarm) {
      await this.ctx.storage.deleteAlarm();
      this.lastScheduledFrequency = null;
      this.lastScheduledTimezone = null;
      this.document.transact(() => {
        this.document.getMap("config").delete("nextAlarmTime");
      });
    } else if (shouldHaveAlarm && !alarm) {
      await this.scheduleNextAlarm();
      this.lastScheduledFrequency = freq;
      this.lastScheduledTimezone = tz;
    } else if (shouldHaveAlarm && alarm && (this.lastScheduledFrequency !== freq || this.lastScheduledTimezone !== tz)) {
      // Frequency or timezone changed — reschedule
      await this.scheduleNextAlarm();
      this.lastScheduledFrequency = freq;
      this.lastScheduledTimezone = tz;
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const days = this.frequencyDays();
    const tz = this.getTimezone();
    const now = new Date();

    // Compute the UTC offset for the user's timezone by comparing
    // formatted times. Workers run in UTC so Date() parses locale strings as UTC.
    const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
    let tzStr: string;
    try {
      tzStr = now.toLocaleString("en-US", { timeZone: tz });
    } catch {
      // Invalid timezone — fall back to UTC
      tzStr = utcStr;
    }
    const offsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();

    // Start with today at SEND_HOUR:00 UTC, then shift by the offset
    // to get the UTC moment when it's SEND_HOUR:00 in the user's timezone
    const next = new Date(now);
    next.setUTCHours(SEND_HOUR, 0, 0, 0);
    next.setTime(next.getTime() - offsetMs);

    if (next <= now) next.setTime(next.getTime() + days * 24 * 60 * 60 * 1000);
    else if (days > 1) next.setTime(next.getTime() + (days - 1) * 24 * 60 * 60 * 1000);

    await this.ctx.storage.setAlarm(next.getTime());
    this.document.transact(() => {
      this.document.getMap("config").set("nextAlarmTime", next.getTime());
    });
  }

  async onAlarm(): Promise<void> {
    const shouldReschedule = this.isEnabled() && this.getFrequency() !== "manual";
    if (shouldReschedule) {
      await this.scheduleNextAlarm();
    } else {
      // Stale or at-least-once alarm after the user disabled scheduling —
      // don't generate or email anything.
      return;
    }
    if (!this.isConfirmed() || !this.roomName) {
      if (!this.roomName) console.error("Alarm fired but room name unknown — skipping digest");
      return;
    }
    // Run digest in background so the DO can still handle WebSocket connections
    this.ctx.waitUntil(this.runScheduledDigest());
  }

  private static readonly MAX_DIGEST_RETRIES = 2;
  private static readonly DIGEST_RETRY_DELAY_MS = 60 * 60 * 1000; // 1 hour

  /** Run the scheduled digest; on failure, retry via a short alarm (up to MAX_DIGEST_RETRIES). */
  private async runScheduledDigest(): Promise<void> {
    try {
      await this.runDigest();
      await this.ctx.storage.put("digestRetryCount", 0);
    } catch (e) {
      console.error("Alarm digest failed:", e);
      // Don't schedule a retry if the user disabled or unsubscribed mid-run —
      // a retry alarm would resurrect a schedule syncAlarmState() tore down.
      if (!this.isEnabled() || this.getFrequency() === "manual") return;
      const retryCount =
        (await this.ctx.storage.get<number>("digestRetryCount")) ?? 0;
      if (retryCount >= DigestObject.MAX_DIGEST_RETRIES) {
        // Give up until the next regular schedule (already set by onAlarm).
        await this.ctx.storage.put("digestRetryCount", 0);
        return;
      }
      await this.ctx.storage.put("digestRetryCount", retryCount + 1);
      const retryAt = Date.now() + DigestObject.DIGEST_RETRY_DELAY_MS;
      await this.ctx.storage.setAlarm(retryAt);
      this.document.transact(() => {
        this.document.getMap("config").set("nextAlarmTime", retryAt);
      });
    }
  }

  // --- Digest generation ---

  /** Resolve the room name (UUID). this.name throws when woken by alarm. */
  private async ensureRoomName(): Promise<void> {
    // Try partyserver's name (available on fetch-triggered loads)
    try {
      const name = this.name;
      if (name) {
        if (this.roomName !== name) {
          this.roomName = name;
          await this.ctx.storage.put("roomName", name);
        }
        return;
      }
    } catch {
      // this.name throws when DO is woken by alarm, not fetch
    }

    // Fall back to KV
    this.roomName = (await this.ctx.storage.get<string>("roomName")) ?? null;
    if (this.roomName) return;

    // Migration: extract UUID from existing digest HTML
    const digests = this.getDigests();
    for (const d of digests) {
      const match = d.html?.match(/\/d\/([a-f0-9-]{36})/);
      if (match) {
        this.roomName = match[1];
        await this.ctx.storage.put("roomName", this.roomName);
        return;
      }
    }
  }

  private getDashboardUrl(): string {
    return `https://news.chadnauseam.com/d/${this.roomName ?? "unknown"}`;
  }

  private async getOrCreateConfirmToken(): Promise<string> {
    const existing = await this.ctx.storage.get<string>("confirmToken");
    if (existing) return existing;
    const token = crypto.randomUUID();
    await this.ctx.storage.put("confirmToken", token);
    return token;
  }

  private async sendVerification(): Promise<void> {
    const email = this.getEmail();
    if (!email) throw new Error("No email configured");
    const now = Date.now();
    if (now - this.lastVerificationSentAt < 60_000) {
      throw new Error("Please wait 60 seconds before resending");
    }
    const token = await this.getOrCreateConfirmToken();
    const confirmUrl = `https://news.chadnauseam.com/confirm/${this.name}/${token}`;
    const topics = this.getTopics();
    const result = await sendConfirmationEmail(
      this.env.RESEND_API_KEY,
      email,
      confirmUrl,
      this.getDashboardUrl(),
      topics
    );
    if (!result.success) console.error("Verification email failed:", result.error);
    this.lastVerificationSentAt = now;
    await this.ctx.storage.put("lastVerificationSentAt", now);
  }

  private async runDigest(): Promise<Digest> {
    const topics = this.getTopics();
    const email = this.getEmail();
    if (topics.length === 0) throw new Error("No topics configured");

    const digests = this.getDigests();
    const context = digests.slice(-DIGEST_CONTEXT_COUNT);
    const previousFunFacts = digests
      .map((d) => d.funFact)
      .filter((f): f is string => !!f);

    const digest = await generateDigest(
      this.env.ANTHROPIC_API_KEY,
      topics,
      context,
      this.getDashboardUrl(),
      previousFunFacts
    );

    this.document.transact(() => {
      const arr = this.document.getArray("digests");
      arr.push([digest]);
      while (arr.length > MAX_DIGESTS) arr.delete(0, 1);
      this.document.getMap("config").set("lastDigestSentAt", Date.now());
    });

    if (email) {
      const result = await sendDigestEmail(
        this.env.RESEND_API_KEY,
        email,
        digest.subject,
        digest.html
      );
      if (!result.success) console.error("Email send failed:", result.error);
    }

    return digest;
  }

  // --- Custom messages (trigger from client) ---

  async onCustomMessage(
    connection: import("partyserver").Connection,
    message: string
  ): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data.type === "trigger") {
      try {
        if (!this.isConfirmed()) {
          await this.sendVerification();
          this.sendCustomMessage(
            connection,
            JSON.stringify({ type: "trigger-result", ok: true })
          );
        } else {
          const now = Date.now();
          if (now - this.lastDigestGeneratedAt < 60_000) {
            throw new Error("Please wait 60 seconds between digest generations");
          }
          this.lastDigestGeneratedAt = now;
          await this.ctx.storage.put("lastDigestGeneratedAt", now);
          // Send immediate ack, run digest in background so the DO stays responsive
          this.sendCustomMessage(
            connection,
            JSON.stringify({ type: "trigger-result", ok: true })
          );
          this.ctx.waitUntil(
            this.runDigest().catch((e) => {
              console.error("Manual digest failed:", e);
              this.sendCustomMessage(
                connection,
                JSON.stringify({ type: "trigger-error", error: e.message })
              );
            })
          );
        }
      } catch (e: any) {
        this.sendCustomMessage(
          connection,
          JSON.stringify({
            type: "trigger-result",
            ok: false,
            error: e.message,
          })
        );
      }
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Path: /parties/digest-object/:uuid/confirm/:token
    const confirmMatch = url.pathname.match(/\/confirm\/([a-f0-9-]+)$/);
    if (confirmMatch && request.method === "GET") {
      const providedToken = confirmMatch[1];
      const storedToken = await this.ctx.storage.get<string>("confirmToken");
      if (!storedToken || providedToken !== storedToken) {
        return new Response("Invalid or expired confirmation link.", { status: 403 });
      }
      if (!this.isConfirmed()) {
        await this.setConfirmed(true);
      }
      return Response.redirect(this.getDashboardUrl(), 302);
    }
    // Path: /parties/digest-object/:uuid/unsubscribe
    if (url.pathname.endsWith("/unsubscribe")) {
      if (request.method === "POST") {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) {
          return new Response("Forbidden", { status: 403 });
        }
        this.document.transact(() => {
          this.document.getMap("config").set("frequency", "manual");
        });
        return Response.redirect(this.getDashboardUrl(), 302);
      }
      // GET shows a confirmation page
      return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe - CN News</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:400px;margin:80px auto;padding:20px;">
<div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.06);text-align:center;">
<h1 style="color:#1a1a2e;font-size:20px;margin:0 0 12px;">Unsubscribe from CN News?</h1>
<p style="color:#555;font-size:14px;margin:0 0 24px;">You'll stop receiving scheduled digests. You can re-enable them anytime from your dashboard.</p>
<form method="POST"><button type="submit" style="background:#e67e22;color:#fff;border:none;font-weight:700;font-size:15px;padding:12px 32px;border-radius:8px;cursor:pointer;">Confirm unsubscribe</button></form>
<p style="margin:16px 0 0;"><a href="${this.getDashboardUrl()}" style="color:#e67e22;font-size:13px;text-decoration:none;">Back to dashboard</a></p>
</div></div></body></html>`, {
        headers: { "content-type": "text/html;charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  }
}
