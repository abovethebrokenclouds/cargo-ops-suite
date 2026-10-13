import { useEffect, useState } from "react";

/** False during server render and hydration, true after the first client effect. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
