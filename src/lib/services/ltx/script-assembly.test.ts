import {describe,it,expect,vi} from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
const root=await fs.mkdtemp(path.join(os.tmpdir(),"ltx-assembly-"));
vi.mock("../../data-dir",()=>({DATA_DIR:root}));
vi.mock("../../ffmpeg-bin",()=>({resolveFfmpeg:()=>"/opt/homebrew/bin/ffmpeg"}));
const {createDraft,draftDir}=await import("./script-drafts");
const {readLtxSceneRequest,ltxSceneDir}=await import("./pipeline");
const {assembleDraft,assembledFile,draftProgress}=await import("./script-assembly");
describe("assembly of approved local clips",()=>{
 it("requires every scene, preserves order and strips source audio",async()=>{
  const d=await createDraft("Order",[{narration:"First",description:"red",motion:"still"},{narration:"Second",description:"blue",motion:"still"}]);
  await expect(assembleDraft(d.id)).rejects.toThrow("cena 1");
  for(const [i,color] of [[1,"red"],[2,"blue"]] as const) {
   const dir=ltxSceneDir(draftDir(d.id),i),r=await readLtxSceneRequest(draftDir(d.id),i);
   execFileSync("/opt/homebrew/bin/ffmpeg",["-nostdin","-loglevel","error","-f","lavfi","-i",`color=c=${color}:s=1920x1080:r=24:d=0.25`,"-f","lavfi","-i","sine=frequency=440:duration=0.25","-c:v","libx264","-preset","ultrafast","-c:a","aac","-shortest",path.join(dir,"clip.mp4")]);
   await fs.writeFile(path.join(dir,"result.json"),JSON.stringify({fingerprint:r.fingerprint,media:"video",stoppedVerified:true}));
  }
  expect((await draftProgress(d.id)).ready).toBe(true);
  const result=await assembleDraft(d.id);expect(result.videoUrl).toContain("asset=1");
  const file=await assembledFile(d.id);
  const probe=JSON.parse(execFileSync("/opt/homebrew/bin/ffprobe",["-v","error","-show_streams","-of","json",file],{encoding:"utf8"}));
  expect(probe.streams).toHaveLength(1);expect(probe.streams[0].nb_frames).toBe("12");
  for(const [at,channel] of [["0.1",0],["0.35",2]] as const) {
   const rgb=execFileSync("/opt/homebrew/bin/ffmpeg",["-nostdin","-loglevel","error","-ss",at,"-i",file,"-frames:v","1","-vf","scale=1:1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
   expect(rgb[channel]).toBeGreaterThan(200);expect(rgb[channel===0?2:0]).toBeLessThan(30);
  }
  await expect(assembleDraft(d.id,true)).rejects.toThrow("narração da cena 1");
  const audioDir=path.join(draftDir(d.id),'narration');
  for(const [i,duration] of [[1,0.4],[2,0.125]] as const) {
   const file=path.join(audioDir,`scene-${i}.wav`);
   execFileSync('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-f','lavfi','-i',`sine=frequency=${i===1?440:880}:duration=${duration}`,'-ar','48000',file]);
   const hash=createHash('sha256').update(await fs.readFile(file)).digest('hex');
   await fs.writeFile(path.join(audioDir,`scene-${i}.json`),JSON.stringify({index:i,text:i===1?'First':'Second',state:'complete',sha256:hash,durationSec:duration}));
  }
  expect((await draftProgress(d.id)).narrationReady).toBe(true);
  await assembleDraft(d.id,true);
  const narrated=await assembledFile(d.id,true);
  const audioProbe=JSON.parse(execFileSync('/opt/homebrew/bin/ffprobe',['-v','error','-show_streams','-of','json',narrated],{encoding:'utf8'}));
  expect(audioProbe.streams.map((s:{codec_type:string})=>s.codec_type)).toEqual(['video','audio']);
  expect(audioProbe.streams[0].nb_frames).toBe('13');
  expect(Number(audioProbe.streams[1].duration)).toBeCloseTo(13/24,1);
  // First scene holds the red last frame past the source's 0.25s duration; second stays blue.
  for(const [at,channel] of [['0.35',0],['0.48',2]] as const) {
   const rgb=execFileSync('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-ss',at,'-i',narrated,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
   expect(rgb[channel]).toBeGreaterThan(200);
  }
  // Decode the first scene audio and count crossings: playback must retain the 440 Hz tone.
  const pcm=execFileSync('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-i',narrated,'-t','0.3','-vn','-ar','48000','-ac','1','-f','s16le','pipe:1']);
  let crossings=0;for(let i=2;i<pcm.length;i+=2)if(pcm.readInt16LE(i-2)<=0 && pcm.readInt16LE(i)>0)crossings++;
  expect(crossings/0.3).toBeGreaterThan(420);expect(crossings/0.3).toBeLessThan(460);
  expect(await assembledFile(d.id)).toBe(file); // silent version remains available
  await fs.rm(path.join(ltxSceneDir(draftDir(d.id),2),"clip.mp4"));
  await expect(assembleDraft(d.id)).rejects.toThrow("cena 2");
  expect(await assembledFile(d.id)).toBe(file);
  await fs.appendFile(file,"tampered");await expect(assembledFile(d.id)).rejects.toThrow("alterado");
 },30000);
 it("rejects a simultaneous assembly and traversal",async()=>{
  const d=await createDraft("Lock",[{narration:"N",description:"D",motion:"M"}]);
  await fs.writeFile(path.join(draftDir(d.id),"assembly.lock"),"");
  await expect(assembleDraft(d.id)).rejects.toThrow("andamento");
  await expect(assembledFile("../outside")).rejects.toThrow();
 });
});
