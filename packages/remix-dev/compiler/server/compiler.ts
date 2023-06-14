import * as esbuild from "esbuild";
import { polyfillNode as NodeModulesPolyfillPlugin } from "esbuild-plugin-polyfill-node";

import { type Manifest } from "../../manifest";
import { loaders } from "../utils/loaders";
import { cssModulesPlugin } from "../plugins/cssModuleImports";
import { cssSideEffectImportsPlugin } from "../plugins/cssSideEffectImports";
import { vanillaExtractPlugin } from "../plugins/vanillaExtract";
import { cssFilePlugin } from "../plugins/cssImports";
import { absoluteCssUrlsPlugin } from "../plugins/absoluteCssUrlsPlugin";
import { deprecatedRemixPackagePlugin } from "../plugins/deprecatedRemixPackage";
import { emptyModulesPlugin } from "../plugins/emptyModules";
import { mdxPlugin } from "../plugins/mdx";
import { serverAssetsManifestPlugin } from "./plugins/manifest";
import { serverBareModulesPlugin } from "./plugins/bareImports";
import { serverEntryModulePlugin } from "./plugins/entry";
import { serverRouteModulesPlugin } from "./plugins/routes";
import { externalPlugin } from "../plugins/external";
import type * as Channel from "../../channel";
import type { Context } from "../context";

type Compiler = {
  // produce ./build/index.js
  compile: () => Promise<esbuild.OutputFile[]>;
  cancel: () => Promise<void>;
  dispose: () => Promise<void>;
};

const createEsbuildConfig = (
  ctx: Context,
  channels: { manifest: Channel.Type<Manifest> }
): esbuild.BuildOptions => {
  let stdin: esbuild.StdinOptions | undefined;
  let entryPoints: string[] | undefined;

  if (ctx.config.serverEntryPoint) {
    entryPoints = [ctx.config.serverEntryPoint];
  } else {
    stdin = {
      contents: ctx.config.serverBuildTargetEntryModule,
      resolveDir: ctx.config.rootDirectory,
      loader: "ts",
    };
  }

  let plugins: esbuild.Plugin[] = [
    deprecatedRemixPackagePlugin(ctx),
    cssModulesPlugin(ctx, { outputCss: false }),
    vanillaExtractPlugin(ctx, { outputCss: false }),
    cssSideEffectImportsPlugin(ctx),
    cssFilePlugin(ctx),
    absoluteCssUrlsPlugin(),
    externalPlugin(/^https?:\/\//, { sideEffects: false }),
    mdxPlugin(ctx),
    emptyModulesPlugin(ctx, /\.client(\.[jt]sx?)?$/),
    serverRouteModulesPlugin(ctx),
    serverEntryModulePlugin(ctx),
    serverAssetsManifestPlugin(channels),
    serverBareModulesPlugin(ctx),
    externalPlugin(/^node:.*/, { sideEffects: false }),
  ];

  if (ctx.config.serverPlatform !== "node") {
    plugins.unshift(NodeModulesPolyfillPlugin());
  }

  return {
    absWorkingDir: ctx.config.rootDirectory,
    stdin,
    entryPoints,
    outfile: ctx.config.serverBuildPath,
    conditions: ctx.config.serverConditions,
    platform: ctx.config.serverPlatform,
    format: ctx.config.serverModuleFormat,
    treeShaking: true,
    // The type of dead code elimination we want to do depends on the
    // minify syntax property: https://github.com/evanw/esbuild/issues/672#issuecomment-1029682369
    // Dev builds are leaving code that should be optimized away in the
    // bundle causing server / testing code to be shipped to the browser.
    // These are properly optimized away in prod builds today, and this
    // PR makes dev mode behave closer to production in terms of dead
    // code elimination / tree shaking is concerned.
    minifySyntax: true,
    minify: ctx.options.mode === "production" && ctx.config.serverMinify,
    mainFields: ctx.config.serverMainFields,
    target: "node14",
    loader: loaders,
    bundle: true,
    logLevel: "silent",
    // As pointed out by https://github.com/evanw/esbuild/issues/2440, when tsconfig is set to
    // `undefined`, esbuild will keep looking for a tsconfig.json recursively up. This unwanted
    // behavior can only be avoided by creating an empty tsconfig file in the root directory.
    tsconfig: ctx.config.tsconfigPath,
    sourcemap: ctx.options.sourcemap, // use linked (true) to fix up .map file
    // The server build needs to know how to generate asset URLs for imports
    // of CSS and other files.
    assetNames: "_assets/[name]-[hash]",
    publicPath: ctx.config.publicPath,
    define: {
      "process.env.NODE_ENV": JSON.stringify(ctx.options.mode),
      // TODO: remove REMIX_DEV_SERVER_WS_PORT in v2
      "process.env.REMIX_DEV_SERVER_WS_PORT": JSON.stringify(
        ctx.config.devServerPort
      ),
      "process.env.REMIX_DEV_HTTP_ORIGIN": JSON.stringify(
        ctx.options.devOrigin ?? "" // TODO: remove nullish check in v2
      ),
    },
    jsx: "automatic",
    jsxDev: ctx.options.mode !== "production",
    plugins,
  };
};

export const create = async (
  ctx: Context,
  channels: { manifest: Channel.Type<Manifest> }
): Promise<Compiler> => {
  let compiler = await esbuild.context({
    ...createEsbuildConfig(ctx, channels),
    write: false,
  });
  let compile = async () => {
    let { outputFiles } = await compiler.rebuild();
    return outputFiles;
  };
  return {
    compile,
    cancel: compiler.cancel,
    dispose: compiler.dispose,
  };
};
