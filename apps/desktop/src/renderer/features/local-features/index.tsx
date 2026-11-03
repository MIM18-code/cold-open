import { useEffect, useState } from "react";
import { app, type Feature } from "../../core/app.ts";
import { desktop } from "../../core/platform.ts";
import { AI_CHANNELS, PROVIDER_LABELS, type AiStatus } from "../../../shared/channels/ai.ts";
import { DICTATION } from "../../../shared/channels/dictation.ts";
import { TABLE_READ } from "../../../shared/channels/table-read.ts";

import { openAiSetup } from "../assistant/setup.ts";
import { VoicePacks } from "./voice-packs.tsx";

function LocalFeatures(){
  const [ai,setAi]=useState<AiStatus|null>(null),[speech,setSpeech]=useState<unknown>(null);
  const [error,setError]=useState("");
  const refresh=async()=>{
    setError("");const results=await Promise.allSettled([desktop.invoke<AiStatus>(AI_CHANNELS.status),desktop.invoke(DICTATION.status)]);
    const [a,s]=results;if(a.status==="fulfilled")setAi(a.value);if(s.status==="fulfilled")setSpeech(s.value);
    const errors=results.filter((x):x is PromiseRejectedResult=>x.status==="rejected");if(errors.length)setError(errors.map((x)=>String(x.reason)).join(" · "));
  };
  useEffect(()=>{void refresh();},[]);
  return <div className="local-features"><p>Writing, saving and ordinary exports work without an AI account. These optional tools run locally unless you explicitly choose a cloud provider for analysis.</p>
    <h3>Table-read voices</h3><VoicePacks/>
    <h3>Draft formatting and dictation</h3><p>Format Draft uses the local formatting model configured under Dictation. Microphone access is needed only for recording, not for formatting pasted text.</p>
    <button className="button" onClick={()=>app.openModal("workspace.settings",{section:"modelManager"})}>Download / manage formatting model</button><button className="button" onClick={()=>app.openModal("workspace.settings",{section:"dictation"})}>Configure local formatter and microphone</button>
    <details><summary>Speech-helper diagnostic status</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{speech?JSON.stringify(speech,null,2):"Not available"}</pre></details>
    <h3>Optional AI analysis</h3>{ai?<><p>Selected provider: {PROVIDER_LABELS[ai.active.provider]}</p><p>{ai.providers.find((p)=>p.provider===ai.active.provider)?.ready?"Provider reports ready. Individual requests can still fail or reach usage limits.":"This provider is not currently ready. Sign-in alone does not enable an unavailable integration."}</p></>:<p>Provider status unavailable.</p>}
    <button className="button" onClick={openAiSetup}>Set up AI…</button>
    {error&&<p role="alert">{error}</p>}<div className="preference-actions"><button className="button" onClick={()=>void refresh()}>Refresh readiness</button><button className="button" onClick={()=>void desktop.invoke(TABLE_READ.clearCache).then(()=>refresh(),(e)=>setError(String(e)))}>Clear generated speech cache</button></div>
    <p>Clearing speech cache does not remove model weights. Nothing automatically switches from local to cloud.</p>
  </div>;
}
const feature:Feature={id:"local-features",commands:[{id:"localFeatures.open",label:"Local Features and Model Readiness…",menu:"Tools",group:"settings",run:(a)=>a.openModal("workspace.settings",{section:"localFeatures"})}],settings:[{id:"localFeatures",title:"Local features",order:20,component:LocalFeatures}]};
export default feature;
