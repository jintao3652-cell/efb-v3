import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";
type MapStyle = "standard" | "satellite";

interface AppState {
  theme: Theme;
  mapStyle: MapStyle;
  language: "zh-CN" | "en";
  sidebarCollapsed: boolean;
  setTheme: (theme: Theme) => void;
  setMapStyle: (mapStyle: MapStyle) => void;
  toggleSidebar: () => void;
  setLanguage: (language: "zh-CN" | "en") => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "dark",
      mapStyle: "standard",
      language: "zh-CN",
      sidebarCollapsed: false,
      setTheme: (theme) => set({ theme }),
      setMapStyle: (mapStyle) => set({ mapStyle }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setLanguage: (language) => set({ language }),
    }),
    { name: "skyboard-efb-preferences" },
  ),
);
