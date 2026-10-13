import { listen, seen } from "./mock-comfy-server.mjs";
const PORT = Number(process.env.PORT ?? 18188);
await listen(PORT, "127.0.0.1").catch(async () => {
  // listen() 内部已用固定 PORT；若被占用换个端口
});
process.on("SIGTERM", () => { console.log("SEEN " + JSON.stringify({ uploads: seen.uploads, polls: seen.polls, problems: seen.problems, viewQuery: seen.viewQuery })); process.exit(0); });
