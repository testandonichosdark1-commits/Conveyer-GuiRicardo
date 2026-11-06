import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { draftDir, readDraft } from "./script-drafts";
import { readLtxSceneRequest, readyLtxScene } from "./pipeline";
import { resolveFfmpeg } from "../../ffmpeg-bin";
import { readNarration, narrationFile } from "./script-narration";
const run = promisify(execFile);
async function hash(file: string) {
  const h = createHash("sha256"); for await (const part of createReadStream(file)) h.update(part); return h.digest("hex");
}
export async function draftProgress(id: string) {
  const draft = await readDraft(id), dir = draftDir(id), scenes = [];
  for (let i=1;i<=draft.scenes.length;i++) {
    let ready = false;
    try { ready = Boolean(await readyLtxScene(dir,await readLtxSceneRequest(dir,i))); } catch {}
    const audio = await readNarration(id, i);
    let audioReady = false;
    if (audio?.state === "complete") { try { await narrationFile(id, i); audioReady = true; } catch {} }
    scenes.push({ index:i,narration:draft.scenes[i-1].narration,ready,audio,audioReady });
  }
  let assembly: { sha256: string; file: string } | null = null;
  try { assembly = JSON.parse(await fs.readFile(path.join(dir,"assembly.json"),"utf8")); } catch {}
  let narrated = false;
  try { await fs.access(path.join(dir, "narrated.json")); narrated = true; } catch {}
  return { id,title:draft.title,scenes,ready:scenes.every(s=>s.ready),narrationReady:scenes.every(s=>s.audioReady),videoUrl:assembly ? `/api/tools/ltx-script?id=${id}&asset=1` : null,narratedUrl:narrated?`/api/tools/ltx-script?id=${id}&asset=1&narrated=1`:null };
}
export async function assembleDraft(id: string, narrated = false) {
  const dir = draftDir(id), draft = await readDraft(id);
  const lock = await fs.open(path.join(dir,"assembly.lock"),"wx").catch(()=>{throw new Error("A montagem deste roteiro já está em andamento.");});
  const temp = path.join(dir,`assembly-${randomUUID()}.mp4`), list = path.join(dir,`concat-${randomUUID()}.txt`);
  const stage = path.join(dir, `render-${randomUUID()}`);
  try {
    const files: string[] = [], signatures = [], audioFiles: {file:string;durationSec:number;signature:string}[] = [];
    for(let i=1;i<=draft.scenes.length;i++) {
      const request = await readLtxSceneRequest(dir,i);
      const file = await readyLtxScene(dir,request);
      if(!file || request.media !== "video") throw new Error(`A cena ${i} ainda não tem um clipe pronto. Nenhuma cena será substituída ou ignorada.`);
      files.push(file); signatures.push(await hash(file));
      if (narrated) { const audio = await narrationFile(id, i); audioFiles.push({...audio,signature:await hash(audio.file)}); }
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({signatures,audioFiles:audioFiles.map(a=>[a.signature,a.durationSec]),mode:narrated?"narrated-v1":"silent"})).digest("hex");
    const output = path.join(dir,`${narrated?"narrated":"assembled"}-${fingerprint}.mp4`);
    let concatFiles = files;
    if (narrated) {
      await fs.mkdir(stage);
      concatFiles = [];
      for (let i=0;i<files.length;i++) {
        const audio = audioFiles[i], duration = Math.ceil(audio.durationSec * 24) / 24;
        const clip = path.join(stage, `${i}.mov`);
        // Preserve speech speed. Trim excess video; hold its last frame when speech is longer.
        await run(resolveFfmpeg(), ["-nostdin","-y","-i",files[i],"-i",audio.file,"-filter_complex",`[0:v]fps=24,scale=1920:1080,setsar=1,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[v];[1:a]aresample=48000,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a]`,"-map","[v]","-map","[a]","-c:v","libx264","-preset","fast","-crf","18","-c:a","pcm_s16le","-t",String(duration),clip], {timeout:600_000,maxBuffer:1024*1024});
        concatFiles.push(clip);
      }
    }
    // Generated paths only; escape the concat demuxer's quoted filename grammar.
    await fs.writeFile(list,concatFiles.map(f=>`file '${f.replace(/'/g,"'\\''")}'`).join("\n"),{mode:0o600});
    const args = narrated ? ["-map","0:v:0","-map","0:a:0","-c:v","copy","-c:a","aac","-b:a","192k"] : ["-map","0:v:0","-an","-vf","fps=24,scale=1920:1080,setsar=1","-c:v","libx264","-preset","fast","-crf","18"];
    await run(resolveFfmpeg(),["-nostdin","-y","-f","concat","-safe","0","-i",list,...args,"-movflags","+faststart",temp],{timeout:600_000,maxBuffer:1024*1024});
    // Sources must remain identical throughout assembly.
    for(let i=0;i<files.length;i++) if(await hash(files[i]) !== signatures[i]) throw new Error("Um clipe mudou durante a montagem. Tente novamente.");
    for(const audio of audioFiles) if(await hash(audio.file) !== audio.signature) throw new Error("Um áudio mudou durante a montagem. Tente novamente.");
    await fs.rename(temp,output);
    const manifest = {file:path.basename(output),sha256:await hash(output),fingerprint,sceneCount:files.length,silent:!narrated};
    const journal = path.join(dir,`assembly-${randomUUID()}.json`);
    await fs.writeFile(journal,JSON.stringify(manifest),{mode:0o600}); await fs.rename(journal,path.join(dir,narrated?"narrated.json":"assembly.json"));
    return await draftProgress(id);
  } finally { await lock.close(); await fs.rm(path.join(dir,"assembly.lock"),{force:true}); await fs.rm(temp,{force:true}); await fs.rm(list,{force:true}); await fs.rm(stage,{force:true,recursive:true}); }
}
export async function assembledFile(id: string, narrated = false) {
  const dir = draftDir(id), m = JSON.parse(await fs.readFile(path.join(dir,narrated?"narrated.json":"assembly.json"),"utf8"));
  if(!(narrated ? /^narrated-[a-f0-9]{64}\.mp4$/ : /^assembled-[a-f0-9]{64}\.mp4$/).test(m.file) || !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error("Montagem inválida.");
  const file = path.join(dir,m.file);
  if(await hash(file) !== m.sha256) throw new Error("O arquivo montado foi alterado.");
  return file;
}
