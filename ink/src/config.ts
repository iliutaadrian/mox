// Mirrors the Go app's config.yaml reading: account order and the manual/AI
// category split (a category with sender rules is "manual").
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Category = {
  name: string;
  hasRules: boolean;
};

export type Config = {
  accounts: string[];
  categories: Category[];
};

export function loadConfig(path: string): Config {
  const raw = parse(readFileSync(path, "utf8"));
  const accounts = (raw.accounts ?? []).map((a: any) => String(a.name));
  const categories = (raw.categories ?? []).map((c: any) => ({
    name: String(c.name),
    hasRules:
      !!c.match &&
      ((c.match.domains?.length ?? 0) > 0 || (c.match.addresses?.length ?? 0) > 0),
  }));
  return { accounts, categories };
}
