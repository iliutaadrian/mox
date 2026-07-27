// Width helpers and the copy-text tidy. A one-cell width mistake makes a row
// wrap inside its pane and tears the screen, so these are load-bearing.
import { describe, expect, test } from "bun:test";

import { emojiPresentation, fit, oneLine, tidyCopy, width } from "../src/text.ts";

describe("fit", () => {
  test("pads short text to exactly the width", () => {
    expect(fit("ab", 5)).toBe("ab   ");
    expect(width(fit("ab", 5))).toBe(5);
  });

  test("truncates with an ellipsis and never exceeds the width", () => {
    expect(width(fit("abcdefghij", 5))).toBe(5);
    expect(fit("abcdefghij", 5)).toContain("…");
  });

  test("zero or negative width yields an empty string", () => {
    expect(fit("abc", 0)).toBe("");
    expect(fit("abc", -3)).toBe("");
  });

  test("wide characters still measure exactly", () => {
    for (const s of ["日本語のテキスト", "📎 attachment", "Cei patru mari 4️⃣", "ăîșț diacritice"]) {
      expect(width(fit(s, 10))).toBe(10);
      expect(width(fit(s, 30))).toBe(30);
    }
  });
});

describe("oneLine", () => {
  test("flattens newlines and tabs", () => {
    expect(oneLine("a\nb\tc\r\nd")).toBe("a b c d");
  });

  test("normalises optional-emoji presentation so the width is unambiguous", () => {
    expect(width(emojiPresentation("✍"))).toBe(width(oneLine("✍")));
  });
});

describe("tidyCopy", () => {
  test("strips the pane's right padding per line", () => {
    expect(tidyCopy("Id:      31613     \nMailbox: Test   ")).toBe("Id:      31613\nMailbox: Test");
  });

  test("keeps leading indentation", () => {
    expect(tidyCopy("    indented   ")).toBe("    indented");
  });

  test("regression: an all-whitespace selection is preserved, not emptied", () => {
    // Trimming a whitespace-only grab to "" made the status line claim a copy
    // that never reached the clipboard.
    expect(tidyCopy("     ")).toBe("     ");
    expect(tidyCopy("  \n  ")).toBe("  \n  ");
  });

  test("leaves a trailing newline alone", () => {
    expect(tidyCopy("line\n")).toBe("line\n");
  });
});
