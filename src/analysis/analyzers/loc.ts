import type { Analyzer, AnalyzerContext } from "./index.ts";

/**
 * `<style>` and `<svg>` regions — CSS and inline vector data. Neither is
 * type-checked logic nor maintained line-by-line, so both are excluded from
 * the line count (see below).
 */
const NON_CODE_RE = /<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi;

/**
 * Maintainable source lines: the file's line count with `<style>` and `<svg>`
 * blocks removed. Counting them would let a big icon's vector data or a large
 * style block dominate a file's weight in the maintainability score (and its
 * graph node size) without reflecting any real maintenance surface — those
 * lines aren't edited by hand or type-checked. Cheap; computed inline.
 */
export const locAnalyzer: Analyzer<number> = {
  name: "loc",
  cost: "inline",
  async analyze({ host, file }: AnalyzerContext): Promise<number> {
    const content = await host.readFile(file);
    if (content === null) {
      throw new Error(`unreadable: ${file}`);
    }
    const code = content.replace(NON_CODE_RE, "");
    if (code.length === 0) {
      return 0;
    }
    const lines = code.split("\n").length;
    return code.endsWith("\n") ? lines - 1 : lines;
  },
};
