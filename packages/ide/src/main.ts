// Local review server entrypoint for the IDE plugins.
//   node packages/ide/src/main.ts   (listens on CAVIX_IDE_PORT, default 7077)
import { createLocalReviewServer } from "./server.ts";

const port = Number(process.env.CAVIX_IDE_PORT ?? "7077");
createLocalReviewServer().listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ level: "info", service: "ide-local-review", msg: "listening", url: `http://127.0.0.1:${port}` }));
});
