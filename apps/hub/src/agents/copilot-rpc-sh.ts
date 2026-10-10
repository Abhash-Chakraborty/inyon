/** Official Copilot SDK JSON-RPC transport, with no credential output. */
export const copilotCatalogScript = String.raw`
const {spawn}=require('node:child_process');
const p=spawn('copilot',['--headless','--stdio','--no-auto-update'],{stdio:['pipe','pipe','ignore']});
let buffer=Buffer.alloc(0),done=false;
const timer=setTimeout(()=>finish('Copilot model discovery timed out'),18000);
function finish(error,value){if(done)return;done=true;clearTimeout(timer);p.kill();if(error){console.error(error);process.exitCode=1;}else console.log(JSON.stringify(value));}
function send(id,method){const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,params:{}}));p.stdin.write('Content-Length: '+body.length+'\r\n\r\n');p.stdin.write(body);}
p.on('error',()=>finish('Copilot CLI is not installed or could not start'));
p.on('exit',()=>{if(!done)finish('Copilot model service exited before returning its catalog')});
p.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const length=Number(buffer.subarray(0,end).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);if(!Number.isSafeInteger(length)||length<0||length>10000000)return finish('Invalid Copilot response');if(buffer.length<end+4+length)return;let response;try{response=JSON.parse(buffer.subarray(end+4,end+4+length).toString())}catch{return finish('Invalid Copilot response')};buffer=buffer.subarray(end+4+length);if(response.id===1){if(response.error)return finish('Copilot connection failed');send(2,'models.list')}else if(response.id===2){if(response.error)return finish('Copilot catalog unavailable; check CLI sign-in');finish(null,response.result)}}});
p.stdin.on('error',()=>finish('Copilot model service disconnected'));
send(1,'connect');
`

export const copilotAuthScript = copilotCatalogScript.replace("send(2,'models.list')", "send(2,'auth.getStatus')").replace("finish(null,response.result)", "finish(response.result?.isAuthenticated ? null : 'Copilot is not signed in',null)")
