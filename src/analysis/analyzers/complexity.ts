import { cyclomaticComplexity, extractSfcScripts } from "../imports.ts";
import type { Analyzer, AnalyzerContext } from "./index.ts";

/**
 * Cyclomatic complexity (decision-point count) of a file, from the oxc AST.
 * For SFCs only the `<script>` is measured. This is the intra-file *shape* the
 * LoC metric is blind to; the maintainability score uses it to weight the cost
 * of a file's structural/type flaws (dense logic makes a flaw costlier to
 * change safely) — it never penalises complexity on its own.
 */
export const complexityAnalyzer: Analyzer<number> = {
  name: "cc",
  cost: "inline",
  async analyze({ host, file }: AnalyzerContext): Promise<number> {
    const content = await host.readFile(file);
    if (content === null) {
      throw new Error(`unreadable: ${file}`);
    }
    const source = file.endsWith(".vue") ? extractSfcScripts(content) : content;
    return cyclomaticComplexity(source, file);
  },
};
