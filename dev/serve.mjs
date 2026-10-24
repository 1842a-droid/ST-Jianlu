import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8'};
const server=http.createServer(async(req,res)=>{
 try {
  const requested=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  const file=path.resolve(root,requested==='/'?'dev/preview.html':'.'+requested);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'text/plain;charset=utf-8','Cache-Control':'no-store'});res.end(bytes);
 } catch{res.writeHead(404);res.end('Not found');}
});
server.listen(18825,'127.0.0.1',()=>console.log('http://127.0.0.1:18825/'));
