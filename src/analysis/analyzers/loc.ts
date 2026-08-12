import type { Analyzer, AnalyzerContext } from "./index.ts";

/** Total lines in the file. Cheap — computed inline during snapshots. */
export const locAnalyzer: Analyzer<number> = {
  name: "loc",
  cost: "inline",
  async analyze({ host, file }: AnalyzerContext): Promise<number> {
    const content = await host.readFile(file);
    if (content === null) {
      throw new Error(`unreadable: ${file}`);
    }
    if (content.length === 0) {
      return 0;
    }
    const lines = content.split("\n").length;
    return content.endsWith("\n") ? lines - 1 : lines;
  },
};
