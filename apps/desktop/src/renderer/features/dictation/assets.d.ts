// Vite: a file imported with ?url&no-inline is emitted as its own file and the import is its URL.
declare module "*?url&no-inline" {
  const url: string;
  export default url;
}
