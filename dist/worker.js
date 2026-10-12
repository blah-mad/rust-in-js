import { execute } from './interpreter.js';

self.onmessage = ({ data }) => {
  try { self.postMessage(execute(data.source, { unsafe: data.unsafe, maxSteps: 10000 })); }
  catch { self.postMessage({ ok:false, stdout:[], error:{code:'E_RUNTIME',message:'The runtime hit an unexpected error.',line:1,column:1,hint:'Try a smaller example or report a reproduction on GitHub.'},steps:0,borrows:[],warnings:[] }); }
};
