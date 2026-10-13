// JSON data modules imported dynamically by the map (tsconfig has no resolveJsonModule).
declare module "@/assets/data/airports-major.json" {
  const airports: unknown;
  export default airports;
}

declare module "world-atlas/countries-110m.json" {
  const topology: unknown;
  export default topology;
}
