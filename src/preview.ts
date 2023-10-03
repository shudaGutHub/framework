import type {FSWatcher} from "fs";
import fs from "fs";
import {readFile} from "fs/promises";
import {IncomingMessage, RequestListener, createServer} from "http";
import send from "send";
import type {WebSocket} from "ws";
import {WebSocketServer} from "ws";
import {computeHash} from "./hash.js";
import {render, renderServerlessSource} from "./render.js";
import util from "node:util";

// TODO
// - header and footer
// - syntax highlighting for code blocks
// - serve different notebooks (routing)
// - 'o' in the terminal opens the browser
// - websocket keepalive via ping
// - websocket automatic re-opening when it closes
// - HTTPS with self-signed certificate or something?

class Server {
  private _server: ReturnType<typeof createServer>;
  private _socketServer: WebSocketServer;
  private readonly port: number;
  private readonly hostname: string;

  constructor({port, hostname}: CommandContext) {
    this.port = port;
    this.hostname = hostname;
  }

  start() {
    this._server = createServer();
    this._server.on("request", this._handleRequest);
    this._socketServer = new WebSocketServer({server: this._server});
    this._socketServer.on("connection", this._handleConnection);
    this._server.listen(this.port, this.hostname, () => {
      console.log(`Server running at http://${this.hostname}:${this.port}/`);
    });
  }

  _handleRequest: RequestListener = async (req, res) => {
    if (req.url === "/") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(await render("./docs/index.md"));
    } else if (req.url === "/_observablehq/runtime.js") {
      send(req, "/@observablehq/runtime/dist/runtime.js", {root: "./node_modules"}).pipe(res);
    } else if (req.url?.startsWith("/_observablehq/")) {
      send(req, req.url.slice("/_observablehq".length), {root: "./public"}).pipe(res);
    } else if (req.url?.startsWith("/_file/")) {
      send(req, req.url.slice("/_file".length), {root: "./docs"}).pipe(res);
    } else {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    }
  };

  _handleConnection(socket: WebSocket, req: IncomingMessage) {
    // TODO: parse file path from req.url? Or, allow any file in ./docs to be watched?
    if (req.url === "/_observablehq") {
      handleWatch(socket, "./docs/index.md");
    } else {
      socket.close();
    }
  }
}

function handleWatch(socket: WebSocket, filePath) {
  let watcher: FSWatcher | null = null;

  socket.on("message", (data) => {
    // TODO error handling
    const message = JSON.parse(String(data));
    console.log("↑", message);
    switch (message.type) {
      case "hello": {
        if (watcher) throw new Error("already watching");
        let currentHash = message.hash;
        watcher = fs.watch(filePath, async () => {
          const source = await readFile(filePath, "utf-8");
          const hash = computeHash(source);
          if (currentHash !== hash) {
            send({type: "reload"});
            currentHash = hash;
          }
        });
        break;
      }
    }
  });

  socket.on("error", (error) => {
    console.error("error", error);
  });

  socket.on("close", () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    console.log("socket close");
  });

  function send(message) {
    console.log("↓", message);
    socket.send(JSON.stringify(message));
  }
}

interface CommandContext {
  serve: boolean;
  build: boolean;
  output?: string;
  hostname: string;
  port: number;
  files: string[];
}

function makeCommandContext(): CommandContext {
  const {values, positionals} = util.parseArgs({
    allowPositionals: true,
    options: {
      hostname: {
        type: "string",
        short: "h"
      },
      output: {
        type: "string",
        short: "o"
      },
      build: {
        type: "boolean",
        short: "b"
      },
      serve: {
        type: "boolean",
        short: "s"
      },
      port: {
        type: "string",
        short: "p"
      }
    }
  });

  return {
    serve: values.serve ?? false,
    build: values.build ?? false,
    output: values.output,
    hostname: values.hostname ?? process.env.HOSTNAME ?? "127.0.0.1",
    port: values.port ? +values.port : process.env.PORT ? +process.env.PORT : 3000,
    files: positionals
  };
}

async function build(context: CommandContext) {
  const {files, output = "./dist"} = context;

  const sources: {
    outputPath: string;
    sourcePath: string;
    content: string;
  }[] = [];

  // Make sure all files are readable before starting to write output files.
  for (let sourcePath of files) {
    let content;
    try {
      if (fs.statSync(sourcePath).isDirectory()) {
        sourcePath += "/index.md";
      }
      const outputPath =
        output + (output.length && output[output.length - 1] !== "/" ? "/" : "") + sourcePath.replace(/\.md$/, ".html");
      content = await readFile(sourcePath, "utf-8");
      sources.push({sourcePath, outputPath, content});
    } catch (error) {
      throw new Error(`Unable to read ${sourcePath}: ${error.message}`);
    }
  }

  sources.forEach(({content, outputPath}) => {
    console.log("Building", outputPath);
    const html = renderServerlessSource(content);
    const outputDirectory = outputPath.lastIndexOf("/") > 0 ? outputPath.slice(0, outputPath.lastIndexOf("/")) : null;
    if (outputDirectory) {
      try {
        console.log("Creating directory", outputDirectory);
        fs.mkdirSync(outputDirectory, {recursive: true});
      } catch (error) {
        throw new Error(`Unable to create output directory ${outputDirectory}: ${error.message}`);
      }
    }
    fs.writeFileSync(outputPath, html);
  });
}

const USAGE = `Usage: preview [--serve --port n | --build --output dir] [files...]`;

await (async function () {
  const context = makeCommandContext();
  if (context.serve) {
    new Server(context).start();
  } else if (context.build) {
    if (!context.files.length) {
      console.error(USAGE);
      process.exit(1);
    }
    await build(context);
    process.exit(0);
  } else {
    console.error(USAGE);
    process.exit(1);
  }
})();
