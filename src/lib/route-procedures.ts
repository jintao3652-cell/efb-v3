import type { FlightPlan, FlightProcedureSelection, FlightRoutePoint } from "../types";
import type { NavigationAirportProcedures, NavigationProcedureSummary } from "./tauri";

/**
 * 从航路文本切出元素。航路文本是空格分隔的 token 序列，例如
 * `CIND8S CINDY Z74 HAREM T104 ROKIL ROKI1B` —— 依次是
 * 离场程序名 / 航路点 / 航路 / 航路点 / 航路 / 航路点 / 进场程序名。
 */
export function routeTokens(route: string): string[] {
  return route.trim().toUpperCase().split(/\s+/).filter(Boolean);
}

/** 按名称精确匹配终端程序（忽略大小写与首尾空白）。 */
export function matchProcedureByName(
  procedures: readonly NavigationProcedureSummary[],
  token: string,
): NavigationProcedureSummary | undefined {
  const name = token.trim().toUpperCase();
  if (!name) return undefined;
  return procedures.find((procedure) => procedure.name.trim().toUpperCase() === name);
}

/**
 * 按 SimBrief / 主流飞行计划格式的约定识别终端程序：
 * **首个元素是离场（SID）名，末个元素是进场（STAR）名**。
 *
 * 这条约定之所以成立，是因为航路文本里 SID / STAR 只以「程序名」出现，
 * 它们的航路点（CINDY、ROKIL 之类）是另外的 token，而程序名本身
 * 并不在 navlog 的 fix 列表里 —— 所以只能靠首尾 token 反查程序表。
 *
 * 只有恰好匹配到机场的程序名才返回；不匹配（例如首 token 是雷达引导
 * 后的第一个航路点）就返回 undefined，不去猜。
 */
export function detectRouteProcedures(
  sids: readonly NavigationProcedureSummary[],
  stars: readonly NavigationProcedureSummary[],
  route: string,
): { sid?: NavigationProcedureSummary; star?: NavigationProcedureSummary } {
  const tokens = routeTokens(route);
  if (tokens.length === 0) return {};
  return {
    sid: matchProcedureByName(sids, tokens[0]),
    // 只有一个 token 时它不可能是「既是离场又是进场」，不做匹配。
    star: tokens.length > 1 ? matchProcedureByName(stars, tokens[tokens.length - 1]) : undefined,
  };
}

/** 四字机场代码 —— 只有这种计划才能去查终端程序。 */
export function validAirportIcao(value: string): boolean {
  return /^[A-Z0-9]{4}$/.test(value.trim().toUpperCase());
}

/** 该程序是否支持这条跑道。跑道留空、或程序本身不带跑道信息时，都视为支持。 */
export function procedureSupportsRunway(procedure: NavigationProcedureSummary, runway: string): boolean {
  return !runway || procedure.runways.length === 0 || procedure.runways.includes(runway);
}

/**
 * 选中某条程序时的跑道与选择体。手动选择、编辑器自动识别、导入时补齐
 * 三条路径共用，避免逻辑各自漂移。
 */
export function procedureSelection(
  procedure: NavigationProcedureSummary,
  currentRunway: string,
): { runway: string; selection: FlightProcedureSelection } {
  const runway = currentRunway && procedureSupportsRunway(procedure, currentRunway) ? currentRunway : procedure.runways[0] ?? "";
  return { runway, selection: { name: procedure.name, transition: procedure.transitions.length === 1 ? procedure.transitions[0] : "", points: [] } };
}

/** 查库入口。注入而非直接 import，便于脱离 Tauri 运行端到端验证。 */
export interface ProcedureLookup {
  procedures: (icao: string) => Promise<NavigationAirportProcedures>;
  points: (procedureId: number, runway: string, transition: string) => Promise<FlightRoutePoint[]>;
}

/** 识别结果 + 过程中遇到的失败。issues 非空时调用方必须展示，绝不静默吞掉。 */
export interface PlanProcedureDetection {
  plan: FlightPlan;
  issues: string[];
}

/**
 * 不打开编辑器就把计划的终端程序补齐：按航路文本识别 SID/STAR、定下跑道，
 * 并把程序航迹点一并取回。
 *
 * 导入的计划必须「导入即激活」，而激活的航迹要完整 —— 只靠编辑器里的自动识别
 * 是不够的：用户不打开编辑器（或打开后直接关掉）就只剩航路点，地图上没有
 * 离场/进场航迹。任何一步失败都退回原计划，绝不阻断导入 —— 但失败原因会记进
 * issues，由调用方展示，避免「没识别出来却毫无提示」的静默失败。
 */
