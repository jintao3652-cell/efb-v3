import { invoke } from "@tauri-apps/api/core";
import type { FlightPlan, WeatherReport } from "../types";

export interface AiracCycle {
  cycleId: string;
  cycleStartDate: string;
  provider: string;
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function listFlightPlans(): Promise<FlightPlan[]> {
  if (!isTauri()) return [];
  return invoke<FlightPlan[]>("list_flight_plans");
}

export async function saveFlightPlan(plan: FlightPlan): Promise<FlightPlan> {
  if (!isTauri()) return plan;
  return invoke<FlightPlan>("save_flight_plan", { plan });
}

export async function getWeather(station: string): Promise<WeatherReport> {
  if (!isTauri()) throw new Error("天气服务仅在桌面应用中可用");
  return invoke<WeatherReport>("get_weather", { station });
}

export async function clearCache(): Promise<void> {
  if (!isTauri()) return;
  await invoke("clear_chart_cache");
}

export async function cacheChartPdf(sourcePath: string, chartId: string): Promise<string> {
  if (!isTauri()) throw new Error("航图缓存仅在桌面应用中可用");
  return invoke<string>("cache_chart_pdf", { sourcePath, chartId });
}

export async function getCurrentAiracCycle(): Promise<AiracCycle> {
  if (!isTauri()) throw new Error("AIRAC 检测仅在桌面应用中可用");
  return invoke<AiracCycle>("get_current_airac_cycle");
}
