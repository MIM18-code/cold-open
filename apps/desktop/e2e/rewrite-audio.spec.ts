import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, launch, runCommand } from "./helpers.ts";

test("a captured read exports a real WAV with chapter timings through trusted IPC",async()=>{
  test.skip(process.platform!=="darwin","System voices require macOS");
  const dir=mkdtempSync(join(tmpdir(),"screenplay-export-read-")),file=join(dir,"read.wav"),run=await launch();
  try{
    await run.electronApp.evaluate(({dialog},path)=>{dialog.showSaveDialog=(async()=>({canceled:false,filePath:path})) as any;},file);
    const result=await run.page.evaluate(async()=>{
      const bridge=(window as any).desktop;
      const status=await bridge.invoke("table-read:status"),engine=status.engines.find((e:any)=>e.id==="system"),voice=engine.voices.find((v:any)=>v.language.startsWith("en"))??engine.voices[0];
      if(!voice)return null;
      const path=await bridge.invoke("files:save-dialog",{title:"Export reading",filters:[{name:"WAV",extensions:["wav"]}]});
      return await bridge.invoke("table-read:export",{id:"e2e-read-export",path,engine:"system",title:"A short read",gapMs:180,cues:[
        {id:"a",text:"The kitchen door is open.",voice:voice.id,scene:"Kitchen",speaker:"Narrator"},
        {id:"b",text:"Then close it.",voice:voice.id,scene:"Hall",speaker:"Mara"},
      ]});
    });
    // Only Apple's Premium and Enhanced voices are listed, and this Mac may have none.
    test.skip(result===null,"No Apple Premium or Enhanced voice is installed on this Mac.");
    expect(existsSync(file)).toBe(true);
    const bytes=readFileSync(file);expect(bytes.subarray(0,4).toString()).toBe("RIFF");
    expect(bytes.readUInt32LE(24)).toBe(24000);expect(bytes.readUInt16LE(22)).toBe(1);
    expect(bytes.readUInt32LE(40)).toBe(bytes.length-44);
    expect(result.passages).toBe(2);expect(result.chapters).toHaveLength(2);expect(result.seconds).toBeGreaterThan(1);
  }finally{await close(run.electronApp,run.page);}
});

test("WAV export refuses ungranted filesystem paths and the reader exposes rehearsal and pronunciation tools",async()=>{
  const run=await launch();try{
    const error=await run.page.evaluate(async()=>{try{await (window as any).desktop.invoke("table-read:export",{id:"bad-export",path:"/tmp/not-granted.wav",engine:"system",title:"test",gapMs:0,cues:[{id:"a",text:"test",voice:"Samantha",scene:"Room",speaker:"Mara"}]});return null;}catch(e){return String(e);}});
    expect(error).toContain("Invalid audio export");
    await runCommand(run.page,"tableRead.open");
    await expect(run.page.getByRole("combobox",{name:"Silent rehearsal role"})).toBeVisible();
    await run.page.getByText("Project pronunciations",{exact:true}).click();
    await expect(run.page.getByRole("textbox",{name:"Project pronunciations"})).toBeVisible();
    await run.page.screenshot({path:test.info().outputPath("reader-rehearsal.png")});
  }finally{await close(run.electronApp,run.page);}
});
