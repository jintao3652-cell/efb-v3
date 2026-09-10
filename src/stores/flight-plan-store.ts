import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FlightPlanData } from "../types";

export type FlightPlanDataUpdate = Partial<Omit<FlightPlanData, "origin" | "destination" | "alternate">> & {
  origin?: Partial<FlightPlanData["origin"]>;
  destination?: Partial<FlightPlanData["destination"]>;
  alternate?: FlightPlanData["alternate"] | Partial<NonNullable<FlightPlanData["alternate"]>>;
};

interface FlightPlanPanelState {
  data: FlightPlanData | null;
  hidden: boolean;
  unloadedPlanId: string;
  setFlightPlan: (data: FlightPlanData) => void;
  updateFlightPlan: (update: FlightPlanDataUpdate) => void;
  setHidden: (hidden: boolean) => void;
  unloadFlightPlan: (planId: string) => void;
  clearFlightPlan: () => void;
}

export const useFlightPlanStore = create<FlightPlanPanelState>()(
  persist(
    (set) => ({
      data: null,
      hidden: false,
      unloadedPlanId: "",
      setFlightPlan: (data) => set((state) => state.unloadedPlanId === data.planId ? state : { data, unloadedPlanId: "" }),
      updateFlightPlan: (update) => set((state) => {
        if (!state.data) return state;
        const alternate = update.alternate === undefined
          ? state.data.alternate
          : update.alternate === null
            ? null
            : { ...(state.data.alternate ?? { icao: "", iata: "", name: "", city: "", vfr: false, metar: "" }), ...update.alternate };
        return {
          data: {
            ...state.data,
            ...update,
            origin: { ...state.data.origin, ...update.origin },
            destination: { ...state.data.destination, ...update.destination },
            alternate,
          },
        };
      }),
      setHidden: (hidden) => set({ hidden }),
      unloadFlightPlan: (planId) => set({ data: null, unloadedPlanId: planId, hidden: false }),
      clearFlightPlan: () => set({ data: null, unloadedPlanId: "", hidden: false }),
    }),
    { name: "skyboard-efb-flight-plan-panel" },
  ),
);

export function updateFlightPlan(partialData: FlightPlanDataUpdate) {
  useFlightPlanStore.getState().updateFlightPlan(partialData);
}
