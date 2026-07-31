// Draft MIME builder. mox never sends mail (no SMTP) — drafts are composed
// here and appended to the account's IMAP Drafts folder (mail.appendDraft),
// then reviewed and sent from the provider's own UI (webmail / phone app).
// The body is multipart/alternative: the plain text as written, plus an HTML
// part generated from it so paragraphs survive every composer. With attachments,
// a multipart/mixed envelope wraps that body and holds one part per file.

// A file to hang off the draft. The caller reads the bytes (mox takes paths, not
// base64 in tool args - see backend.draft) so this layer stays pure.
export type DraftAttachment = {
  filename: string;
  contentType: string;
  bytes: Buffer;
};

export type DraftInput = {
  from: string; // bare address; the provider fills the display name on send
  to: string;
  subject: string;
  text: string; // plain text; blank lines separate paragraphs
  inReplyTo?: string; // original Message-ID, with <> — makes the draft a reply
  attachments?: DraftAttachment[]; // if present, multipart/mixed wraps the body
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

// On the reply path From/To/In-Reply-To come from a stored incoming message, so
// a value can carry a line break and inject a header (`a@b.com\r\nBcc: x@y.com`).
// Every header value in the builder goes through here; folding is not needed
// because these values are single addresses or message ids.
const headerValue = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();

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
const wrap76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");
const b64lines = (s: string) => wrap76(Buffer.from(s, "utf-8").toString("base64"));

const newBoundary = () => `----=_mox_${Math.random().toString(36).slice(2)}`;

// The message body proper: the text as written plus an HTML rendering of it.
function alternativePart(text: string): string[] {
  const boundary = newBoundary();
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64lines(text.replace(/\r\n/g, "\n")),
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    b64lines(htmlFromText(text)),
    `--${boundary}--`,
  ];
}

// Percent-encoding for an RFC 2231 parameter value. Only attribute characters
// pass through; everything else, including the quote and the apostrophe that
// delimits the charset, becomes a hex escape.
const rfc2231 = (s: string) =>
  [...Buffer.from(s, "utf-8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9!#$&+.^_`|~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");

// A filename arrives from the user's disk, so it can hold a quote or a line
// break. A raw line break injects a header and a raw quote closes the parameter
// early, so control characters collapse to a space and the rest is escaped. A
// non-ASCII name cannot use an RFC 2047 encoded word - those are not legal in a
// MIME parameter value, and strict clients save the literal "=?UTF-8?B?..."
// text as the filename. RFC 2231 is the mechanism that works.
function filenameParam(raw: string): string {
  const name = raw.replace(/[\x00-\x1f]+/g, " ").trim();
  if (/[^\x20-\x7e]/.test(name)) return `filename*=UTF-8''${rfc2231(name)}`;
  return `filename="${name.replace(/([\\"])/g, "\\$1")}"`;
}

function attachmentPart(a: DraftAttachment): string[] {
  const param = filenameParam(a.filename);
  return [
    `Content-Type: ${a.contentType}; ${param.replace(/^filename/, "name")}`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; ${param}`,
    ``,
    wrap76(a.bytes.toString("base64")),
  ];
}

export function buildDraftMime(d: DraftInput): string {
  const headers = [
    `From: ${headerValue(d.from)}`,
    `To: ${headerValue(d.to)}`,
    `Subject: ${encodeHeaderValue(headerValue(d.subject))}`,
    ...(d.inReplyTo
      ? [`In-Reply-To: ${headerValue(d.inReplyTo)}`, `References: ${headerValue(d.inReplyTo)}`]
      : []),
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `MIME-Version: 1.0`,
  ];
  const body = alternativePart(d.text);
  const files = d.attachments ?? [];
  if (!files.length) return [...headers, ...body, ``].join("\r\n");

  // Attachments need a multipart/mixed envelope, holding the alternative body first,
  // then one part per file (the order every mail client renders as expected).
  const mixed = newBoundary();
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    ``,
    `--${mixed}`,
    ...body,
    ...files.flatMap((a) => [`--${mixed}`, ...attachmentPart(a)]),
    `--${mixed}--`,
    ``,
  ].join("\r\n");
}

// "Re: " prefix without stacking (Re: Re: …).
export function replySubject(orig: string): string {
  const s = orig.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
