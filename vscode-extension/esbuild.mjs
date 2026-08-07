import * as esbuild from "esbuild";

/* The extension host runs CommonJS in Node, with `vscode` supplied by the
   runtime rather than resolved from node_modules. One bundled file keeps the
   .vsix small and activation fast. */

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !watch ? "linked" : true,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
