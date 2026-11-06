import {describe,it,expect,vi,beforeEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'ltx-narration-'));
const settings:Record<string,string>={AI33_API_KEY:'test-only',AI33_VOICE_ID:'elevenlabs:test',TTS_SPEED:'0.93'};
vi.mock('../../data-dir',()=>({DATA_DIR:root}));
vi.mock('../../settings',()=>({getSetting:(k:string)=>settings[k] || ''}));
vi.mock('../../ffmpeg-bin',()=>({resolveFfmpeg:()=>'/opt/homebrew/bin/ffmpeg',resolveFfprobe:()=>'/opt/homebrew/bin/ffprobe'}));
const {createDraft}=await import('./script-drafts');
const {prepareNarration,generateNarration,recoverNarration,narrationFile}=await import('./script-narration');
const request=vi.fn();vi.stubGlobal('fetch',request);
async function draft(){return createDraft('Voice',[{narration:'Original words.',description:'Image',motion:'Move'}]);}
beforeEach(()=>{request.mockReset();settings.TTS_SPEED='0.93';settings.AI33_VOICE_ID='elevenlabs:test';});
describe('AI33 narration approval and recovery',()=>{
 it('preparation is local; missing approval and changed settings never create a job',async()=>{
  const d=await draft(),p=await prepareNarration(d.id,1);
  expect(request).not.toHaveBeenCalled();
  await expect(generateNarration(d.id,1,p.fingerprint,false)).rejects.toThrow('confirme');
  settings.TTS_SPEED='1';await expect(generateNarration(d.id,1,p.fingerprint,true)).rejects.toThrow('confirme');
  expect(request).not.toHaveBeenCalled();
 });
 it('concurrent submissions produce one POST and a lost response cannot be resent',async()=>{
  const d=await draft(),p=await prepareNarration(d.id,1);
  request.mockRejectedValue(new Error('network lost'));
  await Promise.allSettled([generateNarration(d.id,1,p.fingerprint,true),generateNarration(d.id,1,p.fingerprint,true)]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(await generateNarration(d.id,1,p.fingerprint,true)).toMatchObject({state:'unknown'});
  await expect(recoverNarration(d.id,1)).rejects.toThrow('sem identificador');
  expect(request).toHaveBeenCalledTimes(1);
 });
 it('recovery uses GET only, measures the decoded audio, and never forwards credentials to the download',async()=>{
  const d=await draft(),p=await prepareNarration(d.id,1);
  const wav=path.join(root,'sample.wav');
  execFileSync('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.4','-ar','48000',wav]);
  request.mockResolvedValueOnce(Response.json({task_id:'task-1',credits:3}));
  expect(await generateNarration(d.id,1,p.fingerprint,true)).toMatchObject({state:'running',jobId:'task-1'});
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({text:'Original words.',voice_id:'elevenlabs:test',speed:0.93});
  request.mockResolvedValueOnce(Response.json({status:'completed',audio_url:'https://cdn.example.com/test.wav',credits:4}));
  request.mockResolvedValueOnce(new Response(await fs.readFile(wav),{headers:{'content-type':'audio/wav'}}));
  expect(await recoverNarration(d.id,1)).toMatchObject({state:'complete',durationSec:0.4,credits:4});
  expect(request.mock.calls[1][1].method).toBeUndefined();
  expect(request.mock.calls[2][1].headers).toBeUndefined();
  expect(await recoverNarration(d.id,1)).toMatchObject({state:'complete'});
  expect(request).toHaveBeenCalledTimes(3);
  const audio=await narrationFile(d.id,1);await fs.appendFile(audio.file,'altered');
  await expect(narrationFile(d.id,1)).rejects.toThrow('alterado');
 });
 it('failed jobs and local audio URLs do not lead to another paid request',async()=>{
  const d=await draft(),p=await prepareNarration(d.id,1);
  request.mockResolvedValueOnce(Response.json({id:'task-2'}));await generateNarration(d.id,1,p.fingerprint,true);
  request.mockResolvedValueOnce(Response.json({status:'completed',audio_url:'http://127.0.0.1/private'}));
  await expect(recoverNarration(d.id,1)).rejects.toThrow('recusado');
  request.mockResolvedValueOnce(Response.json({status:'failed'}));
  expect(await recoverNarration(d.id,1)).toMatchObject({state:'failed'});
  expect(await generateNarration(d.id,1,p.fingerprint,true)).toMatchObject({state:'failed'});
  expect(request.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
 });
});
