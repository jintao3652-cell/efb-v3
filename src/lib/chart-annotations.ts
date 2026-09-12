// 航图注记规范：Grid MORA 与特殊空域。
//
// 依据：
//  - Jeppesen《Introduction to Jeppesen Navigation Charts》ENROUTE-7 图例键
//      §4  Special use airspace.
//      §14 Grid MORA. Values 10,000 feet and greater are maroon.
//          Values less than 10,000 feet are green. Values are depicted in hundreds of feet.
//  - 同书 SYMBOLS-3（Symbol Category: AIRSPACE & BOUNDARIES）Special Use Airspace 两组图例
//  - Navigraph《Introduction to Navigraph Charts》
//      "A purple circle or polygon denotes restricted airspace."
//      "The large numbers in the map grid are minimum off-route altitudes."
//
// 说明：这两类都不是点状图标（MORA 是网格数字，特殊空域是面），
// 因此不放进 chart-symbols.ts 的画布图标集，而是以「颜色 + 格式化 + 分类」规范形式提供，
// 供地图注记图层（text-field / fill / line）直接消费。

/** Jeppesen 印刷配色。绿取自 SYMBOLS-6/ENROUTE 样张实心色块（#00a65c），
 *  绛红取自 ENROUTE-1/ENROUTE-7 样张限制区（#901d41）。 */
export const jeppesenPalette = {
  green: "#00a65c",
  maroon: "#901d41",
} as const;

// ─────────────────────────────── Grid MORA ───────────────────────────────

/** ENROUTE-7 §14 的配色分界：10,000 ft 及以上为绛红，低于为绿。 */
export const moraColorThresholdFeet = 10_000;

export type MoraTone = "low" | "high" | "unsurveyed";

/** 按高度值判定配色档。null / 非有限值 = 数据缺失，对应图例的 "Unsurveyed"。 */
export function moraTone(feet: number | null | undefined): MoraTone {
  if (feet === null || feet === undefined || !Number.isFinite(feet)) return "unsurveyed";
  return feet >= moraColorThresholdFeet ? "high" : "low";
}

/** MORA 注记配色。深色底图上略作提亮以保证可读性，reference 为印刷原色。 */
export const moraColors: Record<MoraTone, { reference: string; onMap: string }> = {
  low: { reference: jeppesenPalette.green, onMap: "#37d68f" },
  high: { reference: jeppesenPalette.maroon, onMap: "#e0698d" },
  unsurveyed: { reference: "#6f8291", onMap: "#9db0be" },
};

/** MORA 数值以百英尺取整显示（7,500 ft → "75"；11,000 ft → "110"）。
 *  术语表：数值后缀 "+/-" 表示精度存疑；缺数据时显示 "Unsurveyed"。 */
export function formatMoraValue(feet: number | null | undefined, doubtful = false): string {
  if (feet === null || feet === undefined || !Number.isFinite(feet)) return "Unsurveyed";
  return `${Math.round(feet / 100)}${doubtful ? "±" : ""}`;
}

// ───────────────────────────── 特殊空域 Special Use Airspace ─────────────────────────────

export type SpecialUseAirspaceTone = "advisory" | "restricted";

/** SYMBOLS-3 把 Special Use Airspace 画成两组色：绿（咨询/警戒/活动通报类）与绛红（限制/禁区类）。 */
export const specialUseAirspaceColors: Record<SpecialUseAirspaceTone, { reference: string; onMap: string; fill: string }> = {
  advisory: { reference: jeppesenPalette.green, onMap: "#37d68f", fill: "rgba(55, 214, 143, 0.16)" },
  restricted: { reference: jeppesenPalette.maroon, onMap: "#e0698d", fill: "rgba(224, 105, 141, 0.20)" },
};

type SpecialUseAirspaceRule = {
  tone: SpecialUseAirspaceTone;
  /** 归类展示名 */
  label: string;
  /** 归一化后的匹配片段（小写、去空格与标点） */
  keywords: string[];
  /** SYMBOLS-3 原文列举的空域名称（英文） */
  types: string[];
  /** 常用字母代号 / 缩写 */
  codes: string[];
};

export const specialUseAirspaceRules: SpecialUseAirspaceRule[] = [
  {
    tone: "advisory",
    label: "咨询 / 警戒类",
    keywords: ["advisory", "alert", "caution", "jda", "militaryoperationsarea", "moa", "temporaryreserved", "tra", "training", "warning"],
    types: [
      "Advisory Area (Canada)",
      "Alert Area",
      "Caution Area",
      "JDA Areas (Japan)",
      "Military Operations Area",
      "Temporary Reserved Airspace",
      "Training Area",
      "Warning Area",
    ],
    codes: ["W", "A", "C", "TRA", "TSA", "MOA"],
  },
  {
    tone: "restricted",
    label: "限制 / 禁区类",
    keywords: ["intenseairactivity", "danger", "flightrestricted", "frz", "fueldumping", "highintensityradiotransmission", "hitra", "prohibited", "restricted"],
    types: [
      "Areas of Intense Air Activity",
      "Danger Area",
      "Flight Restricted Zones (FAA)",
      "Fuel Dumping Areas",
      "High Intensity Radio Transmission Areas",
      "Prohibited Area",
      "Restricted Area",
    ],
    codes: ["P", "R", "D"],
  },
];

function normalizeAirspaceType(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 把空域类型/名称归到 SYMBOLS-3 的两个色族。
 *  无法识别时按「限制类」处理——对 EFB 而言把未知空域画得更保守比画得更宽松安全。 */
export function specialUseAirspaceTone(type: string): SpecialUseAirspaceTone {
  const normalized = normalizeAirspaceType(type);
  if (!normalized) return "restricted";
  if (/^[a-z]$/.test(normalized)) {
    const byCode = specialUseAirspaceRules.find((rule) => rule.codes.some((code) => code.toLowerCase() === normalized));
    if (byCode) return byCode.tone;
  }
  const matched = specialUseAirspaceRules.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword)));
  return matched ? matched.tone : "restricted";
}

/** 面要素的 MapLibre 绘制参数，供未来接入特殊空域数据后直接使用。 */
export function specialUseAirspacePaint(type: string) {
  const tone = specialUseAirspaceTone(type);
  const colors = specialUseAirspaceColors[tone];
  return {
    tone,
    fillColor: colors.fill,
    lineColor: colors.onMap,
    lineWidth: 1.6,
    /** 虚线表示空中限制空域（与地面限制区区分），沿用 Jeppesen 印刷的虚线框惯例 */
    lineDasharray: [3, 2],
    label: specialUseAirspaceRules.find((rule) => rule.tone === tone)?.label ?? "",
  };
}
