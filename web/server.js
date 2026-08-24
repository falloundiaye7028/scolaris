import http from "node:http";
import { readFile } from "node:fs/promises";
const html = await readFile(new URL("./index.html", import.meta.url));
http.createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(html);}).listen(5173,"0.0.0.0",()=>console.log("SCOLARIS Web : http://localhost:5173"));
