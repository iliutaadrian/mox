// Draft MIME. These drafts are appended to a real IMAP Drafts folder and then
// sent by a human from webmail, so a malformed header or a mangled charset is a
// mistake the user only discovers after hitting Send.
import { describe, expect, test } from "bun:test";

import { buildDraftMime, encodeHeaderValue, htmlFromText, replySubject } from "../src/compose.ts";

const decodeBase64Part = (mime: string, index: number) => {
  const parts = mime.split(/Content-Transfer-Encoding: base64\r\n\r\n/);
  const chunk = parts[index + 1]!.split(/\r\n--/)[0]!;
  return Buffer.from(chunk.replace(/\s/g, ""), "base64").toString("utf8");
};

const base = { from: "me@example.com", to: "them@example.com", subject: "Hello", text: "First para.\n\nSecond para." };

describe("buildDraftMime", () => {
  test("is multipart/alternative with a plain and an HTML part", () => {
    const mime = buildDraftMime(base);
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("Content-Type: text/html; charset=UTF-8");
    expect((mime.match(/Content-Transfer-Encoding: base64/g) ?? []).length).toBe(2);
  });

  test("headers use CRLF and the boundary closes", () => {
    const mime = buildDraftMime(base);
    expect(mime).toContain("\r\n");
    const boundary = /boundary="([^"]+)"/.exec(mime)![1]!;
    expect(mime).toContain(`--${boundary}--`);
  });

  test("body round-trips through base64 with diacritics intact", () => {
    const text = "Bună ziua,\n\nMulțumesc pentru înțelegere.\n";
    const mime = buildDraftMime({ ...base, text });
    expect(decodeBase64Part(mime, 0)).toContain("Mulțumesc pentru înțelegere");
    expect(decodeBase64Part(mime, 1)).toContain("Bună ziua");
  });

  test("a reply carries In-Reply-To and References", () => {
    const mime = buildDraftMime({ ...base, inReplyTo: "<orig@server>" });
    expect(mime).toContain("In-Reply-To: <orig@server>");
    expect(mime).toContain("References: <orig@server>");
  });

  test("a standalone draft has no threading headers", () => {
    const mime = buildDraftMime(base);
    expect(mime).not.toContain("In-Reply-To");
    expect(mime).not.toContain("References");
  });

  test("base64 lines stay within the 76-char limit", () => {
    const mime = buildDraftMime({ ...base, text: "x".repeat(5000) });
    for (const line of mime.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });
});

describe("buildDraftMime with attachments", () => {
  const pdf = { filename: "invoice.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4\nhello") };

  test("wraps the alternative body in a multipart/mixed envelope", () => {
    const mime = buildDraftMime({ ...base, attachments: [pdf] });
    const outer = /Content-Type: multipart\/mixed; boundary="([^"]+)"/.exec(mime)![1]!;
    const inner = /Content-Type: multipart\/alternative; boundary="([^"]+)"/.exec(mime)![1]!;
    expect(outer).not.toBe(inner);
    expect(mime).toContain(`--${outer}--`);
    expect(mime).toContain(`--${inner}--`);
    // the alternative part opens inside the mixed envelope, not before it
    expect(mime.indexOf(`--${outer}`)).toBeLessThan(mime.indexOf("multipart/alternative"));
  });

  test("the file is a base64 attachment part that round-trips byte for byte", () => {
    // Every byte value, so a charset slip or a stray CR corrupts the result.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const mime = buildDraftMime({ ...base, attachments: [{ ...pdf, bytes }] });
    expect(mime).toContain('Content-Type: application/pdf; name="invoice.pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    const chunk = mime.split('Content-Disposition: attachment; filename="invoice.pdf"\r\n\r\n')[1]!.split(/\r\n--/)[0]!;
    expect(Buffer.from(chunk.replace(/\s/g, ""), "base64").equals(bytes)).toBe(true);
  });
});

describe("encodeHeaderValue", () => {
  test("passes ASCII through untouched", () => {
    expect(encodeHeaderValue("Simple subject")).toBe("Simple subject");
  });

  test("encodes non-ASCII as RFC 2047 words", () => {
    const encoded = encodeHeaderValue("Comandă reprogramare");
    expect(encoded).toContain("=?UTF-8?B?");
    expect(encoded).not.toContain("ă");
    const decoded = encoded
      .split(" ")
      .map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)![1]!, "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("Comandă reprogramare");
  });

  test("no encoded word exceeds the 75-char limit", () => {
    for (const word of encodeHeaderValue("ă".repeat(200)).split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  test("a subject with diacritics is encoded in the MIME", () => {
    const mime = buildDraftMime({ ...base, subject: "Comandă 27568" });
    expect(mime).toContain("Subject: =?UTF-8?B?");
  });
});

describe("htmlFromText", () => {
  test("blank lines split paragraphs, single newlines become <br>", () => {
    const html = htmlFromText("one\ntwo\n\nthree");
    expect((html.match(/<p /g) ?? []).length).toBe(2);
    expect(html).toContain("one<br>two");
  });

  test("escapes markup so a body cannot inject tags", () => {
    const html = htmlFromText("<script>alert(1)</script> & co");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; co");
    expect(html).not.toContain("<script>");
  });
});

describe("replySubject", () => {
  test("prefixes once and never stacks", () => {
    expect(replySubject("Order 1")).toBe("Re: Order 1");
    expect(replySubject("Re: Order 1")).toBe("Re: Order 1");
    expect(replySubject("RE: Order 1")).toBe("RE: Order 1");
  });
});
