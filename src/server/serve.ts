// 极简静态服务器:node src/server/serve.ts [端口]
// 路由:/ → web/index.html;/public/* 编译后的 JS;/data/* 航次数据;/web/* 页面资源
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.argv[2]) || 8080;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".fvoy": "application/octet-stream",
  ".png": "image/png",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (path === "/") path = "/web/index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => console.log(`回声分析台 → http://localhost:${PORT}`));
