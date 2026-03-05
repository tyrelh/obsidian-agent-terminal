import esbuild from "esbuild";
import fs from "node:fs/promises";

const isProduction = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2020",
  sourcemap: isProduction ? false : "inline",
  external: ["obsidian", "electron"],
  logLevel: "info"
});

const xtermCss = await fs.readFile("node_modules/@xterm/xterm/css/xterm.css", "utf8");
const pluginCss = await fs.readFile("src/styles.css", "utf8");
await fs.writeFile("styles.css", `${xtermCss}\n\n${pluginCss}\n`, "utf8");
