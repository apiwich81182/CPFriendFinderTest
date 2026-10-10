'use strict';
// Same-origin gateway for the existing Spring application; WebSocket signaling stays in Spring.
const http=require('node:http');
const backend=new URL(process.env.BACKEND_URL||'http://127.0.0.1:8080');
if(backend.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(backend.hostname))throw new Error('BACKEND_URL must be a loopback HTTP address');
const port=Number(process.env.PORT||3000);
const {getIceStatus,createIceResolver}=require('./cloudflare-turn');
const resolveIceConfig=createIceResolver();
const fs=require('node:fs'),path=require('node:path');
function options(req){return {hostname:backend.hostname,port:backend.port||80,path:req.url,method:req.method,headers:{...req.headers,host:backend.host,'x-forwarded-host':req.headers.host,'x-forwarded-proto':req.headers['x-forwarded-proto']||'http'}};}
const server=http.createServer((req,res)=>{
 const pathname=req.url.split('?')[0];
 const storageOrigin=process.env.STORAGE_PROXY_URL;
 if(pathname.startsWith('/media/')) {
  if(!storageOrigin || !['GET','HEAD'].includes(req.method) || !/^\/media\/storage\/uploads\/[0-9a-f-]+\.(png|jpg|gif|webp)$/.test(pathname)) {res.writeHead(404);res.end();return;}
  const target=new URL(pathname.slice('/media'.length),storageOrigin);
  const proxy=http.request(target,{method:req.method},upstream=>{res.writeHead(upstream.statusCode,{'Content-Type':upstream.headers['content-type']||'application/octet-stream','Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'});upstream.pipe(res);});
  proxy.setTimeout(10000,()=>proxy.destroy());proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>proxy.destroy());proxy.end();return;
 }
 const config=getIceStatus();
 if(pathname==='/turn-check'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,'turn-check.html')));return;}
 if(pathname==='/' && ['GET','HEAD'].includes(req.method)) {res.writeHead(302,{Location:'/login','Cache-Control':'no-store'});res.end();return;}
 if(pathname==='/health') {
  const probe=http.request({...options(req),method:'GET',path:'/login'},upstream=>{upstream.resume();const ready=upstream.statusCode===200;res.writeHead(ready?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({gatewayReady:true,backendReady:ready,relayConfigured:config.relayConfigured}));});
  probe.setTimeout(5000,()=>probe.destroy());probe.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({gatewayReady:true,backendReady:false,relayConfigured:config.relayConfigured}));}});probe.end();return;
 }
 if(req.url.split('?')[0]==='/api/call/ice-config'){
  const auth=http.request({...options(req),method:'GET',path:'/api/users/me'},async upstream=>{upstream.resume();res.setHeader('Cache-Control','no-store');if(upstream.statusCode!==200){res.writeHead(upstream.statusCode===401||upstream.statusCode===403?upstream.statusCode:502);res.end();return;}if(config.configurationError){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'TURN configuration is invalid'}));return;}try{const ice=await resolveIceConfig({identity:req.headers.cookie||'authenticated'});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(ice));}catch(error){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({message:error.message}));}});auth.setTimeout(5000,()=>auth.destroy());auth.on('error',()=>{res.writeHead(502);res.end();});auth.end();return;
 }
 const upstream=http.request(options(req),response=>{const headers={...response.headers};if(headers.location?.startsWith(backend.origin))headers.location=headers.location.slice(backend.origin.length)||'/';res.writeHead(response.statusCode,headers);response.pipe(res);});upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Backend unavailable');});upstream.setTimeout(30000,()=>upstream.destroy(new Error('Backend timeout')));req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
});
server.on('upgrade',(req,socket,head)=>{
 const opts=options(req);if(opts.headers.origin)opts.headers.origin=backend.origin;
 const upstream=http.request(opts);upstream.on('upgrade',(response,remote,remoteHead)=>{socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);remote.pipe(socket);socket.pipe(remote);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());});upstream.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);response.resume();});upstream.on('error',()=>socket.destroy());upstream.end();
});
server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`CPFriendFinder gateway: http://localhost:${port}`));
