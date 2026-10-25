//! 通用 HTTP 代理。
//!
//! XFlySim 的开放接口（`api.xflysim.com/pilot/api/...`）在请求带 `Origin` 头时
//! 直接返回 403，浏览器无法直连；JeppQuery 是本机/内网服务，也没有跨域头。
//! 桌面端统一由这里转发，既不触发对方的来源校验，也绕开 WebView 的 CORS。

use serde::Serialize;
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResponse {
    status: u16,
    content_type: String,
    body: String,
}

/// atisview.com 前置了 Cloudflare，按 UA 做爬虫拦截（`x-atisview-crawler-guard`），
/// 自报身份的 UA 会直接 403 `Request blocked.`；其余接口（XFlySim、JeppQuery）
/// 对 UA 无要求，所以统一伪装成桌面 Chrome。
const BROWSER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(BROWSER_AGENT)
        .build()
        .map_err(|_| "无法创建网络请求".to_string())
}

fn ensure_http(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "接口地址无效".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("仅支持 http/https 接口".to_string()),
    }
}

/// 转发一次请求。`method` 缺省为 GET，`body` 为表单或 JSON 原文。
#[tauri::command]
pub async fn api_proxy(
    url: String,
    method: Option<String>,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<ProxyResponse, String> {
    let target = ensure_http(&url)?;
    let http = client()?;
    let verb = method.unwrap_or_else(|| "GET".to_string()).to_uppercase();

    let mut request = match verb.as_str() {
        "POST" => http.post(target.clone()),
        "GET" => http.get(target.clone()),
        _ => http.get(target.clone()),
    }
    .header(reqwest::header::ACCEPT, "application/json, text/plain, */*");

    if verb == "POST" {
        let payload = body.unwrap_or_default();
        request = request
            .header(
                reqwest::header::CONTENT_TYPE,
                content_type.unwrap_or_else(|| "application/x-www-form-urlencoded".to_string()),
            )
            .body(payload);
    }

    let response = request
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "接口请求超时".to_string()
            } else {
                format!("无法连接接口：{error}")
            }
        })?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let body = response
        .text()
        .await
        .map_err(|_| "读取接口响应失败".to_string())?;

    Ok(ProxyResponse {
        status,
        content_type,
        body,
    })
}
