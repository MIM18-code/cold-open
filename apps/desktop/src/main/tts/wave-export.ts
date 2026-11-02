import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { validWave } from "./runtime.ts";
import type { SynthesisRequest } from "../../shared/channels/table-read.ts";

export interface ExportCue { id: string; text: string; voice: string; scene: string; speaker: string; }
export interface ReadExportRequest { id: string; path: string; engine: SynthesisRequest["engine"]; cues: ExportCue[]; gapMs: number; title: string; }
export interface ReadExportManifest { version: 1; title: string; engine: string; voices: string[]; generatedAt: string; passages: number; seconds: number; sampleRate: number; chapters: { scene: string; seconds: number; passage: number }[]; }
const RATE=24000, MAX_BYTES=512*1024*1024;

/** Normalize supported local WAVs to 24 kHz mono PCM16 without retaining the whole script in memory. */
export function monoPcm24k(bytes: Uint8Array): Buffer {
  if(!validWave(bytes))throw new Error("An utterance is not a supported WAV file.");
  const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);let codec=0,channels=0,rate=0,bits=0,samples:Buffer|undefined;
  for(let at=12;at+8<=b.length;){const name=b.toString("ascii",at,at+4),length=b.readUInt32LE(at+4),end=at+8+length;if(end>b.length)throw new Error("Truncated WAV chunk.");
    if(name==="fmt "){codec=b.readUInt16LE(at+8);channels=b.readUInt16LE(at+10);rate=b.readUInt32LE(at+12);bits=b.readUInt16LE(at+22);}
    if(name==="data")samples=b.subarray(at+8,end);at=end+length%2;
  }
  if(!samples||!(codec===1&&bits===16||codec===3&&bits===32))throw new Error("Unsupported audio sample format.");
  const step=bits/8,frames=Math.floor(samples.length/(step*channels));if(!frames)throw new Error("The utterance contains no samples.");
  const outFrames=Math.max(1,Math.round(frames*RATE/rate)),out=Buffer.alloc(outFrames*2);
  const value=(frame:number)=>{let n=0;for(let c=0;c<channels;c++){const at=(Math.min(frame,frames-1)*channels+c)*step;n+=codec===1?samples!.readInt16LE(at)/32768:samples!.readFloatLE(at);}n/=channels;return Number.isFinite(n)?Math.max(-1,Math.min(1,n)):0;};
  for(let i=0;i<outFrames;i++){const at=i*rate/RATE,lo=Math.floor(at),f=at-lo,n=value(lo)*(1-f)+value(lo+1)*f;out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(n*32767))),i*2);}
  return out;
}
export function waveHeader(dataBytes:number):Buffer {
  const h=Buffer.alloc(44);h.write("RIFF",0);h.writeUInt32LE(dataBytes+36,4);h.write("WAVE",8);h.write("fmt ",12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(RATE,24);h.writeUInt32LE(RATE*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write("data",36);h.writeUInt32LE(dataBytes,40);return h;
}
export async function exportRead(request:ReadExportRequest,signal:AbortSignal,synthesize:(request:SynthesisRequest)=>Promise<{audio:Uint8Array}>,progress:(done:number,total:number)=>void):Promise<ReadExportManifest> {
  const temp=`${request.path}.reading-${randomUUID()}.tmp`;
  const file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|(constants.O_NOFOLLOW??0),0o600);
  let position=44,completed=false,lastScene:string|undefined;
  const chapters:ReadExportManifest["chapters"]=[];
  const write=async(data:Buffer,at:number)=>{for(let offset=0;offset<data.length;){signal.throwIfAborted();const result=await file.write(data,offset,data.length-offset,at+offset);if(!result.bytesWritten)throw new Error("The audio destination stopped accepting data.");offset+=result.bytesWritten;}};
  try{
    await write(waveHeader(0),0);
    for(let i=0;i<request.cues.length;i++){
      signal.throwIfAborted();const cue=request.cues[i]!;
      if(cue.scene!==lastScene){chapters.push({scene:cue.scene,seconds:(position-44)/(RATE*2),passage:i+1});lastScene=cue.scene;}
      const {audio}=await synthesize({id:`${request.id}-${i}`,engine:request.engine,voice:cue.voice,text:cue.text});signal.throwIfAborted();
      const pcm=monoPcm24k(audio),gap=i+1<request.cues.length?Buffer.alloc(Math.round(request.gapMs/1000*RATE)*2):Buffer.alloc(0);
      if(position+pcm.length+gap.length>MAX_BYTES)throw new Error("The read exceeds the 512 MB export limit. Export smaller scene ranges.");
      await write(pcm,position);position+=pcm.length;await write(gap,position);position+=gap.length;progress(i+1,request.cues.length);
    }
    signal.throwIfAborted();await write(waveHeader(position-44),0);await file.sync();await file.close();signal.throwIfAborted();await rename(temp,request.path);completed=true;
    return{version:1,title:request.title,engine:request.engine,voices:[...new Set(request.cues.map((c)=>c.voice))],generatedAt:new Date().toISOString(),passages:request.cues.length,seconds:(position-44)/(RATE*2),sampleRate:RATE,chapters};
  }finally{await file.close().catch(()=>undefined);if(!completed)await rm(temp,{force:true}).catch(()=>undefined);}
}
