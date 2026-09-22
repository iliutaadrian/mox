// Login-code detection. Every fixture below is a real message shape taken from
// the local corpus — a wrong pick here puts the wrong number on the clipboard
// and into a login form, so the false-positive cases matter as much as the hits.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { findLoginCode } from "../src/codes.ts";

// The word list is config, not code (absent config = feature off), so the
// fixtures run against the list mox actually ships rather than a copy that can
// drift away from it.
const shipped = parse(readFileSync("config.example.yaml", "utf8")).login_codes;
const words: string[] = shipped.words;
const subjectWords: string[] = shipped.subject_words;
const find = (subject: string, body = "") => findLoginCode(subject, body, words, subjectWords);

describe("shipped word lists", () => {
  test("phrases cover the senders the corpus actually uses", () => {
    for (const w of ["verification code", "confirmation code", "cod de siguranta", "codul tau de activare"])
      expect(words).toContain(w);
  });

  test("subject words stay bare, and stay clear of the otp/airport collision", () => {
    expect(subjectWords).toContain("code");
    expect(subjectWords).toContain("cod");
    expect(subjectWords).not.toContain("otp");
  });
});

describe("findLoginCode — real corpus", () => {
  test("ANAF: code and a second number on the same line", () => {
    // "expira dupa 300 secunde" — 300 is nearer the end, but it is 3 digits and
    // far from the gate word; the code sits right after "Cod de siguranta".
    const hit = find("Cod de siguranta", "Cod de siguranta: 735470, expira dupa 300 secunde.");
    expect(hit?.code).toBe("735470");
  });

  test("E.ON: code on its own line, blank lines after the gate word", () => {
    const body = "Dragă client,\n\nCodul tău de activare este:\n\n077724\n\nIntrodu acest cod pentru a finaliza activarea.";
    expect(find("Codul tău de activare autentificare în 2 pași E.ON Myline", body)?.code).toBe("077724");
  });

  test("Golf Genius: code after a long English lead-in", () => {
    const body = "Hi Iliuta!\n\nWe recently received a sign in request for your account. To complete the authentication process, please use the following confirmation code:\n\n480487\n\nIf you didn't request this, ignore this message.";
    expect(find("Your Golf Genius account: 2FA confirmation code", body)?.code).toBe("480487");
  });

  test("LinkedIn: code in the subject, after the gate word", () => {
    const hit = find("Here's your verification code 288184");
    expect(hit?.code).toBe("288184");
    expect(hit?.source).toBe("subject");
  });

  test("Facebook: code in the subject, before the gate word", () => {
    expect(find("479982 is your Facebook code")?.code).toBe("479982");
  });

  test("subject wins over the body when both carry a code", () => {
    const hit = find("Here's your verification code 288184", "your code is 111111");
    expect(hit?.code).toBe("288184");
    expect(hit?.source).toBe("subject");
  });
});

describe("findLoginCode — false positives", () => {
  test("a courier tracking number is not a code", () => {
    expect(find("Azi îți livrăm coletul cu AWB 7000156562170! 🎉")).toBeNull();
  });

  test("digits inside a tracking URL never win", () => {
    // E.ON bodies are stuffed with numeric link paths; the real code is the one
    // next to the gate word, and URL digits must not even be candidates.
    const body = "http://noutati.myline-eon.ro/click/598897483/30559176/c0iw/b1e39976/\n\nCodul tău este: 077724";
    expect(find("Codul tău de activare", body)?.code).toBe("077724");
  });

  test("no gate word means no code, however code-shaped the number", () => {
    expect(find("Deployment 08.04.2026 (07) is live", "build 482910 finished")).toBeNull();
  });

  test("a number far from the gate word is not claimed", () => {
    const body = `Your order code is on the way.${" filler".repeat(60)}\n\n482910`;
    expect(find("Order update", body)).toBeNull();
  });

  test("gate words must stand alone, not sit inside another word", () => {
    // "cod" inside "codrul", "pin" inside "shipping" — neither is a gate hit.
    expect(find("Shipping update", "codrul are 482910 de copaci")).toBeNull();
  });

  test("an empty word list disables detection", () => {
    expect(findLoginCode("Cod de siguranta", "Cod de siguranta: 735470.", [], [])).toBeNull();
  });
});

describe("subject words vs phrases", () => {
  // Bare words are subject-only: in a body they turn ordinary mail into hits.
  test("a bare subject word claims a code the phrases cannot enumerate", () => {
    expect(find("911417 is your Facebook account recovery code")?.code).toBe("911417");
  });

  test("the same bare word in a body claims nothing", () => {
    expect(find("Factura a fost emisa", "Cod fiscal: 20767815")).toBeNull();
  });

  test("a phrase still works in the body", () => {
    expect(find("Notificare", "Cod de verificare: 149506")?.code).toBe("149506");
  });
});

describe("findLoginCode — token shape", () => {
  test("digit runs shorter than 4 or longer than 8 are ignored", () => {
    expect(find("Your code", "code: 123")).toBeNull();
    expect(find("Your code", "code: 1234567890")).toBeNull();
  });

  test("a digit run glued to letters is not a token", () => {
    expect(find("Your code", "code ABC123456")).toBeNull();
  });

  test("a hyphen-prefixed code yields the digits only", () => {
    expect(find("Your verification code", "G-472831 is your code")?.code).toBe("472831");
  });

  test("the nearest candidate wins when several are in range", () => {
    expect(find("Your code", "reference 111111, your code is 222222")?.code).toBe("222222");
  });

  test("a bare year is never a candidate", () => {
    // "How I would learn to code in 2024" — a newsletter subject, measured as a
    // real false positive before years were excluded.
    expect(find("How I would learn to code in 2024 (if I could start over)")).toBeNull();
    expect(find("Your code", "your code arrives in 2025")).toBeNull();
  });

  test("HTML tags are stripped before scanning", () => {
    expect(find("Your code", "<p>Your code is <b>735470</b></p>")?.code).toBe("735470");
  });
});
