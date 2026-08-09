/* Non-TS imports the bundler resolves but tsc cannot.
 *
 * `.svg` is the one that matters: @jupyter/builder's base rspack rules load
 * an SVG imported from compiled .js as asset/source, which is exactly the raw
 * string LabIcon.resolve wants. The .css declaration exists so a stylesheet
 * can be imported for its side effect without tsc objecting. */

declare module '*.svg' {
  const source: string;
  export default source;
}

declare module '*.css' {
  const content: string;
  export default content;
}
