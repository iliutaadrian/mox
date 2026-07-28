// Draft MIME builder. mox never sends mail (no SMTP) — drafts are composed
// here and appended to the account's IMAP Drafts folder (mail.appendDraft),
// then reviewed and sent from the provider's own UI (webmail / phone app).
// Output is multipart/alternative: the plain text as written, plus an HTML
// part generated from it so paragraphs survive every composer.

export type DraftInput = {
  from: string; // bare address; the provider fills the display name on send
  to: string;
  subject: string;
  text: string; // plain text; blank lines separate paragraphs
  inReplyTo?: string; // original Message-ID, with <> — makes the draft a reply
};

// RFC 2047 encoded-word for header values with non-ASCII (e.g. diacritics in a
// subject). ASCII passes through untouched. Chunked by code points so a long
// value never produces an encoded word over the 75-char limit.
export function encodeHeaderValue(s: string): string {
  if (!/[^\x20-\x7e]/.test(s)) return s;
  const words: string[] = [];
  for (let i = 0; i < s.length; i += 15) {
    const chunk = s.slice(i, i + 15);
    words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf-8").toString("base64")}?=`);
  }
  return words.join(" ");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Plain text → simple HTML: blank lines split paragraphs, single newlines
// become <br>. Inline style only (mail clients strip <style> blocks).
export function htmlFromText(text: string): string {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px 0;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#222;">${paragraphs.join("")}</div>`;
}

// Base64 body encoding sidesteps every 8-bit/line-length pitfall (Yahoo mangled
// raw 8bit UTF-8 drafts in testing). 76-char lines per RFC 2045.
const b64lines = (s: string) => Buffer.from(s, "utf-8").toString("base64").replace(/(.{76})/g, "$1\r\n");

export function buildDraftMime(d: DraftInput): string {
  const boundary = `----=_mox_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${d.from}`,
    `To: ${d.to}`,
    `Subject: ${encodeHeaderValue(d.subject)}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`, `References: ${d.inReplyTo}`] : []),
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64lines(d.text.replace(/\r\n/g, "\n")),
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64lines(htmlFromText(d.text)),
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

// "Re: " prefix without stacking (Re: Re: …).
export function replySubject(orig: string): string {
  const s = orig.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
