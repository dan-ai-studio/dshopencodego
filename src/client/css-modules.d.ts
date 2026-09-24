/**
 * CSS Modules are compiled by the build into a class-name map; the TypeScript
 * half only needs the shape, never the styles.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
