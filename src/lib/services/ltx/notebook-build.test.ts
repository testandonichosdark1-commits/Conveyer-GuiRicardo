import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import models from "./models.json";

// The notebook can't reach this repo, so it embeds copies — generated, never hand-edited.
const dir = path.join(__dirname, "../../../../workers/ltx-notebook");
it("the committed Colab/Kaggle notebook is up to date with conveyer_proxy.py and models.json", () => {
  const notebookPath = path.join(dir, "conveyer_ltx_notebook.ipynb");
  const committed = fs.readFileSync(notebookPath, "utf8");
  execFileSync("python3", [path.join(dir, "build_notebook.py")]);
  const rebuilt = fs.readFileSync(notebookPath, "utf8");
  fs.writeFileSync(notebookPath, committed);
  expect(committed, "run: python3 workers/ltx-notebook/build_notebook.py").toBe(rebuilt);
  for (const file of models.files) expect(committed).toContain(file.sha256);
  const sources = (JSON.parse(committed).cells as { source: string[] }[]).map((cell) => cell.source.join("")).join("\n");
  expect(sources).toContain(fs.readFileSync(path.join(dir, "conveyer_proxy.py"), "utf8"));
});
