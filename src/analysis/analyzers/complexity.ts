import { cyclomaticComplexity, extractSfcScripts, templateBranches } from "../imports.ts";
import type { Analyzer, AnalyzerContext } from "./index.ts";

/**
 * Cyclomatic complexity (decision-point count) of a file. For SFCs this is
 * the `<script>` blocks' decision points (from the oxc AST) plus the
 * template's branch directives (`v-if`/`v-else-if`/`v-for`/`v-show`) — a
 * `v-if`-dense component with a flat script is real branching load. This is
 * the intra-file *shape* the LoC metric is blind to; the maintainability
 * score charges it as the mass term (each decision point costs more the
 * bigger the file it is buried in).
 */
export const complexityAnalyzer: Analyzer<number> = {
  name: "cc",
  cost: "inline",
  async analyze({ host, file }: AnalyzerContext): Promise<number> {
    const content = await host.readFile(file);
    if (content === null) {
      throw new Error(`unreadable: ${file}`);
    }
    if (file.endsWith(".vue")) {
      return cyclomaticComplexity(extractSfcScripts(content), file) + templateBranches(content);
    }
    return cyclomaticComplexity(content, file);
  },
};