export async function detectPlanRouteProceduresDetailed(plan: FlightPlan, lookup: ProcedureLookup): Promise<PlanProcedureDetection> {
  const issues: string[] = [];
  try {
    const sides = [
      { role: "离场", kind: "sids", label: "SID" },
      { role: "进场", kind: "stars", label: "STAR" },
    ] as const;
    const settled = await Promise.allSettled([
      validAirportIcao(plan.departure) ? lookup.procedures(plan.departure.trim().toUpperCase()) : Promise.resolve(undefined),
      validAirportIcao(plan.arrival) ? lookup.procedures(plan.arrival.trim().toUpperCase()) : Promise.resolve(undefined),
    ]);
    const [departureProcedures, arrivalProcedures] = settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      issues.push(`${sides[index].role}程序表（${plan[sides[index].role === "离场" ? "departure" : "arrival"]}）读取失败：${message}`);
      return undefined;
    });
    const lookupFailed = issues.length > 0;
    const tokens = routeTokens(plan.route);
    const detected = detectRouteProcedures(departureProcedures?.sids ?? [], arrivalProcedures?.stars ?? [], plan.route);
    if (!detected.sid && !detected.star && tokens.length >= 2) {
      const emptyTable = (table?: NavigationAirportProcedures) => !table || (table.sids.length === 0 && table.stars.length === 0);
      if (!lookupFailed && (emptyTable(departureProcedures) || emptyTable(arrivalProcedures))) {
        issues.push("程序表为空：导航库读不到 SID/STAR（检查设置里的导航数据库，或库正被占用）");
      } else if (!lookupFailed) {
        issues.push(`未能从航路文本识别程序：首元素 ${tokens[0]}、末元素 ${tokens[tokens.length - 1]} 都没有命中程序表`);
      }
    }
    let updated = plan;
    if (detected.sid && !plan.sid) {
      const { runway, selection } = procedureSelection(detected.sid, plan.departureRunway ?? "");
      updated = { ...updated, departureRunway: runway, sid: selection };
    }
    if (detected.star && !plan.star) {
      const { runway, selection } = procedureSelection(detected.star, plan.arrivalRunway ?? "");
      updated = { ...updated, arrivalRunway: runway, star: selection };
    }
    // 取点必须用「刚定下的跑道」：ROKI1B 这类 STAR 的 leg 是按跑道过渡编码的，
    // 跑道留空会返回 0 个点 —— 地图上就没有进场航迹了。
    const sidSelection = updated.sid;
    const starSelection = updated.star;
    const [sidPoints, starPoints] = await Promise.allSettled([
      sidSelection && detected.sid
        ? lookup.points(detected.sid.id, updated.departureRunway ?? "", sidSelection.transition)
        : Promise.resolve([] as FlightRoutePoint[]),
      starSelection && detected.star
        ? lookup.points(detected.star.id, updated.arrivalRunway ?? "", starSelection.transition)
        : Promise.resolve([] as FlightRoutePoint[]),
    ]);
    const pointResults = [sidPoints, starPoints] as const;
    const selections = [sidSelection, starSelection] as const;
    const procedures = [detected.sid, detected.star] as const;
    const fields = ["sid", "star"] as const;
    const pointKeys = [0, 1] as const;
    for (const index of pointKeys) {
      const result = pointResults[index];
      const selection = selections[index];
      const procedure = procedures[index];
      if (!selection || !procedure) continue;
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        issues.push(`${procedure.name} 航迹点读取失败：${message}`);
        continue;
      }
      if (result.value.length) updated = { ...updated, [fields[index]]: { ...selection, points: result.value } };
      else issues.push(`${procedure.name} 在跑道 ${updated[sides[index].role === "离场" ? "departureRunway" : "arrivalRunway"] ?? "（未定）"} 下没有可绘制航迹点`);
    }
    return { plan: updated, issues };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`终端程序识别中断：${message}`);
    return { plan, issues };
  }
}

/** 兼容入口：只需要补齐后的计划（编辑器等旧调用方）。 */
export async function detectPlanRouteProcedures(plan: FlightPlan, lookup: ProcedureLookup): Promise<FlightPlan> {
  return (await detectPlanRouteProceduresDetailed(plan, lookup)).plan;
}
