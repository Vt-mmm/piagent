import { App } from "./App.tsx";
import { useInspection } from "./use-inspection.ts";

export default function InspectionApp() {
  const state = useInspection();
  return <App {...state} />;
}
