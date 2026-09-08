import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";

interface AppState {
  theme: Theme;
  language: "zh-CN" | "en";
  sidebarCollapsed: boolean;
  online: boolean;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setOnline: (online: boolean) => void;
  setLanguage: (language: "zh-CN" | "en") => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "dark",
      language: "zh-CN",
      sidebarCollapsed: false,
      online: navigator.onLine,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setOnline: (online) => set({ online }),
      setLanguage: (language) => set({ language }),
    }),
    { name: "skyboard-efb-preferences" },
  ),
);
