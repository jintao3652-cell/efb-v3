import { loadVatsimSnapshot, type VatsimController, type VatsimPilot } from "./airspace";
import type { TrafficSource } from "../stores/app-store";
import { getOnlineUsers, pilotHeading, type XfsController, type XfsPilot } from "./xfly";

/**
 * 在线交通统一层。
 *
 * 两个网络的数据结构差异很大：VATSIM 直接给出 heading（整数度）/ flight_plan，
 * XFlySim 只给 FSD 的 `pbh` 位域整数与拆分过的 flightPlan / aircraft 对象——
 * 航向必须按 `decodePbh()`（见 xfly.ts）从位域里解，不能当角度直接除。
 * 这里统一归一到 VATSIM 的字段形状，地图与详情卡只认一种结构。
 */
export interface TrafficSnapshot {
  source: TrafficSource;
  pilots: VatsimPilot[];
  controllers: VatsimController[];
  fetchedAt: number;
}

const xfsFacilityCodes: Record<string, number> = {
  OBS: 0,
  FSS: 1,
  DEL: 2,
  GND: 3,
  TWR: 4,
  APP: 5,
  CTR: 6,
  DEP: 7,
};

/** XFS 管制呼号形如 ZBPE_CTR / ZBAA_TWR，末段即席位类型。 */
export function xfsFacilityFromCallsign(callsign: string) {
  const suffix = (callsign.split("_").at(-1) ?? "").toUpperCase();
  return xfsFacilityCodes[suffix] ?? 6;
}

function normalizeXfsPilot(pilot: XfsPilot): VatsimPilot {
  const plan = pilot.flightPlan;
  const hasPlan = Boolean(plan && (plan.depAirport || plan.destAirport || plan.route));
  return {
    cid: Number(pilot.cid) || 0,
    name: pilot.name ?? "",
    callsign: pilot.callsign ?? "",
    latitude: Number(pilot.latitude),
    longitude: Number(pilot.longitude),
    altitude: Number(pilot.altitude) || 0,
    groundspeed: Number(pilot.groundSpeed) || 0,
    transponder: String(pilot.transponder ?? ""),
    heading: pilotHeading(pilot),
    qnh_i_hg: 0,
    qnh_mb: 0,
    logon_time: pilot.logonTime ?? "",
    last_updated: pilot.lastUpdated ?? "",
    flight_plan: hasPlan ? {
      flight_rules: plan?.planType ?? "IFR",
      aircraft: plan?.aircraft ?? "",
      aircraft_short: pilot.aircraft?.equipment ?? plan?.aircraft ?? "",
      departure: plan?.depAirport ?? "",
      arrival: plan?.destAirport ?? "",
      alternate: plan?.altAirport ?? "",
      cruise_tas: plan?.tascruise ?? "",
      altitude: plan?.alt ?? "",
      deptime: plan?.depTime ?? "",
      enroute_time: [plan?.hrsEnroute, plan?.minEnroute].filter(Boolean).join(":"),
      fuel_time: [plan?.hrsFuel, plan?.minFuel].filter(Boolean).join(":"),
      remarks: plan?.remarks ?? "",
      route: plan?.route ?? "",
    } : null,
  };
}

function normalizeXfsController(controller: XfsController): VatsimController {
  const raw = controller as unknown as Record<string, unknown>;
  const frequency = controller.frequency ?? raw.frequencyMhz ?? raw.freq ?? "";
  const facility = typeof controller.facility === "number" ? controller.facility : xfsFacilityFromCallsign(controller.callsign ?? "");
  const atis = controller.textAtis ?? (raw.text_atis as string[] | null | undefined) ?? null;
  return {
    cid: Number(controller.cid) || 0,
    callsign: controller.callsign ?? "",
    frequency: String(frequency ?? ""),
    name: controller.name ?? "",
    facility,
    rating: controller.rating,
    logon_time: controller.logonTime ?? (raw.logon_time as string | undefined) ?? "",
    text_atis: Array.isArray(atis) ? atis : null,
  };
}

async function loadXfsTraffic(): Promise<TrafficSnapshot> {
  const snapshot = await getOnlineUsers();
  return {
    source: "xfs",
    pilots: snapshot.pilots.map(normalizeXfsPilot),
    controllers: snapshot.controllers.map(normalizeXfsController),
    fetchedAt: Date.now(),
  };
}

async function loadVatsimTraffic(signal?: AbortSignal): Promise<TrafficSnapshot> {
  const snapshot = await loadVatsimSnapshot(signal);
  return { source: "vatsim", pilots: snapshot.pilots, controllers: snapshot.controllers, fetchedAt: Date.now() };
}

export function loadOnlineTraffic(source: TrafficSource, signal?: AbortSignal): Promise<TrafficSnapshot> {
  return source === "vatsim" ? loadVatsimTraffic(signal) : loadXfsTraffic();
}

export function trafficSourceLabel(source: TrafficSource) {
  return source === "vatsim" ? "VATSIM" : "XFS";
}

/** 详情卡里显示「机型 · 起降场」这类摘要。 */
export function pilotSummary(pilot: VatsimPilot) {
  const plan = pilot.flight_plan;
  if (!plan) return `${Math.round(pilot.altitude / 100) * 100} ft · ${Math.round(pilot.groundspeed)} kt`;
  const leg = plan.departure && plan.arrival ? `${plan.departure}–${plan.arrival}` : "";
  return [plan.aircraft_short || plan.aircraft, leg, plan.altitude].filter(Boolean).join(" · ");
}
