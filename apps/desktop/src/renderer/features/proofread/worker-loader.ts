/// <reference types="vite/client" />
// Only the browser dynamically loads this file. Node's test loader cannot resolve the Vite ?worker suffix.
import CheckWorker from "./proofread.worker.ts?worker";
export { CheckWorker };
