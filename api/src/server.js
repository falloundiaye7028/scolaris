import http from "node:http";

const port = Number(process.env.PORT || 3000);

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      status: "ok",
      service: "scolaris-api",
      timestamp: new Date().toISOString()
    }));
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`SCOLARIS API disponible sur http://localhost:${port}`);
});
