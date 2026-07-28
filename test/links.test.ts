// Numbered-link extraction and the picker's filter. renderEmail() shells out to
// lynx for HTML; the plain-text path is pure, so that is where the ordering and
// escaping edge cases are pinned down.
import { describe, expect, test } from "bun:test";

import { filterLinks, renderEmail, type LinkRef } from "../src/links.ts";

const ref = (over: Partial<LinkRef>): LinkRef => ({
  number: 1,
  url: "https://example.com",
  label: "label",
  context: "context",
  host: "example.com",
  tracking: false,
  ...over,
});

describe("renderEmail — plain text", () => {
  test("numbers bare URLs in appearance order and replaces them in the body", () => {
    const { body, links } = renderEmail("", "first https://a.example.com/one then https://b.example.com/two", 76);
    expect(links.map((l) => l.url)).toEqual(["https://a.example.com/one", "https://b.example.com/two"]);
    expect(body).toContain("[1]");
    expect(body).toContain("[2]");
    expect(body).not.toContain("https://a.example.com/one");
  });

  test("regression: a URL that prefixes another does not clobber it", () => {
    // Replacing shortest-first would turn the deep link into "[1]/deep".
    const { body, links } = renderEmail("", "root https://x.example.com and https://x.example.com/deep/page", 76);
    expect(links.length).toBe(2);
    expect(body).not.toContain("/deep/page");
    expect(body).toMatch(/\[1\][\s\S]*\[2\]/);
  });

  test("no raw URL leaks into a link's context", () => {
    const { links } = renderEmail("", "see https://a.example.com/one and https://b.example.com/two", 76);
    for (const l of links) expect(l.context).not.toContain("http");
  });

  test("trailing punctuation is not part of the URL", () => {
    const { links } = renderEmail("", "read https://example.com/page.", 76);
    expect(links[0]!.url).toBe("https://example.com/page");
  });

  test("duplicate URLs are numbered once", () => {
    const { links } = renderEmail("", "a https://example.com/x b https://example.com/x", 76);
    expect(links.length).toBe(1);
  });

  test("a body with no links yields none", () => {
    expect(renderEmail("", "nothing to see here", 76).links).toEqual([]);
  });

  test("regression: a malformed numeric entity does not throw", () => {
    expect(() => renderEmail("", "x &#99999999; https://example.com/a", 76)).not.toThrow();
    expect(renderEmail("", "x &#99999999; https://example.com/a", 76).links.length).toBe(1);
  });

  test("tracking-looking links are flagged", () => {
    const { links } = renderEmail("", "go https://click.example.com/x?utm_source=mail", 76);
    expect(links[0]!.tracking).toBe(true);
  });

  test("plain links are not flagged", () => {
    expect(renderEmail("", "go https://example.com/docs", 76).links[0]!.tracking).toBe(false);
  });

  test("host strips www", () => {
    expect(renderEmail("", "go https://www.example.com/a", 76).links[0]!.host).toBe("example.com");
  });
});

describe("filterLinks", () => {
  const links = [
    ref({ number: 1, label: "aici", host: "oxigentour.ro", url: "https://oxigentour.ro/tours" }),
    ref({ number: 2, label: "review", host: "google.com", url: "https://google.com/maps" }),
    ref({ number: 10, label: "album", host: "photos.example.com", url: "https://photos.example.com/a" }),
    ref({ number: 12, label: "unsubscribe", host: "mail.example.com", url: "https://mail.example.com/u" }),
  ];

  test("an empty query keeps everything", () => {
    expect(filterLinks(links, "").length).toBe(4);
  });

  test("a numeric query matches by prefix so 1 keeps 1, 10 and 12", () => {
    expect(filterLinks(links, "1").map((l) => l.number)).toEqual([1, 10, 12]);
    expect(filterLinks(links, "12").map((l) => l.number)).toEqual([12]);
  });

  test("text matches label, host and url, case-insensitively", () => {
    expect(filterLinks(links, "AICI").map((l) => l.number)).toEqual([1]);
    expect(filterLinks(links, "photos").map((l) => l.number)).toEqual([10]);
    expect(filterLinks(links, "maps").map((l) => l.number)).toEqual([2]);
  });

  test("no match yields an empty list", () => {
    expect(filterLinks(links, "zzz")).toEqual([]);
  });
});
