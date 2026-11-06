import { describe,it,expect,vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root = await fs.mkdtemp(path.join(os.tmpdir(),"ltx-script-test-"));
vi.mock("../../data-dir",()=>({DATA_DIR:root}));
const {splitScript,createDraft,readDraft,draftDir} = await import("./script-drafts");
const {listLtxScenes} = await import("./pipeline");
describe("local script preparation",()=>{
 it("rejects empty, oversized and unsplittable input",()=>{
  for(const s of ["", "a".repeat(30001), "a".repeat(2001)]) expect(()=>splitScript(s)).toThrow();
 });
 it("preserves narration and rejects traversal",()=>{
  const text="A hand moves a blender. Crumbs are underneath.\n\nWipe the counter.";
  expect(splitScript(text).map(s=>s.narration).join(" ")).toBe(text.replace(/\n\n/g," "));
  expect(()=>draftDir("../../elsewhere")).toThrow();
 });
 it("creates only pending local scenes without a studio run or generation",async()=>{
  const scenes=splitScript("Move the old blender. Wipe the crumbs.");
  const d=await createDraft("Kitchen test",scenes);
  expect(await readDraft(d.id)).toEqual(d);
  const pending=await listLtxScenes(draftDir(d.id));
  expect(pending).toHaveLength(scenes.length);
  expect(pending[0]).toMatchObject({ready:false,media:"video",imageDescription:scenes[0].description});
  expect(await fs.readdir(draftDir(d.id))).toEqual(expect.arrayContaining(["draft.json","ltx"]));
  await expect(createDraft("Bad",[{...scenes[0],description:""}])).rejects.toThrow();
 });
});
